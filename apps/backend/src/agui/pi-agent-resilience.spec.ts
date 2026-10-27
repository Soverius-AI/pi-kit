import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BaseEvent, EventType } from '@ag-ui/client';
import { Observable, Subject, firstValueFrom, toArray } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import { ThreadsRepository } from '../db/threads.repository';
import type { PiSessionService } from '../pi/pi-session.service';
import { PiAgentRunner } from './pi-agent-runner';

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach((close) => close()); });

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'pk-runner-resilience-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const database = new DatabaseService({ dataDir: dir });
  cleanup.push(() => database.onApplicationShutdown());
  const log = new EventLogRepository(database);
  const threads = new ThreadsRepository(database);
  for (const id of ['t1', 't2']) threads.insertDraft({ id, cwd: dir, sessionPath: join(dir, `${id}.jsonl`) });
  const leave = vi.fn();
  let publishUi: Parameters<PiSessionService['onUnattachedUiEvent']>[0] | undefined;
  const sessions = {
    has: () => true, isStreaming: () => false, pendingDialogs: () => [],
    branch: () => ({ entries: [] }), openTree: () => undefined, mcpAppLookup: () => undefined,
    abort: vi.fn(async () => undefined),
    onTreeChanged: () => leave,
    onUnattachedUiEvent: (listener: NonNullable<typeof publishUi>) => { publishUi = listener; return leave; },
    onTurnStarted: () => leave,
  };
  const runner = new PiAgentRunner(log, threads, sessions as unknown as PiSessionService);
  runner.onModuleInit();
  cleanup.push(() => runner.onModuleDestroy());
  const run = (threadId: string, source: Observable<BaseEvent>) => runner.run({
    threadId, agent: { run: () => source } as never,
    input: { threadId, runId: `r-${threadId}`, messages: [], tools: [], state: {}, context: [], forwardedProps: {} },
  } as never);
  const event = (threadId: string, type = EventType.RUN_STARTED): BaseEvent => ({ type, threadId, runId: `r-${threadId}` } as BaseEvent);
  return { database, log, runner, sessions, leave, run, event,
    register: () => publishUi?.('t1', { kind: 'composer', registration: { op: 'action', id: 'test', label: 'Test', text: '/test' } }),
  };
}

describe('run failure containment', () => {
  it.each(['next', 'error', 'complete', 'terminal'] as const)('contains persistent write failures from %s callbacks while another thread finishes', async (trigger) => {
    const { log, runner, sessions, run, event } = world();
    const broken = new Subject<BaseEvent>();
    const healthy = new Subject<BaseEvent>();
    const brokenResult = firstValueFrom(run('t1', broken).pipe(toArray()));
    const healthyResult = firstValueFrom(run('t2', healthy).pipe(toArray()));
    broken.next(event('t1'));
    healthy.next(event('t2'));
    const follower = firstValueFrom(runner.connect({ threadId: 't1' } as never).pipe(toArray()));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const append = log.append.bind(log);
    vi.spyOn(log, 'append').mockImplementation((thread, ...args) => {
      if (thread === 't1') throw new Error('simulated event storage failure');
      return append(thread, ...args);
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
    expect(log.lastRun('t1')?.status).toBe('error');
    expect(log.lastRun('t2')?.status).toBe('finished');
    expect(await runner.isRunning({ threadId: 't1' } as never)).toBe(false);
    expect(broken.observed).toBe(false);
    expect(sessions.abort).toHaveBeenCalledWith('t1');
    // RxJS defers unhandled observer errors to a timer; let that timer run before declaring success.
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('unsubscribes even when storage fails during synchronous subscription', async () => {
    const { log, run, event } = world();
    const stopped = vi.fn();
    vi.spyOn(log, 'append').mockImplementation(() => { throw new Error('storage unavailable'); });
    const result = await firstValueFrom(run('t1', new Observable((subscriber) => {
      subscriber.next(event('t1'));
      return stopped;
    })).pipe(toArray()));
    expect(result.at(-1)).toMatchObject({ code: 'EVENT_LOG_ERROR' });
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('disconnects producers during module teardown before storage closes', async () => {
    const { database, log, runner, leave, run, event } = world();
    const source = new Subject<BaseEvent>();
    const result = firstValueFrom(run('t1', source).pipe(toArray()));
    source.next(event('t1'));
    const append = vi.spyOn(log, 'append');
    runner.onModuleDestroy();
    expect(database.db.open).toBe(true);
    expect(source.observed).toBe(false);
    expect(leave).toHaveBeenCalledTimes(3);
    database.onApplicationShutdown();
    source.next(event('t1', EventType.RUN_FINISHED));
    expect(append).not.toHaveBeenCalled();
    expect(() => run('t2', source)).toThrow('shutting down');
    expect((await result).map((entry) => entry.type)).toEqual([EventType.RUN_STARTED]);
  });

  it('cancels delayed toolbar writes during shutdown', async () => {
    const { database, log, runner, register } = world();
    register();
    const append = vi.spyOn(log, 'append');
    runner.onModuleDestroy();
    database.onApplicationShutdown();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(append).not.toHaveBeenCalled();
  });
});
