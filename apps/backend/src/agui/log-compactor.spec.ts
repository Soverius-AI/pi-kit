import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BaseEvent, EventType } from '@ag-ui/client';
import { compactableIndices, messagesSnapshot } from '@pi-kit/pi-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import { foldComposer } from './composer-log';
import { COMPACTION, LogCompactor } from './log-compactor';

let dir: string;
let log: EventLogRepository;
let databases: DatabaseService[];
let directories: string[];
const database = async (path: string): Promise<DatabaseService> => {
  const db = await DatabaseService.create({ dataDir: path });
  databases.push(db);
  directories.push(path);
  return db;
};
beforeEach(async () => {
  databases = [];
  directories = [];
  dir = mkdtempSync(join(tmpdir(), 'pk-compactor-'));
  log = new EventLogRepository(await database(dir));
});
afterEach(async () => {
  for (const db of databases) await db.onApplicationShutdown();
  for (const path of directories) rmSync(path, { recursive: true, force: true });
});

const ev = (event: Record<string, unknown>) => event as unknown as BaseEvent;

/** A finished run: one streamed answer of `deltas` chunks, a custom event, a snapshot of `turn` turns, the terminal event. */
async function finishedRun(thread: string, run: number, deltas = 6): Promise<void> {
  const runId = `r${run}`;
  const add = async (event: BaseEvent) => await log.append(thread, runId, event);
  await add(ev({ type: EventType.RUN_STARTED, threadId: thread, runId }));
  await add(ev({ type: EventType.TEXT_MESSAGE_START, messageId: `m${run}`, role: 'assistant' }));
  for (let i = 0; i < deltas; i++)
    await add(ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: `m${run}`, delta: `chunk ${i} ` }));
  await add(ev({ type: EventType.TEXT_MESSAGE_END, messageId: `m${run}` }));
  await add(ev({ type: EventType.CUSTOM, name: 'pi.usage', value: { cost: 0, contextTokens: run } }));
  await add(
    messagesSnapshot(
      Array.from({ length: run * 2 }, (_, i) => ({
        id: `x${i}`,
        role: i % 2 ? 'assistant' : 'user',
        content: `m ${i}`,
      })) as never,
    ),
  );
  await add(ev({ type: EventType.RUN_FINISHED, threadId: thread, runId }));
}

const types = async (thread: string) => (await log.read(thread)).map((s) => s.event.type);

describe('LogCompactor, per run pass', () => {
  it('leaves the same log as compacting the whole log after every run', async () => {
    const compactor = new LogCompactor(log, { maxRows: 1e9, keepRuns: 10 });
    const reference = new EventLogRepository(await database(mkdtempSync(join(tmpdir(), 'pk-compactor-ref-'))));
    for (let run = 1; run <= 8; run++) {
      await finishedRun('t', run);
      await compactor.compact('t');
      // the old algorithm, on a copy of the same events
      await finishedRunInto(reference, run);
      const stored = await reference.read('t');
      const drop = compactableIndices(stored.map((s) => s.event));
      await reference.deleteSeqs(
        't',
        drop.map((i) => stored[i].seq),
      );
    }
    expect((await log.read('t')).map((s) => s.event)).toEqual((await reference.read('t')).map((s) => s.event));
  });

  it('keeps exactly one snapshot and no content deltas of finished blocks', async () => {
    const compactor = new LogCompactor(log);
    for (let run = 1; run <= 5; run++) {
      await finishedRun('t', run);
      await compactor.compact('t');
    }
    expect((await types('t')).filter((t) => t === EventType.MESSAGES_SNAPSHOT)).toHaveLength(1);
    expect((await types('t')).filter((t) => t === EventType.TEXT_MESSAGE_CONTENT)).toHaveLength(0);
    expect((await types('t')).filter((t) => t === EventType.CUSTOM)).toHaveLength(5);
  });

  it('does nothing for a log without a snapshot (a run in progress)', async () => {
    await log.append('t', 'r1', ev({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r1' }));
    await log.append('t', 'r1', ev({ type: EventType.TEXT_MESSAGE_START, messageId: 'm', role: 'assistant' }));
    await log.append('t', 'r1', ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm', delta: 'x' }));
    expect(await new LogCompactor(log).compact('t')).toEqual({ trimmed: 0, collapsed: 0 });
    expect(await log.count('t')).toBe(3);
  });

  it('also trims what an earlier run without a snapshot (a dialog, a crash) left behind', async () => {
    await finishedRun('t', 1);
    const compactor = new LogCompactor(log);
    await compactor.compact('t');
    // a run that ended in an interrupt: complete streamed block, no snapshot
    await log.append('t', 'r2', ev({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r2' }));
    await log.append('t', 'r2', ev({ type: EventType.TEXT_MESSAGE_START, messageId: 'm2', role: 'assistant' }));
    await log.append('t', 'r2', ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm2', delta: 'asking' }));
    await log.append('t', 'r2', ev({ type: EventType.TEXT_MESSAGE_END, messageId: 'm2' }));
    await log.append('t', 'r2', ev({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r2' }));
    await finishedRun('t', 3);
    await compactor.compact('t');
    expect((await types('t')).filter((t) => t === EventType.TEXT_MESSAGE_CONTENT)).toHaveLength(0);
  });
});

describe('LogCompactor, collapse', () => {
  it('keeps a log under maxRows by deleting the oldest runs, newest snapshot and recent runs intact', async () => {
    const compactor = new LogCompactor(log, { maxRows: 60, keepRuns: 3 });
    let collapsed = 0;
    for (let run = 1; run <= 40; run++) {
      await finishedRun('t', run);
      collapsed += (await compactor.compact('t')).collapsed;
    }
    expect(collapsed).toBeGreaterThan(0);
    expect(await log.count('t')).toBeLessThanOrEqual(60 + 10);
    const stored = await log.read('t');
    const runs = [...new Set(stored.map((s) => s.runId))];
    expect(runs.slice(-3)).toEqual(['r38', 'r39', 'r40']);
    const snapshots = stored.filter((s) => s.event.type === EventType.MESSAGES_SNAPSHOT);
    expect(snapshots).toHaveLength(1);
    expect((snapshots[0].event as unknown as { messages: unknown[] }).messages).toHaveLength(80);
    // a replay still starts with a run start and ends with the last run's terminal event
    expect(stored[0].event.type).toBe(EventType.RUN_STARTED);
    expect(stored.at(-1)?.event.type).toBe(EventType.RUN_FINISHED);
  });

  it('never collapses when the newest snapshot would go with the old runs', async () => {
    const compactor = new LogCompactor(log, { maxRows: 10, keepRuns: 1 });
    await finishedRun('t', 1);
    await finishedRun('t', 2);
    // the last run has no snapshot (it is still going, or was killed)
    await log.append('t', 'r3', ev({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r3' }));
    for (let i = 0; i < 20; i++)
      await log.append('t', 'r3', ev({ type: EventType.CUSTOM, name: 'pi.usage', value: { cost: 0 } }));
    const before = await log.count('t');
    expect((await compactor.compact('t')).collapsed).toBe(0);
    expect(await log.count('t')).toBeGreaterThanOrEqual(before - 20);
    expect(await types('t')).toContain(EventType.MESSAGES_SNAPSHOT);
  });

  it('keeps the toolbar registrations of extensions when the run that holds them is collapsed away', async () => {
    const compactor = new LogCompactor(log, { maxRows: 60, keepRuns: 3 });
    const composer = (event: Record<string, unknown>) =>
      ev({ type: EventType.CUSTOM, name: 'pi.composer', value: event });
    await finishedRun('t', 1);
    await log.append('t', 'r1', composer({ op: 'action', id: 'hello', label: 'Say hello', text: '/hello ' }));
    await log.append('t', 'r1', composer({ op: 'suggestion', id: 'gone', title: 'Old', text: 'x' }));
    await log.append('t', 'r1', composer({ op: 'remove', id: 'gone' }));
    for (let run = 2; run <= 40; run++) {
      await finishedRun('t', run);
      await compactor.compact('t');
    }
    const registrations = foldComposer((await log.read('t')).map((s) => s.event));
    expect([...registrations.keys()]).toEqual(['hello']);
    // it is written again once, not after every collapse
    expect((await log.read('t')).filter((s) => (s.event as { name?: string }).name === 'pi.composer')).toHaveLength(1);
  });

  it('documents its thresholds', async () => {
    expect(COMPACTION).toEqual({ maxRows: 2000, keepRuns: 10 });
  });
});

async function finishedRunInto(target: EventLogRepository, run: number): Promise<void> {
  const saved = log;
  log = target;
  try {
    await finishedRun('t', run);
  } finally {
    log = saved;
  }
}

it.each(['set', 'clear'] as const)('collapse retains the latest preview %s even in an old run', async (op) => {
  const compactor = new LogCompactor(log, { maxRows: 1, keepRuns: 1 });
  await finishedRun('t', 1);
  await log.append(
    't',
    'r1',
    ev({ type: EventType.CUSTOM, name: 'pi.preview', value: { op: 'set', sourceUrl: 'https://old.example' } }),
  );
  const latest = op === 'clear' ? { op } : { op, sourceUrl: 'https://new.example' };
  await log.append('t', 'r1', ev({ type: EventType.CUSTOM, name: 'pi.preview', value: latest }));
  await finishedRun('t', 2);
  await compactor.compact('t');
  const previews = (await log.read('t'))
    .map((row) => row.event as BaseEvent & { name?: string; value?: unknown })
    .filter((event) => event.name === 'pi.preview');
  expect(previews).toHaveLength(1);
  expect(previews[0].value).toEqual(latest);
});
