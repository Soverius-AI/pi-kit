import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { describe, expect, it } from 'vitest';
import { compareDiffs, dice, firstPromptOf, modelOfSession, parseDiff, planChecks, skillHash, tailOf, verdict } from './verify-rules';

/** `git diff -U0` of three notes: two new files and a changed one with two hunks. */
const DIFF = [
  'diff --git a/notes/one.md b/notes/one.md',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/notes/one.md',
  '@@ -0,0 +1,3 @@',
  '+# Note 1',
  '+A short note.',
  '+Note 1 of 3.',
  'diff --git a/src/map.ts b/src/map.ts',
  'index 2222222..3333333 100644',
  '--- a/src/map.ts',
  '+++ b/src/map.ts',
  '@@ -1,1 +1,1 @@',
  '-export function mapRow(row) {',
  '+export function mapRow(row, extra) {',
  '@@ -4,0 +5,2 @@',
  '+  // one',
  '+  // two',
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-gone',
  '-gone too',
  '',
].join('\n');

describe('parseDiff', () => {
  const files = parseDiff(DIFF);

  it('reads files and hunks of a -U0 diff', () => {
    expect(files.map((f) => f.path)).toEqual(['notes/one.md', 'src/map.ts', 'old.txt']);
    expect(files[0].hunks).toEqual([{ removed: [], added: ['# Note 1', 'A short note.', 'Note 1 of 3.'] }]);
    expect(files[1].hunks).toEqual([
      { removed: ['export function mapRow(row) {'], added: ['export function mapRow(row, extra) {'] },
      { removed: [], added: ['  // one', '  // two'] },
    ]);
    expect(files[2].hunks).toEqual([{ removed: ['gone', 'gone too'], added: [] }]);
  });

  it('does not take the file headers for changed lines, and ignores trailing blanks and CRs', () => {
    const [file] = parseDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x  \n+y\r\n');
    expect(file.hunks).toEqual([{ removed: ['x'], added: ['y'] }]);
  });

  it('knows a binary file by the blob it ends with, and a mode change', () => {
    const [bin, mode] = parseDiff('diff --git a/img.png b/img.png\nindex 111..abc123 100644\nBinary files a/img.png and b/img.png differ\ndiff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n');
    expect(bin).toMatchObject({ path: 'img.png', binary: 'abc123', hunks: [] });
    expect(mode).toMatchObject({ path: 'run.sh', mode: '100755', binary: null });
  });

  it('is empty for no diff', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('refuses an unreadable nonempty diff instead of treating the outcome as empty', () => {
    expect(() => parseDiff('diff --git "unterminated quoted path\n')).toThrow();
  });
});

describe('dice', () => {
  it('is 1 for the same lines in any order and 0 for none in common', () => {
    expect(dice(['a', 'b'], ['b', 'a'])).toBe(1);
    expect(dice(['a'], ['b'])).toBe(0);
    expect(dice([], [])).toBe(1);
    expect(dice(['a'], [])).toBe(0);
  });

  it('counts a repeated line as often as it is repeated', () => {
    expect(dice(['a', 'a', 'b'], ['a', 'b', 'b'])).toBeCloseTo((2 * 2) / 6);
  });
});

const file = (path: string, hunks: { removed?: string[]; added?: string[] }[]) => ({ path, binary: null, mode: null, hunks: hunks.map((h) => ({ removed: h.removed ?? [], added: h.added ?? [] })) });
const note = (n: number) => file(`notes/${n}.md`, [{ added: [`# Note ${n}`, 'A short note.', `Note ${n} of 6.`] }]);
const six = [1, 2, 3, 4, 5, 6].map(note);

describe('compareDiffs', () => {
  it('the same changes are the same by file and by hunk, whatever the order', () => {
    const result = compareDiffs(six, [...six].reverse());
    expect(result).toMatchObject({ reproduced: 6, expected: 6, extra: 0, hunks: { matched: 6, expected: 6, actual: 6 }, score: 1 });
    expect(result.files.every((f) => f.status === 'same' && f.similarity === 1)).toBe(true);
  });

  it('a file the replay did not touch is missing, and a file it touched on its own is extra', () => {
    const result = compareDiffs(six, [...six.slice(0, 5), file('stray.txt', [{ added: ['x'] }])]);
    expect(result.reproduced).toBe(5);
    expect(result.extra).toBe(1);
    expect(result.files.find((f) => f.path === 'notes/6.md')).toMatchObject({ status: 'missing', similarity: 0, hunks: { matched: 0, expected: 1, actual: 0 } });
    expect(result.files.find((f) => f.path === 'stray.txt')).toMatchObject({ status: 'extra', hunks: { expected: 0, actual: 1 } });
    // 15 of the 18 expected lines are there, plus one line that should not be: 2 * 15 / (18 + 16)
    expect(result.score).toBeCloseTo(30 / 34);
  });

  it('a file changed in part is reproduced when most of its lines match, and "different" when few do', () => {
    const close = compareDiffs([file('a', [{ added: ['1', '2', '3', '4', '5'] }])], [file('a', [{ added: ['1', '2', '3', '4', 'five'] }])]);
    expect(close.files[0]).toMatchObject({ status: 'similar', hunks: { matched: 1 } });
    expect(close.files[0].similarity).toBeCloseTo(0.8);
    const far = compareDiffs([file('a', [{ added: ['1', '2', '3', '4', '5'] }])], [file('a', [{ added: ['1', 'b', 'c', 'd', 'e'] }])]);
    expect(far.files[0]).toMatchObject({ status: 'different', hunks: { matched: 0, expected: 1, actual: 1 } });
    expect(far.reproduced).toBe(0);
  });

  it('matches hunks one to one, best match first, wherever they sit in the file', () => {
    const expected = [file('f', [{ added: ['a'] }, { removed: ['x'], added: ['y'] }, { added: ['c'] }])];
    const actual = [file('f', [{ added: ['c'] }, { added: ['a'] }])];
    const result = compareDiffs(expected, actual);
    expect(result.hunks).toEqual({ matched: 2, expected: 3, actual: 2 });
    expect(result.files[0].status).toBe('different');
  });

  it('one replayed hunk matches one expected hunk, not two', () => {
    const result = compareDiffs([file('f', [{ added: ['a'] }, { added: ['a'] }])], [file('f', [{ added: ['a'] }])]);
    expect(result.hunks).toEqual({ matched: 1, expected: 2, actual: 1 });
  });

  it('compares a binary file by its blob', () => {
    const bin = (blob: string) => ({ path: 'i.png', binary: blob, mode: null, hunks: [] });
    expect(compareDiffs([bin('abc')], [bin('abc')]).files[0].status).toBe('same');
    expect(compareDiffs([bin('abc')], [bin('def')]).files[0].status).toBe('different');
  });

  it('two empty diffs are the same, an outcome with no text and a replay with changes is not', () => {
    expect(compareDiffs([], [])).toMatchObject({ reproduced: 0, expected: 0, extra: 0, score: 1 });
    expect(compareDiffs([], [file('x', [{ added: ['a'] }])])).toMatchObject({ extra: 1, score: 0 });
  });

  it('the whole-diff score counts a line of a file only for that file', () => {
    const result = compareDiffs([file('a', [{ added: ['same'] }])], [file('b', [{ added: ['same'] }])]);
    expect(result.score).toBe(0);
  });
});

describe('verdict', () => {
  const full = { reproduced: 6, expected: 6, score: 1 };

  it('pass: every file reproduced, the whole diff alike, no check regressed', () => {
    expect(verdict(full, [])).toBe('pass');
    expect(verdict({ ...full, score: 0.92 }, [{ originalPassed: true, state: 'passed' }])).toBe('pass');
  });

  it('a check that failed before and fails again, or was not run, does not count against the skill', () => {
    expect(verdict(full, [{ originalPassed: false, state: 'failed' }, { originalPassed: true, state: 'skipped' }])).toBe('pass');
  });

  it('a check that passed before and fails now makes a pass partial', () => {
    expect(verdict(full, [{ originalPassed: true, state: 'failed' }])).toBe('partial');
  });

  it('partial: some of the files, or the right files with differences', () => {
    expect(verdict({ reproduced: 5, expected: 6, score: 0.91 }, [])).toBe('partial');
    expect(verdict({ reproduced: 6, expected: 6, score: 0.85 }, [])).toBe('partial');
  });

  it('failed: nothing reproduced, or the whole diff nearly unrelated', () => {
    expect(verdict({ reproduced: 0, expected: 6, score: 0.5 }, [])).toBe('failed');
    expect(verdict({ reproduced: 3, expected: 6, score: 0.2 }, [])).toBe('failed');
  });

  it('an outcome with no changed files is a pass only when the replay changed nothing either', () => {
    expect(verdict({ reproduced: 0, expected: 0, score: 1 }, [])).toBe('pass');
    expect(verdict({ reproduced: 0, expected: 0, score: 0 }, [])).toBe('partial');
  });
});

describe('planChecks: which checks run again', () => {
  const check = (step: number, command: string, passed = true) => ({ step, command, passed });

  it('lists each command once, with the outcome of its last run, in the order they were first run last', () => {
    expect(planChecks([check(2, 'npm test', false), check(5, 'npx eslint .'), check(7, 'npm test', true)], [])).toEqual([
      { command: 'npx eslint .', originalPassed: true },
      { command: 'npm test', originalPassed: true },
    ]);
  });

  it('does not run a command with a masked secret, or one that names the original folder by its path', () => {
    const planned = planChecks([check(1, 'API_KEY=[redacted openai key …abcd] npm test'), check(2, 'cd /home/me/app && npm test'), check(3, 'npm test')], ['/home/me/app', '/home/me/worktrees/app/fix']);
    expect(planned[0].skip).toMatch(/secret/);
    expect(planned[1].skip).toMatch(/absolute path/);
    expect(planned[2].skip).toBeUndefined();
  });

  it('a folder that is only a prefix of another path is not matched by a shorter name', () => {
    expect(planChecks([check(1, 'cd /home/me/app2 && npm test')], ['/'])[0].skip).toBeUndefined();
  });
});

const chain = (...messages: unknown[]): PiSessionEntry[] =>
  messages.map((message, i) => ({ type: 'message', id: `m${i}`, parentId: i === 0 ? null : `m${i - 1}`, timestamp: '2026-10-17T10:00:00.000Z', message }));

describe('what the replay is given', () => {
  it('the first prompt is the first user message, without the skill blocks a chip put in front of it', () => {
    const entries = chain({ role: 'user', content: '<skill name="a" location="/x/SKILL.md">\nReferences are relative to /x.\n\nUse it.\n</skill>\n\nCreate notes/one.md.' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: 'Then notes/two.md.' });
    expect(firstPromptOf(entries, null)).toBe('Create notes/one.md.');
  });

  it('reads a prompt of text blocks, follows the branch to its leaf, and is empty without a user message', () => {
    expect(firstPromptOf(chain({ role: 'user', content: [{ type: 'text', text: 'Do it' }, { type: 'image', data: 'x' }] }), null)).toBe('Do it');
    expect(firstPromptOf(chain({ role: 'assistant', content: [] }), null)).toBe('');
    expect(firstPromptOf([], null)).toBe('');
  });

  it('the model is the one the thread last answered with', () => {
    const entries = chain({ role: 'user', content: 'x' }, { role: 'assistant', provider: 'a', model: 'one', content: [] }, { role: 'user', content: 'y' }, { role: 'assistant', provider: 'b', model: 'two', content: [] });
    expect(modelOfSession(entries, null)).toEqual({ provider: 'b', modelId: 'two' });
    expect(modelOfSession(chain({ role: 'user', content: 'x' }), null)).toBeUndefined();
  });
});

describe('skillHash', () => {
  const text = (verified: string, body = 'Steps.') => `---\nname: a-b\ndescription: Use when x\nx-pi-kit:\n  learnedFrom: t1\n  base: null\n  head: null\n${verified}\n---\n${body}\n`;

  it('does not change with the provenance block, which verification itself rewrites', () => {
    expect(skillHash(text('  verified: null'))).toBe(skillHash(text('  verified:\n    result: pass\n    files: 6/6')));
  });

  it('changes with the name, the description and the instructions', () => {
    const one = skillHash(text('  verified: null'));
    expect(skillHash(text('  verified: null', 'Other steps.'))).not.toBe(one);
    expect(skillHash(text('  verified: null').replace('name: a-b', 'name: a-c'))).not.toBe(one);
    expect(skillHash(text('  verified: null').replace('Use when x', 'Use when y'))).not.toBe(one);
  });

  it('is not troubled by trailing blanks or a missing final newline', () => {
    expect(skillHash(text('  verified: null'))).toBe(skillHash(`${text('  verified: null').trimEnd()}   `));
  });
});

describe('tailOf', () => {
  it('keeps the end of a long output, cut at a line', () => {
    const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const tail = tailOf(output, 100);
    expect(tail.length).toBeLessThanOrEqual(101);
    expect(tail.startsWith('…')).toBe(true);
    expect(tail.endsWith('line 199')).toBe(true);
    expect(tailOf('short\n')).toBe('short');
  });
});
