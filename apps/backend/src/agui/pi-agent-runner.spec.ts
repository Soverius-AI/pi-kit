import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { type BaseEvent, EventType } from '@ag-ui/client';
import { Observable, Subject, firstValueFrom, of, toArray } from 'rxjs';
import { createMapContext, interruptFinished, type PendingDialog, type PiSessionEntry, type PiUiEvent } from '@pi-kit/pi-adapter';
import { type ComposerRegistration, THREAD_HYDRATION_HEADER } from '@pi-kit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import { ThreadsRepository } from '../db/threads.repository';
import type { PiSessionService } from '../pi/pi-session.service';
import { type DialogAnswer, UiBridge } from '../pi/ui-bridge';
import { sessionMtime } from '../threads/session-files';
import { composerChanges } from './composer-log';
import { PiAgent } from './pi-agent';
import { PiAgentRunner } from './pi-agent-runner';

const entries: PiSessionEntry[] = [
  { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'one' } },
  { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  { type: 'message', id: 'u2', parentId: 'a1', message: { role: 'user', content: 'two' } },
  { type: 'message', id: 'a2', parentId: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'ok two' }] } },
  { type: 'message', id: 'u2b', parentId: 'a1', message: { role: 'user', content: 'two, edited' } },
];

/** A stand-in for the open pi session: its branch is the path to `leaf`, its tree is all of `entries`. */
class FakeSessions {
  leaf: string | null = 'a1';
  streaming = false;
  dialogs: PendingDialog[] = [];
  has() { return true; }
  isStreaming() { return this.streaming; }
  readSession = vi.fn(async (_path: string) => ({ entries: this.branch().entries }));
  private listener: ((threadId: string) => void) | undefined;
  onTreeChanged(listener: (threadId: string) => void): () => void {
    this.listener = listener;
    return () => undefined;
  }
  onTurnStarted(_listener: (threadId: string) => void): () => void {
    return () => undefined;
  }
  private unattached: ((threadId: string, event: PiUiEvent) => void) | undefined;
  onUnattachedUiEvent(listener: (threadId: string, event: PiUiEvent) => void): () => void {
    this.unattached = listener;
    return () => undefined;
  }
  register(registration: ComposerRegistration): void {
    this.unattached?.('t1', { kind: 'composer', registration });
  }
  moveTo(leaf: string): void {
    this.leaf = leaf;
    this.listener?.('t1');
  }
  branch() {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const path: PiSessionEntry[] = [];
    for (let e = this.leaf ? byId.get(this.leaf) : undefined; e; e = e.parentId ? byId.get(e.parentId) : undefined) path.unshift(e);
    return { entries: path, path: undefined };
  }
  leafId() {
    return this.leaf;
  }
  openTree() {
    return { entries, leafId: this.leaf };
  }
  pendingDialogs() {
    return this.dialogs;
  }
  mcpAppLookup() {
    return undefined;
  }
}

describe('PiAgentRunner.publishBranch (a leaf change outside a run)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-runner-'));
  const database = new DatabaseService({ dataDir: dir });
  const log = new EventLogRepository(database);
  const threads = new ThreadsRepository(database);
  const sessions = new FakeSessions();
  const sessionFile = join(dir, 'session.jsonl');
  writeFileSync(sessionFile, '{}\n');
  threads.insertDraft({ id: 't1', sessionPath: sessionFile, cwd: dir });
  const runner = new PiAgentRunner(log, threads, sessions as unknown as PiSessionService);
  runner.onModuleInit();

  afterEach(() => undefined);

  it('writes a run with a snapshot of the new branch and a pi.tree signal into the replay log', () => {
    sessions.moveTo('a2');
    const events = log.read('t1').map((s) => s.event);
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.MESSAGES_SNAPSHOT, EventType.CUSTOM, EventType.RUN_FINISHED]);
    const snapshot = events[1] as unknown as { messages: { id: string; role: string }[] };
    expect(snapshot.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(events[2]).toMatchObject({ name: 'pi.tree', value: { leafId: 'a2', changed: ['a2'] } });
    // It is not a run: nothing holds the thread's lock.
    expect(log.lastRun('t1')).toBeUndefined();
  });

  it('replaces the earlier snapshot when the leaf moves again, so the log does not pile up snapshots', () => {
    sessions.moveTo('a1');
    const snapshots = log.read('t1').filter((s) => s.event.type === EventType.MESSAGES_SNAPSHOT);
    expect(snapshots).toHaveLength(1);
    expect((snapshots[0].event as unknown as { messages: { id: string }[] }).messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('records the leaf, the fork count and a valid log in the thread row', () => {
    sessions.moveTo('a2');
    const row = threads.get('t1');
    expect(row).toMatchObject({ leafId: 'a2', forkCount: 1 });
    expect(row?.leafMtime).not.toBeNull();
    expect(row?.logMtime).toBe(row?.leafMtime);
  });
});

describe('PiAgentRunner.publishUiEvent (toolbar registrations outside a run)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-runner-composer-'));
  const database = new DatabaseService({ dataDir: dir });
  const log = new EventLogRepository(database);
  const threads = new ThreadsRepository(database);
  const sessions = new FakeSessions();
  const sessionFile = join(dir, 'session.jsonl');
  writeFileSync(sessionFile, '{}\n');
  threads.insertDraft({ id: 't1', sessionPath: sessionFile, cwd: dir });
  const runner = new PiAgentRunner(log, threads, sessions as unknown as PiSessionService);
  runner.onModuleInit();

  const hello: ComposerRegistration = { op: 'action', id: 'hello', label: 'Say hello', text: '/hello ' };

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

  it('writes registrations that arrive together into one small run of their own, as pi.composer custom events', async () => {
    sessions.register(hello);
    sessions.register({ op: 'suggestion', id: 'ask', title: 'Ask', text: 'apple' });
    expect(log.read('t1')).toHaveLength(0);
    await tick();
    const events = log.read('t1').map((s) => s.event);
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.CUSTOM, EventType.CUSTOM, EventType.RUN_FINISHED]);
    expect(events[1]).toMatchObject({ name: 'pi.composer', value: hello });
    expect(events[2]).toMatchObject({ name: 'pi.composer', value: { id: 'ask' } });
    expect(log.lastRun('t1')).toBeUndefined();
  });

  it('does not write the same registration again, but writes a changed one and a removal', async () => {
    sessions.register(hello);
    await tick();
    expect(log.read('t1')).toHaveLength(4);
    sessions.register({ ...hello, label: 'Greet' });
    await tick();
    expect(log.read('t1')).toHaveLength(7);
    sessions.register({ op: 'remove', id: 'hello' });
    sessions.register({ op: 'remove', id: 'hello' });
    await tick();
    expect(log.read('t1')).toHaveLength(10);
    expect([...runner.composerState('t1').keys()]).toEqual(['ask']);
  });
});

describe('PiAgentRunner.followTurn (a turn pi started by itself)', () => {
  /** An open session whose events a test emits by hand; `startTurn` is what pi does when an extension starts a turn in an idle thread. */
  class TurnSessions extends FakeSessions {
    private turnStarted: ((threadId: string) => void) | undefined;
    private listeners: ((event: unknown) => void)[] = [];
    private settle: (() => void) | undefined;
    prompting: Promise<void> | undefined;
    override onTurnStarted(listener: (threadId: string) => void): () => void {
      this.turnStarted = listener;
      return () => undefined;
    }
    subscribe(_threadId: string, listener: (event: unknown) => void): () => void {
      this.listeners.push(listener);
      return () => undefined;
    }
    onUiEvent() { return () => undefined; }
    onDialogRequested() { return () => undefined; }
    markDialogsReported() { return undefined; }
    takeAbortedWhileWaiting() { return false; }
    whenPromptDone() { return this.prompting; }
    stats() { return { model: { provider: 'p', id: 'm', name: 'm' }, thinkingLevel: 'off' }; }
    startTurn(): void {
      this.prompting = new Promise<void>((resolve) => (this.settle = resolve));
      this.streaming = true;
      this.turnStarted?.('t1');
    }
    emit(event: Record<string, unknown>): void {
      for (const listener of [...this.listeners]) listener(event);
      if (event['type'] === 'agent_settled') {
        this.streaming = false;
        this.settle?.();
        this.prompting = undefined;
      }
    }
  }

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'pk-runner-turn-'));
    const database = new DatabaseService({ dataDir: dir });
    const log = new EventLogRepository(database);
    const threads = new ThreadsRepository(database);
    const sessionFile = join(dir, 'session.jsonl');
    writeFileSync(sessionFile, '{}\n');
    threads.insertDraft({ id: 't1', sessionPath: sessionFile, cwd: dir });
    const sessions = new TurnSessions();
    const runner = new PiAgentRunner(log, threads, sessions as unknown as PiSessionService);
    runner.onModuleInit();
    const agent = new PiAgent(sessions as unknown as PiSessionService, { defaultCwd: dir, threads: {} as never, carry: new Map(), relayMcp: async () => undefined });
    runner.useAgent(() => agent.clone());
    return { database, log, sessions, runner };
  }
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

  it('opens a run of its own that streams the turn live, is replayed by connect() and releases the lock when pi settles', async () => {
    const { database, log, sessions, runner } = setup();
    try {
      sessions.startTurn();
      await flush();
      expect(log.lastRun('t1')).toMatchObject({ status: 'running' });
      expect(await runner.isRunning({ threadId: 't1' } as never)).toBe(true);
      const live = firstValueFrom(runner.connect({ threadId: 't1', agent: {} as never, headers: {} } as never).pipe(toArray()));
      await flush(); // connect() is attached to the run; what follows streams to it (the stored deltas are compacted at the end).
      sessions.emit({ type: 'message_end', message: { role: 'user', content: 'From the extension' } });
      sessions.emit({ type: 'message_start', message: { role: 'assistant', provider: 'p', model: 'm' } });
      sessions.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
      sessions.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' } });
      sessions.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello' } });
      sessions.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Hello' }] } });
      sessions.emit({ type: 'agent_settled', aborted: false });
      await flush();
      const events = await live;
      const runs = log.read('t1').map((row) => row.runId);
      expect(new Set(runs).size).toBe(1);
      expect(runs[0]).toMatch(/^turn-/);
      expect(events.map((e) => e.type)).toEqual(expect.arrayContaining([EventType.RUN_STARTED, EventType.TEXT_MESSAGE_CONTENT, EventType.RUN_FINISHED]));
      // The placed message streams as the run's first message; the client has nothing of it beforehand.
      expect(events.filter((e) => e.type === EventType.TEXT_MESSAGE_START).map((e) => (e as unknown as { role: string }).role)).toEqual(['user', 'assistant']);
      expect(log.lastRun('t1')).toMatchObject({ status: 'finished' });
      expect(await runner.isRunning({ threadId: 't1' } as never)).toBe(false);
    } finally { database.onApplicationShutdown(); }
  });

  it('follows a turn that starts while the previous run is still ending, once that run is over', async () => {
    const { database, log, sessions, runner } = setup();
    try {
      // Run r1 is ending (its agent has not sent the terminal yet) when pi starts the next turn by itself.
      let finishR1: () => void = () => undefined;
      const agent = { run: () => new Observable<BaseEvent>((subscriber) => {
        subscriber.next({ type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' } as BaseEvent);
        finishR1 = () => { subscriber.next({ type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1', outcome: { type: 'success' } } as BaseEvent); subscriber.complete(); };
      }) };
      runner.run({ threadId: 't1', agent: agent as never, input: { threadId: 't1', runId: 'r1', messages: [], tools: [], state: {}, context: [] } } as never).subscribe({ error: () => undefined });
      sessions.startTurn();
      await flush();
      expect(new Set(log.read('t1').map((row) => row.runId))).toEqual(new Set(['r1']));
      finishR1();
      await flush();
      // pi is still in the turn: it gets a run of its own, which streams it and ends when pi settles.
      expect(log.lastRun('t1')).toMatchObject({ status: 'running' });
      sessions.emit({ type: 'message_start', message: { role: 'assistant', provider: 'p', model: 'm' } });
      sessions.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Forwarded to you.' }] } });
      sessions.emit({ type: 'agent_settled', aborted: false });
      await flush();
      const runs = [...new Set(log.read('t1').map((row) => row.runId))];
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatch(/^turn-/);
      expect(log.lastRun('t1')).toMatchObject({ status: 'finished' });
    } finally { database.onApplicationShutdown(); }
  });

  it('does not follow afterwards a turn the run itself carried to the end', async () => {
    const { database, log, sessions, runner } = setup();
    try {
      let finishR1: () => void = () => undefined;
      const agent = { run: () => new Observable<BaseEvent>((subscriber) => {
        subscriber.next({ type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' } as BaseEvent);
        finishR1 = () => { subscriber.next({ type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1', outcome: { type: 'success' } } as BaseEvent); subscriber.complete(); };
      }) };
      runner.run({ threadId: 't1', agent: agent as never, input: { threadId: 't1', runId: 'r1', messages: [], tools: [], state: {}, context: [] } } as never).subscribe({ error: () => undefined });
      sessions.startTurn();
      sessions.emit({ type: 'agent_settled', aborted: false });
      finishR1();
      await flush();
      expect([...new Set(log.read('t1').map((row) => row.runId))]).toEqual(['r1']);
    } finally { database.onApplicationShutdown(); }
  });

  it('leaves a thread alone while one of its own runs is going', async () => {
    const { database, log, sessions, runner } = setup();
    try {
      const agent = { run: () => new Observable<BaseEvent>((subscriber) => { subscriber.next({ type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' } as BaseEvent); }) };
      runner.run({ threadId: 't1', agent: agent as never, input: { threadId: 't1', runId: 'r1', messages: [], tools: [], state: {}, context: [] } } as never);
      sessions.startTurn();
      await flush();
      expect(log.read('t1').map((row) => row.runId)).toEqual(['r1']);
    } finally { database.onApplicationShutdown(); }
  });
});

describe('PiAgentRunner event order with asynchronous middleware', () => {
  it('holds extension registrations until RUN_STARTED reaches the runner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-runner-order-'));
    const database = new DatabaseService({ dataDir: dir });
    const log = new EventLogRepository(database);
    const threads = new ThreadsRepository(database);
    const sessions = new FakeSessions();
    threads.insertDraft({ id: 't1', sessionPath: join(dir, 'missing.jsonl'), cwd: dir });
    const runner = new PiAgentRunner(log, threads, sessions as unknown as PiSessionService);
    runner.onModuleInit();
    try {
      const agent = { run: () => new Observable<BaseEvent>((subscriber) => {
        sessions.register({ op: 'action', id: 'early', label: 'Early', text: '/early' });
        const timer = setTimeout(() => {
          subscriber.next({ type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' } as BaseEvent);
          subscriber.next({ type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' } as BaseEvent);
          subscriber.complete();
        }, 100);
        return () => clearTimeout(timer);
      }) };
      const events = await firstValueFrom(runner.run({ threadId: 't1', agent: agent as never, input: { threadId: 't1', runId: 'r1', messages: [], tools: [], state: {}, context: [] } } as never).pipe(toArray()));
      expect(events[0]).toMatchObject({ type: EventType.RUN_STARTED });
      expect(events[1]).toMatchObject({ type: EventType.CUSTOM, name: 'pi.composer', value: { id: 'early' } });
      expect(log.read('t1')[0].event.type).toBe(EventType.RUN_STARTED);
    } finally { database.onApplicationShutdown(); }
  });
});

describe('PiAgentRunner replay compaction', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'pk-runner-replay-'));
    const database = new DatabaseService({ dataDir: dir });
    const log = new EventLogRepository(database);
    const threads = new ThreadsRepository(database);
    const sessionFile = join(dir, 'session.jsonl');
    writeFileSync(sessionFile, '{}\n');
    threads.insertDraft({ id: 't1', sessionPath: sessionFile, cwd: dir });
    const sessions = new FakeSessions();
    const runner = new PiAgentRunner(log, threads, sessions as unknown as PiSessionService);
    const input = { threadId: 't1', runId: 'r1', messages: [], tools: [], state: {}, context: [] };
    const events = [
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
      { type: EventType.TOOL_CALL_START, toolCallId: 'c1', toolCallName: 'write', parentMessageId: 'a1' },
      ...Array.from({ length: 3000 }, () => ({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: 'x' })),
      { type: EventType.TOOL_CALL_END, toolCallId: 'c1' },
      { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' },
    ] as BaseEvent[];
    return { database, log, threads, runner, input, events, sessionFile, sessions };
  }

  it('compacts argument chunks when a real run finishes and delivers its snapshot once', async () => {
    const { database, log, runner, input, events } = setup();
    try {
      const agent = { run: () => of(...events) };
      const live = await firstValueFrom(runner.run({ threadId: 't1', agent: agent as never, input }).pipe(toArray()));
      expect(live.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT)).toHaveLength(1);
      const stored = log.read('t1').map((s) => s.event);
      expect(stored.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT)).toHaveLength(1);
      expect(stored.filter((e) => e.type === EventType.TOOL_CALL_ARGS)).toHaveLength(0);
      expect(stored.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      expect(log.lastRun('t1')?.status).toBe('finished');
    } finally { database.onApplicationShutdown(); rmSync(dirname(database.path), { recursive: true, force: true }); }
  });

  it.each(['dialog', 'streaming'])('keeps a live %s prompt’s question and tool state across reconnects, even with a stale file timestamp', async (owner) => {
    const { database, log, threads, runner, sessionFile, sessions } = setup();
    try {
      sessions.streaming = owner === 'streaming';
      const dialogs: PendingDialog[] = [{ id: 'question', request: { method: 'input', title: 'Where are you seeing the name?', toolCallId: 'ask1' } }];
      sessions.dialogs = owner === 'dialog' ? dialogs : [];
      const events = [
        { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' },
        { type: EventType.TOOL_CALL_START, toolCallId: 'ask1', toolCallName: 'ask_user', parentMessageId: 'a1' },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: 'ask1', delta: '{"question":"Where are you seeing the name?"}' },
        { type: EventType.TOOL_CALL_END, toolCallId: 'ask1' },
        { type: EventType.ACTIVITY_SNAPSHOT, messageId: 'tool:ask1', activityType: 'pi.tool', content: { toolCallId: 'ask1', toolName: 'ask_user', status: 'running', startedAt: Date.now() } },
        interruptFinished('t1', 'r1', dialogs),
      ] as BaseEvent[];
      let lastSeq = 0;
      for (const event of events) lastSeq = log.append('t1', 'r1', event);
      threads.setLogMtime('t1', (sessionMtime(sessionFile) ?? 1) - 1);
      const cursor = log.cursor('t1', lastSeq);
      for (let visit = 0; visit < 2; visit++) {
        const replay = await firstValueFrom(runner.connect({ threadId: 't1' }).pipe(toArray()));
        expect(replay.slice(1)).toMatchObject(events);
        expect(replay.at(-1)).toMatchObject({ outcome: { type: 'interrupt', interrupts: [{ id: 'question' }] } });
        expect(sessions.readSession).not.toHaveBeenCalled();
        expect(log.resolveCursor('t1', cursor)).toBeDefined();
      }
      runner.publishBranch('t1');
      expect(log.read('t1').map((stored) => stored.event)).toEqual(events);
    } finally { database.onApplicationShutdown(); rmSync(dirname(database.path), { recursive: true, force: true }); }
  });

  it('holds toolbar changes while suspended, then delivers them inside the resumed run', async () => {
    const { database, log, runner, input, sessions } = setup();
    try {
      runner.onModuleInit();
      sessions.dialogs = [{ id: 'question', request: { method: 'input', title: 'Continue?' } }];
      const terminal = interruptFinished('t1', 'r1', sessions.dialogs);
      log.append('t1', 'r1', terminal);
      sessions.register({ op: 'action', id: 'later', label: 'Later', text: '/later' });
      const replay = await firstValueFrom(runner.connect({ threadId: 't1' }).pipe(toArray()));
      expect(replay.slice(1)).toMatchObject([terminal]);
      sessions.dialogs = [];
      const runId = 'resume';
      const events = [
        { type: EventType.RUN_STARTED, threadId: 't1', runId },
        { type: EventType.RUN_FINISHED, threadId: 't1', runId },
      ] as BaseEvent[];
      const resumed = await firstValueFrom(runner.run({ threadId: 't1', agent: { run: () => of(...events) } as never, input: { ...input, runId } }).pipe(toArray()));
      expect(resumed.slice(0, 2)).toMatchObject([events[0], { type: EventType.CUSTOM, name: 'pi.composer', value: { id: 'later' } }]);
      expect(log.read('t1').filter((stored) => stored.event.type === EventType.RUN_STARTED).map((stored) => stored.runId)).toEqual([runId]);
    } finally { database.onApplicationShutdown(); rmSync(dirname(database.path), { recursive: true, force: true }); }
  });

  it('rechecks prompt ownership after an asynchronous session read before replacing its event log', async () => {
    const { database, log, threads, runner, sessionFile, sessions } = setup();
    try {
      threads.setLogMtime('t1', (sessionMtime(sessionFile) ?? 1) - 1);
      sessions.readSession.mockImplementationOnce(async () => {
        sessions.streaming = true;
        sessions.dialogs = [{ id: 'question', request: { method: 'input', title: 'Continue?' } }];
        log.append('t1', 'r1', interruptFinished('t1', 'r1', sessions.dialogs));
        return { entries: [] };
      });
      const replay = await firstValueFrom(runner.connect({ threadId: 't1' }).pipe(toArray()));
      expect(replay.at(-1)).toMatchObject({ outcome: { type: 'interrupt' } });
      expect(replay.some((event) => event.type === EventType.MESSAGES_SNAPSHOT)).toBe(false);
    } finally { database.onApplicationShutdown(); rmSync(dirname(database.path), { recursive: true, force: true }); }
  });

  it('records the session checkpoint at an interrupt without replacing its streamed history', async () => {
    const { database, log, threads, runner, input, sessionFile, sessions } = setup();
    try {
      sessions.dialogs = [{ id: 'question', request: { method: 'input', title: 'Continue?' } }];
      const events = [{ type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' }, interruptFinished('t1', 'r1', sessions.dialogs)] as BaseEvent[];
      await firstValueFrom(runner.run({ threadId: 't1', agent: { run: () => of(...events) } as never, input }).pipe(toArray()));
      expect(threads.get('t1')?.logMtime).toBe(sessionMtime(sessionFile));
      expect(log.read('t1').map((stored) => stored.event)).toEqual(expect.arrayContaining([events[1]]));
      expect(log.read('t1').some((stored) => stored.event.type === EventType.MESSAGES_SNAPSHOT)).toBe(false);
    } finally { database.onApplicationShutdown(); rmSync(dirname(database.path), { recursive: true, force: true }); }
  });

  it('repairs an oversized legacy log on connect, including deltas before its previous snapshot', async () => {
    const { database, log, threads, runner, events, sessionFile } = setup();
    try {
      for (const e of events.slice(0, -1)) log.append('t1', 'r1', e);
      // The duplicate snapshot has already been deleted by the old incremental pass; its deltas survived.
      log.append('t1', 'r1', { type: EventType.MESSAGES_SNAPSHOT, messages: [{ id: 'u1', role: 'user', content: 'one' }] } as BaseEvent);
      log.append('t1', 'r1', events[events.length - 1]);
      log.append('t1', 'r2', { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r2' } as BaseEvent);
      log.append('t1', 'r2', { type: EventType.MESSAGES_SNAPSHOT, messages: [{ id: 'u2', role: 'user', content: 'two' }] } as BaseEvent);
      log.append('t1', 'r2', { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r2' } as BaseEvent);
      threads.setLogMtime('t1', sessionMtime(sessionFile));
      const replay = await firstValueFrom(runner.connect({ threadId: 't1' } as never).pipe(toArray()));
      expect(replay.filter((e) => e.type === EventType.TOOL_CALL_ARGS)).toHaveLength(0);
      expect(replay.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT)).toMatchObject([
        { type: EventType.MESSAGES_SNAPSHOT, messages: [{ id: 'u2', role: 'user', content: 'two' }] },
      ]);
      expect(log.count('t1')).toBeLessThan(10);
      expect(replay.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    } finally { database.onApplicationShutdown(); rmSync(dirname(database.path), { recursive: true, force: true }); }
  });

  it('sends only new events for a retained cursor, and no history when nothing changed', async () => {
    const { database, log, threads, runner, sessionFile } = setup();
    try {
      threads.setLogMtime('t1', sessionMtime(sessionFile));
      const first = log.append('t1', 'r1', { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' } as BaseEvent);
      const cursor = log.cursor('t1', first);
      const connect = () => firstValueFrom(runner.connect({ threadId: 't1', headers: { 'x-pi-kit-replay-cursor': cursor } }).pipe(toArray()));
      expect(await connect()).toEqual([{ type: EventType.CUSTOM, name: 'pi.replay', value: { reset: false } }]);
      log.append('t1', 'r1', { type: EventType.TEXT_MESSAGE_START, messageId: 'a1', role: 'assistant' } as BaseEvent);
      const delta = await connect();
      expect(delta.map((e) => e.type)).toEqual([EventType.CUSTOM, EventType.TEXT_MESSAGE_START]);
      expect(delta[1].metadata?.['piKitReplayCursor']).toBe(log.cursor('t1', first + 1));
    } finally { database.onApplicationShutdown(); rmSync(dirname(database.path), { recursive: true, force: true }); }
  });

  it('hydrates a cold client once without changing or compacting its AG-UI log', async () => {
    const { database, log, threads, runner, sessionFile, events } = setup();
    try {
      threads.setLogMtime('t1', sessionMtime(sessionFile));
      for (const event of events) log.append('t1', 'r1', event);
      const before = log.read('t1');
      const response = await firstValueFrom(runner.connect({ threadId: 't1', headers: { 'x-pi-kit-hydrate': '1' } }).pipe(toArray()));
      expect(response.map((e) => e.type)).toEqual(['CUSTOM', 'RUN_STARTED', 'CUSTOM', 'RUN_FINISHED']);
      expect(response[2]).toMatchObject({ name: 'pi.thread.hydrate', value: {
        messages: [{ id: 'a1', toolCalls: [{ id: 'c1', function: { arguments: 'x'.repeat(3000) } }] }],
      } });
      expect(log.read('t1')).toEqual(before);
      const cursor = response[2].metadata?.['piKitReplayCursor'] as string;
      const unchanged = await firstValueFrom(runner.connect({ threadId: 't1', headers: {
        'x-pi-kit-hydrate': '1', 'x-pi-kit-replay-cursor': cursor,
      } }).pipe(toArray()));
      expect(unchanged).toEqual([{ type: EventType.CUSTOM, name: 'pi.replay', value: { reset: false, running: false } }]);
    } finally { database.onApplicationShutdown(); rmSync(dirname(database.path), { recursive: true, force: true }); }
  });

  it('joins the live AG-UI stream exactly after hydration, keeping partial arguments intact', async () => {
    const { database, log, runner, input } = setup();
    const source = new Subject<BaseEvent>();
    const live: BaseEvent[] = [];
    const running = runner.run({ threadId: 't1', input, agent: { run: () => source } as never }).subscribe();
    source.next({ type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' } as BaseEvent);
    source.next({ type: EventType.TOOL_CALL_START, toolCallId: 'c1', parentMessageId: 'a1', toolCallName: 'write' } as BaseEvent);
    source.next({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '{"path":"a"' } as BaseEvent);
    const connection = runner.connect({ threadId: 't1', headers: { 'x-pi-kit-hydrate': '1' } }).subscribe((e) => live.push(e));
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(live[2]).toMatchObject({ name: 'pi.thread.hydrate', value: { messages: [
        { toolCalls: [{ function: { arguments: '{"path":"a"' } }] },
      ] } });
      expect(live.filter((e) => e.type === EventType.TOOL_CALL_ARGS)).toHaveLength(0);
      source.next({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '}' } as BaseEvent);
      expect(live.filter((e) => e.type === EventType.TOOL_CALL_ARGS)).toHaveLength(1);
      expect(live.at(-1)).toMatchObject({ delta: '}' });
      const seq = log.resolveCursor('t1', live[2].metadata?.['piKitReplayCursor'] as string);
      expect(log.readAfter('t1', seq as number).map((e) => e.event)).toEqual([{ type: EventType.TOOL_CALL_ARGS, toolCallId: 'c1', delta: '}' }]);
    } finally {
      connection.unsubscribe();
      source.next({ type: EventType.RUN_FINISHED, threadId: 't1', runId: 'r1' } as BaseEvent);
      running.unsubscribe();
      database.onApplicationShutdown(); rmSync(dirname(database.path), { recursive: true, force: true });
    }
  });

  it('resets a cached transcript if its log was rebuilt or its cursor row was compacted away', async () => {
    const { database, log, threads, runner, sessionFile } = setup();
    try {
      threads.setLogMtime('t1', sessionMtime(sessionFile));
      const event = { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' } as BaseEvent;
      const seq = log.append('t1', 'r1', event);
      const cursor = log.cursor('t1', seq);
      log.clear('t1');
      log.append('t1', 'r1', event); // Same numeric seq, different log generation.
      const replay = await firstValueFrom(runner.connect({ threadId: 't1', headers: { 'x-pi-kit-replay-cursor': cursor } }).pipe(toArray()));
      expect(replay[0]).toMatchObject({ value: { reset: true } });
      const current = log.cursor('t1', seq);
      log.deleteSeqs('t1', [seq]);
      expect(log.resolveCursor('t1', current)).toBeUndefined();
      expect(new EventLogRepository(database).resolveCursor('t1', current)).toBeUndefined();
    } finally { database.onApplicationShutdown(); rmSync(dirname(database.path), { recursive: true, force: true }); }
  });
});

describe('PiAgentRunner with a resume pi cannot take', () => {
  /** An open session that waits on real extension dialogs, as a run that ended in an interrupt leaves it. */
  class DialogSessions extends FakeSessions {
    readonly ui = new UiBridge();
    abort = vi.fn(async () => undefined);
    override pendingDialogs(_threadId?: string, onlyNew?: boolean) { return this.ui.list(onlyNew); }
    markDialogsReported(_threadId: string, ids: string[]) { this.ui.markReported(ids); }
    answerDialog(_threadId: string, id: string, answer: DialogAnswer) { return this.ui.answer(id, answer); }
    subscribe() { return () => undefined; }
    onUiEvent() { return () => undefined; }
    onDialogRequested(_threadId: string, listener: () => void) { return this.ui.onDialog(listener); }
    whenPromptDone() { return undefined; }
    takeAbortedWhileWaiting() { return this.ui.takeAborted(); }
  }

  /** Thread t1 suspended at a select: run r1 asked "Range?" and its log ends in that interrupt, as `PiAgent` leaves it. */
  function setup(withDialog = true) {
    const dir = mkdtempSync(join(tmpdir(), 'pk-runner-resume-'));
    const database = new DatabaseService({ dataDir: dir });
    const log = new EventLogRepository(database);
    const threads = new ThreadsRepository(database);
    const sessionFile = join(dir, 'session.jsonl');
    writeFileSync(sessionFile, '{}\n');
    threads.insertDraft({ id: 't1', sessionPath: sessionFile, cwd: dir });
    const sessions = new DialogSessions();
    const runner = new PiAgentRunner(log, threads, sessions as unknown as PiSessionService);
    const carry = new Map([['t1', createMapContext({ threadId: 't1', runId: 'r1' })]]);
    const agent = new PiAgent(sessions as unknown as PiSessionService, { defaultCwd: dir, threads: {} as never, carry, relayMcp: async () => undefined });
    const answer = withDialog ? sessions.ui.select('Range?', ['Week', 'Month']) : undefined;
    const dialogs = sessions.ui.list();
    sessions.ui.markReported(dialogs.map((d) => d.id));
    log.beginRun('t1', 'r1');
    log.append('t1', 'r1', { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' } as BaseEvent);
    log.append('t1', 'r1', interruptFinished('t1', 'r1', dialogs));
    log.endRun('r1', 'finished');
    const resume = (runId: string, value: string, ids = dialogs.map((d) => d.id)) => firstValueFrom(runner.run({ threadId: 't1', agent: agent.clone(),
      input: { threadId: 't1', runId, messages: [], tools: [], state: {}, context: [], resume: ids.map((interruptId) => ({ interruptId, status: 'resolved', payload: { value } })) } } as never).pipe(toArray()));
    const hydrate = () => firstValueFrom(runner.connect({ threadId: 't1', headers: { [THREAD_HYDRATION_HEADER]: '1' } } as never).pipe(toArray()));
    const close = () => { sessions.ui.cancelAll(); database.onApplicationShutdown(); rmSync(dir, { recursive: true, force: true }); };
    return { log, sessions, dialogs, answer, resume, hydrate, close };
  }
  const snapshots = (log: EventLogRepository) => log.read('t1').filter((row) => row.event.type === EventType.MESSAGES_SNAPSHOT);

  it('keeps the thread suspended at the interrupt when the answer is not an option, and says why', async () => {
    const { log, sessions, dialogs, resume, hydrate, close } = setup();
    try {
      const events = await resume('r2', 'Year');
      expect(events).toContainEqual(expect.objectContaining({ type: EventType.CUSTOM, name: 'pi.notify', value: { level: 'error', text: 'Select an available option.' } }));
      expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, runId: 'r2', outcome: { type: 'interrupt', interrupts: [{ id: dialogs[0].id }] } });
      expect(sessions.ui.size).toBe(1);
      expect(snapshots(log)).toHaveLength(0);
      expect(log.lastRun('t1')).toMatchObject({ runId: 'r2', status: 'finished' });
      const replay = await hydrate();
      expect(replay.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'interrupt', interrupts: [{ id: dialogs[0].id }] } });
    } finally { close(); }
  });

  it('still takes a valid answer after a refused one', async () => {
    const { log, answer, resume, close } = setup();
    try {
      await resume('r2', 'Year');
      const events = await resume('r3', 'Month');
      expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, runId: 'r3', outcome: { type: 'success' } });
      expect(await answer).toBe('Month');
      expect(snapshots(log)).toHaveLength(1);
      expect(log.lastRun('t1')).toMatchObject({ runId: 'r3', status: 'finished' });
    } finally { close(); }
  });

  it('fails a resume that cannot apply when pi waits on nothing any more', async () => {
    const { log, resume, close } = setup(false);
    try {
      const events = await resume('r2', 'Month', ['gone', 'gone']);
      expect(events.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, code: 'invalid_resume' });
      expect(events.some((event) => event.type === EventType.CUSTOM && (event as { name?: string }).name === 'pi.notify')).toBe(false);
      expect(log.lastRun('t1')).toMatchObject({ runId: 'r2', status: 'error' });
    } finally { close(); }
  });
});

describe('composerChanges', () => {
  const state = new Map<string, ComposerRegistration>([['a', { op: 'suggestion', id: 'a', title: 'Ask', text: 'hi' }]]);
  it('is false for the same registration or a removal of an unknown id', () => {
    expect(composerChanges(state, { op: 'suggestion', id: 'a', title: 'Ask', text: 'hi' })).toBe(false);
    expect(composerChanges(state, { op: 'remove', id: 'zzz' })).toBe(false);
  });
  it('is true for a new, a changed and a removed id', () => {
    expect(composerChanges(state, { op: 'suggestion', id: 'b', title: 'Ask', text: 'hi' })).toBe(true);
    expect(composerChanges(state, { op: 'suggestion', id: 'a', title: 'Ask', text: 'hi', send: true })).toBe(true);
    expect(composerChanges(state, { op: 'remove', id: 'a' })).toBe(true);
  });
});
