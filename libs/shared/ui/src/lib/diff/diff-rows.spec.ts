import { type DiffModel, type ReviewComment, hunksToModel } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { buildRows, countByFile, defaultAnchor, modelFromActivity, snippetOf, type Draft } from './diff-rows';

const model = (): DiffModel => {
  const hunks = hunksToModel([
    { oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' keep', '-old line', '+new line', ' tail'] },
  ]);
  return { path: 'a.ts', status: 'M', added: 1, removed: 1, binary: false, tooLarge: false, hunks };
};
const comment = (id: string, side: 'old' | 'new', line: number): ReviewComment => ({
  id,
  file: 'a.ts',
  side,
  line,
  snippet: 's',
  text: `t${id}`,
});

describe('buildRows', () => {
  it('lists a hunk header and one row per line in the unified layout', () => {
    const rows = buildRows(model(), 'unified', [], null);
    expect(rows.map((r) => r.kind)).toEqual(['hunk', 'unified', 'unified', 'unified', 'unified']);
  });

  it('names every hunk row by the id a hunk label is stored under: the file and the two start lines of its header', () => {
    const [hunk] = buildRows(model(), 'unified', [], null);
    expect(hunk).toMatchObject({ kind: 'hunk', header: '@@ -10,3 +10,3 @@', id: 'a.ts@10:10' });
    expect(buildRows(model(), 'split', [], null)[0]).toMatchObject({ kind: 'hunk', id: 'a.ts@10:10' });
  });

  it('puts a comment on a removed line under its old number and on an added line under its new one', () => {
    const rows = buildRows(model(), 'unified', [comment('1', 'old', 11), comment('2', 'new', 11)], null);
    const unified = rows.filter((r) => r.kind === 'unified');
    expect(unified.map((r) => r.comments.map((c) => c.id))).toEqual([[], ['1'], ['2'], []]);
  });

  it('shows the comment being edited as the editor only', () => {
    const draft: Draft = { side: 'new', line: 11, snippet: 'new line', id: '2', text: 'old text' };
    const rows = buildRows(model(), 'unified', [comment('2', 'new', 11)], draft);
    const row = rows.filter((r) => r.kind === 'unified')[2];
    expect(row.kind === 'unified' && row.comments).toEqual([]);
    expect(row.kind === 'unified' && row.draft?.id).toBe('2');
  });

  it('a range comment sits under its last line and marks every row it covers, on its side only', () => {
    const range: ReviewComment = { ...comment('r', 'new', 10), endLine: 12, snippet: 'keep\nnew line\ntail' };
    const rows = buildRows(model(), 'unified', [range], null);
    const unified = rows.filter((r) => r.kind === 'unified');
    // rows: keep (old 10 / new 10), old line (old 11), new line (new 11), tail (old 12 / new 12)
    expect(unified.map((r) => r.kind === 'unified' && r.marked)).toEqual([true, false, true, true]);
    expect(unified.map((r) => r.comments.map((c) => c.id))).toEqual([[], [], [], ['r']]);
    const split = buildRows(model(), 'split', [range], null).filter((r) => r.kind === 'split');
    expect(split.map((r) => r.kind === 'split' && [r.markedOld, r.markedNew])).toEqual([
      [false, true],
      [false, true],
      [false, true],
    ]);
    expect(split[2].kind === 'split' && split[2].comments.map((c) => c.id)).toEqual(['r']);
  });

  it('the editor of a range is placed and marked the same way, and snippetOf joins the covered lines of one side', () => {
    const draft: Draft = { side: 'new', line: 10, endLine: 11, snippet: '' };
    const rows = buildRows(model(), 'unified', [], draft).filter((r) => r.kind === 'unified');
    expect(rows.map((r) => r.kind === 'unified' && r.marked)).toEqual([true, false, true, false]);
    expect(rows[2].kind === 'unified' && rows[2].draft?.endLine).toBe(11);
    expect(snippetOf(model(), 'new', 10, 12)).toBe('keep\nnew line\ntail');
    expect(snippetOf(model(), 'old', 11, 11)).toBe('old line');
  });

  it('pairs removed and added lines in the split layout and keeps comments on their own side', () => {
    const rows = buildRows(model(), 'split', [comment('1', 'old', 11), comment('2', 'new', 11)], null);
    const split = rows.filter((r) => r.kind === 'split');
    expect(split).toHaveLength(3);
    const pair = split[1];
    expect(pair.kind === 'split' && [pair.left?.row.text, pair.right?.row.text]).toEqual(['old line', 'new line']);
    // both comments hang under the pair: it hosts the old line 11 and the new line 11
    expect(pair.kind === 'split' && pair.comments.map((c) => c.id)).toEqual(['1', '2']);
  });

  it('places an editor for a new comment once', () => {
    const rows = buildRows(model(), 'unified', [], { side: 'new', line: 10, snippet: 'keep' });
    expect(rows.filter((r) => r.kind === 'unified' && r.draft)).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('anchors a removed line on the old side and anything else on the new side', () => {
    const [hunk] = model().hunks;
    expect(defaultAnchor(hunk.lines[1])).toEqual({ side: 'old', line: 11, snippet: 'old line' });
    expect(defaultAnchor(hunk.lines[2])).toEqual({ side: 'new', line: 11, snippet: 'new line' });
  });

  it('makes a model of a pi.diff activity, a written file as added', () => {
    const edit = modelFromActivity({
      path: 'x.ts',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
    });
    expect(edit).toMatchObject({ status: 'M', added: 1, removed: 1 });
    const written = modelFromActivity({
      path: 'y.ts',
      written: true,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }],
    });
    expect(written).toMatchObject({ status: 'A', added: 2, removed: 0 });
  });

  it('counts comments per file', () => {
    expect([
      ...countByFile([comment('1', 'new', 1), comment('2', 'new', 2), { ...comment('3', 'new', 3), file: 'b.ts' }]),
    ]).toEqual([
      ['a.ts', 2],
      ['b.ts', 1],
    ]);
  });
});
