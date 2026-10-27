import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  type LearnedSkill,
  type LearnedSkillDetail,
  type LearnedVerification,
  type SaveLearnedSkill,
  type SkillDraft,
  type UsingThread,
  learnedFlag,
  provenanceOf,
  verificationSummary,
  verifiedOfText,
} from '@pi-kit/protocol';
import { MetaRepository } from '../db/meta.repository';
import { SkillDraftsRepository } from '../db/skill-drafts.repository';
import { SkillUsesRepository } from '../db/skill-uses.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import type { SkillUse } from '../pi/skill-use';
import { OutcomesService } from '../threads/outcomes.service';
import { LearnService } from './learn.service';
import { retiredFolderOf } from './skill-files';
import { VerifyService } from './verify.service';
import { skillHash } from './verify-rules';

/** pi-kit's own record keeping is by real path, so a skill reached through a symlink (`/tmp` on macOS) is the same file. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  // The real path of the nearest folder that exists, then the rest as it was written (a retired skill's folder may not be there).
  for (let at = absolute; ; at = dirname(at)) {
    try {
      return join(realpathSync(at), absolute.slice(at.length));
    } catch {
      if (dirname(at) === at) return absolute;
    }
  }
}

/**
 * The record of the learned skills. It counts every use of a skill whose `SKILL.md` carries `x-pi-kit.learnedFrom` (a chip or `/skill:name` in a prompt of any
 * thread, told by the session service), marks the uses of a thread with the outcome it lands (`OutcomesService.onOutcome`), and answers `GET /api/skills/learned`: provenance, uses,
 * merged-after-use, last verification and a flag when the skill's recent threads keep failing. Retire, restore, save and re-verify are the person's; the writes go through
 * `LearnService` (the one writer) and `VerifyService`.
 */
@Injectable()
export class LearnedSkillsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LearnedSkillsService.name);
  private offUses: (() => void) | undefined;
  private offOutcome: (() => void) | undefined;

  constructor(
    private readonly drafts: SkillDraftsRepository,
    private readonly uses: SkillUsesRepository,
    private readonly threadRows: ThreadsRepository,
    private readonly sessions: PiSessionService,
    private readonly outcomes: OutcomesService,
    private readonly meta: MetaRepository,
    private readonly learn: LearnService,
    private readonly verify: VerifyService,
  ) {}

  onModuleInit(): void {
    this.offUses = this.sessions.onSkillsUsed((threadId, used) => this.record(threadId, used));
    this.offOutcome = this.outcomes.onOutcome((threadId, kind) => {
      try {
        this.uses.markOutcome(threadId, kind);
      } catch (error) {
        this.logger.warn(`Could not mark the skill uses of ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  onModuleDestroy(): void {
    this.offUses?.();
    this.offOutcome?.();
  }

  /** A prompt used these skills: each one whose file carries `x-pi-kit.learnedFrom` is a use. A verification replay is not a use (it pins the draft to test it). */
  record(threadId: string, used: readonly SkillUse[]): void {
    if (this.meta.isVerificationThread(threadId)) return;
    for (const skill of used) {
      try {
        const learnedFrom = provenanceOf(readFileSync(skill.path, 'utf8')).learnedFrom;
        if (learnedFrom) this.uses.record({ learnedFrom, threadId });
      } catch {
        // A skill file that cannot be read is not a learned skill we can count.
      }
    }
  }

  // ---- reads

  list(): LearnedSkill[] {
    return this.drafts
      .approved()
      .filter((draft) => !!draft.path)
      .map((draft) => this.view(draft))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  detail(id: string): LearnedSkillDetail {
    const draft = this.require(id);
    const text = this.textOf(draft) ?? draft.text;
    return { ...this.view(draft), text, draft: { ...draft, text } };
  }

  // ---- the person's actions

  async retire(id: string): Promise<LearnedSkill> {
    this.require(id);
    return this.view(await this.learn.retire(id));
  }

  async unretire(id: string): Promise<LearnedSkill> {
    this.require(id);
    return this.view(await this.learn.unretire(id));
  }

  async save(id: string, body: SaveLearnedSkill): Promise<LearnedSkill> {
    this.require(id);
    return this.view(await this.learn.saveApproved(id, body));
  }

  /** Re-verify: the approved skill, as the file is now, is replayed from its thread's base commit. The draft stays approved; the report lands in `verification` and the file. */
  async reverify(id: string): Promise<LearnedSkill> {
    const draft = this.require(id);
    if (this.drafts.retiredAt(draft.id) !== null) throw new ConflictException('This skill is retired. Restore it first.');
    this.learn.syncApprovedText(id);
    return this.view(await this.verify.start(id, {}));
  }

  // ---- the record

  private require(id: string): SkillDraft & { path: string } {
    const draft = this.drafts.get(id);
    if (!draft || draft.state !== 'approved' || !draft.path) throw new NotFoundException('There is no such learned skill.');
    return draft as SkillDraft & { path: string };
  }

  /** The `SKILL.md` as it is on disk now: where it lives, or in `.retired/` while it is retired. */
  private fileOf(draft: SkillDraft & { path: string }, retired: boolean): string {
    return retired ? join(retiredFolderOf(draft.path, draft.name), 'SKILL.md') : draft.path;
  }

  private textOf(draft: SkillDraft & { path: string }): string | undefined {
    try {
      return readFileSync(this.fileOf(draft, this.drafts.retiredAt(draft.id) !== null), 'utf8');
    } catch {
      return undefined;
    }
  }

  private view(draft: SkillDraft): LearnedSkill {
    const approved = draft as SkillDraft & { path: string };
    const retiredAt = this.drafts.retiredAt(draft.id);
    const file = this.fileOf(approved, retiredAt !== null);
    const fileText = this.textOf(approved);
    const summary = this.uses.summary(draft.threadId);
    const origin = this.threadRows.get(draft.threadId);
    const outcome = this.outcomes.get(draft.threadId);
    const verification = this.verificationOf(draft, fileText);
    const threads: UsingThread[] = summary.threads.map((t) => ({ ...t, ended: !this.running(t.threadId) }));
    const provenance = fileText ? provenanceOf(fileText) : { base: undefined, head: undefined };
    return {
      id: draft.id,
      name: draft.name,
      scope: draft.scope,
      path: draft.path ?? file,
      retiredAt,
      missing: !existsSync(file),
      learnedFrom: { threadId: draft.threadId, title: origin?.title?.trim() || null, base: provenance.base ?? outcome?.base ?? null, head: provenance.head ?? outcome?.head ?? null },
      verification,
      uses: summary.uses,
      mergedAfterUse: summary.mergedAfterUse,
      threads: summary.threads.length,
      lastUsedAt: summary.lastUsedAt,
      flag: retiredAt === null ? learnedFlag(threads, verification?.state === 'done' ? verification.result : undefined) : null,
    };
  }

  private running(threadId: string): boolean {
    try {
      return this.sessions.has(threadId) && this.sessions.isStreaming(threadId);
    } catch {
      return false;
    }
  }

  /** The draft's record of the last replay, or the file's `x-pi-kit.verified` when the record is missing or says only that a later try did not finish. */
  private verificationOf(draft: SkillDraft, fileText: string | undefined): LearnedVerification | null {
    const v = draft.verification;
    const text = fileText ?? draft.text;
    const hash = skillHash(text);
    if (v?.state === 'running') return { state: 'running', ...(v.phase ? { phase: v.phase } : {}), stale: false };
    if (v?.state === 'done' && v.result) return { state: 'done', result: v.result, ...(v.finishedAt ? { at: v.finishedAt } : {}), summary: v.summary ?? verificationSummary(v), stale: v.skillHash !== undefined && v.skillHash !== hash };
    const stated = verifiedOfText(text);
    if (stated) return { state: 'done', result: stated.result, ...(stated.at ? { at: stated.at } : {}), stale: false };
    if (v?.state === 'stopped' || v?.state === 'error') return { state: v.state, ...(v.finishedAt ? { at: v.finishedAt } : {}), summary: verificationSummary(v), stale: false };
    return null;
  }
}
