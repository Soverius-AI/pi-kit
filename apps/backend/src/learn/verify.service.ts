import { existsSync } from 'node:fs';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  type SkillDraft,
  type SkillVerification,
  type StartVerify,
  type VerifiedCheck,
  type VerifyPlan,
  normalizeSkillText,
  parseSkillText,
  setSkillName,
  skillTextProblems,
  stampVerified,
  verificationSummary,
} from '@pi-kit/protocol';
import { AguiService } from '../agui/agui.service';
import { AttendantService } from '../attendant/attendant.service';
import { MetaRepository } from '../db/meta.repository';
import { SkillDraftsRepository } from '../db/skill-drafts.repository';
import { type ThreadRow, ThreadsRepository } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { ResourcesService } from '../pi/resources.service';
import { runProcess } from '../pi/process-runner';
import { TrustService } from '../pi/trust.service';
import { OutcomesService } from '../threads/outcomes.service';
import { ThreadStatusService } from '../threads/thread-status.service';
import { ThreadsService } from '../threads/threads.service';
import * as git from '../worktree/worktree-git';
import { WorktreeService } from '../worktree/worktree.service';
import { LearnService } from './learn.service';
import { restampVerified, writeScratchSkill } from './skill-files';
import { type PlannedCheck, compareDiffs, firstPromptOf, modelOfSession, parseDiff, planChecks, skillHash, tailOf, verdict } from './verify-rules';

/** Keep only the report's output tail in memory; output volume never terminates a command. */
const OUTPUT_TAIL_CHARS = 800;

/** A verification that could not be carried out: a sentence for the person, not a verdict on the skill. */
class VerifyError extends Error {}

interface Active {
  abort: AbortController;
  threadId?: string;
  done: Promise<SkillVerification>;
}

/**
 * Verification: a draft skill is replayed from the commit its thread started from, in a scratch worktree, and the result is compared with what the thread produced.
 *
 * The replay is a normal thread of the project while it runs: made with `ThreadsService.create` in a worktree cut at the outcome's base commit (`WorktreeService`, under the worktree root),
 * titled "Verify: name", marked as a verification thread (so the attendant leaves it alone and it never gets an outcome of its own), run with the thread's first prompt and the draft pinned as a
 * skill chip through the same runner a message from the composer takes, so it shows in the sidebar, streams to anyone who opens it and can be stopped. Nothing is pushed or merged. Afterwards
 * the scratch worktree and its branch are removed and the thread is archived as the record of the run; it cannot run again (`ThreadsService.prepareRun`).
 */
@Injectable()
export class VerifyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VerifyService.name);
  private readonly active = new Map<string, Active>();
  private readonly starting = new Set<string>();
  private closing = false;

  constructor(
    private readonly drafts: SkillDraftsRepository,
    private readonly threadRows: ThreadsRepository,
    private readonly threads: ThreadsService,
    private readonly worktrees: WorktreeService,
    private readonly outcomes: OutcomesService,
    private readonly sessions: PiSessionService,
    private readonly trust: TrustService,
    private readonly agui: AguiService,
    private readonly attendant: AttendantService,
    private readonly resources: ResourcesService,
    private readonly meta: MetaRepository,
    private readonly status: ThreadStatusService,
    private readonly learn: LearnService,
  ) {}

  onModuleInit(): void {
    this.learn.useVerifier(this);
    this.outcomes.excludeThreads((threadId) => this.meta.isVerificationThread(threadId));
    // A verification that was running when the app closed has nobody left to finish it: it says so, and its scratch worktree goes.
    for (const draft of this.drafts.verifying()) void this.recover(draft).catch((error: unknown) => this.logger.warn(`Could not recover the verification of ${draft.name}: ${error instanceof Error ? error.message : String(error)}`));
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    const active = [...this.active.values()];
    for (const entry of active) {
      entry.abort.abort();
      if (entry.threadId && this.sessions.has(entry.threadId)) void this.sessions.abort(entry.threadId).catch(() => undefined);
    }
    await Promise.allSettled(active.map((entry) => entry.done));
  }

  private async recover(draft: SkillDraft): Promise<void> {
    const record = draft.verification;
    this.drafts.setVerification(draft.id, { ...(record ?? { state: 'error' }), state: 'error', phase: undefined, finishedAt: Date.now(), error: 'The app was closed while the skill was being verified.' });
    this.status.touch(draft.threadId);
    const row = record?.threadId ? this.threadRows.get(record.threadId) : undefined;
    if (row) await this.cleanup(row, row.branch ?? undefined);
  }

  // ---- reads

  /** The record of a draft's last verification. */
  verificationOf(draftId: string): SkillVerification | null {
    return this.requireDraft(draftId).verification;
  }

  /** What a verification would do: the prompt it would send, the commit it starts from, the checks it repeats, and whether it can start. */
  async plan(draftId: string): Promise<VerifyPlan> {
    const draft = this.requireDraft(draftId);
    const row = this.threadRows.get(draft.threadId);
    const outcome = this.outcomes.get(draft.threadId);
    const busy = this.active.has(draftId) || draft.verification?.state === 'running';
    const blank: VerifyPlan = { canVerify: false, prompt: '', base: outcome?.base ?? null, head: outcome?.head ?? null, files: outcome?.files.length ?? 0, checks: [], model: null, busy };
    if (!row) return { ...blank, reason: 'The thread of this draft is gone.' };
    let prompt: string;
    let model: string | null;
    let checks: PlannedCheck[] = [];
    try {
      const source = await this.threads.treeSource(draft.threadId);
      prompt = firstPromptOf(source.entries, source.leafId);
      const used = modelOfSession(source.entries, source.leafId);
      model = used ? `${used.provider}/${used.modelId}` : null;
      if (outcome) checks = planChecks((await this.learn.transcriptOf(draft.threadId)).checks, this.foldersOf(row));
    } catch (error) {
      return { ...blank, reason: `The thread cannot be read: ${error instanceof Error ? error.message : String(error)}` };
    }
    const facts = { ...blank, prompt, model, checks };
    if (draft.state === 'discarded') return { ...facts, reason: 'This draft was discarded. Reopen it to verify it.' };
    if (busy) return { ...facts, reason: 'This draft is being verified now.' };
    if (!outcome) return { ...facts, reason: 'The thread has no outcome yet (merged, committed or a pull request), so there is no commit to replay from and nothing to compare with.' };
    if (!prompt) return { ...facts, reason: 'The thread has no first prompt to replay.' };
    if (!(await git.toplevel(row.cwd))) return { ...facts, reason: 'The project folder is not a git repository any more.' };
    if (!(await git.refExists(row.cwd, outcome.base)) || !(await git.refExists(row.cwd, outcome.head))) return { ...facts, reason: 'The commits of the outcome are not in the repository any more (rewritten or garbage collected).' };
    return { ...facts, canVerify: true };
  }

  // ---- start, wait, stop

  /**
   * Starts the replay and answers at once with the draft (its verification is `running`); the work goes on in the background. `text` and `name` are the person's edits in the dialog: they
   * become the draft's text (a pending draft only) and are what is replayed.
   */
  async start(draftId: string, body: StartVerify = {}): Promise<SkillDraft> {
    if (this.closing) throw new ConflictException('The app is closing.');
    let draft = this.requireDraft(draftId);
    if (draft.state === 'discarded') throw new ConflictException('This draft was discarded. Reopen it first.');
    if (this.starting.has(draftId) || this.active.has(draftId) || draft.verification?.state === 'running') throw new ConflictException('This draft is being verified already.');
    if (body.text !== undefined && draft.state === 'approved') throw new ConflictException('The skill is approved: its text is the file that was written. Edit the skill, or verify it as it is.');
    this.starting.add(draftId);
    try {
      if (body.text !== undefined) {
        const name = (body.name ?? parseSkillText(body.text).name ?? draft.name).trim();
        const text = normalizeSkillText(body.text, name);
        const problems = skillTextProblems(text);
        if (problems.length > 0) throw new BadRequestException(problems.join(' '));
        draft = this.drafts.edit(draftId, { name, text }) as SkillDraft;
      }
      const plan = await this.plan(draftId);
      if (this.closing) throw new ConflictException('The app is closing.');
      if (!plan.canVerify) throw new ConflictException(plan.reason ?? 'This draft cannot be verified now.');
      const prompt = body.prompt?.trim() || plan.prompt;
      const outcome = this.outcomes.get(draft.threadId);
      if (!outcome) throw new ConflictException('The thread has no outcome.');
      const warnings = outcome.baseSource === 'estimated' ? ['The base commit was estimated from the thread’s first message, so the replay may not start where the thread did.'] : [];
      const record: SkillVerification = {
        ...(draft.verification?.requested ? { requested: true } : {}),
        state: 'running',
        phase: 'worktree',
        startedAt: Date.now(),
        prompt,
        base: outcome.base,
        head: outcome.head,
        ...(plan.model ? { model: plan.model } : {}),
        skillHash: skillHash(draft.text),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
      this.drafts.setVerification(draftId, record);
      this.status.touch(draft.threadId);
      const entry: Active = { abort: new AbortController(), done: Promise.resolve(record) };
      entry.done = this.execute(draftId, entry, record, plan).finally(() => this.active.delete(draftId));
      this.active.set(draftId, entry);
      // The promise is awaited by the plugin API's callers; an unobserved failure is written into the record by `execute`.
      entry.done.catch(() => undefined);
      return this.requireDraft(draftId);
    } finally {
      this.starting.delete(draftId);
    }
  }

  /** Resolves with the record when the draft's running verification is over (at once when none is). */
  async whenDone(draftId: string): Promise<SkillVerification | null> {
    const entry = this.active.get(draftId);
    return entry ? entry.done : this.requireDraft(draftId).verification;
  }

  /** Stops a running verification: the replay's run is aborted and the work ends as `stopped`. */
  stop(draftId: string): SkillDraft {
    const draft = this.requireDraft(draftId);
    const entry = this.active.get(draftId);
    if (!entry) throw new ConflictException('This draft is not being verified.');
    entry.abort.abort();
    if (entry.threadId && this.sessions.has(entry.threadId)) void this.sessions.abort(entry.threadId).catch(() => undefined);
    this.status.touch(draft.threadId);
    return this.requireDraft(draftId);
  }

  // ---- the work

  private async execute(draftId: string, entry: Active, started: SkillVerification, plan: VerifyPlan): Promise<SkillVerification> {
    let record = started;
    const update = (patch: Partial<SkillVerification>): void => {
      record = { ...record, ...patch };
      this.drafts.setVerification(draftId, record);
      const current = this.drafts.get(draftId);
      if (current) this.status.touch(current.threadId);
    };
    const stopped = (): boolean => entry.abort.signal.aborted;
    let created: { row: ThreadRow; branch: string | undefined } | undefined;
    try {
      const draft = this.requireDraft(draftId);
      const origin = this.threadRows.get(draft.threadId);
      const outcome = this.outcomes.get(draft.threadId);
      if (!origin || !outcome) throw new VerifyError('The thread or its outcome is gone.');
      const project = origin.cwd;
      const checks = plan.checks;

      // 1. the scratch worktree and its thread
      let scratch = '';
      const detail = await this.threads.create(project, `Verify: ${draft.name}`, { base: outcome.base }, undefined, { setup: 'skip', onId: (threadId) => this.meta.markVerificationThread(threadId, draftId) }).catch((error: unknown) => {
        throw new VerifyError(`Could not make the scratch worktree: ${error instanceof Error ? error.message : String(error)}`);
      });
      entry.threadId = detail.id;
      scratch = detail.worktree?.path ?? '';
      created = { row: this.threadRows.get(detail.id) as ThreadRow, branch: detail.worktree?.branch ?? undefined };
      if (!scratch || !existsSync(scratch)) throw new VerifyError('The scratch worktree was not created.');
      update({ threadId: detail.id });
      if (stopped()) return await this.finish(draftId, record, 'stopped');

      const setup = this.worktrees.settingsOf(project).setup;
      if (setup) {
        const result = await this.shell(setup, scratch, entry);
        if (result.exitCode !== 0) update({ warnings: [...(record.warnings ?? []), `The project’s setup command failed (${result.exitCode === null ? 'it did not finish' : `exit ${result.exitCode}`}), so the checks may not run.`] });
        if (stopped()) return await this.finish(draftId, record, 'stopped');
      }

      const refused = await this.trust.trustScratch(scratch, project);
      if (refused) throw new VerifyError(refused);

      // The name pi lists the skill by in the scratch worktree: its own, unless pi has a skill of that name already (the approved copy), which would shadow it.
      const text = draft.text;
      const taken = await this.resources.overview(scratch).then((o) => o.items.some((item) => item.type === 'skills' && item.name === draft.name)).catch(() => false);
      const pinned = taken ? `${draft.name}-replay`.slice(0, 64) : draft.name;
      writeScratchSkill(scratch, pinned, taken ? setSkillName(text, pinned) : text, this.worktrees.rootOf(project));

      await this.threads.openSession(detail.id);
      if (plan.model) {
        const [provider, ...rest] = plan.model.split('/');
        await this.sessions.setModel(detail.id, { provider, modelId: rest.join('/') }).catch(() => update({ warnings: [...(record.warnings ?? []), `The thread’s model ${plan.model} is not available now, so the replay used pi’s default.`] }));
      }
      const used = this.sessions.stats(detail.id).model;
      const usedLabel = used ? `${used.provider}/${used.id}` : undefined;
      if (usedLabel) update({ model: usedLabel });
      // The replay counts under the attendant's daily cap when it runs on the attendant's own model.
      const attendantModel = await this.attendant.modelLabel();
      const onAttendantModel = !!usedLabel && usedLabel === attendantModel;
      if (onAttendantModel && this.attendant.capReached()) throw new VerifyError('The attendant’s daily cost cap is reached, and this replay would use its model. Try again tomorrow, or raise the cap in Settings › Attendant.');
      if (stopped()) return await this.finish(draftId, record, 'stopped');

      // 2. the run
      update({ phase: 'run' });
      const mainBefore = await this.snapshot(project);
      if (stopped()) return await this.finish(draftId, record, 'stopped');
      const run = await this.agui.runHeadless(detail.id, record.prompt ?? plan.prompt, { cwd: scratch, chips: [{ kind: 'skill', name: pinned, pinned: true }] });
      const usage = this.usageOf(detail.id);
      if (run.status === 'aborted' || stopped()) return await this.finish(draftId, { ...record, ...usage }, 'stopped');
      if (run.status === 'error') throw new VerifyError(`The replay failed: ${run.error ?? 'pi reported an error.'}`);
      if (run.status === 'interrupted') {
        const question = this.sessions.pendingDialogs(detail.id)[0]?.request.title;
        await this.sessions.abort(detail.id).catch(() => undefined);
        throw new VerifyError(`pi stopped to ask a question${question ? ` (“${question}”)` : ''} and nobody can answer a replay. A skill that makes pi ask is not reproducing the thread.`);
      }

      // 3. the comparison
      update({ phase: 'compare', ...usage });
      const [expected, actual] = await Promise.all([this.diffOf(project, ['diff', '--no-renames', '-U0', `${outcome.base}..${outcome.head}`]), this.replayDiff(scratch, outcome.base, pinned)]);
      const comparison = compareDiffs(parseDiff(expected), parseDiff(actual));
      const warnings = [...(record.warnings ?? [])];
      const mainAfter = await this.snapshot(project);
      if (mainBefore !== mainAfter) warnings.push('Something in the project folder changed while the replay ran. If it was not you, the replay wrote outside its scratch worktree: look at `git status` there.');
      if (stopped()) return await this.finish(draftId, { ...record, ...usage }, 'stopped');

      // 4. the checks of the original thread, again, in the scratch worktree (which holds the replay's result)
      update({ phase: 'checks', warnings });
      const rerun: VerifiedCheck[] = [];
      for (const check of checks) {
        if (stopped()) break;
        rerun.push(await this.runCheck(check, scratch, entry));
      }
      if (stopped()) return await this.finish(draftId, { ...record, ...usage }, 'stopped');

      const result = verdict(comparison, rerun.map((c) => ({ originalPassed: c.originalPassed, state: c.state })));
      const done: SkillVerification = {
        ...record,
        ...usage,
        state: 'done',
        phase: undefined,
        finishedAt: Date.now(),
        result,
        score: Math.round(comparison.score * 1000) / 1000,
        files: { reproduced: comparison.reproduced, expected: comparison.expected, extra: comparison.extra },
        hunks: comparison.hunks,
        fileList: comparison.files,
        checks: rerun,
        warnings,
      };
      done.summary = verificationSummary(done);
      if (onAttendantModel) this.attendant.note('learn', origin, `Verified the skill ${draft.name}: ${result}. ${done.summary}`, 'done', { model: usedLabel as string, inputTokens: usage.tokens ?? 0, outputTokens: 0, cost: usage.cost ?? 0 });
      else this.attendant.note('learn', origin, `Verified the skill ${draft.name}: ${result}. ${done.summary}`, 'done');
      return await this.finish(draftId, done, 'done');
    } catch (error) {
      const message = error instanceof VerifyError ? error.message : `The verification failed: ${error instanceof Error ? error.message : String(error)}`;
      if (!(error instanceof VerifyError)) this.logger.warn(`Verification of ${draftId} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      return await this.finish(draftId, { ...record, ...this.usageOfSafe(entry.threadId) }, 'error', message);
    } finally {
      if (created) await this.cleanup(created.row, created.branch).catch((error: unknown) => this.logger.warn(`Could not remove the scratch worktree: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /** Writes the end of a verification: the record, the verified marker in the draft text (and in the written file when approved), and the state push. */
  private async finish(draftId: string, record: SkillVerification, state: 'done' | 'stopped' | 'error', error?: string): Promise<SkillVerification> {
    const final: SkillVerification = { ...record, state, phase: undefined, finishedAt: record.finishedAt ?? Date.now(), ...(error ? { error } : {}) };
    this.drafts.setVerification(draftId, final);
    const draft = this.drafts.get(draftId);
    if (draft) {
      // The frontmatter states what was measured: a finished comparison. A stopped or failed one leaves `verified: null` (or the earlier result, which is still true of the text it measured).
      if (state === 'done') {
        const text = stampVerified(draft.text, final);
        if (text !== draft.text) this.drafts.edit(draftId, { text });
        if (draft.state === 'approved' && draft.path) restampVerified(draft.path, { name: draft.name, threadId: draft.threadId }, final);
      }
      this.status.touch(draft.threadId);
    }
    return final;
  }

  /** Removes the scratch worktree and its branch, forgets its trust, and archives the thread as the record of the run. */
  private async cleanup(row: ThreadRow, branch: string | undefined): Promise<void> {
    const threadId = row.id;
    if (this.sessions.has(threadId) && this.sessions.isStreaming(threadId)) {
      await this.sessions.abort(threadId).catch(() => undefined);
    }
    const fresh = this.threadRows.get(threadId) ?? row;
    const path = fresh.worktreePath;
    try {
      if (path) await this.worktrees.remove(fresh, { force: true }, branch);
    } finally {
      if (path) this.trust.forgetScratch(path);
      this.sessions.dispose(threadId);
      if (this.threadRows.get(threadId)) await this.threads.patch(threadId, { archived: true }).catch(() => undefined);
    }
  }

  // ---- git and the shell

  /** Everything in the project folder git could tell apart: what a run that wrote there would change. */
  private async snapshot(project: string): Promise<string> {
    const [head, status] = await Promise.all([git.run(project, ['rev-parse', 'HEAD']), git.run(project, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])]);
    return `${head.stdout.trim()}\n${status.stdout}`;
  }

  private async diffOf(folder: string, args: string[]): Promise<string> {
    const result = await git.run(folder, args);
    if (!result.ok) throw new VerifyError(`git could not read the diff: ${result.stderr}`);
    return result.stdout;
  }

  /** What the replay changed against the base: the scratch worktree's tracked and new files, not the pinned skill. Only the scratch worktree's own index is touched. */
  private async replayDiff(scratch: string, baseCommit: string, skill: string): Promise<string> {
    const added = await git.run(scratch, ['add', '-A', '--', '.', `:(exclude).pi/skills/${skill}`]);
    if (!added.ok) throw new VerifyError(`git could not stage the replay’s files: ${added.stderr}`);
    return this.diffOf(scratch, ['diff', '--cached', '--no-renames', '-U0', baseCommit]);
  }

  private async runCheck(check: PlannedCheck, cwd: string, entry: Active): Promise<VerifiedCheck> {
    if (check.skip) return { command: check.command, originalPassed: check.originalPassed, state: 'skipped', exitCode: null, seconds: 0, output: '', note: check.skip };
    const started = Date.now();
    const result = await this.shell(check.command, cwd, entry);
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    const cancelled = entry.abort.signal.aborted;
    return {
      command: check.command,
      originalPassed: check.originalPassed,
      state: result.exitCode === 0 ? 'passed' : 'failed',
      exitCode: result.exitCode,
      seconds,
      output: tailOf(result.output, OUTPUT_TAIL_CHARS),
      ...(cancelled ? { note: 'Stopped.' } : {}),
    };
  }

  /** A cancellable shell command whose complete process group belongs to this verification. */
  private async shell(command: string, cwd: string, entry: Active): Promise<{ exitCode: number | null; output: string }> {
    let output = '';
    const windows = process.platform === 'win32';
    try {
      const result = await runProcess({
        command: windows ? (process.env['ComSpec'] ?? 'cmd.exe') : '/bin/sh',
        args: windows ? ['/d', '/s', '/c', command] : ['-c', command],
        cwd,
        processGroup: true,
        signal: entry.abort.signal,
        env: { ...process.env, CI: '1', PI_KIT_VERIFY: '1' },
        // One extra character lets tailOf mark truncation, without buffering the command's full output.
        onOutput: (chunk) => { output = (output + chunk).slice(-(OUTPUT_TAIL_CHARS + 1)); },
      });
      return { exitCode: result.code, output };
    } catch (error) {
      return { exitCode: null, output: output || (error instanceof Error ? error.message : String(error)) };
    }
  }

  private usageOf(threadId: string): Pick<SkillVerification, 'tokens' | 'cost'> {
    const stats = this.sessions.stats(threadId);
    return { tokens: stats.tokens.total, cost: Math.round(stats.cost * 1e6) / 1e6 };
  }

  private usageOfSafe(threadId: string | undefined): Pick<SkillVerification, 'tokens' | 'cost'> {
    try {
      return threadId && this.sessions.has(threadId) ? this.usageOf(threadId) : {};
    } catch {
      return {};
    }
  }

  private foldersOf(row: ThreadRow): string[] {
    return [row.cwd, row.sessionCwd, row.worktreePath].filter((folder): folder is string => !!folder);
  }

  private requireDraft(id: string): SkillDraft {
    const draft = this.drafts.get(id);
    if (!draft) throw new NotFoundException('There is no such draft.');
    return draft;
  }
}
