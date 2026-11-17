import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type {
  AgentQuestionDialog,
  BgAgent,
  SkillDraft,
  ThreadScoreBadge,
  ThreadState,
  ThreadSuggestion,
  ThreadsEvent,
} from '@pi-kit/protocol';
import { AttendantRepository } from '../db/attendant.repository';
import { EventLogRepository, type RunRow } from '../db/event-log.repository';
import { type OutcomeRow, OutcomesRepository } from '../db/outcomes.repository';
import { draftBadge, SkillDraftsRepository } from '../db/skill-drafts.repository';
import { type ThreadRow, ThreadsRepository } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { sessionMtime } from './session-files';
import { outcomeBadge } from './outcome-rules';
import { computeThreadState } from './thread-state';

/** What `stateOf` can be handed so a pass over every thread reads each table once instead of once per thread. */
export interface StateLookups {
  lastRuns: Map<string, RunRow>;
  summaries: Map<string, string>;
  suggestions: Map<string, ThreadSuggestion[]>;
  outcomes: Map<string, OutcomeRow>;
  drafts: Map<string, SkillDraft>;
}

/**
 * The state of every thread at a glance, and the status channel that carries it: `running`, `waiting` with the question's
 * first words, the context share, `error` / `aborted`, `unread` and `cli`. It is computed here, in one place, from the lock rows, the pending
 * dialogs, the context measurement and the user's last look, and pushed to `GET /api/threads/events` whenever something that feeds it changes: a run
 * starting or ending, a dialog opening or closing, the attendant writing a summary. Nothing in the renderer polls for it.
 */
@Injectable()
export class ThreadStatusService implements OnModuleInit {
  private readonly logger = new Logger(ThreadStatusService.name);
  /** The state last pushed per thread, as JSON, so an unchanged state is not pushed again. */
  private readonly last = new Map<string, string>();
  private work: Promise<unknown> = Promise.resolve();
  private readonly revisions = new Map<string, number>();

  private ordered<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.work.then(run);
    this.work = pending.catch(() => undefined);
    return pending;
  }
  private readonly listeners = new Set<(event: ThreadsEvent) => unknown>();
  /** What the Meat Proxy Score plugin adds to an outcome's badge: the score, while its package is installed. Set by the score service. */
  private scoreBadge: ((row: OutcomeRow) => ThreadScoreBadge | undefined) | undefined;
  /** The questions of a thread's background agents the user has to answer; set by the agents module. */
  private agentQuestions: ((threadId: string) => AgentQuestionDialog[] | Promise<AgentQuestionDialog[]>) | undefined;

  constructor(
    private readonly threads: ThreadsRepository,
    private readonly events: EventLogRepository,
    private readonly attendant: AttendantRepository,
    private readonly sessions: PiSessionService,
    private readonly outcomes: OutcomesRepository,
    private readonly drafts: SkillDraftsRepository,
  ) {}

  onModuleInit(): void {
    // A run ends in the runner's synchronous bookkeeping (the session file's mtime, the counts); the push waits until it is complete.
    this.events.onRunChange((threadId, change) =>
      setImmediate(async () => {
        try {
          if (change === 'end') await this.measureOpenSession(threadId);
          await this.touch(threadId);
        } catch (error) {
          this.logger.warn(
            `The state of ${threadId} could not be pushed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
    this.sessions.onDialogsChanged((threadId) => {
      void (async () => {
        // A drafted answer belongs to a question; once the question is gone the draft is too.
        await this.attendant.expireAnswers(
          threadId,
          this.sessions.pendingDialogs(threadId).map((d) => d.id),
        );
        await this.touch(threadId);
      })().catch((error) => this.logger.warn(`Dialog state of ${threadId}: ${String(error)}`));
    });
  }

  /** Where the outcome badge gets its score; without one the badge shows the outcome alone. */
  setScoreBadge(source: ((row: OutcomeRow) => ThreadScoreBadge | undefined) | undefined): void {
    this.scoreBadge = source;
  }

  /** Where the user questions of background agents come from: they make the thread wait like pi's own dialogs. */
  setAgentQuestions(
    source: ((threadId: string) => AgentQuestionDialog[] | Promise<AgentQuestionDialog[]>) | undefined,
  ): void {
    this.agentQuestions = source;
  }

  /** The state of a thread. Pass `lookups` when computing many. */
  async stateOf(row: ThreadRow, lookups?: StateLookups): Promise<ThreadState> {
    const lastRun = lookups ? lookups.lastRuns.get(row.id) : await this.events.lastRun(row.id);
    const outcomeRow = lookups ? lookups.outcomes.get(row.id) : await this.outcomes.get(row.id);
    return computeThreadState({
      running: lastRun?.status === 'running',
      dialogs: this.sessions.pendingDialogs(row.id),
      prose: this.sessions.proseQuestion(row.id) ?? null,
      lastRun,
      contextPct: row.contextPct,
      seenAt: row.seenAt,
      origin: row.origin,
      fileMtime: sessionMtime(row.sessionPath),
      logMtime: row.logMtime,
      summary: (lookups ? lookups.summaries.get(row.id) : (await this.attendant.meta(row.id))?.summary) ?? null,
      suggestions: lookups ? (lookups.suggestions.get(row.id) ?? []) : await this.attendant.openSuggestions(row.id),
      outcome: outcomeBadge(outcomeRow, outcomeRow ? this.scoreBadge?.(outcomeRow) : undefined),
      draft: draftBadge(lookups ? lookups.drafts.get(row.id) : await this.drafts.forThread(row.id)),
      agentQuestions: (await this.agentQuestions?.(row.id)) ?? [],
    });
  }

  async lookups(): Promise<StateLookups> {
    return {
      lastRuns: await this.events.lastRunByThread(),
      summaries: await this.attendant.summaries(),
      suggestions: await this.attendant.allOpenSuggestions(),
      outcomes: await this.outcomes.all(),
      drafts: await this.drafts.all(),
    };
  }

  /** Every thread's state, and what a stream that just connected starts with. It also seeds the "last pushed" memory. */
  async snapshot(): Promise<Record<string, ThreadState>> {
    return await this.ordered(async () => await this.computeSnapshot());
  }

  private async computeSnapshot(): Promise<Record<string, ThreadState>> {
    const revisions = new Map(this.revisions);
    const lookups = await this.lookups();
    const states: Record<string, ThreadState> = {};
    for (const row of await this.threads.all()) {
      const state = await this.stateOf(row, lookups);
      states[row.id] = state;
      if (revisions.get(row.id) === this.revisions.get(row.id)) this.last.set(row.id, JSON.stringify(state));
    }
    return states;
  }

  subscribe(listener: (event: ThreadsEvent) => unknown): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Recomputes one thread and pushes it if it changed. */
  async touch(threadId: string): Promise<void> {
    return await this.ordered(async () => await this.computeTouch(threadId));
  }

  private async computeTouch(threadId: string): Promise<void> {
    const revisions = new Map(this.revisions);
    const row = await this.threads.get(threadId);
    if (!row) return this.gone(threadId);
    const state = await this.stateOf(row);
    const key = JSON.stringify(state);
    if (revisions.get(threadId) !== this.revisions.get(threadId) || this.last.get(threadId) === key) return;
    this.last.set(threadId, key);
    this.emit({ type: 'state', id: threadId, state });
  }

  /** Recomputes every thread (after a reconcile pass, which can change the file facts of many) and pushes what changed. */
  async touchAll(): Promise<void> {
    return await this.ordered(async () => await this.computeTouchall());
  }

  private async computeTouchall(): Promise<void> {
    const revisions = new Map(this.revisions);
    const lookups = await this.lookups();
    const known = new Set<string>();
    for (const row of await this.threads.all()) {
      known.add(row.id);
      const state = await this.stateOf(row, lookups);
      const key = JSON.stringify(state);
      if (revisions.get(row.id) !== this.revisions.get(row.id) || this.last.get(row.id) === key) continue;
      this.last.set(row.id, key);
      this.emit({ type: 'state', id: row.id, state });
    }
    for (const id of [...this.last.keys()])
      if (!known.has(id) && revisions.get(id) === this.revisions.get(id)) this.gone(id);
  }

  gone(threadId: string): void {
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    if (this.last.delete(threadId)) this.emit({ type: 'gone', id: threadId });
  }

  /** Threads or projects were added, removed, renamed or reordered: every client fetches the list again. */
  listChanged(): void {
    this.emit({ type: 'list' });
  }

  /** The background agents of a thread changed: the whole list goes out, so a panel needs no second request. */
  pushAgents(threadId: string, agents: BgAgent[]): void {
    this.emit({ type: 'agents', id: threadId, agents });
  }

  /** The thread's session is open and a run just ended: pi knows the context exactly. */
  private async measureOpenSession(threadId: string): Promise<void> {
    try {
      const row = await this.threads.get(threadId);
      if (!row || !this.sessions.has(threadId)) return;
      await this.threads.setContext(threadId, this.sessions.contextShare(threadId), sessionMtime(row.sessionPath));
    } catch (error) {
      this.logger.debug(
        `Could not measure the context of ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private emit(event: ThreadsEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        Promise.resolve(listener(event)).catch(() => undefined);
      } catch {
        // a closed stream must not stop the others
      }
    }
  }
}
