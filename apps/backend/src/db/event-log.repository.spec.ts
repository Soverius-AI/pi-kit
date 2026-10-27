import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BaseEvent, EventType } from '@ag-ui/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database.service';
import { EventLogRepository } from './event-log.repository';

const event: BaseEvent = { type: EventType.CUSTOM, name: 'test', value: {} } as BaseEvent;
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((close) => close()));

function writers() {
  const dir = mkdtempSync(join(tmpdir(), 'pk-event-writers-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const databases = [new DatabaseService({ dataDir: dir }), new DatabaseService({ dataDir: dir })];
  for (const database of databases) cleanup.push(() => database.onApplicationShutdown());
  return databases.map((database) => new EventLogRepository(database));
}

describe('event sequence allocation', () => {
  it('allocates distinct sequences when independent writers share the database', () => {
    const [first, second] = writers();
    expect(first.append('t', 'r', event)).toBe(1);
    expect(second.append('t', 'r', event)).toBe(2);
    expect(first.append('t', 'r', event)).toBe(3);
    expect(second.append('t', 'r', event)).toBe(4);
    expect(first.read('t').map((row) => row.seq)).toEqual([1, 2, 3, 4]);
  });

  it('keeps interleaved threads ordered across writers', async () => {
    const logs = writers();
    await Promise.all(Array.from({ length: 16 }, async (_, thread) => {
      let previous = 0;
      for (let i = 0; i < 40; i++) {
        await Promise.resolve();
        const seq = logs[i % logs.length].append(`t${thread}`, 'r', event);
        expect(seq).toBeGreaterThan(previous);
        previous = seq;
      }
    }));
    for (let thread = 0; thread < 16; thread++) expect(logs[0].count(`t${thread}`)).toBe(40);
  });

  it('allocates after serialization, which may itself append an event', () => {
    const [log] = writers();
    const outer = { type: EventType.CUSTOM, name: 'outer', value: {
      toJSON: () => {
        log.append('t', 'r', event);
        return {};
      },
    } } as BaseEvent;
    expect(log.append('t', 'r', outer)).toBe(2);
    expect(log.read('t').map((row) => row.seq)).toEqual([1, 2]);
  });

  it('does not reuse a deleted sequence when another writer appends', () => {
    const [log, other] = writers();
    log.append('t', 'r', event);
    log.append('t', 'r', event);
    log.deleteSeqs('t', [2]);
    expect(other.append('t', 'r', event)).toBe(3);
  });

  it('resumes a thread across gaps from other threads and rejects their cursors', () => {
    const [log] = writers();
    const first = log.append('t1', 'r1', event);
    const cursor = log.cursor('t1', first);
    log.append('t2', 'r2', event);
    const last = log.append('t1', 'r1', event);
    expect(log.resolveCursor('t1', cursor)).toBe(first);
    expect(log.resolveCursor('t2', cursor)).toBeUndefined();
    expect(log.readAfter('t1', first).map((row) => row.seq)).toEqual([last]);
    log.clear('t1');
    expect(log.resolveCursor('t1', cursor)).toBeUndefined();
    expect(log.append('t1', 'r3', event)).toBeGreaterThan(last);
  });
});
