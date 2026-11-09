import { describe, expect, it } from 'vitest';
import { addedFileHunks, diffStat, parseUnifiedPatch } from './diff';

describe('parseUnifiedPatch', () => {
  const patch = [
    'Index: src/a.ts',
    '===================================================================',
    '--- src/a.ts',
    '+++ src/a.ts',
    '@@ -3,4 +3,5 @@',
    ' keep',
    '-old line',
    '+new line',
    '+extra line',
    ' keep too',
    '@@ -20 +21 @@',
    '-x',
    '+y',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  it('reads hunk headers and keeps only diff lines', () => {
    const hunks = parseUnifiedPatch(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual({
      oldStart: 3,
      oldLines: 4,
      newStart: 3,
      newLines: 5,
      lines: [' keep', '-old line', '+new line', '+extra line', ' keep too'],
    });
    expect(hunks[1]).toMatchObject({ oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: ['-x', '+y'] });
  });

  it('does not take the file headers for changed lines', () => {
    expect(parseUnifiedPatch('--- a\n+++ b\n')).toEqual([]);
    expect(parseUnifiedPatch('')).toEqual([]);
  });

  it('does not include a following file header or metadata in the previous hunk', () => {
    const hunks = parseUnifiedPatch(
      'diff --git a/first b/first\n--- a/first\n+++ b/first\n@@ -1 +1 @@\n-old\n+new\n' +
        'diff --git a/second b/second\n--- a/second\n+++ b/second\n@@ -2 +2 @@\n-before\n+after\n',
    );
    expect(hunks.map((hunk) => hunk.lines)).toEqual([
      ['-old', '+new'],
      ['-before', '+after'],
    ]);
    expect(diffStat(hunks)).toEqual({ added: 2, removed: 2 });
  });

  it('bounds headerless file sections without mistaking header-like body lines for metadata', () => {
    expect(
      parseUnifiedPatch(
        '--- first\n+++ first\n@@ -1 +1 @@\n--- removed text\n+++ added text\n' +
          '--- second\n+++ second\n@@ -1 +1 @@\n-old\n+new\n',
      ).map((hunk) => hunk.lines),
    ).toEqual([
      ['--- removed text', '+++ added text'],
      ['-old', '+new'],
    ]);
  });

  it('ends a partial hunk at the next file section even when that file has no hunks', () => {
    const hunks = parseUnifiedPatch(
      'Index: first\n--- first\n+++ first\n@@ -1,4 +1,4 @@\n-old\n+new\n' + 'Index: second\n--- second\n+++ second\n',
    );
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual(['-old', '+new']);
  });

  it('preserves partial tool patches and exact zero-length-side coordinates', () => {
    expect(parseUnifiedPatch('@@ -0,0 +1,3 @@\n+first\n')).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, lines: ['+first'] },
    ]);
    expect(parseUnifiedPatch('@@ -3,2 +2,0 @@\n-one\n-two\n')[0]).toMatchObject({
      oldStart: 3,
      oldLines: 2,
      newStart: 2,
      newLines: 0,
      lines: ['-one', '-two'],
    });
  });

  it('counts added and removed lines', () => {
    expect(diffStat(parseUnifiedPatch(patch))).toEqual({ added: 3, removed: 2 });
  });
});

describe('addedFileHunks', () => {
  it('shows a written file as one added hunk', () => {
    expect(addedFileHunks('a\nb\n')).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] },
    ]);
    expect(addedFileHunks('')).toEqual([]);
  });
});
