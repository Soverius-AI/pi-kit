import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BaseEvent, EventType } from '@ag-ui/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from './database.service';
import { EventLogRepository } from './event-log.repository';

const event: BaseEvent = { type: EventType.CUSTOM, name: 'test', value: {} } as BaseEvent;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function writers() {
  const dir = mkdtempSync(join(tmpdir(), 'pk-event-writers-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const databases = [await DatabaseService.create({ dataDir: dir }), await DatabaseService.create({ dataDir: dir })];
  for (const database of databases) cleanup.push(() => database.onApplicationShutdown());
  return databases.map((database) => new EventLogRepository(database));
}

async function isolatedWriter() {
  const dir = mkdtempSync(join(tmpdir(), 'pk-event-batches-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const database = await DatabaseService.create({ dataDir: dir });
  cleanup.push(() => database.onApplicationShutdown());
  return { database, log: new EventLogRepository(database) };
}

describe('batched event deletion', () => {
  it('deletes across parameter-bounded chunks without deleting another thread’s events', async () => {
    const { database, log } = await isolatedWriter();
    await database.db.exec(`
      WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<1200)
      INSERT INTO thread_events(thread_id,run_id,event_json,type)
      SELECT CASE WHEN n%2=1 THEN 't' ELSE 'other' END,'r','{"type":"CUSTOM","name":"test","value":{}}','CUSTOM'
      FROM numbers;
    `);
    const seqs = Array.from({ length: 1100 }, (_, i) => i + 1);
    await log.deleteSeqs('t', [...seqs, 1]);
    expect(await log.count('t')).toBe(50);
    expect(await log.count('other')).toBe(600);
    expect((await log.read('t'))[0].seq).toBe(1101);
  });

  it('rolls back earlier chunks when a later delete fails', async () => {
    const { database, log } = await isolatedWriter();
    await database.db.exec(`
      WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<1200)
      INSERT INTO thread_events(thread_id,run_id,event_json,type)
      SELECT 't','r','{"type":"CUSTOM","name":"test","value":{}}','CUSTOM' FROM numbers;
      CREATE TRIGGER refuse_delete BEFORE DELETE ON thread_events WHEN OLD.seq=1001
      BEGIN SELECT RAISE(ABORT, 'late delete failure'); END;
    `);
    await expect(
      log.deleteSeqs(
        't',
        Array.from({ length: 1200 }, (_, i) => i + 1),
      ),
    ).rejects.toThrow('late delete failure');
    expect(await log.count('t')).toBe(1200);
    expect((await log.read('t'))[0].seq).toBe(1);
  });

  it('does not open a transaction for an empty deletion', async () => {
    const { database, log } = await isolatedWriter();
    const transaction = vi.spyOn(database.db, 'transaction');
    await log.deleteSeqs('t', []);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('event sequence allocation', async () => {
  it('allocates distinct sequences when independent writers share the database', async () => {
    const [first, second] = await writers();
    expect(await first.append('t', 'r', event)).toBe(1);
    expect(await second.append('t', 'r', event)).toBe(2);
    expect(await first.append('t', 'r', event)).toBe(3);
    expect(await second.append('t', 'r', event)).toBe(4);
    expect((await first.read('t')).map((row) => row.seq)).toEqual([1, 2, 3, 4]);
  });

  it('keeps interleaved threads ordered across writers', async () => {
    const logs = await writers();
    await Promise.all(
      Array.from({ length: 16 }, async (_, thread) => {
        let previous = 0;
        for (let i = 0; i < 40; i++) {
          await Promise.resolve();
          const seq = await logs[i % logs.length].append(`t${thread}`, 'r', event);
          expect(seq).toBeGreaterThan(previous);
          previous = seq;
        }
      }),
    );
    for (let thread = 0; thread < 16; thread++) expect(await logs[0].count(`t${thread}`)).toBe(40);
  });

  it('allocates after serialization, which may itself append an event', async () => {
    const [log] = await writers();
    const outer = {
      type: EventType.CUSTOM,
      name: 'outer',
      value: {
        toJSON: () => {
          void log.append('t', 'r', event);
          return {};
        },
      },
    } as BaseEvent;
    expect(await log.append('t', 'r', outer)).toBe(2);
    expect((await log.read('t')).map((row) => row.seq)).toEqual([1, 2]);
  });

  it('does not reuse a deleted sequence when another writer appends', async () => {
    const [log, other] = await writers();
    await log.append('t', 'r', event);
    await log.append('t', 'r', event);
    await log.deleteSeqs('t', [2]);
    expect(await other.append('t', 'r', event)).toBe(3);
  });

  it('resumes a thread across gaps from other threads and rejects their cursors', async () => {
    const [log] = await writers();
    const first = await log.append('t1', 'r1', event);
    const cursor = log.cursor('t1', first);
    await log.append('t2', 'r2', event);
    const last = await log.append('t1', 'r1', event);
    expect(await log.resolveCursor('t1', cursor)).toBe(first);
    expect(await log.resolveCursor('t2', cursor)).toBeUndefined();
    expect((await log.readAfter('t1', first)).map((row) => row.seq)).toEqual([last]);
    await log.clear('t1');
    expect(await log.resolveCursor('t1', cursor)).toBeUndefined();
    expect(await log.append('t1', 'r3', event)).toBeGreaterThan(last);
  });
});

it('arbitrates concurrent beginRun calls using the partial unique index', async () => {
  const [first, second] = await writers();
  const results = await Promise.allSettled([first.beginRun('t', 'one'), second.beginRun('t', 'two')]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  const running = await first.staleRuns();
  expect(running).toHaveLength(1);
  await first.endRun(running[0].runId, 'finished');
  await second.beginRun('t', 'replacement');
  expect((await second.lastRun('t'))?.runId).toBe('replacement');
});

it('waits for a real competing writer lock without blocking the event loop or publishing early', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-event-lock-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const holder = await DatabaseService.create({ dataDir: dir });
  cleanup.push(() => holder.onApplicationShutdown());
  const writer = await DatabaseService.create({ dataDir: dir });
  cleanup.push(() => writer.onApplicationShutdown());
  let release!: () => void;
  let locked!: () => void;
  const held = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = holder.db.transaction(async () => {
    await holder.db
      .prepare("INSERT INTO runs(run_id,thread_id,status,started_at) VALUES('lock','other','running',1)")
      .run();
    locked();
    await gate;
  })();
  await held;
  let committed = false;
  const append = new EventLogRepository(writer).append('t', 'r', event).then((seq) => {
    committed = true;
    return seq;
  });
  // This timer must run while SQLite's busy handler is waiting on the other connection.
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(committed).toBe(false);
  release();
  await transaction;
  expect(await append).toBe(1);
  expect(committed).toBe(true);
});

it('rotates cursor generations before an asynchronous clear yields, not after later writes can publish', async () => {
  const [log] = await writers();
  const previous = await log.append('t', 'r', event);
  const old = log.cursor('t', previous);
  const clearing = log.clear('t');
  const generationDuringClear = log.cursor('t', previous + 1).split(':')[0];
  await clearing;
  const next = await log.append('t', 'new', event);
  const cursor = log.cursor('t', next);
  expect(cursor.split(':')[0]).toBe(generationDuringClear);
  expect(await log.resolveCursor('t', old)).toBeUndefined();
  expect(await log.resolveCursor('t', cursor)).toBe(next);
});
