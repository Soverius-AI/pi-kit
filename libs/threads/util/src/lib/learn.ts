import type { Translate } from '@pi-kit/i18n';
import {
  type LearnedSkill,
  type SkillScope,
  type SkillVerification,
  type ThreadDraftBadge,
  type VerificationPhase,
  type VerifiedCheck,
  type VerifiedFile,
  type VerifyPlan,
  skillTextProblems,
} from '@pi-kit/protocol';
import { agoText } from './outcome';

/** What the thread menus offer about learning a skill from a thread: pure, so the words and the rule are tested without a component. */

export type LearnAction = 'draft' | 'read' | 'reopen' | 'learned';

export interface LearnMenuEntry {
  action: LearnAction;
  label: string;
  /** The entry shows but cannot be used (a thread without messages has nothing to learn from; an approved draft is the skill). */
  disabled: boolean;
  /** Why it is disabled, as a tooltip. */
  reason?: string;
}

/** The entry for a thread's menu: ask for a draft, read the pending one, reopen the discarded one, or say it was learned. `messageCount` is the thread's. */
export function learnMenuEntry(
  translate: Translate,
  draft: ThreadDraftBadge | null | undefined,
  messageCount: number,
): LearnMenuEntry {
  if (!draft) {
    return messageCount === 0
      ? {
          action: 'draft',
          label: translate('threads.learn.learnASkillFromThisThread'),
          disabled: true,
          reason: translate('threads.learn.nothingToLearnFromYetTheThread'),
        }
      : { action: 'draft', label: translate('threads.learn.learnASkillFromThisThread'), disabled: false };
  }
  switch (draft.state) {
    case 'pending':
      return { action: 'read', label: translate('threads.learn.readTheSkillDraft'), disabled: false };
    case 'discarded':
      return { action: 'reopen', label: translate('threads.learn.reopenTheSkillDraft'), disabled: false };
    case 'approved':
      return {
        action: 'learned',
        label: translate('threads.learn.learnedAs', { value1: draft.name }),
        disabled: true,
        reason: translate('threads.learn.thisThreadSDraftWasApprovedEdit'),
      };
  }
}

/** The card at the end of a thread: its sentence, which depends on who made the draft. */
export function draftCardText(translate: Translate, draft: ThreadDraftBadge): string {
  return draft.madeBy === 'attendant'
    ? translate('threads.learn.theAttendantDraftedASkillFromThis')
    : translate('threads.learn.aSkillWasDraftedFromThisThread');
}

/** The sidebar chip: the attendant's `learn` suggestion, in the same place as its labels and answers. */
export const learnChipText = (translate: Translate, name: string): string =>
  translate('threads.learn.skillDrafted', { value1: name });

/** The dialog's own check before Approve is enabled, on the text it will send (the name is the text's `name:` line): sentences. The backend and pi have the last word. */
export const reviewProblems = (text: string): string[] => skillTextProblems(text);

/** Where Approve writes, for the scope choice's sentence. `~/.pi/agent` is shown as the user's folder; a test world shows its own. */
export function scopeFolder(scope: SkillScope, name: string, userFolder = '~/.pi/agent'): string {
  const folder = name.trim() || '<name>';
  return scope === 'project' ? `.pi/skills/${folder}/SKILL.md` : `${userFolder}/skills/${folder}/SKILL.md`;
}

// ---- verification: the words and the rule of the dialog's report

/** The words after the card's name once a verification runs or has run: "verifying…", "verified: it reproduces its thread". Empty for a draft nobody replayed. */
export function draftVerifiedNote(translate: Translate, draft: ThreadDraftBadge): string {
  switch (draft.verification) {
    case 'running':
      return translate('threads.learn.verifyingTrace');
    case 'pass':
      return translate('threads.learn.verifiedItReproducesItsThread');
    case 'partial':
      return translate('threads.learn.verifiedItReproducesPartOfItsThread');
    case 'failed':
      return translate('threads.learn.verifiedItDoesNotReproduceItsThread');
    default:
      return '';
  }
}

export type ChipTone = 'ok' | 'warn' | 'err' | 'off';

/** The chip of a verification's state and result. */
export function verificationChip(
  translate: Translate,
  v: SkillVerification | null | undefined,
): { label: string; tone: ChipTone } | undefined {
  if (!v || v.state === 'not-run') return undefined;
  switch (v.state) {
    case 'running':
      return { label: translate('threads.learn.verifying'), tone: 'off' };
    case 'stopped':
      return { label: translate('threads.learn.stopped'), tone: 'off' };
    case 'error':
      return { label: translate('threads.learn.couldNotVerify'), tone: 'err' };
    case 'done':
      return v.result === 'pass'
        ? { label: translate('threads.learn.pass'), tone: 'ok' }
        : v.result === 'partial'
          ? { label: translate('threads.learn.partial'), tone: 'warn' }
          : { label: translate('threads.learn.failed'), tone: 'err' };
  }
}

const verificationPhases = (translate: Translate): Record<VerificationPhase, string> => ({
  worktree: translate('threads.learn.makingAScratchWorktreeAtTheBase'),
  run: translate('threads.learn.theThreadIsRunningWithTheSkill'),
  compare: translate('threads.learn.comparingWhatItDidWithTheOutcome'),
  checks: translate('threads.learn.runningTheThreadSChecksAgain'),
});
export const verificationPhaseText = (translate: Translate, phase: VerificationPhase | undefined): string =>
  phase ? verificationPhases(translate)[phase] : translate('threads.learn.starting');

const fileStatuses = (translate: Translate): Record<VerifiedFile['status'], { label: string; tone: ChipTone }> => ({
  same: { label: translate('threads.learn.identical'), tone: 'ok' },
  similar: { label: translate('threads.learn.reproduced'), tone: 'ok' },
  different: { label: translate('threads.learn.differs'), tone: 'warn' },
  missing: { label: translate('threads.learn.notTouched'), tone: 'err' },
  extra: { label: translate('threads.learn.notInTheOutcome'), tone: 'warn' },
});
export const fileStatusChip = (
  translate: Translate,
  status: VerifiedFile['status'],
): { label: string; tone: ChipTone } => fileStatuses(translate)[status];

export const percentText = (fraction: number): string => `${Math.round(fraction * 100)} %`;

/** A check's line: its state and exit code, "passed", "failed (exit 1)", "not run". */
export function checkStateText(translate: Translate, check: VerifiedCheck): string {
  if (check.state === 'skipped') return translate('threads.learn.notRun');
  if (check.state === 'passed') return translate('threads.learn.passed');
  return check.exitCode === null
    ? translate('threads.learn.didNotFinish')
    : translate('threads.learn.failedExit', { value1: check.exitCode });
}

export interface PrimaryStep {
  /** `verify`: replay the skill first; `approve`: write it; `wait`: a replay is running. */
  action: 'verify' | 'approve' | 'wait';
  label: string;
  /** A sentence under the button: why Approve goes ahead without a report. */
  note?: string;
}

/**
 * What the dialog's primary button does. With "Verify first" on and no finished report for exactly this text, Approve replays the skill first and the report decides nothing by itself:
 * the person reads it and then approves or discards. A draft that cannot be verified (no outcome, the commits are gone) is approved as it is, with the reason shown. A report that
 * says partial or failed does not block Approve either: it is information, and the person decides.
 */
export function primaryStep(
  translate: Translate,
  input: {
    verify: boolean;
    verification: SkillVerification | null | undefined;
    stale: boolean;
    plan: VerifyPlan | undefined;
  },
): PrimaryStep {
  const { verify, verification, stale, plan } = input;
  if (verification?.state === 'running') return { action: 'wait', label: translate('threads.learn.verifying691f4') };
  if (!verify) return { action: 'approve', label: translate('threads.learn.approve') };
  if (verification?.state === 'done' && !stale) return { action: 'approve', label: translate('threads.learn.approve') };
  if (plan && !plan.canVerify)
    return {
      action: 'approve',
      label: translate('threads.learn.approve'),
      note: translate('threads.learn.cannotVerifyFirstSoApproveGoesAhead'),
    };
  return {
    action: 'verify',
    label:
      verification?.state === 'done' || verification?.state === 'error' || verification?.state === 'stopped'
        ? translate('threads.learn.verifyAgain')
        : translate('threads.learn.verifyFirst'),
  };
}

// ---- the record of a learned skill

/** "Oct 17" in the current year, "Oct 17, 2025" in another. */
export function shortDate(translate: Translate, at: number, now = Date.now()): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(
    translate('common.locale'),
    sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}

/** What the record says of the last verification, in a few words: "verified Oct 17, pass", "not verified", "verifying…". */
export function learnedVerifiedText(
  translate: Translate,
  skill: Pick<LearnedSkill, 'verification'>,
  now = Date.now(),
): string {
  const v = skill.verification;
  if (!v) return translate('threads.learn.notVerified');
  switch (v.state) {
    case 'running':
      return translate('threads.learn.verifyingTrace');
    case 'stopped':
      return translate('threads.learn.verificationStopped');
    case 'error':
      return translate('threads.learn.verificationDidNotRun');
    case 'done':
      return translate('threads.learn.verified', {
        value1: v.at ? ` ${shortDate(translate, v.at, now)}` : '',
        value2: v.result ?? translate('threads.learn.noResult'),
        value3: v.stale ? translate('threads.learn.editedSince') : '',
      });
  }
}

/** "used 4 times, merged after 3", "used once, none merged after", "not used yet". */
export function learnedUsesText(translate: Translate, skill: Pick<LearnedSkill, 'uses' | 'mergedAfterUse'>): string {
  if (skill.uses === 0) return translate('threads.learn.notUsedYet');
  const times =
    skill.uses === 1
      ? translate('threads.learn.usedOnce')
      : translate('threads.learn.usedTimes', { value1: skill.uses });
  return `${times}, ${skill.mergedAfterUse === 0 ? translate('threads.learn.noneMergedAfter') : translate('threads.learn.mergedAfter', { value1: skill.mergedAfterUse })}`;
}

export interface LearnedRecordLine {
  /** The thread it was learned from (an em in the row); a thread that is gone reads "a thread that was deleted". */
  from: string;
  /** The facts after it, each shown after a dot: verification, uses, last use. */
  facts: string[];
}

/** The line under a learned skill's row: "Learned from *Add six notes* · verified Oct 17, pass · used 4 times, merged after 3 · last used 2 h ago". */
export function learnedRecordLine(translate: Translate, skill: LearnedSkill, now = Date.now()): LearnedRecordLine {
  const facts = [learnedVerifiedText(translate, skill, now), learnedUsesText(translate, skill)];
  if (skill.lastUsedAt !== null)
    facts.push(translate('threads.learn.lastUsed', { value1: agoText(translate, skill.lastUsedAt, now) }));
  return { from: skill.learnedFrom.title ?? translate('threads.learn.aThreadThatWasDeleted'), facts };
}

/** The same line as one sentence, for a tooltip or an accessible name. */
export const learnedRecordText = (translate: Translate, skill: LearnedSkill, now = Date.now()): string => {
  const line = learnedRecordLine(translate, skill, now);
  return translate('threads.learn.learnedFrom', { value1: line.from, value2: line.facts.join(' · ') });
};

/** Words for the retired list: "retired 3 d ago". */
export const retiredText = (translate: Translate, skill: Pick<LearnedSkill, 'retiredAt'>, now = Date.now()): string =>
  skill.retiredAt === null
    ? ''
    : translate('threads.learn.retired', { value1: agoText(translate, skill.retiredAt, now) });
