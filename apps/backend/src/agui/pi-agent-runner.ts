import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { type AbstractAgent, type BaseEvent, EventType, type RunAgentInput } from '@ag-ui/client';
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from '@copilotkit/runtime/v2';
import {
  type ComposerRegistration,
  isProxiedMcpRun,
  parseAgentQuestionId,
  REPLAY_CURSOR_HEADER,
  REPLAY_CURSOR_METADATA,
  REPLAY_RESET_EVENT,
  THREAD_HYDRATION_HEADER,
  THREAD_HYDRATION_EVENT,
} from '@pi-kit/protocol';
import {
  closeRun,
  isAborted,
  isInterrupt,
  isTerminal,
  buildSessionTree,
  mapUiEvent,
  messagesSnapshot,
  type PiUiEvent,
  sessionToMessages,
} from '@pi-kit/pi-adapter';
import { defer, Observable, of, ReplaySubject, Subject, type Subscription, switchMap } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { EventLogRepository } from '../db/event-log.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { RunSnapshotsService } from '../snapshots/run-snapshots.service';
import { sessionMtime } from '../threads/session-files';
import { lastAssistantLine } from '../threads/thread-context';
import { newestUserMessage, streamingBehavior } from './pi-agent';
import { composerChanges, foldComposer } from './composer-log';
import { COMPACTION, LogCompactor } from './log-compactor';
import { runWithMiddleware } from './run-with-middleware';
import { hydrateThread } from './thread-hydration';

const logger = new Logger('PiAgentRunner');

/** How long registrations wait for others before they are written. */
const COMPOSER_BATCH_MS = 20;
/** How often a queued message looks whether pi took the prompt of the run before it. */
const PROMPT_LOOK_MS = 20;

const RESTART_MESSAGE = 'The app was closed while this run was in progress.';

interface ActiveRun {
  runId: string;
  /** This run's events so far, to close it properly if its stream ends badly. */
  events: BaseEvent[];
  /** Live feed for `connect()` followers; a storage failure has no durable log position. */
  live: Subject<{ seq?: number; event: BaseEvent }>;
  upstream?: Subscription;
  /** Writes an event into this run's log and feeds it to the followers and the run's own stream. */
  emit?: (event: BaseEvent) => void;
  close?: () => void;
  /** Stop was pressed: a run that has not handed pi its prompt yet (it waits for the folder's snapshot) never does, nor do messages queued behind it. */
  stopped?: boolean;
}

/**
 * Durable threads for CopilotKit's runtime. It replaces `InMemoryAgentRunner`:
 *
 * - `run()` takes the thread's lock (an in-process map entry and a `runs` row), starts the `PiAgent`
 *   and appends every event to `thread_events` as it passes. The run belongs to the runner, not to the
 *   HTTP request: a client that disconnects or reloads does not stop it, `stop()` does.
 * - `connect()` replays the stored log and then follows the active run, if any.
 * - When a run ends, the log gets a `MESSAGES_SNAPSHOT` built from pi's session file and is compacted.
 *
 * pi's session file stays the source of truth. If it changed without us (the CLI continued the
 * session) `connect()` throws the log away and synthesises it from the file.
 */
@Injectable()
export class PiAgentRunner extends AgentRunner implements OnModuleInit, OnModuleDestroy {
  private readonly active = new Map<string, ActiveRun>();
  /** Threads where pi started a turn while a run was still going (or still ending): followed once that run is over. */
  private readonly pendingTurns = new Set<string>();
  private readonly listeners: (() => void)[] = [];
  private destroyed = false;
  /** Toolbar registrations that came while no run listened, waiting a moment so ones that arrive together are written together. */
  private readonly pendingComposer = new Map<
    string,
    { timer: NodeJS.Timeout; registrations: ComposerRegistration[] }
  >();
  private readonly compactor: LogCompactor;
  /** The agent a run of a turn pi started by itself attaches with (`AguiService` hands over the registered `PiAgent`). */
  private followAgent?: () => AbstractAgent;
  /** The runner of the agent `pi-bg`, whose requests the runtime sends here like every other agent's. */
  private background?: Pick<PiAgentRunner, 'run' | 'connect' | 'stop'> & {
    isRunning(threadId: string): boolean;
    owns(threadId: string): boolean;
  };

  constructor(
    private readonly log: EventLogRepository,
    private readonly threads: ThreadsRepository,
    private readonly sessions: PiSessionService,
    /** The snapshot of the folder is taken before pi gets the prompt (`beforePrompt`); absent in tests that do not care. */
    @Optional() private readonly snapshots?: RunSnapshotsService,
  ) {
    super();
    this.compactor = new LogCompactor(log);
  }

  /**
   * Runs still marked 'running' belong to a process that is gone: close them in the log as aborted. Navigating the
   * session tree outside a run (the panel, an extension) is written to the log as a small run of its own.
   */
  onModuleInit(): void {
    this.listeners.push(
      this.sessions.onTreeChanged((threadId) => this.publishBranch(threadId)),
      this.sessions.onUnattachedUiEvent((threadId, event) => this.publishUiEvent(threadId, event)),
      this.sessions.onTurnStarted((threadId) => this.followTurn(threadId)),
    );
    for (const run of this.log.staleRuns()) {
      const events = this.log
        .read(run.threadId)
        .filter((stored) => stored.runId === run.runId)
        .map((stored) => stored.event);
      for (const event of closeRun(events, { message: RESTART_MESSAGE, code: 'aborted' })) {
        this.log.append(run.threadId, run.runId, event);
      }
      this.log.endRun(run.runId, 'aborted');
      // The log now accounts for everything in the file, so it is not stale.
      const row = this.threads.get(run.threadId);
      if (row) this.threads.setLogMtime(run.threadId, sessionMtime(row.sessionPath));
      logger.warn(`Marked run ${run.runId} of thread ${run.threadId} as aborted (the backend restarted mid-run).`);
    }
  }

  /** Stop event producers and delayed toolbar writes before the database's application shutdown hook closes it. */
  onModuleDestroy(): void {
    this.destroyed = true;
    this.listeners.splice(0).forEach((leave) => leave());
    for (const queued of this.pendingComposer.values()) clearTimeout(queued.timer);
    this.pendingComposer.clear();
    const runs = [...this.active.values()];
    this.active.clear();
    for (const run of runs) {
      try {
        run.upstream?.unsubscribe();
      } catch (error) {
        logger.warn(`Unsubscribing run ${run.runId} during shutdown failed: ${String(error)}`);
      }
      run.close?.();
    }
  }

  useAgent(factory: () => AbstractAgent): void {
    this.followAgent = factory;
  }

  useBackground(runner: NonNullable<PiAgentRunner['background']>): void {
    this.background = runner;
  }

  /** A request of `pi-bg`: by its agent id where the runtime says it, else by the thread id, which is then an agent's. */
  private isBackground(request: { threadId: string; agent?: AbstractAgent; agentId?: string }): boolean {
    return (
      !!this.background &&
      (request.agent?.agentId === 'pi-bg' || request.agentId === 'pi-bg' || this.background.owns(request.threadId))
    );
  }

  /**
   * pi started a turn nobody prompted (an extension's `pi.sendMessage(…, { triggerTurn: true })` or `pi.sendUserMessage()` in an idle thread):
   * it gets a run of its own, with the lock and the log of any other, so an open transcript follows it (the status channel
   * says the thread runs, and the renderer connects again) and a later `connect()` replays it. While a run of the thread is going the turn
   * waits: that run may carry it (a steer or a follow-up), but a run that is already ending does not, so once it is over a turn pi is still
   * in gets a run of its own (`followPending`).
   */
  private followTurn(threadId: string): void {
    if (!this.followAgent) return;
    if (this.active.has(threadId)) {
      this.pendingTurns.add(threadId);
      return;
    }
    const runId = `turn-${randomUUID()}`;
    const input: RunAgentInput = {
      threadId,
      runId,
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: { followTurn: true },
    };
    try {
      this.run({ threadId, agent: this.followAgent(), input }).subscribe({ error: () => undefined });
    } catch (error) {
      logger.warn(
        `Could not follow the turn pi started in ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * A turn pi started while the thread's last run was going, now that the run is over: followed when pi is still in it (and not waiting
   * on a dialog of its own prompt). A turn the run carried has settled by now, so nothing is followed twice.
   */
  private followPending(threadId: string): void {
    if (!this.pendingTurns.delete(threadId)) return;
    queueMicrotask(() => {
      if (this.active.has(threadId) || !this.sessions.has(threadId) || !this.sessions.isStreaming(threadId)) return;
      if (this.sessions.pendingDialogs(threadId).length > 0) return;
      this.followTurn(threadId);
    });
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    if (this.destroyed) throw new Error('The backend is shutting down.');
    if (this.isBackground(request)) return (this.background as NonNullable<typeof this.background>).run(request);
    const { threadId, agent, input } = request;
    const runId = input.runId;
    // Steering and follow-ups go to the run that is going; they are neither a run of their own
    // nor part of the log (the message appears when pi delivers it, through that run's stream).
    if (
      streamingBehavior(input) &&
      (this.active.has(threadId) || (this.sessions.has(threadId) && this.sessions.isStreaming(threadId)))
    ) {
      // The run going on may not have handed pi its prompt yet (it waits for the folder's snapshot, then prepares the session): this message
      // would reach an idle pi first and start as a prompt of its own. It waits until pi works on that prompt, or the run is over; a run that
      // was stopped meanwhile takes its queued messages with it. Otherwise the message is routed again: queued while pi works, else (the run
      // ended without pi working: its prompt failed) a run of its own, with the lock, the log and the snapshots.
      const active = this.active.get(threadId);
      if (!active || this.piWorks(threadId)) return runWithMiddleware(agent, input);
      return defer(() => this.untilPiTakesPrompt(threadId, active)).pipe(
        switchMap(() => (active.stopped ? stoppedRun(threadId, input.runId) : this.run(request))),
      );
    }
    // An MCP App asking for its resource or calling a tool is a relay, not a run: it takes no lock (the
    // widget waits for the agent to be idle anyway), writes nothing to the log (resources are whole HTML pages) and
    // never touches pi's session. Its answer is the `RUN_FINISHED.result` of the stream it gets back.
    if (isProxiedMcpRun(input.forwardedProps)) return runWithMiddleware(agent, input);
    // The user's answer to a background agent's question is a relay too: the agents settle it, nothing of pi's changes.
    if (
      input.resume?.length &&
      input.resume.every((entry) => parseAgentQuestionId((entry as { interruptId?: string }).interruptId))
    )
      return runWithMiddleware(agent, input);
    if (this.active.has(threadId)) throw new Error('Thread already running');
    try {
      this.log.beginRun(threadId, runId);
    } catch {
      throw new Error('Thread already running');
    }

    const active: ActiveRun = { runId, events: [], live: new Subject() };
    this.active.set(threadId, active);
    const out = new ReplaySubject<BaseEvent>(Infinity);
    active.close = () => {
      out.complete();
      active.live.complete();
    };

    const emit = (event: BaseEvent): void => {
      const seq = this.log.append(threadId, runId, event);
      active.events.push(event);
      const delivered = this.withCursor(threadId, seq, event);
      active.live.next({ seq, event: delivered });
      out.next(delivered);
    };
    // Middleware can defer RUN_STARTED while session_start extensions already publish toolbar events.
    // AG-UI requires the run to start before any of those events reach the client or replay log.
    let started = false;
    const beforeStart: BaseEvent[] = [];
    // RxJS reports exceptions thrown by observer callbacks as uncaught exceptions. Never let a write
    // failure escape a next/error/complete callback: only this run should end, even when storage is unavailable.
    const storageFailed = (error: unknown): void => {
      if (this.active.get(threadId) !== active) return;
      this.active.delete(threadId);
      logger.error(
        `Writing run ${runId} of thread ${threadId} failed: ${error instanceof Error ? error.stack : String(error)}`,
      );
      try {
        this.log.endRun(runId, 'error');
      } catch (endError) {
        logger.error(`Releasing run ${runId} failed: ${String(endError)}`);
      }
      try {
        active.upstream?.unsubscribe();
      } catch (stopError) {
        logger.warn(`Unsubscribing run ${runId} failed: ${String(stopError)}`);
      }
      // Dispatch cancellation before clients see the error and can start a replacement run.
      void this.sessions
        .abort(threadId)
        .catch((abortError: unknown) => logger.warn(`Stopping run ${runId} failed: ${String(abortError)}`));
      for (const event of closeRun(active.events, {
        message: 'The run stopped because its events could not be saved.',
        code: 'EVENT_LOG_ERROR',
      })) {
        // These events have no durable cursor. A reconnect resumes from the last successful write.
        active.live.next({ event });
        out.next(event);
      }
      active.close?.();
    };
    active.emit = (event) => {
      if (this.active.get(threadId) !== active) return;
      try {
        if (started) emit(event);
        else beforeStart.push(event);
      } catch (error) {
        storageFailed(error);
      }
    };
    const finish = (terminal: BaseEvent): void => {
      if (this.active.get(threadId) !== active) return; // already ended
      this.endRun(threadId, active, terminal, emit);
      this.active.delete(threadId);
      active.close?.();
      this.followPending(threadId);
    };
    // The stream broke without a terminal event: close what is open, then end the run with an error.
    const fail = (message: string, code: string): void => {
      if (this.active.get(threadId) !== active) return;
      try {
        const closing = closeRun(active.events, { message, code });
        const terminal = closing.pop() as BaseEvent;
        closing.forEach(emit);
        finish(terminal);
      } catch (error) {
        storageFailed(error);
      }
    };

    try {
      // pi gets the prompt once the folder's snapshot is taken: what the run changes is measured from it.
      const upstream = runWithMiddleware(agent, input);
      active.upstream = upstream.subscribe({
        next: (event) => {
          if (this.active.get(threadId) !== active) return;
          try {
            if (isTerminal(event)) return finish(event);
            emit(event.type === EventType.RUN_STARTED ? withInput(event, input) : event);
            if (event.type === EventType.RUN_STARTED) {
              started = true;
              beforeStart.splice(0).forEach(emit);
              this.flushComposer(threadId);
            }
          } catch (error) {
            storageFailed(error);
          }
        },
        error: (error) => fail(error instanceof Error ? error.message : String(error), 'error'),
        complete: () => fail('The run ended without a result.', 'INCOMPLETE_STREAM'),
      });
      if (this.active.get(threadId) !== active) active.upstream.unsubscribe();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error), 'error');
    }
    return out.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    if (this.isBackground(request)) return (this.background as NonNullable<typeof this.background>).connect(request);
    const { threadId } = request;
    return new Observable<BaseEvent>((subscriber) => {
      let follow: Subscription | undefined;
      let closed = false;

      void (async () => {
        await this.ensureCurrent(threadId);
        if (closed) return;
        // Older versions wrote the final snapshot twice, so the incremental compaction window missed the run's
        // deltas. Repair oversized idle logs before replaying thousands of tiny chunks into the renderer.
        const hydrate = request.headers?.[THREAD_HYDRATION_HEADER] === '1';
        if (!hydrate && !this.hasLivePrompt(threadId) && this.log.count(threadId) > COMPACTION.maxRows) {
          this.compactor.compact(threadId, { full: true });
        }
        this.flushComposer(threadId);
        this.expireOrphanedInterrupt(threadId);
        // Everything from here to the subscription is synchronous, so no event slips between the
        // stored log and the live feed.
        const after = this.log.resolveCursor(threadId, request.headers?.[REPLAY_CURSOR_HEADER]);
        const run = this.active.get(threadId);
        subscriber.next({
          type: EventType.CUSTOM,
          name: REPLAY_RESET_EVENT,
          value: { reset: after === undefined, ...(hydrate ? { running: !!run } : {}) },
        } as BaseEvent);
        const stored = after === undefined ? this.log.read(threadId) : this.log.readAfter(threadId, after);
        if (hydrate && (after === undefined || stored.length > 0)) {
          // This is a state transfer, not a replay. Keep the durable AG-UI log unchanged, including
          // unfinished tool arguments. Read/project/join synchronously so no new event can fall in a gap.
          const history = after === undefined ? stored : this.log.read(threadId);
          const seq = history.at(-1)?.seq ?? 0;
          const runId = run?.runId ?? history.at(-1)?.runId ?? `hydrate-${threadId}`;
          subscriber.next({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
          const value = hydrateThread(history.map((row) => row.event));
          value.view.promptActive = this.hasLivePrompt(threadId);
          const snapshot = {
            type: EventType.CUSTOM,
            name: THREAD_HYDRATION_EVENT,
            value: { ...value, running: !!run },
          } as BaseEvent;
          subscriber.next(this.withCursor(threadId, seq, snapshot));
          if (!run) {
            const terminal = [...history].reverse().find((row) => isTerminal(row.event))?.event;
            const outcome =
              terminal?.type === EventType.RUN_FINISHED
                ? (terminal as { outcome?: unknown }).outcome
                : { type: 'success' };
            subscriber.next(
              this.withCursor(threadId, seq, {
                type: EventType.RUN_FINISHED,
                threadId,
                runId,
                outcome,
                result: {
                  aborted:
                    terminal?.type === EventType.RUN_FINISHED &&
                    (terminal as { result?: { aborted?: boolean } }).result?.aborted === true,
                },
              } as BaseEvent),
            );
          }
        } else if (!hydrate) {
          for (const { seq, event } of stored) subscriber.next(this.withCursor(threadId, seq, event));
        }
        if (!run) return subscriber.complete();
        const last = stored.at(-1)?.seq ?? after ?? 0;
        follow = run.live.subscribe({
          next: ({ seq, event }) => (seq === undefined || seq > last) && subscriber.next(event),
          complete: () => subscriber.complete(),
        });
      })().catch((error) => subscriber.error(error));

      return () => {
        closed = true;
        follow?.unsubscribe();
      };
    });
  }

  private withCursor(threadId: string, seq: number, event: BaseEvent): BaseEvent {
    return { ...event, metadata: { ...event.metadata, [REPLAY_CURSOR_METADATA]: this.log.cursor(threadId, seq) } };
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    if (this.isBackground(request))
      return Promise.resolve((this.background as NonNullable<typeof this.background>).isRunning(request.threadId));
    return Promise.resolve(this.active.has(request.threadId));
  }

  /**
   * Aborts pi's current run. The adapter then ends the stream with `RUN_FINISHED { result: { aborted } }`
   * which closes the run through the normal path. A thread that is blocked in an extension
   * dialog has no run at the moment (the run ended in an interrupt) but pi is still busy: stopping dismisses
   * the dialog and aborts pi, and the client's answer to the interrupt then ends as a stopped run.
   */
  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    if (this.isBackground(request)) return (this.background as NonNullable<typeof this.background>).stop(request);
    const run = this.active.get(request.threadId);
    if (!run) {
      if (this.sessions.pendingDialogs(request.threadId).length === 0) return false;
      await this.sessions.abort(request.threadId);
      return true;
    }
    if (request.runId !== undefined && request.runId !== run.runId) return false;
    run.stopped = true;
    await this.sessions.abort(request.threadId);
    return true;
  }

  /**
   * The agent asks this just before pi gets a prompt (the thread is prepared, nothing written yet): the folder's snapshot is taken first, so the
   * run has its "before". `false` when the run was stopped meanwhile: pi never gets the prompt.
   */
  async beforePrompt(threadId: string): Promise<boolean> {
    await this.snapshots?.whenStarted(threadId);
    return !this.active.get(threadId)?.stopped;
  }

  private piWorks(threadId: string): boolean {
    return this.sessions.has(threadId) && this.sessions.isStreaming(threadId);
  }

  /** Resolves once pi works on a prompt of the thread, or `active` is no longer the thread's run (it ended), or it was stopped. */
  private untilPiTakesPrompt(threadId: string, active: ActiveRun): Promise<void> {
    return new Promise((resolve) => {
      const look = (): void => {
        if (this.active.get(threadId) !== active || active.stopped || this.piWorks(threadId)) return resolve();
        setTimeout(look, PROMPT_LOOK_MS).unref();
      };
      look();
    });
  }

  /**
   * The leaf moved or an entry was appended outside a run: the log gets a run of its own that carries a
   * `MESSAGES_SNAPSHOT` of the new active branch and a `pi.tree` signal, so the next `connect()` replays the transcript
   * of the branch the thread is on now, and our bookkeeping (leaf, fork count, log validity) follows. A thread that runs
   * is left alone: its own run records the tree when it ends.
   */
  publishBranch(threadId: string): void {
    if (this.hasLivePrompt(threadId)) return;
    const entries = this.sessionEntries(threadId);
    if (!entries) return;
    const runId = `tree-${randomUUID()}`;
    const leafId = this.sessions.leafId(threadId);
    const events = [
      { type: EventType.RUN_STARTED, threadId, runId },
      messagesSnapshot(sessionToMessages(entries, this.sessionOptions(threadId))),
      { type: EventType.CUSTOM, name: 'pi.tree', value: { leafId, changed: leafId ? [leafId] : [] } },
      { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } },
    ] as BaseEvent[];
    for (const event of events) this.log.append(threadId, runId, event);
    try {
      this.compact(threadId);
    } catch (error) {
      logger.warn(
        `Compacting the log of ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.recordTree(threadId);
  }

  /**
   * Extensions can register toolbar actions and suggestions (`pi.composer`) while no run listens: at `session_start` when the
   * session is opened for the command list, or on `/reload`. They are part of the thread's replay like the other `pi.*` signals.
   * Registrations that arrive together are written together (see `flushComposer`).
   */
  private publishUiEvent(threadId: string, event: PiUiEvent): void {
    if (event.kind !== 'composer') return;
    const queued = this.pendingComposer.get(threadId);
    if (queued) {
      queued.registrations.push(event.registration);
      return;
    }
    const timer = setTimeout(() => {
      try {
        this.flushComposer(threadId);
      } catch (error) {
        logger.error(`Writing toolbar registrations for ${threadId} failed: ${String(error)}`);
      }
    }, COMPOSER_BATCH_MS);
    timer.unref();
    this.pendingComposer.set(threadId, { timer, registrations: [event.registration] });
  }

  /**
   * Writes the queued registrations that change what the log already says: into the run that is going when there is one (that run
   * opened the session), else into one small run of their own, so the next `connect()` replays them. `connect()` flushes first.
   */
  private flushComposer(threadId: string): void {
    const queued = this.pendingComposer.get(threadId);
    if (!queued) return;
    // A synthetic toolbar run would replace the suspended run's interrupt with a success outcome.
    // Keep these registrations for the next real run, which flushes them after RUN_STARTED.
    if (!this.active.has(threadId) && this.hasLivePrompt(threadId)) return;
    clearTimeout(queued.timer);
    this.pendingComposer.delete(threadId);
    if (!this.threads.get(threadId)) return;
    const state = this.composerState(threadId);
    const fresh: ComposerRegistration[] = [];
    for (const registration of queued.registrations) {
      if (!composerChanges(state, registration)) continue;
      fresh.push(registration);
      if (registration.op === 'remove') state.delete(registration.id);
      else state.set(registration.id, registration);
    }
    if (fresh.length === 0) return;
    const events = fresh.flatMap((registration) => mapUiEvent({ kind: 'composer', registration }));
    const active = this.active.get(threadId);
    if (active?.emit) {
      events.forEach(active.emit);
      return;
    }
    const runId = `composer-${randomUUID()}`;
    const run = [
      { type: EventType.RUN_STARTED, threadId, runId },
      ...events,
      { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } },
    ] as BaseEvent[];
    for (const e of run) this.log.append(threadId, runId, e);
  }

  /** The toolbar registrations the replay log holds for a thread, by id, as a client reducing the log ends up with them. */
  composerState(threadId: string): Map<string, ComposerRegistration> {
    return foldComposer(this.log.read(threadId).map((stored) => stored.event));
  }

  // ---- internals

  /** The leaf the app is on, the thread's fork count and the log's validity against the file as it is now. */
  private recordTree(threadId: string): void {
    const row = this.threads.get(threadId);
    const source = this.sessions.openTree(threadId);
    if (!row || !source) return;
    const mtime = sessionMtime(row.sessionPath);
    this.threads.setLeaf(threadId, source.leafId, mtime);
    this.threads.setForkCount(threadId, buildSessionTree(source.entries, source.leafId).forks, mtime);
    if (mtime !== null) this.threads.setLogMtime(threadId, mtime);
  }

  /** Writes the run's tail: snapshot from pi's file, terminal event, then compaction and bookkeeping. */
  private endRun(threadId: string, active: ActiveRun, terminal: BaseEvent, emit: (event: BaseEvent) => void): void {
    if (isInterrupt(terminal)) {
      // pi is still inside its prompt, waiting for an answer: the session file is not at a boundary yet, so
      // the log keeps the stream as it was (no snapshot, no compaction) and the next run continues it.
      emit(terminal);
      this.log.endRun(active.runId, 'finished');
      // The prompt is still alive, but its persisted entries are already represented by this run's stream.
      this.recordTree(threadId);
      return;
    }
    const snapshot = this.snapshotFromSession(threadId);
    // The log gets the snapshot in front of the terminal event. Live clients get it too: the messages they streamed
    // carry provisional ids, and everything that addresses a message later (the thumbs, regenerate, branch navigation, Edit) needs
    // the pi entry ids the snapshot names. CopilotKit's message view keeps a row's element across such an id change.
    if (snapshot) {
      // emit stores the event too. A second append would make the compactor start at this same run's snapshot.
      emit(snapshot);
    }
    emit(terminal);

    this.log.endRun(
      active.runId,
      isAborted(terminal) ? 'aborted' : terminal.type === EventType.RUN_FINISHED ? 'finished' : 'error',
    );
    try {
      this.compact(threadId);
    } catch (error) {
      logger.warn(
        `Compacting the log of ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const row = this.threads.get(threadId);
    if (row) {
      const entries = this.sessionEntries(threadId);
      const open = this.sessions.openTree(threadId);
      const first = entries && sessionToMessages(entries).find((m) => m.role === 'user');
      this.threads.recordRunEnd(threadId, {
        logMtime: sessionMtime(row.sessionPath),
        messageCount: entries?.filter((e) => e.type === 'message').length ?? row.messageCount,
        preview: first && typeof first.content === 'string' ? first.content.slice(0, 200) : undefined,
        ...(open ? { lastLine: lastAssistantLine(open.entries, open.leafId) } : {}),
      });
      this.recordTree(threadId);
    }
  }

  /**
   * A log that ends in an interrupt belongs to a pi session that is waiting for an answer. If this process
   * does not hold that session (the app was restarted) nobody can ever answer: close the log as aborted
   * instead of showing a question that goes nowhere.
   */
  private expireOrphanedInterrupt(threadId: string): void {
    if (this.hasLivePrompt(threadId)) return;
    const last = this.log.read(threadId).at(-1);
    if (!last || !isInterrupt(last.event)) return;
    const runId = `expired-${Date.now()}`;
    this.log.append(threadId, runId, { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
    this.log.append(threadId, runId, {
      type: EventType.RUN_ERROR,
      message: 'The app was closed while pi was waiting for an answer.',
      code: 'aborted',
    } as BaseEvent);
  }

  /** What `sessionToMessages` needs besides the file: which MCP tools link an app (only an open session knows). */
  private sessionOptions(threadId: string): { mcpApp?: (server: string, tool: string) => string | undefined } {
    const mcpApp = this.sessions.mcpAppLookup(threadId);
    return mcpApp ? { mcpApp } : {};
  }

  private sessionEntries(threadId: string): ReturnType<PiSessionService['branch']>['entries'] | undefined {
    try {
      return this.sessions.branch(threadId).entries;
    } catch {
      return undefined; // the session is not open (it failed to open)
    }
  }

  private snapshotFromSession(threadId: string): BaseEvent | undefined {
    const entries = this.sessionEntries(threadId);
    return entries && messagesSnapshot(sessionToMessages(entries, this.sessionOptions(threadId)));
  }

  private compact(threadId: string): void {
    const result = this.compactor.compact(threadId);
    if (result.collapsed > 0) logger.log(`Collapsed ${result.collapsed} rows of old runs from the log of ${threadId}.`);
  }

  /**
   * Makes the stored log match what is in pi's session file: if the file is newer than the log, or
   * the thread has no log yet, the log is rebuilt as one `MESSAGES_SNAPSHOT` of the file's active
   * branch. This is also how CLI-created sessions get their history without ever having run here.
   */
  private async ensureCurrent(threadId: string): Promise<void> {
    if (this.hasLivePrompt(threadId)) return;
    const row = this.threads.get(threadId);
    if (!row) return;
    this.threads.touchOpened(threadId);
    const mtime = sessionMtime(row.sessionPath);
    const hasLog = this.log.count(threadId) > 0;
    if (mtime === null) return; // a draft without a file: nothing to show
    if (hasLog && row.logMtime !== null && mtime <= row.logMtime) return;

    const session = await this.sessions.readSession(row.sessionPath);
    if (this.hasLivePrompt(threadId)) return; // a prompt started or suspended while the file was being read
    this.log.clear(threadId);
    const runId = `history-${mtime}`;
    const messages = sessionToMessages(session.entries, this.sessionOptions(threadId));
    // Clearing the log also dropped the toolbar registrations; the open session still holds them.
    const composer = this.sessions
      .composerRegistrations(threadId)
      .flatMap((registration) => mapUiEvent({ kind: 'composer', registration }));
    const events = [
      { type: EventType.RUN_STARTED, threadId, runId },
      messagesSnapshot(messages),
      ...composer,
      { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } },
    ] as BaseEvent[];
    for (const event of events) this.log.append(threadId, runId, event);
    this.threads.setLogMtime(threadId, mtime);
  }

  /** A suspended AG-UI run still belongs to pi's live prompt. Its stream contains control state absent from the session file. */
  private hasLivePrompt(threadId: string): boolean {
    return (
      this.active.has(threadId) ||
      this.sessions.pendingDialogs(threadId).length > 0 ||
      (this.sessions.has(threadId) && this.sessions.isStreaming(threadId))
    );
  }
}

/** The stored `RUN_STARTED` carries the prompt, because a connecting client has not got the user's message otherwise. */
/** What a run that was stopped before pi got it says: it started, and it was stopped. */
function stoppedRun(threadId: string, runId: string) {
  return of(
    { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent,
    { type: EventType.RUN_FINISHED, threadId, runId, result: { aborted: true } } as BaseEvent,
  );
}

function withInput(event: BaseEvent, input: RunAgentInput): BaseEvent {
  const prompt = newestUserMessage(input.messages);
  return {
    ...event,
    input: {
      threadId: input.threadId,
      runId: input.runId,
      messages: prompt ? [prompt] : [],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    },
  } as BaseEvent;
}
