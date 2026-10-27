import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { buildSessionTree } from '@pi-kit/pi-adapter';
import {
  type AttendantKind,
  type AttendantSettings,
  AttendantSettingsSchema,
  type AttendantStatus,
  DEFAULT_ATTENDANT_SETTINGS,
  type PatchAttendantSettings,
  type ThreadSuggestion,
} from '@pi-kit/protocol';
import { AttendantRepository } from '../db/attendant.repository';
import { EventLogRepository } from '../db/event-log.repository';
import { MetaRepository } from '../db/meta.repository';
import { type ThreadRow, ThreadsRepository } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { sessionMtime } from '../threads/session-files';
import { ThreadStatusService } from '../threads/thread-status.service';
import { ThreadsService } from '../threads/threads.service';
import { TreeService } from '../tree/tree.service';
import { type ModelChoice, AttendantModelPort, type ModelReply } from './attendant-model';
import {
  answerOptions,
  cleanLabel,
  cleanSummary,
  cleanTitle,
  digestOf,
  draftPrompt,
  labelPrompt,
  parseChoice,
  type Prompt,
  summaryPrompt,
  titlePrompt,
  type ThreadDigest,
} from './attendant-text';

export const SETTINGS_KEY = 'attendant';
/** Why a thread is being looked at: a run ended, it asked a question, the sweep found it changed, or the user asked. */
export type Reason = 'end' | 'interrupt' | 'sweep' | 'manual' | 'learn';

/** One job of the queue: a look at a thread, or (`task`) work another service hands the attendant so it runs in line, under the same cap and opt-out. */
interface Job {
  threadId: string;
  reason: Reason;
  task?: () => Promise<void>;
  /** What kind of task it is (`learn`, `score`): one task of each kind per thread at a time. */
  key?: string;
}

/** The answer of `complete()`: the model's text and what it cost, or why there was no call. */
export type Completion =
  | { ok: true; text: string; model: string; inputTokens: number; outputTokens: number; cost: number }
  | { ok: false; code: 'off' | 'cap' | 'no-model' | 'failed'; error: string };

/** Who asked for a request: the attendant itself (its loop, or `complete` on its own trigger) or a person (a request they consented to). */
type Initiative = 'attendant' | 'person';
/** Why a request was aborted (`AbortSignal.reason`): the attendant was switched off, or the caller or the backend went away. */
type AbortReason = 'off' | 'cancelled';
const CANCELLED: Completion = { ok: false, code: 'failed', error: 'The request was cancelled.' };

/** How long after a run ended the attendant waits (the runner's own bookkeeping has to be complete). */
const END_DELAY_MS = 1500;
/** Threads a sweep takes at most (the first look after switching on, and every scheduled one). */
const SWEEP_LIMIT = 10;
/** Label proposals per thread and pass. */
const LABELS_PER_PASS = 2;

export const labelOf = (m: Pick<ModelChoice, 'provider' | 'id'>): string => `${m.provider}/${m.id}`;

/**
 * The attendant: off by default, and while it is off nothing here runs and no model is called. On, it looks at a thread
 * when a run of it ended, when it asks a question, and (optionally) every N minutes, one thread at a time, and it does four things: names a
 * thread that has no name, keeps a one-line summary (the sidebar's meta line), proposes labels for fork points and drafts answers to
 * mechanical questions. It writes only titles (into pi's `session_info` through `ThreadsService.patch`, so the CLI sees them) and
 * its own tables; labels and answers are suggestions that wait for the user. Everything it did is in `attendant_actions`, with the cost.
 */
@Injectable()
export class AttendantService implements OnModuleInit, OnModuleDestroy {
  private promptValidator?: (suggestion: ThreadSuggestion & { threadId: string }) => Promise<boolean>;

  setPromptValidator(validate: (suggestion: ThreadSuggestion & { threadId: string }) => Promise<boolean>): void {
    this.promptValidator = validate;
  }
  private readonly logger = new Logger(AttendantService.name);
  private readonly queue: Job[] = [];
  private working = false;
  /** The thread whose task (work another service handed in) is running now. */
  private runningTask: string | undefined;
  /** The kind of the task that is running now (see `Job.key`). */
  private runningKey: string | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private readonly timers = new Set<NodeJS.Timeout>();
  /** The day (local) a "cap reached" skip was logged for, so it is listed once, not at every run. */
  private capLoggedDay: string | undefined;
  private stopped = false;
  /**
   * Every request in flight, with whose initiative it is. Switching the attendant off aborts all of its own (its loop and `complete` on its initiative, which can be in
   * flight at the same time), never a person's; the backend quitting aborts them all.
   */
  private readonly inFlight = new Map<AbortController, Initiative>();

  constructor(
    private readonly meta: MetaRepository,
    private readonly repo: AttendantRepository,
    private readonly threads: ThreadsService,
    private readonly threadRows: ThreadsRepository,
    private readonly status: ThreadStatusService,
    private readonly events: EventLogRepository,
    private readonly sessions: PiSessionService,
    private readonly model: AttendantModelPort,
    private readonly tree: TreeService,
  ) {}

  onModuleInit(): void {
    this.events.onRunChange((threadId, change) => {
      if (change !== 'end' || !this.settings().enabled || !this.settings().when.onEnd) return;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.enqueue(threadId, 'end');
      }, END_DELAY_MS);
      timer.unref();
      this.timers.add(timer);
    });
    this.sessions.onDialogsChanged((threadId) => {
      const settings = this.settings();
      if (settings.enabled && settings.when.onInterrupt && this.sessions.pendingDialogs(threadId).length > 0) this.enqueue(threadId, 'interrupt');
    });
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const controller of this.inFlight.keys()) controller.abort('cancelled' satisfies AbortReason);
    clearInterval(this.sweepTimer);
    for (const timer of this.timers) clearTimeout(timer);
  }

  // ---- settings and status

  settings(): AttendantSettings {
    const saved = this.meta.getSetting(SETTINGS_KEY) as Partial<AttendantSettings> | undefined;
    const merged = { ...DEFAULT_ATTENDANT_SETTINGS, ...saved, when: { ...DEFAULT_ATTENDANT_SETTINGS.when, ...saved?.when } };
    const parsed = AttendantSettingsSchema.safeParse(merged);
    return parsed.success ? parsed.data : DEFAULT_ATTENDANT_SETTINGS;
  }

  patch(patch: PatchAttendantSettings): AttendantSettings {
    const before = this.settings();
    const next: AttendantSettings = {
      ...before,
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.followUpSuggestions !== undefined ? { followUpSuggestions: patch.followUpSuggestions } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.dailyCostCap !== undefined ? { dailyCostCap: patch.dailyCostCap } : {}),
      when: { ...before.when, ...patch.when },
    };
    this.meta.setSetting(SETTINGS_KEY, next);
    this.schedule();
    // Switched off: what is queued is dropped and every request in flight on the attendant's own initiative is aborted, so not one more model call is made on it.
    // A person's request (`complete` with initiative `person`) goes on: they asked for it, and the switch is about what the attendant does by itself.
    if (!next.enabled) {
      this.queue.length = 0;
      for (const [controller, initiative] of this.inFlight) if (initiative === 'attendant') controller.abort('off' satisfies AbortReason);
    }
    if (!next.enabled || !next.followUpSuggestions) {
      this.repo.expirePrompts();
      this.status.touchAll();
    }
    // Switching it on takes a first look at the threads that most need one.
    if (next.enabled && !before.enabled) this.sweep();
    return next;
  }

  async statusReport(): Promise<AttendantStatus> {
    const settings = this.settings();
    const today = this.repo.usageSince(startOfDay());
    let active: ModelChoice | undefined;
    try {
      active = await this.model.resolve(settings);
    } catch (error) {
      this.logger.debug(`No model for the attendant: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      settings,
      calls: this.model.calls,
      today,
      capReached: this.capReached(settings),
      queued: this.queue.length + (this.working ? 1 : 0),
      activeModel: active ? labelOf(active) : null,
      actions: this.repo.actions(100),
    };
  }

  // ---- scheduling

  /** The sweep timer follows the settings: on while the attendant is on and `everyMinutes` is set. */
  private schedule(): void {
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    const settings = this.settings();
    if (this.stopped || !settings.enabled || settings.when.everyMinutes <= 0) return;
    this.sweepTimer = setInterval(() => this.sweep(), settings.when.everyMinutes * 60_000);
    this.sweepTimer.unref();
  }

  /** Looks at the most recent threads whose file changed since the attendant last went over them. */
  sweep(limit = SWEEP_LIMIT): number {
    if (!this.settings().enabled) return 0;
    let queued = 0;
    const rows = this.threadRows.all().sort((a, b) => b.updatedAt - a.updatedAt);
    for (const row of rows) {
      if (queued >= limit) break;
      if (row.archived || row.messageCount === 0 || !this.projectAllowed(row.cwd) || this.meta.isVerificationThread(row.id)) continue;
      if (this.repo.meta(row.id)?.lookedFor === sessionMtime(row.sessionPath)) continue;
      this.enqueue(row.id, 'sweep');
      queued += 1;
    }
    return queued;
  }

  /** `POST /api/attendant/run`: now, for one thread or for the sweep's selection; refused while the attendant is off. */
  run(threadId?: string): number {
    if (!this.settings().enabled) throw new ConflictException('The attendant is off.');
    if (!threadId) return this.sweep();
    const row = this.threadRows.get(threadId);
    if (!row) throw new NotFoundException(`Thread ${threadId} not found.`);
    this.enqueue(threadId, 'manual');
    return 1;
  }

  /**
   * Work another service wants done in the attendant's line (drafting a skill after an outcome): it waits behind the job in flight, ahead of the sweep, and is dropped
   * when the attendant is off or the thread's project opted out. One task per thread and kind (`key`: `learn` by default, the Meat Proxy Score uses `score`) at a time.
   */
  enqueueTask(threadId: string, task: () => Promise<void>, key = 'learn'): boolean {
    const row = this.threadRows.get(threadId);
    if (this.stopped || !this.settings().enabled || !row || !this.projectAllowed(row.cwd)) return false;
    if ((this.runningTask === threadId && this.runningKey === key) || this.queue.some((job) => job.task && job.threadId === threadId && (job.key ?? 'learn') === key)) return false;
    this.insert({ threadId, reason: 'learn', task, key });
    void this.drain();
    return true;
  }

  /** `provider/id` of the model a request would go to now, or `null` when none is available. */
  async modelLabel(): Promise<string | null> {
    const choice = await this.model.resolve(this.settings()).catch(() => undefined);
    return choice ? labelOf(choice) : null;
  }

  /**
   * One capped model call for a service that is not the attendant's own loop (the plugin API's `pi-kit:attendant:run`). `initiative` says who asked: `attendant` (its own
   * trigger, so it only runs while the attendant is on) or `person` (a request, which runs while it is off too, after the caller got the person's consent). The day's cap holds for
   * both. The call is listed in the activity with its cost; `describe` turns the answer into the line the list shows.
   *
   * `signal` is the caller's own cancellation (the HTTP request that asked for the scoring closed): the model request is aborted with it, and a signal that is aborted already
   * makes no call at all. An aborted call answers `failed` and is not listed as an error; switching the attendant off aborts only its own initiative, the backend quitting aborts every call.
   */
  async complete(
    row: ThreadRow,
    prompt: Prompt,
    options: { kind: AttendantKind; initiative: Initiative; describe: (text: string) => { status: 'done' | 'error'; text: string }; signal?: AbortSignal },
  ): Promise<Completion> {
    const settings = this.settings();
    if (options.initiative === 'attendant' && !settings.enabled) return { ok: false, code: 'off', error: 'The attendant is off.' };
    if (this.stopped || options.signal?.aborted) return CANCELLED;
    const controller = new AbortController();
    const cancel = (): void => controller.abort('cancelled' satisfies AbortReason);
    options.signal?.addEventListener('abort', cancel, { once: true });
    this.inFlight.set(controller, options.initiative);
    let choice: ModelChoice | undefined;
    try {
      if (this.capReached(settings)) {
        this.logCapReached(settings, row);
        return { ok: false, code: 'cap', error: `The attendant’s daily cost cap of $${settings.dailyCostCap?.toFixed(2)} is reached; it rests until tomorrow.` };
      }
      choice = await this.model.resolve(settings).catch(() => undefined);
      if (!choice) {
        this.record(options.kind, 'skipped', row, 'No model is available for the attendant.');
        return { ok: false, code: 'no-model', error: 'No model is available. Choose one in Settings › Attendant, or set up a provider.' };
      }
      // The caller went away, or the attendant was switched off, while the model was being chosen: no call.
      if (controller.signal.aborted) return abortedCompletion(controller.signal);
      const reply = await this.model.ask(prompt, choice, controller.signal);
      if (controller.signal.aborted) return abortedCompletion(controller.signal);
      const line = options.describe(reply.text);
      this.record(options.kind, line.status, row, line.text, { model: reply.model, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, cost: reply.cost });
      return { ok: true, text: reply.text, model: reply.model, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, cost: reply.cost };
    } catch (error) {
      if (controller.signal.aborted) return abortedCompletion(controller.signal);
      const message = error instanceof Error ? error.message : String(error);
      this.record(options.kind, 'error', row, message, choice ? { model: labelOf(choice) } : {});
      return { ok: false, code: 'failed', error: message };
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      this.inFlight.delete(controller);
    }
  }

  /** A line in the activity list for something another service decided not to do or did (no model call). */
  note(kind: AttendantKind, row: ThreadRow, text: string, status: 'done' | 'skipped' | 'error' = 'skipped', usage: { model?: string; inputTokens?: number; outputTokens?: number; cost?: number } = {}): void {
    this.record(kind, status, row, text, usage);
  }

  /** The project (a folder) lets the attendant act: Settings › Attendant, per-project switch. */
  allowedIn(cwd: string): boolean {
    return this.projectAllowed(cwd);
  }

  /**
   * Queues a thread. A question goes first; a run that ended and the user's own request go ahead of the sweep's jobs (a sweep over the history must not make a
   * thread you just finished wait behind ten others); a thread that is queued already is not queued twice, and a sweep job that gets a better reason
   * moves forward.
   */
  enqueue(threadId: string, reason: Reason): void {
    if (this.stopped || !this.settings().enabled) return;
    const waiting = this.queue.findIndex((job) => job.threadId === threadId && !job.task);
    if (waiting >= 0) {
      if (reason === 'sweep') return;
      const [job] = this.queue.splice(waiting, 1);
      // A question outranks the rest: its job should draft the answer.
      job.reason = reason === 'interrupt' || job.reason === 'interrupt' ? 'interrupt' : reason;
      this.insert(job);
    } else {
      this.insert({ threadId, reason });
    }
    void this.drain();
  }

  private insert(job: Job): void {
    const firstSweep = this.queue.findIndex((queued) => queued.reason === 'sweep');
    // A question is waiting for its draft: first. The rest of the user-driven jobs keep their order, ahead of the sweep.
    const at = job.reason === 'interrupt' ? 0 : job.reason === 'sweep' || firstSweep < 0 ? this.queue.length : firstSweep;
    this.queue.splice(at, 0, job);
  }

  /** Jobs run one at a time: a local model cannot do two at once, and a hosted one should not be hit in bursts. */
  async drain(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (let job = this.queue.shift(); job && !this.stopped; job = this.queue.shift()) {
        try {
          if (job.task) {
            this.runningTask = job.threadId;
            this.runningKey = job.key ?? 'learn';
            try {
              await job.task();
            } finally {
              this.runningTask = undefined;
              this.runningKey = undefined;
            }
          } else await this.process(job.threadId, job.reason);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`The attendant failed on thread ${job.threadId}: ${message}`);
          this.record('summary', 'error', this.threadRows.get(job.threadId), message);
        }
      }
    } finally {
      this.working = false;
    }
  }

  /** Resolves when the queue is empty and nothing is running (tests, and `POST /run` callers that want to wait). */
  async idle(): Promise<void> {
    while (this.working || this.queue.length > 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // ---- one thread

  async process(threadId: string, reason: Reason): Promise<void> {
    const settings = this.settings();
    if (!settings.enabled) return;
    const row = this.threadRows.get(threadId);
    // A verification run is pi-kit's own scratch thread: it is neither named, summarised nor looked at.
    if (!row || row.archived || !this.projectAllowed(row.cwd) || this.meta.isVerificationThread(threadId) || this.meta.learningSource(threadId)) return;
    if (row.messageCount === 0 && reason !== 'interrupt') return;
    // The title is written into the session file; a thread in the middle of a run is looked at when the run ends.
    if (reason !== 'interrupt' && this.events.lastRun(threadId)?.status === 'running') return;
    if (this.capReached(settings)) return this.logCapReached(settings, row);
    const choice = await this.model.resolve(settings);
    if (!choice) return void this.record('summary', 'skipped', row, 'No model is available for the attendant.');

    const source = await this.threads.treeSource(threadId);
    const digest = digestOf(source.entries, source.leafId);
    const dialogs = this.sessions.pendingDialogs(threadId);
    const question = dialogs[0]?.request.title;
    const startMtime = sessionMtime(row.sessionPath);
    const meta = this.repo.meta(threadId);

    // 1. a name for a thread that has none
    if (row.title === null && digest.answered) {
      const title = await this.ask('title', row, titlePrompt(digest), choice, cleanTitle);
      if (title && this.threadRows.get(threadId)?.title === null) {
        await this.threads.patch(threadId, { title });
      }
    }

    // 2. the one-line status, the sidebar's meta line
    if (digest.recent.length > 0 && (reason === 'interrupt' || reason === 'manual' || question || meta?.summaryFor !== startMtime)) {
      const summary = await this.ask('summary', row, summaryPrompt(digest, question), choice, cleanSummary);
      if (summary) {
        this.repo.setSummary(threadId, summary, sessionMtime(row.sessionPath));
        this.status.touch(threadId);
      }
    }

    // 3. labels for the fork points that have none
    await this.proposeLabels(row, source.entries, source.leafId, choice);

    // 4. answers to mechanical questions
    await this.draftAnswers(row, digest, choice);

    this.repo.markLooked(threadId, sessionMtime(row.sessionPath));
    this.status.touch(threadId);
  }

  private async proposeLabels(row: ThreadRow, entries: Parameters<typeof buildSessionTree>[0], leafId: string | null, choice: ModelChoice): Promise<void> {
    if (row.forkCount === 0) return;
    const tree = buildSessionTree(entries, leafId);
    let made = 0;
    for (const point of tree.rows) {
      if (made >= LABELS_PER_PASS) break;
      if (point.kind !== 'turn' || point.childCount < 2 || point.label || !point.onActivePath) continue;
      if (this.repo.hasSuggestion(row.id, 'label', point.id)) continue;
      const branches = tree.rows.filter((r) => r.parentId === point.id && r.kind === 'turn').map((r) => r.preview);
      const label = await this.ask('label', row, labelPrompt({ preview: point.preview, branches }), choice, cleanLabel, (text) =>
        this.repo.addSuggestion({ threadId: row.id, kind: 'label', target: point.id, text, reason: `Turn ${point.number} splits into ${branches.length} directions.` }),
      );
      if (label) made += 1;
    }
    if (made > 0) this.status.touch(row.id);
  }

  private async draftAnswers(row: ThreadRow, digest: ThreadDigest, choice: ModelChoice): Promise<void> {
    for (const dialog of this.sessions.pendingDialogs(row.id)) {
      const options = answerOptions(dialog.request);
      if (!options) continue;
      if (this.repo.openSuggestions(row.id).some((s) => s.kind === 'answer' && s.target === dialog.id)) continue;
      const reply = await this.call('draft', row, draftPrompt(dialog.request, options, digest), choice);
      if (!reply) continue;
      const picked = parseChoice(reply.reply.text, options);
      if (picked) {
        this.repo.addSuggestion({ threadId: row.id, kind: 'answer', target: dialog.id, text: picked, reason: `Suggested for “${dialog.request.title}”. Your choice.` });
        this.finish(reply, 'draft', row, `Suggested “${picked}” for “${dialog.request.title}”`);
        this.status.touch(row.id);
      } else {
        this.finish(reply, 'draft', row, `No draft for “${dialog.request.title}”: not a routine question, left to you`);
      }
    }
  }

  // ---- suggestions

  /** The user accepted a suggestion. A label is applied (the thread must be idle); an answer was given by the user in the approval, this only closes it. */
  async accept(id: number): Promise<void> {
    const suggestion = this.repo.suggestion(id);
    if (!suggestion || suggestion.state !== 'open') throw new NotFoundException(`Suggestion ${id} is not open.`);
    // A drafted skill is settled by its review (approve or discard), never by this route.
    if (suggestion.kind === 'learn') throw new ConflictException('Read the drafted skill and approve or discard it.');
    if (suggestion.kind === 'prompt' && !(await this.promptValidator?.(suggestion))) {
      this.repo.setSuggestionState(id, 'dismissed');
      this.status.touch(suggestion.threadId);
      throw new ConflictException('This follow-up no longer matches the conversation.');
    }
    if (suggestion.kind === 'label') {
      try {
        await this.tree.label(suggestion.threadId, suggestion.target, suggestion.text);
      } catch (error) {
        throw new ConflictException(error instanceof Error ? error.message : String(error));
      }
    }
    this.repo.setSuggestionState(id, 'accepted');
    this.status.touch(suggestion.threadId);
  }

  dismiss(id: number): void {
    const suggestion = this.repo.suggestion(id);
    if (!suggestion || suggestion.state !== 'open') throw new NotFoundException(`Suggestion ${id} is not open.`);
    this.repo.setSuggestionState(id, 'dismissed');
    this.status.touch(suggestion.threadId);
  }

  // ---- model calls

  /** One request whose answer is cleaned into text; records it as an action, `onResult` runs for a usable answer before it is recorded. */
  private async ask(kind: AttendantKind, row: ThreadRow, prompt: Prompt, choice: ModelChoice, clean: (text: string) => string | undefined, onResult?: (text: string) => void): Promise<string | undefined> {
    const reply = await this.call(kind, row, prompt, choice);
    if (!reply) return undefined;
    const text = clean(reply.reply.text);
    if (!text) {
      this.finish(reply, kind, row, 'The model’s answer was not usable.', 'error');
      return undefined;
    }
    onResult?.(text);
    this.finish(reply, kind, row, text);
    return text;
  }

  /** The request itself, refused when the day's cap is reached; a failed request is an action of status `error`. */
  private async call(kind: AttendantKind, row: ThreadRow, prompt: Prompt, choice: ModelChoice): Promise<{ reply: ModelReply } | undefined> {
    const settings = this.settings();
    if (this.stopped || !settings.enabled) return undefined;
    if (this.capReached(settings)) {
      this.logCapReached(settings, row);
      return undefined;
    }
    const controller = new AbortController();
    this.inFlight.set(controller, 'attendant');
    try {
      return { reply: await this.model.ask(prompt, choice, controller.signal) };
    } catch (error) {
      // Aborted because it was switched off (or the backend is quitting): not an error worth listing.
      if (controller.signal.aborted) return undefined;
      this.record(kind, 'error', row, error instanceof Error ? error.message : String(error), { model: labelOf(choice) });
      return undefined;
    } finally {
      this.inFlight.delete(controller);
    }
  }

  private finish(result: { reply: ModelReply }, kind: AttendantKind, row: ThreadRow, text: string, status: 'done' | 'error' = 'done'): void {
    const { reply } = result;
    this.record(kind, status, row, text, { model: reply.model, inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, cost: reply.cost });
  }

  private record(
    kind: AttendantKind,
    status: 'done' | 'skipped' | 'error',
    row: ThreadRow | undefined,
    text: string,
    usage: { model?: string; inputTokens?: number; outputTokens?: number; cost?: number } = {},
  ): void {
    this.repo.addAction({ kind, status, threadId: row?.id ?? null, threadTitle: row ? (row.title ?? row.preview?.slice(0, 80) ?? null) : null, text, ...usage });
  }

  // ---- limits

  private projectAllowed(cwd: string): boolean {
    return !this.meta.listWorkspaces().find((w) => w.cwd === cwd)?.attendantOff;
  }

  capReached(settings: AttendantSettings = this.settings()): boolean {
    return settings.dailyCostCap !== null && this.repo.usageSince(startOfDay()).cost >= settings.dailyCostCap;
  }

  private logCapReached(settings: AttendantSettings, row: ThreadRow | undefined): void {
    const day = new Date().toDateString();
    if (this.capLoggedDay === day) return;
    this.capLoggedDay = day;
    this.record('summary', 'skipped', row, `The daily cost cap of $${settings.dailyCostCap?.toFixed(2)} is reached; the attendant rests until tomorrow.`);
  }
}

/** What an aborted `complete` answers: the switch is named when it was the switch, otherwise the request was cancelled (by its caller, or because the backend quits). */
function abortedCompletion(signal: AbortSignal): Completion {
  return (signal.reason as AbortReason | undefined) === 'off' ? { ok: false, code: 'failed', error: 'The attendant was switched off.' } : CANCELLED;
}

/** Local midnight, in epoch milliseconds. */
export function startOfDay(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
