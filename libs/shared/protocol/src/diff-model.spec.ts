import { describe, expect, it } from 'vitest';
import { countChanges, hunksToModel, reviewBatchOf, splitRows } from './index';

const hunk = (oldStart: number, newStart: number, lines: string[]) => ({
  oldStart,
  oldLines: lines.filter((l) => !l.startsWith('+')).length,
  newStart,
  newLines: lines.filter((l) => !l.startsWith('-')).length,
  lines,
});

describe('hunksToModel', () => {
  it('numbers old and new lines from the hunk header', () => {
    const [model] = hunksToModel([hunk(40, 40, [' keep', '-gone', '+new one', '+new two', ' tail'])]);
    expect(model.header).toBe('@@ -40,3 +40,4 @@');
    expect(model.lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ['ctx', 40, 40, 'keep'],
      ['del', 41, null, 'gone'],
      ['add', null, 41, 'new one'],
      ['add', null, 42, 'new two'],
      ['ctx', 42, 43, 'tail'],
    ]);
    expect(countChanges([model])).toEqual({ added: 2, removed: 1 });
  });

  it('shows a written file as all added from line 1', () => {
    const [model] = hunksToModel([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }]);
    expect(model.lines.map((l) => l.newNo)).toEqual([1, 2]);
    expect(model.lines.every((l) => l.oldNo === null)).toBe(true);
  });
});

describe('splitRows', () => {
  const rows = (lines: string[]) => hunksToModel([hunk(1, 1, lines)])[0].split.map((r) => [r.left?.text ?? null, r.right?.text ?? null]);

  it('puts context on both sides', () => {
    expect(rows([' a', ' b'])).toEqual([['a', 'a'], ['b', 'b']]);
  });

  it('pairs a removed run with the added run that follows and lets the longer run overhang', () => {
    expect(rows([' a', '-x', '-y', '+X', ' z'])).toEqual([['a', 'a'], ['x', 'X'], ['y', null], ['z', 'z']]);
    expect(rows(['-x', '+X', '+Y'])).toEqual([['x', 'X'], [null, 'Y']]);
  });

  it('starts a new block when a removal follows an addition', () => {
    expect(rows(['+A', '-b'])).toEqual([[null, 'A'], ['b', null]]);
  });

  it('is empty for no lines', () => {
    expect(splitRows([])).toEqual([]);
  });
});

describe('reviewBatchOf', () => {
  const comment = { id: 'c1', file: 'a.ts', side: 'new', line: 3, snippet: 'x', text: 'why' };

  it('reads a valid batch from forwardedProps', () => {
    expect(reviewBatchOf({ review: { comments: [comment] } })?.comments).toHaveLength(1);
  });

  it('ignores anything else so the prompt still runs', () => {
    expect(reviewBatchOf(undefined)).toBeUndefined();
    expect(reviewBatchOf({ review: { comments: [] } })).toBeUndefined();
    expect(reviewBatchOf({ review: { comments: [{ ...comment, line: 'three' }] } })).toBeUndefined();
  });
});
