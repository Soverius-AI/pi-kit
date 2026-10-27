import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import {
  AttendantRunRequestSchema,
  type ApproveSkillDraft,
  type ApprovedSkillDraft,
  DraftRequestSchema,
  OutcomeRequestSchema,
  PLUGIN_CHANNELS,
  type SaveLearnedSkill,
  type PluginFailure,
  type PluginFailureCode,
  type SkillDraft,
  type SkillDraftMaker,
  type SkillDraftRequestResult,
  type SkillVerification,
  type ThreadOutcome,
  type ThreadTranscript,
  TranscriptRequestSchema,
  VerifiedRequestSchema,
  isSkillName,
  normalizeSkillText,
  parseSkillText,
  provenanceOf,
  skillTextProblems,
  stampProvenance,
  stampVerified,
} from '@pi-kit/protocol';
import { AttendantRepository } from '../db/attendant.repository';
import { MetaRepository } from '../db/meta.repository';
import { RedactionService } from '../db/redaction.service';
import { SignalsRepository } from '../db/signals.repository';
import { SkillDraftsRepository } from '../db/skill-drafts.repository';
import { type ThreadRow, ThreadsRepository } from '../db/threads.repository';
import { AttendantService } from '../attendant/attendant.service';
import { loadPi } from '../pi/load-pi';
import { PiSessionService } from '../pi/pi-session.service';
import { type PluginReplyShape, PiPluginService } from '../pi/pi-plugin.service';
import { ResourcesService } from '../pi/resources.service';
import { OutcomesService } from '../threads/outcomes.service';
import { ThreadStatusService } from '../threads/thread-status.service';
import { ThreadsService } from '../threads/threads.service';
import * as git from '../worktree/worktree-git';
import { worthADraft } from './draft-rules';
import { LearnPackage } from './learn-package';
import { restoreSkillFolder, retireSkillFolder } from './skill-files';
import { reduceTranscript } from './transcript';
import { skillHash } from './verify-rules';

const CONSENT_SETTING = 'learn-consent';
const CONSENT_KEEP = 500;
const DIFF_BYTES = 2_000_000;

type Pi = Awaited<ReturnType<typeof loadPi>>;
type DraftResult = { ok: true; draft: SkillDraft } | { ok: false; error: string; code: PluginFailureCode };

/** What the plugin API's `pi-kit:learn:verified` needs of the verification service (it depends on this one, so it registers itself: `useVerifier`). */
export interface VerifierPort {
  start(draftId: string, body?: { prompt?: string }): Promise<SkillDraft>;
  whenDone(draftId: string): Promise<SkillVerification | null>;
}

export const consentSentence = (model: string): string =>
  `This sends the thread’s transcript (prompts, tool calls, errors and the final diff, with secrets masked) to ${model} to draft a skill. The attendant is off, so nothing else is ever sent for this thread.`;

/**
 * Learning from finished threads. It is the host side of the plugin API (the `pi-kit:*` events an extension emits on its session's bus), the
 * attendant's third job (a draft after an outcome, under its cap and per-project opt-out), the draft store with its state machine (pending, approved, discarded, reopened) and,
 * the one place a skills folder is written, the approval. A draft is a database row until the person approves it: `approve()` is the only code in pi-kit that creates a
 * skill folder for it.
 */
@Injectable()
export class LearnService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LearnService.name);
  private offOutcome: (() => void) | undefined;
  private verifier: VerifierPort | undefined;
  private readonly drafting = new Map<string, Promise<DraftResult>>();
  /** Threads whose "not worth a draft" was already listed, so the activity says it once. */
  private readonly told = new Set<string>();
  /** The dialogs the person answered, for the transcript's turns. Property-injected so the constructor stays as it was. */
  @Optional() @Inject(SignalsRepository) private readonly signals?: SignalsRepository;

  constructor(
    private readonly drafts: SkillDraftsRepository,
    private readonly attendantRows: AttendantRepository,
    private readonly attendant: AttendantService,
    private readonly threadRows: ThreadsRepository,
    private readonly threads: ThreadsService,
    private readonly outcomes: OutcomesService,
    private readonly sessions: PiSessionService,
    private readonly status: ThreadStatusService,
    private readonly resources: ResourcesService,
    private readonly redaction: RedactionService,
    private readonly meta: MetaRepository,
    private readonly pkg: LearnPackage,
    private readonly plugins: PiPluginService,
  ) {}

  onModuleInit(): void {
    this.plugins.setDefault((threadId, channel, payload, signal) => this.plugin(threadId, channel, payload, signal));
    this.offOutcome = this.outcomes.onOutcome((threadId) => this.onOutcome(threadId));
    void this.pkg.ensureInstalled().catch((error: unknown) => this.logger.warn(`Could not install the learn package: ${error instanceof Error ? error.message : String(error)}`));
  }

  onModuleDestroy(): void {
    this.offOutcome?.();
    this.plugins.setDefault(undefined);
  }

  /** The verification service registers itself, so `pi-kit:learn:verified` can start a replay (it needs this service for the transcript, so this one cannot take it in its constructor). */
  useVerifier(verifier: VerifierPort | undefined): void {
    this.verifier = verifier;
  }

  // ---- reads

  forThread(threadId: string): SkillDraft {
    this.threads.assertExists(threadId);
    const draft = this.drafts.forThread(threadId);
    if (!draft) throw new NotFoundException('This thread has no skill draft.');
    return draft;
  }

  pending(): SkillDraft[] {
    return this.drafts.pending();
  }

  /** The transcript of a thread, reduced and redacted: the payload of `pi-kit:thread:transcript`. */
  async transcriptOf(threadId: string): Promise<ThreadTranscript> {
    const row = this.require(threadId);
    const source = await this.threads.treeSource(threadId);
    const outcome = this.outcomes.get(threadId);
    return reduceTranscript({
      threadId,
      title: row.title,
      cwd: row.cwd,
      entries: source.entries,
      leafId: source.leafId,
      outcome: outcome ? await this.outcomeFacts(row, outcome) : undefined,
      patterns: this.redaction.extraPatterns(),
      answers: this.signals?.answers(threadId),
      folder: row.sessionCwd || row.cwd,
    });
  }

  private async outcomeFacts(row: ThreadRow, outcome: ThreadOutcome) {
    // The project's folder, not the worktree's: the commits are in the shared repository, and the worktree may be removed any moment (a merge back removes it right after the outcome is written).
    const folder = row.cwd;
    const range = `${outcome.base}..${outcome.head}`;
    const [diff, numstat, message] = await Promise.all([
      git.run(folder, ['diff', '--no-renames', '--relative', '-U3', range]),
      git.run(folder, ['diff', '--numstat', '--no-renames', range]),
      git.run(folder, ['log', '-1', '--format=%B', outcome.head]),
    ]);
    let changedLines = 0;
    for (const line of numstat.stdout.split('\n')) {
      const [added, removed] = line.split('\t');
      changedLines += (Number(added) || 0) + (Number(removed) || 0);
    }
    return {
      base: outcome.base,
      head: outcome.head,
      diff: diff.ok ? diff.stdout.slice(0, DIFF_BYTES) : null,
      changedLines,
      commitMessage: message.ok ? message.stdout.trim() || null : null,
    };
  }

  // ---- asking for a draft

  /** `POST /api/threads/:id/skill-draft`: a draft for the thread on the person's request, after their consent when the attendant is off. */
  async request(threadId: string, options: { consent?: boolean } = {}): Promise<SkillDraftRequestResult> {
    const row = this.require(threadId);
    const existing = this.drafts.forThread(threadId);
    // One draft per thread: a pending one is read, an approved one is the skill, a discarded one is reopened from the thread menu.
    if (existing) return { status: 'drafted', draft: existing };
    if (this.meta.learningSource(threadId)) throw new ConflictException('Choose the original chat to learn from.');
    if (this.meta.isVerificationThread(threadId)) throw new ConflictException('This thread replayed a skill to verify it. There is nothing to learn from a replay.');
    const needed = await this.consentNeeded(threadId, options.consent === true);
    if (needed) return { status: 'consent', model: needed.model, message: needed.message };
    const made = await this.makeDraft(row, 'person');
    if (!made.ok) throw new ConflictException(made.error);
    return { status: 'drafted', draft: made.draft };
  }

  /** The sentence the person agrees to when the attendant is off and they have not agreed for this thread; `undefined` when they have, or the attendant is on. */
  private async consentNeeded(threadId: string, consent: boolean): Promise<{ model: string; message: string } | undefined> {
    if (this.attendant.settings().enabled || this.hasConsent(threadId)) return undefined;
    if (consent) {
      this.giveConsent(threadId);
      return undefined;
    }
    const model = (await this.attendant.modelLabel()) ?? 'the attendant’s model';
    return { model, message: consentSentence(model) };
  }

  private hasConsent(threadId: string): boolean {
    return ((this.meta.getSetting(CONSENT_SETTING) as string[] | undefined) ?? []).includes(threadId);
  }

  private giveConsent(threadId: string): void {
    const known = (this.meta.getSetting(CONSENT_SETTING) as string[] | undefined) ?? [];
    this.meta.setSetting(CONSENT_SETTING, [...known.filter((id) => id !== threadId), threadId].slice(-CONSENT_KEEP));
  }

  /** The model call and the draft it becomes, shared by the person's request and the attendant's own. */
  private makeDraft(row: ThreadRow, madeBy: SkillDraftMaker): Promise<DraftResult> {
    const existing = this.drafts.forThread(row.id);
    if (existing) return Promise.resolve({ ok: true, draft: existing });
    const pending = this.drafting.get(row.id);
    if (pending) return pending;
    // A merge can trigger the attendant while the person asks for the same draft. Share the model call and its result.
    const generating = this.generateDraft(row, madeBy);
    this.drafting.set(row.id, generating);
    const release = () => { if (this.drafting.get(row.id) === generating) this.drafting.delete(row.id); };
    void generating.then(release, release);
    return generating;
  }

  private async generateDraft(row: ThreadRow, madeBy: SkillDraftMaker): Promise<DraftResult> {
    const analysis = await this.pkg.analysis();
    if (!analysis) return { ok: false, code: 'off', error: 'The @pi-kit/learn package is not installed in pi (pi install <path to packages/pi-kit-learn>), so there is nothing to draft with.' };
    const transcript = await this.transcriptOf(row.id);
    // The session itself says whether there is anything to learn from (the thread list's message count can lag behind a run that just ended).
    if (transcript.prompts.length === 0) return { ok: false, code: 'invalid', error: 'The thread has no messages yet, so there is nothing to learn from.' };
    const prompt = analysis.buildAnalysisPrompt(transcript);
    let parsed: ReturnType<typeof analysis.parseDraftReply> | undefined;
    const completion = await this.attendant.complete(row, prompt, {
      kind: 'learn',
      initiative: madeBy === 'attendant' ? 'attendant' : 'person',
      describe: (text) => {
        parsed = analysis.parseDraftReply(text);
        return parsed.ok ? { status: 'done', text: `Drafted the skill ${parsed.name}` } : { status: parsed.skip ? 'done' : 'error', text: parsed.skip ? `Nothing to learn: ${parsed.reason}` : `The model’s answer was not a skill: ${parsed.reason}` };
      },
    });
    if (!completion.ok) return completion;
    if (!parsed?.ok) return { ok: false, code: 'failed', error: parsed?.skip ? `Nothing in this thread generalises: ${parsed.reason}` : `The model’s answer was not a skill: ${parsed?.reason ?? 'no answer'}.` };
    // A plugin may have supplied a draft while this model call was pending. Keep the thread's existing draft.
    const existing = this.drafts.forThread(row.id);
    if (existing) return { ok: true, draft: existing };
    const stored = this.store(row.id, parsed.text, madeBy, completion.model);
    return stored.ok ? { ok: true, draft: stored.draft } : stored;
  }

  /** Validates a `SKILL.md` a model or a package produced, stamps its provenance and keeps it as a pending draft with a `learn` suggestion for the sidebar. */
  private store(threadId: string, rawText: string, madeBy: SkillDraftMaker, model: string | null): { ok: true; draft: SkillDraft } | { ok: false; error: string; code: PluginFailureCode } {
    const existing = this.drafts.forThread(threadId);
    if (existing) return { ok: false, code: 'conflict', error: `This thread already has a draft (${existing.state}): ${existing.name}.` };
    const problems = skillTextProblems(rawText);
    const name = parseSkillText(rawText).name;
    if (problems.length > 0 || !name) return { ok: false, code: 'invalid', error: problems.join(' ') || 'The draft has no name.' };
    const outcome = this.outcomes.get(threadId);
    const text = stampProvenance(normalizeSkillText(rawText, name), { learnedFrom: threadId, base: outcome?.base ?? null, head: outcome?.head ?? null });
    const draft = this.drafts.insert({ threadId, name, text, scope: 'project', madeBy, model });
    this.suggest(draft);
    this.status.touch(threadId);
    this.logger.log(`Drafted the skill ${name} from thread ${threadId} (${madeBy})`);
    return { ok: true, draft };
  }

  private suggest(draft: SkillDraft): void {
    this.attendantRows.addSuggestion({
      threadId: draft.threadId,
      kind: 'learn',
      target: draft.id,
      text: draft.name,
      reason: draft.madeBy === 'attendant' ? 'The attendant drafted a skill from this thread. Read it, then approve or discard it.' : 'A skill was drafted from this thread. Read it, then approve or discard it.',
    });
  }

  // ---- after an outcome (the attendant's third job)

  private onOutcome(threadId: string): void {
    if (!this.attendant.settings().enabled || this.drafts.forThread(threadId) || this.meta.isVerificationThread(threadId) || this.meta.learningSource(threadId)) return;
    this.attendant.enqueueTask(threadId, async () => void (await this.autoDraft(threadId)));
  }

  /** Drafts without being asked, if the thread looks worth it. Runs in the attendant's queue. */
  async autoDraft(threadId: string): Promise<'drafted' | 'not-worth' | 'skipped'> {
    const row = this.threadRows.get(threadId);
    if (!row || this.drafts.forThread(threadId) || !this.attendant.settings().enabled || !this.attendant.allowedIn(row.cwd)) return 'skipped';
    if (!(await this.pkg.analysis())) return 'skipped';
    const transcript = await this.transcriptOf(threadId);
    const overview = await this.resources.overview(row.cwd).catch(() => undefined);
    const skills = (overview?.items ?? []).filter((item) => item.type === 'skills').map((item) => ({ name: item.name, description: item.description }));
    const verdict = worthADraft({ toolCalls: transcript.toolCalls, changedLines: transcript.changedLines, firstPrompt: transcript.prompts[0] ?? '', skills });
    if (!verdict.worth) {
      if (!this.told.has(threadId)) {
        this.told.add(threadId);
        this.attendant.note('learn', row, `Not worth a skill: ${verdict.reason}`);
      }
      return 'not-worth';
    }
    const made = await this.makeDraft(row, 'attendant');
    if (!made.ok) this.logger.debug(`No draft for ${threadId}: ${made.error}`);
    return made.ok ? 'drafted' : 'skipped';
  }

  // ---- deciding

  private requireDraft(id: string): SkillDraft {
    const draft = this.drafts.get(id);
    if (!draft) throw new NotFoundException('There is no such draft.');
    return draft;
  }

  /**
   * Approve: the only writer of a skills folder. The name, scope and text are the person's final ones. The name must be pi's kind of name and free in the folder and among the
   * skills pi lists; the text must be a skill pi loads (name, description, instructions); the folder is made inside the skills folder of the scope and nowhere else, and an
   * existing `SKILL.md` is never overwritten. Then the draft is `approved` with the path, sessions that are idle reload so the skill is in their `/` menu at once, and the
   * thread's `learn` suggestion is closed.
   */
  async approve(id: string, body: ApproveSkillDraft): Promise<ApprovedSkillDraft> {
    const draft = this.requireDraft(id);
    if (draft.state !== 'pending') throw new ConflictException(draft.state === 'approved' ? `This draft is approved already (${draft.path}).` : 'This draft was discarded. Reopen it first.');
    const name = body.name.trim();
    if (!isSkillName(name)) throw new BadRequestException('A skill name uses lowercase letters, digits and single hyphens, at most 64 characters.');
    const problems = skillTextProblems(normalizeSkillText(body.text, name));
    if (problems.length > 0) throw new BadRequestException(problems.join(' '));
    const outcome = this.outcomes.get(draft.threadId);
    const stamped = stampProvenance(normalizeSkillText(body.text, name), { learnedFrom: draft.threadId, base: outcome?.base ?? null, head: outcome?.head ?? null });
    // What the frontmatter says about verification is the record of a replay of exactly this text, never what the editor holds: a forged `verified` is replaced, and an edit made after
    // the replay leaves `verified: null` (the report is for another text).
    const verification = draft.verification;
    const text = stampVerified(stamped, verification?.state === 'done' && verification.skillHash === skillHash(stamped) ? verification : null);
    const pi = await loadPi();
    this.assertPiReads(pi, text, name);

    const project = this.threadRows.get(draft.threadId)?.cwd;
    if (body.scope === 'project' && !project) throw new BadRequestException('The thread’s project is gone, so there is no project folder to write into. Choose the user folder.');
    const root = body.scope === 'project' ? join(project as string, pi.CONFIG_DIR_NAME, 'skills') : join(pi.getAgentDir(), 'skills');
    const folder = resolve(root, name);
    // The name is a validated slug, so this holds by construction; the check is for the day it does not.
    if (!folder.startsWith(resolve(root) + sep)) throw new BadRequestException('That name would leave the skills folder.');
    if (existsSync(folder)) throw new ConflictException(`A folder named ${name} already exists in ${root}. Choose another name.`);
    const listed = await this.resources.overview(project ?? process.cwd()).catch(() => undefined);
    const clash = listed?.items.find((item) => item.type === 'skills' && item.name === name);
    if (clash) throw new ConflictException(`pi already has a skill named ${name} (${clash.label}). Choose another name.`);

    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'SKILL.md');
    try {
      writeFileSync(file, text, { flag: 'wx' });
    } catch (error) {
      throw new ConflictException(`Could not write ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.drafts.edit(id, { name, text, scope: body.scope });
    if (body.verify) this.drafts.setVerification(id, { ...(draft.verification ?? { state: 'not-run' as const }), requested: true });
    const approved = this.drafts.setState(id, 'approved', { path: file }) as SkillDraft;
    this.attendantRows.closeLearn(id, 'accepted');
    this.status.touch(draft.threadId);
    this.logger.log(`Approved the skill ${name} (${body.scope}) from thread ${draft.threadId}: ${file}`);
    await this.reloadSessions(body.scope === 'project' ? project : undefined);
    return { draft: approved, path: file };
  }

  /** pi's own parser has the last word on whether it will load the text. */
  private assertPiReads(pi: Pi, text: string, name: string): void {
    try {
      const { frontmatter } = pi.parseFrontmatter<{ name?: unknown; description?: unknown }>(text);
      if (frontmatter.name !== name) throw new Error('the frontmatter name differs from the name');
      if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) throw new Error('the frontmatter has no description');
    } catch (error) {
      throw new BadRequestException(`pi would not load this text: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Sessions that are open and idle read their skills again, so the new one is in the `/` menu; the others pick it up when they open. */
  private async reloadSessions(project: string | undefined): Promise<void> {
    for (const row of this.threadRows.all()) {
      if (project && row.cwd !== project) continue;
      if (!this.sessions.has(row.id) || this.sessions.stats(row.id).streaming) continue;
      try {
        await this.sessions.reload(row.id);
      } catch (error) {
        this.logger.debug(`Could not reload ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Discard: records the decision, writes nothing. The thread is not drafted again; the draft can be reopened. */
  discard(id: string): SkillDraft {
    const draft = this.requireDraft(id);
    if (draft.state !== 'pending') throw new ConflictException(draft.state === 'approved' ? 'This draft is approved: the skill exists. Retire the skill instead.' : 'This draft is discarded already.');
    const discarded = this.drafts.setState(id, 'discarded') as SkillDraft;
    this.attendantRows.closeLearn(id, 'dismissed');
    this.status.touch(draft.threadId);
    return discarded;
  }

  /** Reopen: a discarded draft is pending again, with a new `learn` suggestion. */
  reopen(id: string): SkillDraft {
    const draft = this.requireDraft(id);
    if (draft.state !== 'discarded') throw new ConflictException(draft.state === 'pending' ? 'This draft is open already.' : 'This draft is approved.');
    const reopened = this.drafts.setState(id, 'pending') as SkillDraft;
    this.suggest(reopened);
    this.status.touch(draft.threadId);
    return reopened;
  }

  // ---- the skill after it is approved: edit, retire, restore

  private requireApproved(id: string): SkillDraft & { path: string } {
    const draft = this.requireDraft(id);
    if (draft.state !== 'approved' || !draft.path) throw new ConflictException('This draft is not an approved skill.');
    return draft as SkillDraft & { path: string };
  }

  /** The project folder an approved project skill lives in (`<project>/.pi/skills/<name>/SKILL.md`), or `undefined` for the user scope. */
  private projectOf(draft: SkillDraft & { path: string }): string | undefined {
    return draft.scope === 'project' ? dirname(dirname(dirname(dirname(draft.path)))) : undefined;
  }

  /**
   * Save an edited approved skill: the second place this service writes a skill file. The name and the folder stay; the text must be a skill pi loads under that name; the provenance is
   * stamped again (so a forged or deleted block is put right, the commits kept), and the `verified` block says a result only for a replay of exactly this text. Sessions that are
   * idle read their skills again.
   */
  async saveApproved(id: string, body: SaveLearnedSkill): Promise<SkillDraft> {
    const draft = this.requireApproved(id);
    if (this.drafts.retiredAt(id) !== null) throw new ConflictException('This skill is retired. Restore it first.');
    if (draft.verification?.state === 'running') throw new ConflictException('This skill is being verified. Wait for it, or stop it, before saving.');
    if (!existsSync(draft.path)) throw new ConflictException(`The skill file is gone (${draft.path}).`);
    const normalized = normalizeSkillText(body.text, draft.name);
    const problems = skillTextProblems(normalized);
    if (problems.length > 0) throw new BadRequestException(problems.join(' '));
    const current = provenanceOf(readFileSync(draft.path, 'utf8'));
    const outcome = this.outcomes.get(draft.threadId);
    const stamped = stampProvenance(normalized, { learnedFrom: draft.threadId, base: current.base ?? outcome?.base ?? null, head: current.head ?? outcome?.head ?? null });
    const verification = draft.verification;
    const text = stampVerified(stamped, verification?.state === 'done' && verification.skillHash === skillHash(stamped) ? verification : null);
    this.assertPiReads(await loadPi(), text, draft.name);
    writeFileSync(draft.path, text);
    const saved = this.drafts.edit(draft.id, { text }) as SkillDraft;
    this.status.touch(draft.threadId);
    this.logger.log(`Saved the skill ${draft.name}: ${draft.path}`);
    await this.reloadSessions(this.projectOf(draft));
    return saved;
  }

  /** The text of an approved skill's file brought into the draft, so a replay tests the file as it is (a hand edit outside pi-kit counts). Writes no skill file. */
  syncApprovedText(id: string): SkillDraft {
    const draft = this.requireApproved(id);
    const file = this.drafts.retiredAt(id) !== null ? join(dirname(dirname(draft.path)), '.retired', draft.name, 'SKILL.md') : draft.path;
    if (!existsSync(file)) return draft;
    const text = readFileSync(file, 'utf8');
    return text === draft.text ? draft : ((this.drafts.edit(id, { text }) as SkillDraft | undefined) ?? draft);
  }

  /** Retire: the skill's folder moves to `<skills>/.retired/<name>/` (pi does not load it any more), the draft records when, and open sessions read their skills again. Nothing is deleted. */
  async retire(id: string): Promise<SkillDraft> {
    const draft = this.requireApproved(id);
    if (this.drafts.retiredAt(id) !== null) throw new ConflictException('This skill is retired already.');
    if (draft.verification?.state === 'running') throw new ConflictException('This skill is being verified. Wait for it, or stop it, before retiring it.');
    try {
      retireSkillFolder(draft.path, { name: draft.name, threadId: draft.threadId });
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : String(error));
    }
    this.drafts.setRetired(id, Date.now());
    this.status.touch(draft.threadId);
    this.logger.log(`Retired the skill ${draft.name} (${draft.path})`);
    await this.reloadSessions(this.projectOf(draft));
    return this.requireDraft(id);
  }

  /** Restore: a retired skill's folder moves back and pi loads it again, unless pi lists another skill of that name by now. */
  async unretire(id: string): Promise<SkillDraft> {
    const draft = this.requireApproved(id);
    if (this.drafts.retiredAt(id) === null) throw new ConflictException('This skill is not retired.');
    const project = this.projectOf(draft);
    const listed = await this.resources.overview(project ?? process.cwd()).catch(() => undefined);
    const clash = listed?.items.find((item) => item.type === 'skills' && item.name === draft.name);
    if (clash) throw new ConflictException(`pi has a skill named ${draft.name} now (${clash.label}). Restoring this one would collide with it.`);
    try {
      restoreSkillFolder(draft.path, { name: draft.name, threadId: draft.threadId });
    } catch (error) {
      throw new ConflictException(error instanceof Error ? error.message : String(error));
    }
    this.drafts.setRetired(id, null);
    this.status.touch(draft.threadId);
    this.logger.log(`Restored the skill ${draft.name} (${draft.path})`);
    await this.reloadSessions(project);
    return this.requireDraft(id);
  }

  // ---- the plugin API

  /**
   * One `pi-kit:*` request of an extension: validated, answered with the reply to emit on `<channel>:reply`.
   * `signal` is the session's binding (`PiPluginService`): when the session closes, the model call it asked for is aborted. A replay (`pi-kit:learn:verified`) is not: it is
   * the verification service's own job, with its own Stop, and runs on after the session that asked for it is gone.
   */
  async plugin(sessionThread: string, channel: string, payload: unknown, signal?: AbortSignal): Promise<PluginReplyShape | undefined> {
    const requestId = (payload as { requestId?: unknown } | null | undefined)?.requestId;
    if (typeof requestId !== 'string' || !requestId) return undefined;
    const fail = (code: PluginFailureCode, error: string, extra: { model?: string } = {}): PluginFailure => ({ requestId, ok: false, code, error, ...extra });
    try {
      switch (channel) {
        case PLUGIN_CHANNELS.transcript: {
          const request = TranscriptRequestSchema.safeParse(payload);
          if (!request.success) return fail('invalid', request.error.issues.map((i) => i.message).join('; '));
          const id = this.resolveThread(request.data.thread ?? sessionThread);
          if (!id) return fail('not-found', 'There is no such thread.');
          const draft = this.drafts.forThread(id);
          return { requestId, ok: true, transcript: await this.transcriptOf(id), draft: draft ? { id: draft.id, name: draft.name, state: draft.state } : null };
        }
        case PLUGIN_CHANNELS.outcome: {
          const request = OutcomeRequestSchema.safeParse(payload);
          if (!request.success) return fail('invalid', request.error.issues.map((i) => i.message).join('; '));
          const id = this.resolveThread(request.data.thread ?? sessionThread);
          if (!id) return fail('not-found', 'There is no such thread.');
          const outcome = this.outcomes.get(id) ?? null;
          const facts = request.data.diff && outcome ? await this.outcomeFacts(this.require(id), outcome) : undefined;
          return { requestId, ok: true, outcome, ...(request.data.diff ? { diff: facts?.diff ?? null } : {}) };
        }
        case PLUGIN_CHANNELS.attendant: {
          const request = AttendantRunRequestSchema.safeParse(payload);
          if (!request.success) return fail('invalid', request.error.issues.map((i) => i.message).join('; '));
          const id = this.resolveThread(request.data.thread ?? sessionThread);
          if (!id) return fail('not-found', 'There is no such thread.');
          const needed = await this.consentNeeded(id, request.data.consent === true);
          if (needed) return fail('consent', needed.message, { model: needed.model });
          const completion = await this.attendant.complete(this.require(id), { system: request.data.system, user: request.data.user }, { kind: 'learn', initiative: 'person', signal, describe: () => ({ status: 'done', text: 'Drafted a skill for /learn' }) });
          if (!completion.ok) return fail(completion.code, completion.error);
          return { requestId, ok: true, text: completion.text, model: completion.model, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, cost: completion.cost };
        }
        case PLUGIN_CHANNELS.draft: {
          const request = DraftRequestSchema.safeParse(payload);
          if (!request.success) return fail('invalid', request.error.issues.map((i) => i.message).join('; '));
          const id = this.resolveThread(request.data.thread ?? sessionThread);
          if (!id) return fail('not-found', 'There is no such thread.');
          const stored = this.store(id, request.data.text, 'person', request.data.model ?? null);
          return stored.ok ? { requestId, ok: true, draft: stored.draft } : fail(stored.code, stored.error);
        }
        case PLUGIN_CHANNELS.verified: {
          const request = VerifiedRequestSchema.safeParse(payload);
          if (!request.success) return fail('invalid', request.error.issues.map((i) => i.message).join('; '));
          const id = this.resolveThread(request.data.thread ?? sessionThread);
          if (!id) return fail('not-found', 'There is no such thread.');
          const draft = this.drafts.forThread(id);
          if (!draft) return fail('not-found', 'This thread has no skill draft to verify. Draft one first with /learn.');
          const summary = (d: SkillDraft) => ({ id: d.id, name: d.name, state: d.state });
          if (request.data.start === false) return { requestId, ok: true, draft: summary(draft), verification: draft.verification };
          if (!this.verifier) return fail('off', 'Verification is not available in this build.');
          try {
            await this.verifier.start(draft.id, request.data.prompt ? { prompt: request.data.prompt } : {});
          } catch (error) {
            const status = error instanceof HttpException ? error.getStatus() : 500;
            return fail(status === 400 ? 'invalid' : status === 404 ? 'not-found' : status === 409 ? 'conflict' : 'failed', error instanceof Error ? error.message : String(error));
          }
          // The reply comes when the replay is over (a minute to many; `whenDone` is the running job's own promise), and the person can watch the thread in the sidebar meanwhile.
          // A session that closes first is answered as failed by the plugin bridge; the replay itself keeps running under the verification service, which owns its Stop.
          const verification = await this.verifier.whenDone(draft.id);
          return { requestId, ok: true, draft: summary(this.drafts.get(draft.id) ?? draft), verification };
        }
        default:
          return fail('invalid', `pi-kit has no event named ${channel}.`);
      }
    } catch (error) {
      return fail('failed', error instanceof Error ? error.message : String(error));
    }
  }

  /** A thread id, or the start of one when it is unique. */
  private resolveThread(idOrPrefix: string): string | undefined {
    if (this.threadRows.get(idOrPrefix)) return idOrPrefix;
    const matches = this.threadRows.all().filter((row) => row.id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0].id : undefined;
  }

  private require(threadId: string): ThreadRow {
    const row = this.threadRows.get(threadId);
    if (!row) throw new NotFoundException(`Thread ${threadId} not found.`);
    return row;
  }
}
