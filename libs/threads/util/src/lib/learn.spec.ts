import { english } from '@pi-kit/i18n/testing';
import { describe, expect, it } from 'vitest';
import type { LearnedSkill, SkillVerification, VerifyPlan } from '@pi-kit/protocol';
import {
  checkStateText,
  draftCardText,
  draftVerifiedNote,
  fileStatusChip,
  learnChipText,
  learnMenuEntry,
  learnedRecordLine,
  learnedRecordText,
  learnedUsesText,
  learnedVerifiedText,
  percentText,
  retiredText,
  shortDate,
  primaryStep,
  reviewProblems,
  scopeFolder,
  verificationChip,
  verificationPhaseText,
} from './learn';

const badge = (state: 'pending' | 'approved' | 'discarded', madeBy: 'attendant' | 'person' = 'attendant') => ({
  id: 'd1',
  name: 'add-a-migration',
  state,
  madeBy,
});
const TEXT = '---\nname: add-a-migration\ndescription: Use when adding a table\n---\n\n# Steps\n1. Do it\n';

describe('the thread menu’s entry about learning', () => {
  it('offers a draft for a thread that has messages and none for an empty one', () => {
    expect(learnMenuEntry(english, null, 4)).toEqual({
      action: 'draft',
      label: 'Learn a skill from this thread',
      disabled: false,
    });
    expect(learnMenuEntry(english, undefined, 0)).toMatchObject({
      action: 'draft',
      disabled: true,
      reason: expect.stringContaining('no messages'),
    });
  });

  it('reads a pending draft, reopens a discarded one, and says an approved one was learned', () => {
    expect(learnMenuEntry(english, badge('pending'), 4)).toEqual({
      action: 'read',
      label: 'Read the skill draft',
      disabled: false,
    });
    expect(learnMenuEntry(english, badge('discarded'), 4)).toEqual({
      action: 'reopen',
      label: 'Reopen the skill draft',
      disabled: false,
    });
    expect(learnMenuEntry(english, badge('approved'), 4)).toMatchObject({
      action: 'learned',
      label: 'Learned as add-a-migration',
      disabled: true,
    });
  });
});

describe('the words', () => {
  it('the card says who drafted', () => {
    expect(draftCardText(english, badge('pending'))).toBe('The attendant drafted a skill from this thread:');
    expect(draftCardText(english, badge('pending', 'person'))).toBe('A skill was drafted from this thread:');
  });

  it('the chip names the skill', () => {
    expect(learnChipText(english, 'add-a-migration')).toBe('Skill “add-a-migration”, drafted');
  });

  it('the scope choice shows where the folder goes', () => {
    expect(scopeFolder('project', 'x-y')).toBe('.pi/skills/x-y/SKILL.md');
    expect(scopeFolder('user', 'x-y')).toBe('~/.pi/agent/skills/x-y/SKILL.md');
    expect(scopeFolder('user', ' ', '/tmp/agent')).toBe('/tmp/agent/skills/<name>/SKILL.md');
  });
});

describe('reviewProblems: what keeps Approve disabled', () => {
  it('is empty for a text pi would load', () => {
    expect(reviewProblems(TEXT)).toEqual([]);
  });

  it('says what is wrong with the name and the text', () => {
    expect(reviewProblems(TEXT.replace('add-a-migration', 'Add A Migration'))).toEqual([
      expect.stringContaining('lowercase letters'),
    ]);
    expect(reviewProblems('# no frontmatter')).toEqual([expect.stringContaining('frontmatter')]);
    expect(reviewProblems('---\nname: x\n---\nbody')).toEqual([expect.stringContaining('description')]);
  });
});

describe('verification', () => {
  const plan = (over: Partial<VerifyPlan> = {}): VerifyPlan => ({
    canVerify: true,
    prompt: 'p',
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    files: 6,
    checks: [],
    model: null,
    busy: false,
    ...over,
  });
  const done = (over: Partial<SkillVerification> = {}): SkillVerification => ({
    state: 'done',
    result: 'pass',
    files: { reproduced: 6, expected: 6, extra: 0 },
    hunks: { matched: 6, expected: 6, actual: 6 },
    ...over,
  });

  it('the card says what the replay found, and nothing for a draft nobody replayed', () => {
    expect(draftVerifiedNote(english, { ...badge('pending'), verification: 'running' })).toBe('verifying…');
    expect(draftVerifiedNote(english, { ...badge('pending'), verification: 'pass' })).toBe(
      'verified: it reproduces its thread',
    );
    expect(draftVerifiedNote(english, { ...badge('pending'), verification: 'partial' })).toBe(
      'verified: it reproduces part of its thread',
    );
    expect(draftVerifiedNote(english, { ...badge('pending'), verification: 'failed' })).toBe(
      'verified: it does not reproduce its thread',
    );
    expect(draftVerifiedNote(english, badge('pending'))).toBe('');
    expect(draftVerifiedNote(english, { ...badge('pending'), verification: null })).toBe('');
  });

  it('the chip carries the state and the result, with a tone', () => {
    expect(verificationChip(english, null)).toBeUndefined();
    expect(verificationChip(english, { state: 'not-run', requested: true })).toBeUndefined();
    expect(verificationChip(english, { state: 'running' })).toEqual({ label: 'Verifying', tone: 'off' });
    expect(verificationChip(english, { state: 'stopped' })).toEqual({ label: 'Stopped', tone: 'off' });
    expect(verificationChip(english, { state: 'error', error: 'x' })).toEqual({
      label: 'Could not verify',
      tone: 'err',
    });
    expect(verificationChip(english, done())).toEqual({ label: 'Pass', tone: 'ok' });
    expect(verificationChip(english, done({ result: 'partial' }))).toEqual({ label: 'Partial', tone: 'warn' });
    expect(verificationChip(english, done({ result: 'failed' }))).toEqual({ label: 'Failed', tone: 'err' });
  });

  it('words for the phases, the files, the checks and the numbers', () => {
    expect(verificationPhaseText(english, 'run')).toBe('The thread is running with the skill pinned…');
    expect(verificationPhaseText(english, undefined)).toBe('Starting…');
    expect(fileStatusChip(english, 'same')).toEqual({ label: 'identical', tone: 'ok' });
    expect(fileStatusChip(english, 'missing').tone).toBe('err');
    expect(percentText(0.916)).toBe('92 %');
    const check = { command: 'npm test', originalPassed: true, exitCode: 0, seconds: 1, output: '' };
    expect(checkStateText(english, { ...check, state: 'passed' })).toBe('passed');
    expect(checkStateText(english, { ...check, state: 'failed', exitCode: 2 })).toBe('failed (exit 2)');
    expect(checkStateText(english, { ...check, state: 'failed', exitCode: null })).toBe('did not finish');
    expect(checkStateText(english, { ...check, state: 'skipped', exitCode: null })).toBe('not run');
  });

  describe('what the primary button does', () => {
    it('approves at once with Verify first off', () => {
      expect(primaryStep(english, { verify: false, verification: null, stale: false, plan: plan() })).toEqual({
        action: 'approve',
        label: 'Approve',
      });
    });

    it('replays first when Verify first is on and there is no report for this text', () => {
      expect(primaryStep(english, { verify: true, verification: null, stale: false, plan: plan() })).toEqual({
        action: 'verify',
        label: 'Verify first',
      });
      expect(primaryStep(english, { verify: true, verification: null, stale: false, plan: undefined })).toMatchObject({
        action: 'verify',
      });
      expect(
        primaryStep(english, {
          verify: true,
          verification: { state: 'not-run', requested: true },
          stale: false,
          plan: plan(),
        }),
      ).toMatchObject({ action: 'verify', label: 'Verify first' });
    });

    it('waits while a replay runs', () => {
      expect(
        primaryStep(english, { verify: true, verification: { state: 'running' }, stale: false, plan: plan() }),
      ).toEqual({
        action: 'wait',
        label: 'Verifying…',
      });
    });

    it('approves after a report for this text, whatever it says: the person decides', () => {
      for (const result of ['pass', 'partial', 'failed'] as const)
        expect(
          primaryStep(english, { verify: true, verification: done({ result }), stale: false, plan: plan() }),
        ).toEqual({
          action: 'approve',
          label: 'Approve',
        });
    });

    it('replays again after an edit, a stop or a replay that could not run', () => {
      expect(primaryStep(english, { verify: true, verification: done(), stale: true, plan: plan() })).toEqual({
        action: 'verify',
        label: 'Verify again',
      });
      expect(
        primaryStep(english, { verify: true, verification: { state: 'stopped' }, stale: false, plan: plan() }),
      ).toEqual({
        action: 'verify',
        label: 'Verify again',
      });
      expect(
        primaryStep(english, {
          verify: true,
          verification: { state: 'error', error: 'x' },
          stale: false,
          plan: plan(),
        }),
      ).toEqual({ action: 'verify', label: 'Verify again' });
    });

    it('approves as it is, with the reason, when the draft cannot be verified', () => {
      expect(
        primaryStep(english, {
          verify: true,
          verification: null,
          stale: false,
          plan: plan({ canVerify: false, reason: 'The thread has no outcome yet.' }),
        }),
      ).toEqual({
        action: 'approve',
        label: 'Approve',
        note: 'Cannot verify first, so Approve goes ahead without a report.',
      });
    });
  });
});

describe('the record line of a learned skill', () => {
  const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
  const skill = (over: Partial<LearnedSkill> = {}): LearnedSkill => ({
    id: 'd1',
    name: 'add-notes',
    scope: 'project',
    path: '/p/.pi/skills/add-notes/SKILL.md',
    retiredAt: null,
    missing: false,
    learnedFrom: { threadId: 't1', title: 'Add six notes', base: null, head: null },
    verification: { state: 'done', result: 'pass', at: Date.UTC(2026, 9, 17, 9), stale: false },
    uses: 4,
    mergedAfterUse: 3,
    threads: 3,
    lastUsedAt: NOW - 2 * 3_600_000,
    flag: null,
    ...over,
  });

  it('reads like the Settings row: learned from, verified, used and merged after, last used', () => {
    const line = learnedRecordLine(english, skill(), NOW);
    expect(line.from).toBe('Add six notes');
    expect(line.facts).toEqual(['verified Oct 17, pass', 'used 4 times, merged after 3', 'last used 2 h ago']);
    expect(learnedRecordText(english, skill(), NOW)).toBe(
      'Learned from Add six notes · verified Oct 17, pass · used 4 times, merged after 3 · last used 2 h ago',
    );
  });

  it('says what it does not know: never verified, never used, a thread that is gone', () => {
    const line = learnedRecordLine(
      english,
      skill({
        verification: null,
        uses: 0,
        mergedAfterUse: 0,
        lastUsedAt: null,
        learnedFrom: { threadId: 't1', title: null, base: null, head: null },
      }),
      NOW,
    );
    expect(line).toEqual({ from: 'a thread that was deleted', facts: ['not verified', 'not used yet'] });
  });

  it('counts one use, and none merged', () => {
    expect(learnedUsesText(english, { uses: 1, mergedAfterUse: 0 })).toBe('used once, none merged after');
    expect(learnedUsesText(english, { uses: 2, mergedAfterUse: 0 })).toBe('used 2 times, none merged after');
    expect(learnedUsesText(english, { uses: 2, mergedAfterUse: 1 })).toBe('used 2 times, merged after 1');
  });

  it('words every state of the last verification, a stale report included', () => {
    expect(learnedVerifiedText(english, { verification: { state: 'running', stale: false } }, NOW)).toBe('verifying…');
    expect(learnedVerifiedText(english, { verification: { state: 'stopped', stale: false } }, NOW)).toBe(
      'verification stopped',
    );
    expect(learnedVerifiedText(english, { verification: { state: 'error', stale: false } }, NOW)).toBe(
      'verification did not run',
    );
    expect(
      learnedVerifiedText(
        english,
        { verification: { state: 'done', result: 'partial', at: Date.UTC(2025, 11, 3), stale: true } },
        NOW,
      ),
    ).toBe('verified Dec 3, 2025, partial (edited since)');
  });

  it('dates in the current year have no year', () => {
    expect(shortDate(english, Date.UTC(2026, 9, 5, 12), NOW)).toBe('Oct 5');
    expect(shortDate(english, Date.UTC(2024, 0, 20, 12), NOW)).toBe('Jan 20, 2024');
  });

  it('says when a skill was retired', () => {
    expect(retiredText(english, { retiredAt: NOW - 3 * 86_400_000 }, NOW)).toBe('retired 3 d ago');
    expect(retiredText(english, { retiredAt: null }, NOW)).toBe('');
  });
});
