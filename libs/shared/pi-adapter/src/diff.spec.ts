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

  it('counts added and removed lines', () => {
    expect(diffStat(parseUnifiedPatch(patch))).toEqual({ added: 3, removed: 2 });
  });
});

describe('addedFileHunks', () => {
  it('shows a written file as one added hunk', () => {
    expect(addedFileHunks('a\nb\n')).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }]);
    expect(addedFileHunks('')).toEqual([]);
  });
});
