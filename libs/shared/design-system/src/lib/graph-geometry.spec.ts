import { describe, expect, it } from 'vitest';
import {
  GRAPH_BAND,
  GRAPH_LANE,
  GRAPH_ROW,
  type PkGraphNode,
  graphCell,
  graphCellWidth,
  graphLaneX,
  ringLevel,
} from './graph-geometry';

const node = (patch: Partial<PkGraphNode> = {}): PkGraphNode => ({
  kind: 'turn',
  lane: 0,
  through: [],
  forks: [],
  up: true,
  down: true,
  onActivePath: true,
  isLeaf: false,
  ...patch,
});

describe('graph geometry v2', () => {
  it('uses 28px lanes and 36px rows, nodes centred in the lane and the row', () => {
    expect(GRAPH_LANE).toBe(28);
    expect(GRAPH_ROW).toBe(36);
    expect(graphLaneX(0)).toBe(14);
    expect(graphLaneX(1)).toBe(42);
    const cell = graphCell(node(), 2);
    expect(cell.height).toBe(36);
    expect(cell.width).toBe(2 * 28 + 8);
    expect(cell.glyph).toMatchObject({ shape: 'circle', x: 14, y: 18, size: 5, classes: 'on' });
  });

  it('is never narrower than two lanes', () => {
    expect(graphCellWidth(1)).toBe(graphCellWidth(2));
    expect(graphCellWidth(3)).toBe(3 * 28 + 8);
  });

  it('draws the active line in the accent and a line that crosses the row in its lane', () => {
    const cell = graphCell(node({ through: [1] }), 2);
    expect(cell.paths).toEqual([
      { d: 'M42 0 V 36', on: false },
      { d: 'M14 0 V 36', on: true },
    ]);
  });

  it('draws only the half line at the ends of the path', () => {
    expect(graphCell(node({ up: false }), 2).paths).toEqual([{ d: 'M14 18 V 36', on: true }]);
    expect(graphCell(node({ down: false }), 2).paths).toEqual([{ d: 'M14 0 V 18', on: true }]);
  });

  it('opens a lane with the mockup curve from the node to the bottom of the row', () => {
    const cell = graphCell(node({ forks: [1] }), 2);
    expect(cell.paths).toContainEqual({ d: 'M14 18 C 14 32, 42 22, 42 36', on: false });
  });

  it('marks the leaf (it glows through the stylesheet) and draws the ghost as a dashed stub', () => {
    expect(graphCell(node({ isLeaf: true }), 2).glyph.classes).toBe('leaf');
    const ghost = graphCell(node({ kind: 'ghost', down: false }), 2);
    expect(ghost.glyph.classes).toBe('ghost');
    expect(ghost.paths).toEqual([{ d: 'M14 0 V 18', on: false, dashed: true }]);
  });

  it('draws a compaction as a square in a 28px band', () => {
    const cell = graphCell(node({ kind: 'compaction' }), 2);
    expect(cell.height).toBe(GRAPH_BAND);
    expect(cell.glyph).toMatchObject({ shape: 'square', x: 9, y: 9, size: 10 });
    expect(cell.paths).toEqual([{ d: 'M14 0 V 28', on: true }]);
  });

  it('draws a folded group with a dashed node when its branch was summarised', () => {
    expect(
      graphCell(node({ kind: 'group', lane: 1, down: false, onActivePath: false, dashed: true }), 2).glyph,
    ).toMatchObject({ x: 42, classes: 'summary' });
    expect(graphCell(node({ kind: 'group', lane: 1, onActivePath: false }), 2).glyph.classes).toBe('');
  });

  describe('context ring', () => {
    it('is a circle of radius 8.5 around a turn node whose arc is the percentage', () => {
      expect(graphCell(node({ contextPct: 88 }), 2).ring).toEqual({ cx: 14, cy: 18, r: 8.5, pct: 88, level: 'warn' });
      expect(graphCell(node({ lane: 1, contextPct: 24 }), 2).ring).toMatchObject({ cx: 42, pct: 24, level: '' });
    });
    it('is muted below 70, warning from 70, hot from 90', () => {
      expect([69, 70, 89, 90, 100].map(ringLevel)).toEqual(['', 'warn', 'warn', 'hot', 'hot']);
    });
    it('is clamped to 0 to 100 and absent for other rows', () => {
      expect(graphCell(node({ contextPct: 140 }), 2).ring?.pct).toBe(100);
      expect(graphCell(node({ kind: 'compaction', contextPct: 50 }), 2).ring).toBeUndefined();
      expect(graphCell(node(), 2).ring).toBeUndefined();
    });
  });
});
