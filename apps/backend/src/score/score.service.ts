import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  AnnotateRequestSchema,
  AttendantRunRequestSchema,
  BaselinesRequestSchema,
  type BaselineFile,
  type HunkLabel,
  type OutcomeScoreView,
  OutcomeRequestSchema,
  OutsideEditsRequestSchema,
  PLUGIN_CHANNELS,
  type PluginFailure,
  type PluginFailureCode,
  type ProjectScores,
  type ScoreOverview,
  type ScoreRequestResult,
  type ThreadOutcome,
  effectiveHunks,
} from '@pi-kit/protocol';
import { AttendantService } from '../attendant/attendant.service';
import { branchOf } from '../attendant/attendant-text';
import { collectTouched } from '../changes/touched';
import { ChangesRepository } from '../db/changes.repository';
import { MetaRepository } from '../db/meta.repository';
import { type OutcomeRow, OutcomesRepository } from '../db/outcomes.repository';
import { SignalsRepository } from '../db/signals.repository';
import { type ThreadRow, ThreadsRepository } from '../db/threads.repository';
import { LearnService } from '../learn/learn.service';
import { type PluginReplyShape, PiPluginService } from '../pi/pi-plugin.service';
import { OutcomesService } from '../threads/outcomes.service';
import { ThreadStatusService } from '../threads/thread-status.service';
import { ThreadsService } from '../threads/threads.service';
import * as git from '../worktree/worktree-git';
import { type HostFailure, MeatProxyPackage, type ScoringHost, type ScoringResult } from './meat-proxy-package';
import { type ScoredThread, mergeLabels, parseLabelsStore, parseScores, projectScores, relabelHunk, scoreBadgeOf } from './score-rules';

const CONSENT_SETTING = 'score-consent';
const CONSENT_KEEP = 500;
const NOT_INSTALLED = 'The @pi-kit/meat-proxy package is not installed in pi (pi install <path to packages/pi-kit-meat-proxy>), so there is no score.';

export const scoreConsentSentence = (model: string): string =>
  `This sends the thread’s transcript (prompts, tool calls, review comments, the final diff and the files you changed by hand, with secrets masked) to ${model} to attribute each change to what you did. The attendant is off, so nothing else is ever sent for this thread.`;

/**
 * The Meat Proxy Score: the host side of the plugin events the package needs beyond `learn`'s (`baselines`, `outside-edits`, `annotate`, the outcome's stored
 * annotations, the attendant's `score` task), the attendant's fourth job (scoring a thread after its outcome lands, under its cap and per-project opt-out), and what the app asks
 * for: the score of a thread, scoring it now, relabelling a hunk, and the per-project distribution. Core stores and draws; the labelling and the arithmetic are the package's
 * (`lib/pipeline.mjs`), and nothing here is drawn while the package is not installed in pi.
 */
@Injectable()
export class ScoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScoreService.name);
  private readonly offs: (() => void)[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly outcomeRows: OutcomesRepository,
    private readonly outcomes: OutcomesService,
    private readonly threadRows: ThreadsRepository,
    private readonly threads: ThreadsService,
    private readonly learn: LearnService,
    private readonly signals: SignalsRepository,
    private readonly changes: ChangesRepository,
    private readonly attendant: AttendantService,
    private readonly plugins: PiPluginService,
    private readonly status: ThreadStatusService,
    private readonly meta: MetaRepository,
    private readonly pkg: MeatProxyPackage,
  ) {}

  onModuleInit(): void {
    const channels = [PLUGIN_CHANNELS.baselines, PLUGIN_CHANNELS.outsideEdits, PLUGIN_CHANNELS.annotate, PLUGIN_CHANNELS.outcome, PLUGIN_CHANNELS.attendant];
    this.offs.push(
      this.plugins.register(channels, (threadId, channel, payload, signal) => this.plugin(threadId, channel, payload, signal)),
      this.outcomes.onOutcome((threadId) => this.onOutcome(threadId)),
      this.pkg.onInstalledChange(() => this.status.touchAll()),
    );
    this.status.setScoreBadge((row) => this.badgeOf(row));
    void this.pkg
      .ensureInstalled()
      .catch((error: unknown) => this.logger.warn(`Could not install the meat-proxy package: ${error instanceof Error ? error.message : String(error)}`))
      .then(() => this.pkg.refresh())
      .then(() => this.status.touchAll())
      .catch(() => undefined);
    // `pi remove` and `pi install` happen outside pi-kit: look at pi's settings now and then, so the badge and the views follow.
    this.timer = setInterval(() => void this.pkg.refresh(), 5000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    for (const off of this.offs) off();
    this.status.setScoreBadge(undefined);
  }

  // ---- what the app reads

  private badgeOf(row: OutcomeRow) {
    if (!this.pkg.installedNow()) return undefined;
    return scoreBadgeOf(parseScores(row.scores), parseLabelsStore(row.hunkLabels), { base: row.baseCommit, head: row.headCommit });
  }

  /** The score of a thread's outcome with the label of every hunk, as they stand; 404 while there is none (or the package is gone: then nothing of it is drawn). */
  view(threadId: string): OutcomeScoreView {
    this.threads.assertExists(threadId);
    if (!this.pkg.installedNow()) throw new NotFoundException('There is no score: the meat-proxy package is not installed.');
    const row = this.outcomeRows.get(threadId);
    const store = parseLabelsStore(row?.hunkLabels);
    const scores = parseScores(row?.scores);
    if (!row || !store || !scores) throw new NotFoundException('This thread has not been scored.');
    const hunks = effectiveHunks(store);
    return {
      scores,
      hunks,
      model: store.model,
      at: store.at,
      stale: store.head !== row.headCommit || store.base !== row.baseCommit,
      base: store.base,
      head: store.head,
      corrected: Object.keys(store.corrections).filter((id) => store.labels.some((l) => l.id === id)).length,
    };
  }

  /** The distribution of the scored threads of every project (Settings › Projects and trust). Empty while the package is not installed. */
  overview(): ScoreOverview {
    const installed = this.pkg.installedNow();
    if (!installed) return { installed, projects: [] };
    const scored: ScoredThread[] = [];
    for (const [threadId, row] of this.outcomeRows.all()) {
      const scores = parseScores(row.scores);
      const thread = this.threadRows.get(threadId);
      if (!scores || !thread || !parseLabelsStore(row.hunkLabels)) continue;
      scored.push({ threadId, title: thread.title, cwd: thread.cwd, meat: scores.meat, line: scores.line, at: row.at });
    }
    const projects: ProjectScores[] = [...new Set(scored.map((s) => s.cwd))].map((cwd) => projectScores(cwd, scored));
    return { installed, projects };
  }

  // ---- what the app asks for

  /**
   * Score the thread now (the badge menu): with the attendant off, the first request answers `consent`; send it again with `consent: true` once the person agreed.
   * `signal` is the request's own life: when it aborts (the client closed the connection), the model call in flight is aborted, no further batch is sent and nothing is stored.
   */
  async request(threadId: string, options: { consent?: boolean } = {}, signal?: AbortSignal): Promise<ScoreRequestResult> {
    const row = this.require(threadId);
    if (!(await this.pkg.refresh())) throw new ConflictException(NOT_INSTALLED);
    if (!this.outcomes.get(threadId)) throw new ConflictException('This thread has no outcome yet, so there is nothing to score. It gets one when its worktree is merged back, a pull request is opened, or a commit contains files it changed.');
    const needed = await this.consentNeeded(threadId, options.consent === true);
    if (needed) return { status: 'consent', model: needed.model, message: needed.message };
    const result = await this.score(row, 'person', signal);
    if (!result.ok) {
      if (result.code === 'not-found') throw new NotFoundException(result.error);
      throw new ConflictException(result.error);
    }
    return { status: 'scored', score: this.view(threadId) };
  }

  /** The person says what a hunk is; the score is computed again from the labels as they stand, and the correction is kept for the next scoring of the thread. */
  async relabel(threadId: string, hunk: string, label: HunkLabel | null): Promise<OutcomeScoreView> {
    this.threads.assertExists(threadId);
    const module = await this.pkg.scoring();
    if (!module) throw new ConflictException(NOT_INSTALLED);
    const row = this.outcomeRows.get(threadId);
    const store = parseLabelsStore(row?.hunkLabels);
    if (!row || !store) throw new NotFoundException('This thread has not been scored.');
    const next = relabelHunk(store, hunk, label, Date.now());
    if (!next) throw new NotFoundException('The thread’s outcome has no such hunk.');
    const scores = module.computeScores(effectiveHunks(next));
    if (!scores) throw new BadRequestException('The outcome has no changed lines to weigh.');
    this.outcomeRows.setAnnotations(threadId, { hunkLabels: next, scores });
    this.status.touch(threadId);
    return this.view(threadId);
  }

  // ---- scoring

  /** The whole scoring of a thread through the package's pipeline, against a host that answers from pi-kit's own records. `signal`: the caller's cancellation, see `request`. */
  async score(row: ThreadRow, initiative: 'attendant' | 'person', signal?: AbortSignal): Promise<ScoringResult> {
    const module = await this.pkg.scoring();
    if (!module) return { ok: false, code: 'off', error: NOT_INSTALLED };
    return module.scoreThread(this.hostFor(row, initiative, signal));
  }

  private hostFor(row: ThreadRow, initiative: 'attendant' | 'person', signal?: AbortSignal): ScoringHost {
    const id = row.id;
    return {
      outcome: async () => ({ ok: true, ...(await this.outcomeReply(row, true)) }),
      transcript: async () => ({ ok: true, transcript: await this.learn.transcriptOf(id) }),
      baselines: async () => ({ ok: true, files: await this.baselinesOf(row) }),
      outsideEdits: async () => ({ ok: true, edits: this.signals.outsideEdits(id) }),
      // Every batch is its own capped call in the attendant's activity: a long diff shows its progress there, and switching the attendant off stops the next one.
      // The caller's signal rides along: an aborted one makes the call in flight fail and the next one answer `failed` before any model is asked, and the pipeline stops there without storing.
      run: async (prompt, { batch, batches }) => {
        const text = batches > 1 ? `Attributed the outcome’s hunks to what you did (batch ${batch} of ${batches})` : 'Attributed the outcome’s hunks to what you did';
        const completion = await this.attendant.complete(row, prompt, { kind: 'score', initiative, signal, describe: () => ({ status: 'done', text }) });
        return completion.ok ? { ok: true, text: completion.text, model: completion.model } : { ok: false, code: completion.code, error: completion.error };
      },
      // The same signal guards the write: a cancellation that lands after the last model reply, or before a scoring that needs no model, stores nothing either.
      annotate: async (body) => this.store(id, { requestId: 'pi-kit', ...body }, signal),
    };
  }

  // ---- the attendant's fourth job

  private onOutcome(threadId: string): void {
    if (!this.attendant.settings().enabled) return;
    const outcome = this.outcomeRows.get(threadId);
    const store = parseLabelsStore(outcome?.hunkLabels);
    // Scored already for this very outcome: only a later commit (a longer outcome) is scored again.
    if (outcome && store && store.head === outcome.headCommit && store.base === outcome.baseCommit) return;
    this.attendant.enqueueTask(threadId, async () => void (await this.autoScore(threadId)), 'score');
  }

  /** Scores without being asked. Runs in the attendant's queue, under its cap; the activity lists the call as `score` and then the result. */
  async autoScore(threadId: string): Promise<'scored' | 'skipped'> {
    const row = this.threadRows.get(threadId);
    if (!row || !this.attendant.settings().enabled || !this.attendant.allowedIn(row.cwd)) return 'skipped';
    if (!(await this.pkg.refresh())) return 'skipped';
    const result = await this.score(row, 'attendant');
    if (result.ok) {
      this.attendant.note('score', row, result.scores.line, 'done');
      return 'scored';
    }
    // The cap and a missing model are listed by the attendant itself; what is left is the thread's own reason.
    if (result.code === 'invalid' || result.code === 'not-found') this.attendant.note('score', row, result.error, 'skipped');
    else this.logger.debug(`No score for ${threadId}: ${result.error}`);
    return 'skipped';
  }

  // ---- the plugin API

  /**
   * One `pi-kit:*` request of an extension that is about scoring (or that learn's host hands over because it carries `annotations` or the task `score`).
   * `signal` is the session's binding (`PiPluginService`): when the session closes, the model call it asked for is aborted and nothing is stored for it.
   */
  async plugin(sessionThread: string, channel: string, payload: unknown, signal?: AbortSignal): Promise<PluginReplyShape | undefined> {
    const requestId = (payload as { requestId?: unknown } | null | undefined)?.requestId;
    if (typeof requestId !== 'string' || !requestId) return undefined;
    const fail = (code: PluginFailureCode, error: string, extra: { model?: string } = {}): PluginFailure => ({ requestId, ok: false, code, error, ...extra });
    const raw = payload as Record<string, unknown>;
    // Everything the learn plugin already used stays learn's: only the new ways of asking are answered here.
    if (channel === PLUGIN_CHANNELS.outcome && raw['annotations'] !== true) return this.learn.plugin(sessionThread, channel, payload, signal);
    if (channel === PLUGIN_CHANNELS.attendant && raw['task'] !== 'score') return this.learn.plugin(sessionThread, channel, payload, signal);
    try {
      switch (channel) {
        case PLUGIN_CHANNELS.baselines: {
          const request = BaselinesRequestSchema.safeParse(payload);
          if (!request.success) return fail('invalid', request.error.issues.map((i) => i.message).join('; '));
          const row = this.lookup(request.data.thread ?? sessionThread);
          return row ? { requestId, ok: true, files: await this.baselinesOf(row) } : fail('not-found', 'There is no such thread.');
        }
        case PLUGIN_CHANNELS.outsideEdits: {
          const request = OutsideEditsRequestSchema.safeParse(payload);
          if (!request.success) return fail('invalid', request.error.issues.map((i) => i.message).join('; '));
          const row = this.lookup(request.data.thread ?? sessionThread);
          return row ? { requestId, ok: true, edits: this.signals.outsideEdits(row.id) } : fail('not-found', 'There is no such thread.');
        }
        case PLUGIN_CHANNELS.annotate: {
          const request = AnnotateRequestSchema.safeParse(payload);
          if (!request.success) return fail('invalid', request.error.issues.map((i) => i.message).join('; '));
          const row = this.lookup(request.data.thread ?? sessionThread);
          if (!row) return fail('not-found', 'There is no such thread.');
          const stored = await this.store(row.id, request.data, signal);
          return stored.ok ? { requestId, ok: true } : fail(stored.code as PluginFailureCode, stored.error);
        }
        case PLUGIN_CHANNELS.outcome: {
          const request = OutcomeRequestSchema.safeParse(payload);
          if (!request.success) return fail('invalid', request.error.issues.map((i) => i.message).join('; '));
          const row = this.lookup(request.data.thread ?? sessionThread);
          if (!row) return fail('not-found', 'There is no such thread.');
          const reply = await this.outcomeReply(row, request.data.diff === true);
          return { requestId, ok: true, outcome: reply.outcome, ...(request.data.diff ? { diff: reply.diff } : {}), annotations: reply.annotations };
        }
        case PLUGIN_CHANNELS.attendant: {
          const request = AttendantRunRequestSchema.safeParse(payload);
          if (!request.success) return fail('invalid', request.error.issues.map((i) => i.message).join('; '));
          const row = this.lookup(request.data.thread ?? sessionThread);
          if (!row) return fail('not-found', 'There is no such thread.');
          const needed = await this.consentNeeded(row.id, request.data.consent === true);
          if (needed) return fail('consent', needed.message, { model: needed.model });
          const completion = await this.attendant.complete(row, { system: request.data.system, user: request.data.user }, { kind: 'score', initiative: 'person', signal, describe: () => ({ status: 'done', text: 'Attributed the outcome’s hunks for /score' }) });
          if (!completion.ok) return fail(completion.code, completion.error);
          return { requestId, ok: true, text: completion.text, model: completion.model, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, cost: completion.cost };
        }
        default:
          return fail('invalid', `pi-kit has no event named ${channel}.`);
      }
    } catch (error) {
      return fail('failed', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Stores what a plugin annotated; the person's corrections stay, and with any of them the score is computed again over the labels as they stand.
   * `signal` is the scoring's life (the request's, or the session's): one that is aborted by the time the write would happen stores nothing. The write itself is one call.
   */
  private async store(threadId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: true } | HostFailure> {
    const request = AnnotateRequestSchema.safeParse(body);
    if (!request.success) return { ok: false, code: 'invalid', error: request.error.issues.map((i) => i.message).join('; ') };
    const row = this.outcomeRows.get(threadId);
    if (!row) return { ok: false, code: 'not-found', error: 'This thread has no outcome to annotate.' };
    const labels = mergeLabels(parseLabelsStore(row.hunkLabels), request.data, Date.now());
    let scores = request.data.scores;
    if (labels && Object.keys(labels.corrections).length > 0) {
      const module = await this.pkg.scoring();
      scores = module?.computeScores(effectiveHunks(labels)) ?? scores;
    }
    if (signal?.aborted) return { ok: false, code: 'failed', error: 'The request was cancelled.' };
    this.outcomeRows.setAnnotations(threadId, { hunkLabels: labels, scores });
    this.status.touch(threadId);
    return { ok: true };
  }

  /** The outcome of a thread, its diff against the base (`--relative`, so the paths are the ones the Outcome view shows), and what plugins stored with it. */
  private async outcomeReply(row: ThreadRow, withDiff: boolean): Promise<{ outcome: ThreadOutcome | null; diff: string | null; annotations: { hunkLabels: unknown; scores: unknown } }> {
    const outcome = this.outcomes.get(row.id) ?? null;
    const stored = this.outcomeRows.get(row.id);
    let diff: string | null = null;
    if (withDiff && outcome) {
      // The project's folder, not the worktree's: the commits are in the shared repository, and the worktree may be removed any moment.
      const result = await git.run(row.cwd, ['diff', '--no-renames', '--relative', '-U3', `${outcome.base}..${outcome.head}`]);
      diff = result.ok ? result.stdout : null;
    }
    return { outcome, diff, annotations: { hunkLabels: stored?.hunkLabels ?? null, scores: stored?.scores ?? null } };
  }

  /** The files pi edited or wrote in the thread, with when and in which message it first touched each: never their content. */
  async baselinesOf(row: ThreadRow): Promise<BaselineFile[]> {
    const source = await this.threads.treeSource(row.id);
    const touched = new Map(collectTouched(branchOf(source.entries, source.leafId), row.sessionCwd || row.cwd).map((f) => [f.path, f] as const));
    return this.changes.touchedPaths(row.id).map(({ path, at }) => ({
      path,
      existed: this.changes.baseline(row.id, path)?.existed ?? true,
      at,
      turn: touched.get(path)?.turn ?? null,
      edits: touched.get(path)?.steps.length ?? 0,
    }));
  }

  // ---- consent (the attendant is off)

  private async consentNeeded(threadId: string, consent: boolean): Promise<{ model: string; message: string } | undefined> {
    if (this.attendant.settings().enabled || this.hasConsent(threadId)) return undefined;
    if (consent) {
      this.giveConsent(threadId);
      return undefined;
    }
    const model = (await this.attendant.modelLabel()) ?? 'the attendant’s model';
    return { model, message: scoreConsentSentence(model) };
  }

  private hasConsent(threadId: string): boolean {
    return ((this.meta.getSetting(CONSENT_SETTING) as string[] | undefined) ?? []).includes(threadId);
  }

  private giveConsent(threadId: string): void {
    const known = (this.meta.getSetting(CONSENT_SETTING) as string[] | undefined) ?? [];
    this.meta.setSetting(CONSENT_SETTING, [...known.filter((id) => id !== threadId), threadId].slice(-CONSENT_KEEP));
  }

  // ---- lookups

  /** A thread id, or the start of one when it is unique. */
  private lookup(idOrPrefix: string): ThreadRow | undefined {
    const exact = this.threadRows.get(idOrPrefix);
    if (exact) return exact;
    const matches = this.threadRows.all().filter((row) => row.id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private require(threadId: string): ThreadRow {
    const row = this.threadRows.get(threadId);
    if (!row) throw new NotFoundException(`Thread ${threadId} not found.`);
    return row;
  }
}
