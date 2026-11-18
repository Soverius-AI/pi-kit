import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Logger } from '@nestjs/common';
import { type BaseEvent, EventType } from '@ag-ui/client';
import { REPLAY_CURSOR_METADATA } from '@pi-kit/protocol';
import { Observable, Subject, firstValueFrom, toArray, tap } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import { ThreadsRepository } from '../db/threads.repository';
import type { PiSessionService } from '../pi/pi-session.service';
import { PiAgentRunner } from './pi-agent-runner';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'pk-runner-resilience-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const database = await DatabaseService.create({ dataDir: dir });
  cleanup.push(() => database.onApplicationShutdown());
  const log = new EventLogRepository(database);
  const threads = new ThreadsRepository(database);
  for (const id of ['t1', 't2']) await threads.insertDraft({ id, cwd: dir, sessionPath: join(dir, `${id}.jsonl`) });
  const leave = vi.fn();
  let publishUi: Parameters<PiSessionService['onUnattachedUiEvent']>[0] | undefined;
  const sessions = {
    has: () => true,
    isStreaming: () => false,
    pendingDialogs: () => [],
    branch: () => ({ entries: [] }),
    leafId: () => null,
    readSession: vi.fn(async (_path: string) => ({ entries: [] })),
    openTree: () => undefined,
    mcpAppLookup: () => undefined,
    abort: vi.fn(async () => undefined),
    onTreeChanged: () => leave,
    onUnattachedUiEvent: (listener: NonNullable<typeof publishUi>) => {
      publishUi = listener;
      return leave;
    },
    onTurnStarted: () => leave,
  };
  const runner = new PiAgentRunner(log, threads, sessions as unknown as PiSessionService);
  await runner.onModuleInit();
  cleanup.push(() => runner.onModuleDestroy());
  const run = (threadId: string, source: Observable<BaseEvent>) =>
    runner.run({
      threadId,
      agent: { run: () => source } as never,
      input: { threadId, runId: `r-${threadId}`, messages: [], tools: [], state: {}, context: [], forwardedProps: {} },
    } as never);
  const event = (threadId: string, type = EventType.RUN_STARTED): BaseEvent =>
    ({ type, threadId, runId: `r-${threadId}` }) as BaseEvent;
  return {
    database,
    log,
    runner,
    sessions,
    leave,
    run,
    event,
    register: () =>
      publishUi?.('t1', { kind: 'composer', registration: { op: 'action', id: 'test', label: 'Test', text: '/test' } }),
  };
}

describe('run failure containment', async () => {
  it('keeps the run alive when replay clients switch threads and replays work completed while detached', async () => {
    const { log, runner, sessions, run, event } = await world();
    const source = new Subject<BaseEvent>();
    const client = run('t1', source).subscribe();
    await vi.waitFor(() => expect(source.observed).toBe(true));
    source.next(event('t1'));
    const replay = runner.connect({ threadId: 't1' }).subscribe();
    await new Promise<void>((resolve) => setImmediate(resolve));
    client.unsubscribe();
    replay.unsubscribe();
    expect(source.observed).toBe(true);
    expect(await runner.isRunning({ threadId: 't1' })).toBe(true);
    expect(sessions.abort).not.toHaveBeenCalled();

    source.next({ type: EventType.CUSTOM, name: 'work-while-detached', value: { done: true } } as BaseEvent);
    source.next(event('t1', EventType.RUN_FINISHED));
    const reconnected = await firstValueFrom(runner.connect({ threadId: 't1' }).pipe(toArray()));
    expect(reconnected).toContainEqual(expect.objectContaining({ name: 'work-while-detached' }));
    expect(reconnected.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
    expect((await log.lastRun('t1'))?.status).toBe('finished');
    expect(sessions.abort).not.toHaveBeenCalled();
  });

  it('logs an accepted stop request separately from replay cancellation', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { runner, sessions, run, event } = await world();
    const source = new Subject<BaseEvent>();
    run('t1', source).subscribe();
    await vi.waitFor(() => expect(source.observed).toBe(true));
    source.next(event('t1'));
    expect(await runner.stop({ threadId: 't1', runId: 'not-the-active-run' })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(await runner.stop({ threadId: 't1', runId: 'r-t1' })).toBe(true);
    expect(sessions.abort).toHaveBeenCalledWith('t1');
    expect(warn).toHaveBeenCalledWith(
      `RUN_STOP ${JSON.stringify({ pid: process.pid, threadId: 't1', runId: 'r-t1', reason: 'stop-request' })}`,
    );
    source.next(event('t1', EventType.RUN_FINISHED));
  });

  it.each(['next', 'error', 'complete', 'terminal'] as const)(
    'contains persistent write failures from %s callbacks while another thread finishes',
    async (trigger) => {
      const { log, runner, sessions, run, event } = await world();
      const broken = new Subject<BaseEvent>();
      const healthy = new Subject<BaseEvent>();
      const brokenResult = firstValueFrom(run('t1', broken).pipe(toArray()));
      const healthyResult = firstValueFrom(run('t2', healthy).pipe(toArray()));
      await vi.waitFor(() => {
        expect(broken.observed).toBe(true);
        expect(healthy.observed).toBe(true);
      });
      broken.next(event('t1'));
      healthy.next(event('t2'));
      const follower = firstValueFrom(runner.connect({ threadId: 't1' } as never).pipe(toArray()));
      await vi.waitFor(async () => expect(await log.count('t1')).toBe(1));
      const append = log.append.bind(log);
      const appendMany = log.appendMany.bind(log);
      vi.spyOn(log, 'append').mockImplementation((thread, ...args) => {
        if (thread === 't1') throw new Error('simulated event storage failure');
        return append(thread, ...args);
      });
      vi.spyOn(log, 'appendMany').mockImplementation((thread, ...args) => {
        if (thread === 't1') throw new Error('simulated event storage failure');
        return appendMany(thread, ...args);
      });
      if (trigger === 'next') broken.next({ type: EventType.CUSTOM, name: 'test', value: {} } as BaseEvent);
      else if (trigger === 'error') broken.error(new Error('upstream failed'));
      else if (trigger === 'complete') broken.complete();
      else broken.next(event('t1', EventType.RUN_FINISHED));
      healthy.next(event('t2', EventType.RUN_FINISHED));
      const [failed, followed, finished] = await Promise.all([brokenResult, follower, healthyResult]);
      expect(failed.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'EVENT_LOG_ERROR' });
      expect(followed.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'EVENT_LOG_ERROR' });
      expect(failed.at(-1)?.metadata).toBeUndefined();
      expect(finished.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
      expect((await log.lastRun('t1'))?.status).toBe('error');
      expect((await log.lastRun('t2'))?.status).toBe('finished');
      expect(await runner.isRunning({ threadId: 't1' } as never)).toBe(false);
      expect(broken.observed).toBe(false);
      expect(sessions.abort).toHaveBeenCalledWith('t1');
      // RxJS defers unhandled observer errors to a timer; let that timer run before declaring success.
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  );

  it('unsubscribes even when storage fails during synchronous subscription', async () => {
    const { log, run, event } = await world();
    const stopped = vi.fn();
    vi.spyOn(log, 'append').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const result = await firstValueFrom(
      run(
        't1',
        new Observable((subscriber) => {
          subscriber.next(event('t1'));
          return stopped;
        }),
      ).pipe(toArray()),
    );
    expect(result.at(-1)).toMatchObject({ code: 'EVENT_LOG_ERROR' });
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('disconnects producers during module teardown before storage closes', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { database, log, runner, leave, run, event } = await world();
    const source = new Subject<BaseEvent>();
    const result = firstValueFrom(run('t1', source).pipe(toArray()));
    await vi.waitFor(() => expect(source.observed).toBe(true));
    source.next(event('t1'));
    const append = vi.spyOn(log, 'append');
    await runner.onModuleDestroy();
    expect(warn).toHaveBeenCalledWith(
      `RUN_SHUTDOWN ${JSON.stringify({ pid: process.pid, runs: [{ threadId: 't1', runId: 'r-t1' }] })}`,
    );
    expect(database.db.open).toBe(true);
    expect(source.observed).toBe(false);
    expect(leave).toHaveBeenCalledTimes(3);
    expect((await log.lastRun('t1'))?.status).toBe('aborted');
    append.mockClear();
    await database.onApplicationShutdown();
    source.next(event('t1', EventType.RUN_FINISHED));
    expect(append).not.toHaveBeenCalled();
    expect(() => run('t2', source)).toThrow('shutting down');
    expect((await result).at(-1)).toMatchObject({ code: 'aborted' });
  });

  it('cancels delayed toolbar writes during shutdown', async () => {
    const { database, log, runner, register } = await world();
    register();
    const append = vi.spyOn(log, 'append');
    await runner.onModuleDestroy();
    await database.onApplicationShutdown();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(append).not.toHaveBeenCalled();
  });
});

/** The producer is deliberately faster than SQLite: publication must follow commits, not next(). */
it('serializes delayed event writes and never publishes an uncommitted event, including the final snapshot', async () => {
  const { log, run, event } = await world();
  const append = log.append.bind(log);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writing = 0;
  let peak = 0;
  const committed: string[] = [];
  vi.spyOn(log, 'append').mockImplementation(async (thread, runId, value) => {
    peak = Math.max(peak, ++writing);
    if (value.type === EventType.RUN_STARTED) await gate;
    try {
      const seq = await append(thread, runId, value);
      committed.push(value.type);
      return seq;
    } finally {
      writing--;
    }
  });
  const appendMany = log.appendMany.bind(log);
  vi.spyOn(log, 'appendMany').mockImplementation(async (thread, runId, values) => {
    peak = Math.max(peak, ++writing);
    try {
      const seqs = await appendMany(thread, runId, values);
      committed.push(...values.map((value) => value.type));
      return seqs;
    } finally {
      writing--;
    }
  });
  const delivered: BaseEvent[] = [];
  const done = firstValueFrom(
    run(
      't1',
      new Observable((subscriber) => {
        subscriber.next(event('t1'));
        subscriber.next({ type: EventType.CUSTOM, name: 'ordered', value: {} } as BaseEvent);
        subscriber.next(event('t1', EventType.RUN_FINISHED));
        subscriber.complete();
      }),
    ).pipe(
      tap((value) => {
        expect(committed).toContain(value.type);
        delivered.push(value);
      }),
      toArray(),
    ),
  );
  await vi.waitFor(() => expect(writing).toBe(1));
  expect(await log.count('t1')).toBe(0);
  expect(delivered).toEqual([]);
  release();
  const events = await done;
  expect(peak).toBe(1);
  expect(events.map((value) => value.type)).toEqual(committed);
  expect(events.map((value) => value.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.CUSTOM,
    EventType.MESSAGES_SNAPSHOT,
    EventType.RUN_FINISHED,
  ]);
  expect((await log.lastRun('t1'))?.status).toBe('finished');
});

it('writes a synchronous burst as one batch and finishes the run', async () => {
  const { log, run, event, sessions } = await world();
  const batches: number[] = [];
  const appendMany = log.appendMany.bind(log);
  vi.spyOn(log, 'appendMany').mockImplementation((thread, runId, values) => {
    batches.push(values.length);
    return appendMany(thread, runId, values);
  });
  const result = await firstValueFrom(
    run(
      't1',
      new Observable((subscriber) => {
        subscriber.next(event('t1'));
        for (let i = 0; i < 2000; i++)
          subscriber.next({ type: EventType.CUSTOM, name: 'burst', value: i } as BaseEvent);
        subscriber.next(event('t1', EventType.RUN_FINISHED));
        subscriber.complete();
      }),
    ).pipe(toArray()),
  );
  expect(result.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  expect(batches).toEqual([2000]);
  const stored = await log.read('t1');
  expect(stored.map((row) => row.event.type)).toEqual(result.map((value) => value.type));
  expect(
    stored
      .filter((row) => (row.event as { name?: string }).name === 'burst')
      .map((row) => (row.event as { value?: number }).value),
  ).toEqual(Array.from({ length: 2000 }, (_, i) => i));
  expect((await log.lastRun('t1'))?.status).toBe('finished');
  expect(sessions.abort).not.toHaveBeenCalled();
});

it('keeps a producer that outruns a slow log alive and delivers the overflow in order once it is written', async () => {
  const { log, run, event, sessions } = await world();
  const batches: number[] = [];
  const appendMany = log.appendMany.bind(log);
  vi.spyOn(log, 'appendMany').mockImplementation(async (thread, runId, values) => {
    batches.push(values.length);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return appendMany(thread, runId, values);
  });
  const total = 5000;
  const result = await firstValueFrom(
    run(
      't1',
      new Observable<BaseEvent>((subscriber) => {
        subscriber.next(event('t1'));
        let sent = 0;
        const timer = setInterval(() => {
          for (let n = 0; n < 250 && sent < total; n++, sent++)
            subscriber.next({ type: EventType.CUSTOM, name: 'burst', value: sent } as BaseEvent);
          if (sent < total) return;
          clearInterval(timer);
          subscriber.next(event('t1', EventType.RUN_FINISHED));
          subscriber.complete();
        }, 1);
        return () => clearInterval(timer);
      }),
    ).pipe(toArray()),
  );
  expect(result.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  expect(sessions.abort).not.toHaveBeenCalled();
  expect(batches.reduce((sum, size) => sum + size, 0)).toBe(total);
  expect(batches.length).toBeLessThan(total / 10);
  expect(Math.max(...batches)).toBeGreaterThan(256);
  const burst = result.filter((value) => (value as { name?: string }).name === 'burst');
  expect(burst.map((value) => (value as { value?: number }).value)).toEqual(Array.from({ length: total }, (_, i) => i));
  const stored = await log.read('t1');
  expect(result.map((value) => value.metadata?.[REPLAY_CURSOR_METADATA])).toEqual(
    stored.map((row) => log.cursor('t1', row.seq)),
  );
  expect((await log.lastRun('t1'))?.status).toBe('finished');
});

it('shutdown waits for accepted writes before releasing the run lock', async () => {
  const { log, runner, run, event } = await world();
  const source = new Subject<BaseEvent>();
  const appendMany = log.appendMany.bind(log);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = false;
  vi.spyOn(log, 'appendMany').mockImplementation(async (...args) => {
    blocked = true;
    await gate;
    return appendMany(...args);
  });
  const result = firstValueFrom(run('t1', source).pipe(toArray()));
  await vi.waitFor(() => expect(source.observed).toBe(true));
  source.next(event('t1'));
  source.next({ type: EventType.CUSTOM, name: 'accepted', value: {} } as BaseEvent);
  await vi.waitFor(() => expect(blocked).toBe(true));
  let closed = false;
  const shutdown = runner.onModuleDestroy().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(closed).toBe(false);
  expect((await log.lastRun('t1'))?.status).toBe('running');
  release();
  await shutdown;
  const events = await result;
  expect(events.some((value) => (value as { name?: string }).name === 'accepted')).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'aborted' });
  expect((await log.lastRun('t1'))?.status).toBe('aborted');
});

it('attaches a run reserved during an idle replay read before allowing its first publication', async () => {
  const { log, runner, run, event } = await world();
  await log.append('t1', null, { type: EventType.CUSTOM, name: 'old', value: {} } as BaseEvent);
  const read = log.read.bind(log);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let blocked = false;
  vi.spyOn(log, 'read').mockImplementation(async (threadId) => {
    const rows = await read(threadId);
    if (++reads === 2) {
      blocked = true;
      await gate;
    }
    return rows;
  });
  const replay = firstValueFrom(runner.connect({ threadId: 't1' }).pipe(toArray()));
  await vi.waitFor(() => expect(blocked).toBe(true));
  let began = false;
  const running = firstValueFrom(
    run(
      't1',
      new Observable((subscriber) => {
        began = true;
        subscriber.next(event('t1'));
        subscriber.next({ type: EventType.CUSTOM, name: 'new', value: {} } as BaseEvent);
        subscriber.next(event('t1', EventType.RUN_FINISHED));
        subscriber.complete();
      }),
    ).pipe(toArray()),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(began).toBe(false);
  release();
  await running;
  const events = await replay;
  expect(events.filter((value) => (value as { name?: string }).name === 'new')).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
});

it('abandons a stale filesystem reconciliation when a run reserves the thread during the read', async () => {
  const { database, log, runner, sessions, run, event } = await world();
  writeFileSync(join(dirname(database.path), 't1.jsonl'), '{}\n');
  await log.append('t1', null, { type: EventType.CUSTOM, name: 'keep', value: {} } as BaseEvent);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading = false;
  sessions.readSession.mockImplementation(async () => {
    reading = true;
    await gate;
    return { entries: [] };
  });
  const clear = vi.spyOn(log, 'clear');
  const replay = firstValueFrom(runner.connect({ threadId: 't1' }).pipe(toArray()));
  await vi.waitFor(() => expect(reading).toBe(true));
  let began = false;
  const running = firstValueFrom(
    run(
      't1',
      new Observable((subscriber) => {
        began = true;
        subscriber.next(event('t1'));
        subscriber.next(event('t1', EventType.RUN_FINISHED));
        subscriber.complete();
      }),
    ).pipe(toArray()),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(began).toBe(false);
  release();
  await Promise.all([running, replay]);
  expect(clear).not.toHaveBeenCalled();
  expect((await log.read('t1')).some((row) => (row.event as { name?: string }).name === 'keep')).toBe(true);
});

it('keeps admission behind an in-flight branch compaction without blocking another thread', async () => {
  const { log, runner, run, event } = await world();
  const lastSnapshot = log.lastSnapshotSeq.bind(log);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = false;
  vi.spyOn(log, 'lastSnapshotSeq').mockImplementation(async (...args) => {
    if (args[0] === 't1' && !blocked) {
      blocked = true;
      await gate;
    }
    return lastSnapshot(...args);
  });
  const maintenance = runner.publishBranch('t1');
  await vi.waitFor(() => expect(blocked).toBe(true));
  const source = (thread: string, onBegin: () => void) =>
    new Observable<BaseEvent>((subscriber) => {
      onBegin();
      subscriber.next(event(thread));
      subscriber.next(event(thread, EventType.RUN_FINISHED));
      subscriber.complete();
    });
  let began = false;
  const waiting = firstValueFrom(
    run(
      't1',
      source('t1', () => {
        began = true;
      }),
    ).pipe(toArray()),
  );
  const independent = await firstValueFrom(
    run(
      't2',
      source('t2', () => undefined),
    ).pipe(toArray()),
  );
  expect(independent.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  expect(began).toBe(false);
  release();
  await Promise.all([maintenance, waiting]);
  expect((await log.lastRun('t1'))?.status).toBe('finished');
});

it('stages toolbar registrations while the committed RUN_STARTED is still pending ahead of a terminal burst', async () => {
  const { log, runner, register, run, event } = await world();
  const append = log.append.bind(log);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = false;
  vi.spyOn(log, 'append').mockImplementation(async (...args) => {
    if (args[2].type === EventType.RUN_STARTED) {
      blocked = true;
      await gate;
    }
    return append(...args);
  });
  const done = firstValueFrom(
    run(
      't1',
      new Observable((subscriber) => {
        subscriber.next(event('t1'));
        subscriber.next(event('t1', EventType.RUN_FINISHED));
        subscriber.complete();
      }),
    ).pipe(toArray()),
  );
  await vi.waitFor(() => expect(blocked).toBe(true));
  register();
  // connect flushes synchronously registered toolbar batches before it attempts replay.
  const connected = firstValueFrom(runner.connect({ threadId: 't1' }).pipe(toArray()));
  await new Promise((resolve) => setTimeout(resolve, 40));
  release();
  const events = await done;
  await connected;
  expect(events.slice(0, 2)).toMatchObject([
    { type: EventType.RUN_STARTED },
    { type: EventType.CUSTOM, name: 'pi.composer', value: { id: 'test' } },
  ]);
});
