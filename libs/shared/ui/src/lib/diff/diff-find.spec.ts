import { describe, expect, it } from 'vitest';
import { hunksToModel, type DiffModel } from '@pi-kit/protocol';
import { buildRows } from './diff-rows';
import { diffTextParts, findInDiff } from './diff-find';

const model: DiffModel = {
  path: 'file.txt',
  status: 'M',
  added: 1,
  removed: 1,
  binary: false,
  tooLarge: false,
  hunks: hunksToModel([
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' Needle', '-old needle', '+new needle needle'] },
  ]),
};

describe('find in diff', () => {
  it('finds every occurrence in unified order, including context and removed text', () => {
    const index = findInDiff(buildRows(model, 'unified', [], null), 'needle');
    expect(index.matches.map((match) => match.row)).toEqual([1, 2, 3, 3]);
    expect(findInDiff(buildRows(model, 'unified', [], null), 'needle', true).matches).toHaveLength(3);
  });

  it('indexes both sides in split order and counts each displayed occurrence', () => {
    const index = findInDiff(buildRows(model, 'split', [], null), 'needle');
    expect(index.matches.map((match) => match.side)).toEqual(['old', 'new', 'old', 'new', 'new']);
    expect(index.byCell.get('2:new')).toHaveLength(2);
  });

  it('treats regex syntax literally and preserves text safely when highlighting', () => {
    const rows = buildRows(
      {
        ...model,
        hunks: hunksToModel([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+  <b>[.*]</b> [.*]'] }]),
      },
      'unified',
      [],
      null,
    );
    const index = findInDiff(rows, '[.*]');
    expect(index.matches).toHaveLength(2);
    const parts = diffTextParts('  <b>[.*]</b> [.*]', index.byCell.get('1:unified'));
    expect(parts.map((part) => part.text).join('')).toBe('  <b>[.*]</b> [.*]');
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(['[.*]', '[.*]']);
  });

  it('keeps Unicode offsets valid when a case fold would change string length', () => {
    const rows = buildRows(
      {
        ...model,
        hunks: hunksToModel([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+İ İ needle'] }]),
      },
      'unified',
      [],
      null,
    );
    const index = findInDiff(rows, 'NEEDLE');
    expect(index.matches[0]).toMatchObject({ start: 4, end: 10 });
  });

  it('returns no results for an empty query and handles many matches on one line', () => {
    const rows = buildRows(
      {
        ...model,
        hunks: hunksToModel([
          { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+' + 'x'.repeat(100_000)] },
        ]),
      },
      'unified',
      [],
      null,
    );
    expect(findInDiff(rows, '').matches).toEqual([]);
    const index = findInDiff(rows, 'x');
    expect(index.matches).toHaveLength(100_000);
    const current = index.matches[99_999];
    const parts = diffTextParts('x'.repeat(100_000), index.matches, current);
    expect(parts.filter((part) => part.match)).toHaveLength(200);
    expect(parts.some((part) => part.match === current)).toBe(true);
    expect(parts.map((part) => part.text).join('')).toBe('x'.repeat(100_000));
  });
});
