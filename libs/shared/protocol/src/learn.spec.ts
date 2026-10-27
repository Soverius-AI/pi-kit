import { describe, expect, it } from 'vitest';
import { type SkillVerification, SkillVerificationSchema, isSkillName, normalizeSkillText, parseSkillText, provenanceOf, setSkillName, skillTextProblems, slugSkillName, stampProvenance, stampVerified, verificationSummary, verifiedLines, verifiedOfText, verifiedResult, verifiedResultOfText, learnedFlag, type UsingThread } from './learn';

const skill = '---\nname: add-a-migration\ndescription: Use when adding a table with its migration\n---\n\n# Add a migration\n\n1. Write the SQL\n';

describe('skill names', () => {
  it('follow pi’s rule: lowercase letters, digits and single hyphens, at most 64', () => {
    for (const ok of ['a', 'add-a-migration', 'x1-y2', 'a'.repeat(64)]) expect(isSkillName(ok), ok).toBe(true);
    for (const bad of ['', 'Add', 'a--b', '-a', 'a-', 'a_b', 'a b', 'a/b', '../x', 'a.b', 'a'.repeat(65)]) expect(isSkillName(bad), bad).toBe(false);
  });

  it('are made from free text', () => {
    expect(slugSkillName('Add a Migration (with test)!')).toBe('add-a-migration-with-test');
    expect(slugSkillName('Überprüfung der Größe')).toBe('uberprufung-der-gro-e');
    expect(slugSkillName('!!!')).toBeUndefined();
  });
});

describe('parseSkillText', () => {
  it('reads name, description and body', () => {
    expect(parseSkillText(skill)).toMatchObject({ frontmatter: true, name: 'add-a-migration', description: 'Use when adding a table with its migration', body: '\n# Add a migration\n\n1. Write the SQL\n' });
  });

  it('reads quoted values and CRLF', () => {
    expect(parseSkillText('---\r\nname: "x-y"\r\ndescription: \'Use when: z\'\r\n---\r\nBody').description).toBe('Use when: z');
    expect(parseSkillText('no frontmatter')).toMatchObject({ frontmatter: false, name: undefined });
  });
});

describe('skillTextProblems', () => {
  it('is empty for a skill pi loads', () => {
    expect(skillTextProblems(skill)).toEqual([]);
  });

  it('names what is wrong', () => {
    expect(skillTextProblems('# just text')).toEqual([expect.stringContaining('frontmatter')]);
    expect(skillTextProblems('---\ndescription: d\n---\nbody')).toEqual(['The frontmatter has no name.']);
    expect(skillTextProblems('---\nname: Bad Name\ndescription: d\n---\nbody')).toEqual([expect.stringContaining('lowercase')]);
    expect(skillTextProblems('---\nname: a\n---\nbody')).toEqual([expect.stringContaining('no description')]);
    expect(skillTextProblems('---\nname: a\ndescription: d\n---\n\n')).toEqual([expect.stringContaining('no instructions')]);
  });
});

describe('normalizeSkillText', () => {
  it('quotes a description YAML would misread, and sets the name', () => {
    const text = normalizeSkillText('---\nname: old\ndescription: Use when: adding things # now\n---\nBody\n', 'new-name');
    expect(text).toContain('name: new-name\n');
    expect(text).toContain('description: "Use when: adding things # now"\n');
    expect(parseSkillText(text).description).toBe('Use when: adding things # now');
  });

  it('leaves a safe description and an already quoted one alone', () => {
    expect(normalizeSkillText(skill)).toContain('description: Use when adding a table with its migration\n');
    expect(normalizeSkillText('---\nname: a\ndescription: "Use when: x"\n---\nB\n')).toContain('description: "Use when: x"');
  });
});

describe('setSkillName', () => {
  it('replaces only the name line and leaves everything else as the person wrote it', () => {
    const text = '---\nname: old\ndescription: "Use when: x"\nx-pi-kit:\n  learnedFrom: t\n---\n\n# Body\n\nText\n';
    expect(setSkillName(text, 'new-name')).toBe(text.replace('name: old', 'name: new-name'));
    expect(setSkillName(setSkillName(text, 'a'), 'old')).toBe(text);
  });

  it('adds the line when there is none, or the whole frontmatter when there is none', () => {
    expect(setSkillName('---\ndescription: d\n---\nB\n', 'n')).toBe('---\nname: n\ndescription: d\n---\nB\n');
    expect(setSkillName('Just text\n', 'n')).toBe('---\nname: n\n---\nJust text\n');
  });
});

describe('the provenance block', () => {
  const prov = { learnedFrom: 'thread-1', base: 'a'.repeat(40), head: 'b'.repeat(40) };

  it('records the thread and the commits under x-pi-kit', () => {
    const text = stampProvenance(skill, prov);
    expect(text).toContain(`x-pi-kit:\n  learnedFrom: thread-1\n  base: ${'a'.repeat(40)}\n  head: ${'b'.repeat(40)}\n  verified: null\n---\n`);
    expect(parseSkillText(text)).toMatchObject({ name: 'add-a-migration', description: 'Use when adding a table with its migration' });
    expect(provenanceOf(text)).toEqual({ learnedFrom: 'thread-1', base: 'a'.repeat(40), head: 'b'.repeat(40) });
    // The body stays as it was written: the blank line after the frontmatter is still there.
    expect(text).toContain('verified: null\n---\n\n# Add a migration');
    expect(normalizeSkillText(skill)).toContain('---\n\n# Add a migration');
  });

  it('writes null for a thread without an outcome', () => {
    const text = stampProvenance(skill, { learnedFrom: 't', base: null, head: null });
    expect(text).toContain('  base: null\n  head: null');
    expect(provenanceOf(text)).toEqual({ learnedFrom: 't', base: undefined, head: undefined });
  });

  it('replaces an edited block but keeps what verification wrote', () => {
    const edited = stampProvenance(skill, prov).replace('learnedFrom: thread-1', 'learnedFrom: forged').replace('verified: null', 'verified:\n    result: pass\n    score: 0.9');
    const again = stampProvenance(edited, prov);
    expect(provenanceOf(again).learnedFrom).toBe('thread-1');
    expect(again).toContain('  verified:\n    result: pass\n    score: 0.9\n');
    expect(again.match(/x-pi-kit:/g)).toHaveLength(1);
  });

  it('restores a block the person deleted', () => {
    expect(provenanceOf(stampProvenance(stampProvenance(skill, prov).replace(/x-pi-kit:[\s\S]*?(?=---\n\n)/, ''), prov)).learnedFrom).toBe('thread-1');
  });
});

describe('the verification record', () => {
  const prov = { learnedFrom: 'thread-1', base: 'a'.repeat(40), head: 'b'.repeat(40) };
  const FINISHED = Date.UTC(2026, 9, 17, 10, 30, 0);
  const done: SkillVerification = {
    state: 'done',
    result: 'partial',
    finishedAt: FINISHED,
    base: 'a'.repeat(40),
    score: 0.9166,
    files: { reproduced: 5, expected: 6, extra: 0 },
    hunks: { matched: 5, expected: 6, actual: 5 },
    checks: [
      { command: 'npm test', originalPassed: true, state: 'passed', exitCode: 0, seconds: 1.2, output: '' },
      { command: 'npm run lint', originalPassed: true, state: 'skipped', exitCode: null, seconds: 0, output: '', note: 'x' },
    ],
  };

  it('states a result only for a replay that ran to the end', () => {
    expect(verifiedLines(done)).toEqual([
      '  verified:',
      '    result: partial',
      '    at: 2026-10-17T10:30:00.000Z',
      '    files: 5/6',
      '    hunks: 5/6',
      '    checks: 1/1',
      '    similarity: 0.92',
      `    replayedFrom: ${'a'.repeat(40)}`,
    ]);
    for (const other of [null, undefined, { state: 'running' as const }, { state: 'stopped' as const }, { state: 'error' as const, error: 'x' }, { state: 'not-run' as const }, { state: 'done' as const }]) expect(verifiedLines(other)).toEqual(['  verified: null']);
  });

  it('stamps the result into the x-pi-kit block, replaces an older one, and clears it', () => {
    const base = stampProvenance(skill, prov);
    const stamped = stampVerified(base, done);
    expect(stamped).toContain('  head: ' + 'b'.repeat(40) + '\n  verified:\n    result: partial\n    at: 2026-10-17T10:30:00.000Z\n');
    expect(parseSkillText(stamped)).toMatchObject({ name: 'add-a-migration' });
    expect(provenanceOf(stamped)).toEqual({ learnedFrom: 'thread-1', base: 'a'.repeat(40), head: 'b'.repeat(40) });
    expect(stamped.match(/x-pi-kit:/g)).toHaveLength(1);
    // The body and the blank line after the frontmatter are untouched.
    expect(stamped.endsWith('---\n\n# Add a migration\n\n1. Write the SQL\n')).toBe(true);
    const again = stampVerified(stamped, { ...done, result: 'pass', files: { reproduced: 6, expected: 6, extra: 0 } });
    expect(again).toContain('    result: pass\n');
    expect(again).not.toContain('result: partial');
    expect(again.match(/verified:/g)).toHaveLength(1);
    expect(stampVerified(again, null)).toBe(base);
    // stampProvenance keeps the block it does not own.
    expect(stampProvenance(stamped, prov)).toBe(stamped);
  });

  it('leaves a text without a provenance block or without frontmatter as it is', () => {
    expect(stampVerified(skill, done)).toBe(skill);
    expect(stampVerified('no frontmatter', done)).toBe('no frontmatter');
  });

  it('keeps other keys of the block and what follows it', () => {
    const text = '---\nname: a\ndescription: d\nx-pi-kit:\n  learnedFrom: t\n  base: null\n  head: null\n  verified: null\nlicense: MIT\n---\nB\n';
    const stamped = stampVerified(text, done);
    expect(stamped).toContain('  head: null\n  verified:\n    result: partial\n');
    expect(stamped).toContain('replayedFrom: ' + 'a'.repeat(40) + '\nlicense: MIT\n---\nB\n');
  });

  it('reads the stated result back', () => {
    expect(verifiedResultOfText(stampVerified(stampProvenance(skill, prov), done))).toBe('partial');
    expect(verifiedResultOfText(stampProvenance(skill, prov))).toBeUndefined();
    expect(verifiedResultOfText('---\nname: a\n---\n')).toBeUndefined();
  });

  it('describes a finished replay with its numbers, and the other states in a few words', () => {
    expect(verificationSummary(done)).toBe('Reproduced 5 of 6 files and 5 of 6 hunks; 1 of 1 check passes again.');
    expect(verificationSummary({ ...done, files: { reproduced: 1, expected: 1, extra: 2 }, hunks: { matched: 1, expected: 1, actual: 3 }, checks: [] })).toBe('Reproduced 1 of 1 file and 1 of 1 hunk, and touched 2 files it should not have.');
    expect(verificationSummary({ ...done, checks: [done.checks![0], { ...done.checks![0], command: 'b', state: 'failed' }] })).toContain('1 of 2 checks pass again');
    expect(verificationSummary({ state: 'running' })).toBe('Verifying…');
    expect(verificationSummary({ state: 'stopped' })).toMatch(/Stopped/);
    expect(verificationSummary({ state: 'error', error: 'No worktree.' })).toBe('No worktree.');
    expect(verificationSummary({ state: 'not-run' })).toBe('Not verified.');
  });

  it('only a finished replay has a result', () => {
    expect(verifiedResult(done)).toBe('partial');
    expect(verifiedResult({ state: 'running', result: 'pass' })).toBeUndefined();
    expect(verifiedResult(null)).toBeUndefined();
  });

  it('the schema takes the 10b record and refuses an unknown state', () => {
    expect(SkillVerificationSchema.safeParse({ requested: true, state: 'not-run' }).success).toBe(true);
    expect(SkillVerificationSchema.safeParse({ state: 'sideways' }).success).toBe(false);
    expect(SkillVerificationSchema.safeParse(done).success).toBe(true);
  });
});

describe('the flag of a learned skill', () => {
  const thread = (n: number, outcome: UsingThread['outcome'] = null, ended = true): UsingThread => ({ threadId: `t${n}`, lastUseAt: n * 1000, outcome, ended });

  it('needs three threads that have ended', () => {
    expect(learnedFlag([], undefined)).toBeNull();
    expect(learnedFlag([thread(1), thread(2)], undefined)).toBeNull();
    // A thread that still runs has not failed yet; it is not one of the three.
    expect(learnedFlag([thread(1), thread(2), thread(3, null, false)], undefined)).toBeNull();
    expect(learnedFlag([thread(1), thread(2), thread(3, null, false), thread(4)], undefined)?.reason).toBe('no-outcomes');
  });

  it('flags the last three threads that all ended without an outcome', () => {
    expect(learnedFlag([thread(1), thread(2), thread(3)], undefined)).toMatchObject({ reason: 'no-outcomes', text: expect.stringContaining('without a commit, merge or pull request') });
    // Only the last three count: an older failure and a newer success do not flag, and an old success followed by three failures does.
    expect(learnedFlag([thread(1), thread(2), thread(3), thread(4, 'merged')], undefined)).toBeNull();
    expect(learnedFlag([thread(1, 'merged'), thread(2), thread(3), thread(4)], undefined)?.reason).toBe('no-outcomes');
  });

  it('does not flag when any of the last three landed an outcome', () => {
    expect(learnedFlag([thread(1), thread(2, 'committed'), thread(3)], undefined)).toBeNull();
    expect(learnedFlag([thread(1), thread(2, 'pr'), thread(3)], 'pass')).toBeNull();
  });

  it('flags a failed verification when none of the last three merged, and never when one did', () => {
    expect(learnedFlag([thread(1, 'committed'), thread(2, 'pr'), thread(3)], 'failed')?.reason).toBe('failed-verification');
    expect(learnedFlag([thread(1, 'committed'), thread(2, 'merged'), thread(3, 'committed')], 'failed')).toBeNull();
    expect(learnedFlag([thread(1, 'committed'), thread(2), thread(3, 'committed')], 'partial')).toBeNull();
    expect(learnedFlag([thread(1), thread(2)], 'failed')).toBeNull();
  });

  it('reads the order from the time of the last use, whatever order the threads come in', () => {
    expect(learnedFlag([thread(3), thread(1), thread(4, 'merged'), thread(2)], undefined)).toBeNull();
    expect(learnedFlag([thread(2), thread(5), thread(1, 'merged'), thread(3)], undefined)?.reason).toBe('no-outcomes');
  });
});

describe('verifiedOfText', () => {
  it('reads the result and time of the verified block', () => {
    const text = stampVerified(stampProvenance(skill, { learnedFrom: 't', base: null, head: null }), { state: 'done', result: 'partial', finishedAt: Date.UTC(2026, 9, 17, 10, 30), files: { reproduced: 1, expected: 2, extra: 0 }, hunks: { matched: 1, expected: 2, actual: 1 } });
    expect(verifiedOfText(text)).toEqual({ result: 'partial', at: Date.UTC(2026, 9, 17, 10, 30) });
    expect(verifiedOfText(stampProvenance(skill, { learnedFrom: 't', base: null, head: null }))).toBeUndefined();
    expect(verifiedOfText(skill)).toBeUndefined();
  });
});
