/**
 * Geometry of one row of the session graph v2 (doc/docs/design-system.md "Session graph"):
 * a 36px row (28px for a compaction band) whose lane cell holds one column of 28px per lane, nodes 10px wide in the middle of
 * the row. Pure, so it is tested without a DOM. A row says which lanes cross it and which it opens; this turns that into
 * path data.
 */

export const GRAPH_LANE = 28;
export const GRAPH_ROW = 36;
export const GRAPH_BAND = 28;
/** Space right of the last lane, before the text. */
export const GRAPH_PAD = 8;
export const GRAPH_NODE_RADIUS = 5;

export type PkGraphKind = 'root' | 'turn' | 'compaction' | 'branch_summary' | 'group' | 'ghost';

/** The part of a row that decides how its lane cell looks. */
export interface PkGraphNode {
  kind: PkGraphKind;
  lane: number;
  /** Lanes (other than `lane`) whose line crosses the whole row. */
  through: readonly number[];
  /** Lanes that open at this node: a curve from `lane` into each, in the bottom part of the row. */
  forks: readonly number[];
  up: boolean;
  down: boolean;
  onActivePath: boolean;
  isLeaf: boolean;
  /** A folded group whose branch has a summary draws its node dashed. */
  dashed?: boolean;
  /** Share of the context window in use after this turn, 0 to 100: the ring around the node. */
  contextPct?: number;
}

/** The context ring: a circle around the node whose arc (pathLength 100) is the percentage. */
export interface PkGraphRing {
  cx: number;
  cy: number;
  r: number;
  pct: number;
  /** Muted below 70 %, `warn` from 70 %, `hot` from 90 %. */
  level: '' | 'warn' | 'hot';
}

export const GRAPH_RING_RADIUS = 8.5;
export const ringLevel = (pct: number): PkGraphRing['level'] => (pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : '');

export interface PkGraphPath {
  d: string;
  /** Lane 0 is the active path and draws in the accent colour; the other lanes are muted. */
  on: boolean;
  /** The ghost row's stub. */
  dashed?: boolean;
}

export interface PkGraphGlyph {
  shape: 'circle' | 'square';
  /** Class names for the glyph, on top of `c` (the stylesheet's node class). */
  classes: string;
  /** Centre of a circle, top-left of a square. */
  x: number;
  y: number;
  /** Radius of a circle, side of a square. */
  size: number;
}

export interface PkGraphCell {
  width: number;
  height: number;
  paths: PkGraphPath[];
  glyph: PkGraphGlyph;
  ring?: PkGraphRing;
}

export const graphLaneX = (lane: number): number => lane * GRAPH_LANE + GRAPH_LANE / 2;

/** Width of the lane cell for `lanes` columns (never narrower than two, so a straight session does not look cramped). */
export const graphCellWidth = (lanes: number): number => Math.max(2, lanes) * GRAPH_LANE + GRAPH_PAD;

/** The paths and glyph of a row's lane cell, `lanes` columns wide. */
export function graphCell(node: PkGraphNode, lanes: number): PkGraphCell {
  const height = node.kind === 'compaction' ? GRAPH_BAND : GRAPH_ROW;
  const mid = node.kind === 'compaction' ? height / 2 : GRAPH_ROW / 2;
  const x = graphLaneX(node.lane);
  const paths: PkGraphPath[] = [];

  for (const lane of node.through) paths.push({ d: `M${graphLaneX(lane)} 0 V ${height}`, on: lane === 0 });
  const on = node.lane === 0 && node.kind !== 'ghost';
  const dashed = node.kind === 'ghost';
  if (node.up && node.down) paths.push({ d: `M${x} 0 V ${height}`, on });
  else if (node.up) paths.push({ d: `M${x} 0 V ${mid}`, on, ...(dashed ? { dashed } : {}) });
  else if (node.down) paths.push({ d: `M${x} ${mid} V ${height}`, on });
  for (const lane of node.forks) {
    const to = graphLaneX(lane);
    // From the node into the next lane: leaves downwards, arrives downwards, as `git log --graph` clients draw it.
    paths.push({ d: `M${x} ${mid} C ${x} ${height - 4}, ${to} ${mid + 4}, ${to} ${height}`, on: false });
  }
  const pct = node.contextPct;
  const ring: PkGraphRing | undefined =
    node.kind === 'turn' && pct !== undefined
      ? {
          cx: x,
          cy: mid,
          r: GRAPH_RING_RADIUS,
          pct: Math.max(0, Math.min(100, Math.round(pct))),
          level: ringLevel(pct),
        }
      : undefined;
  return { width: graphCellWidth(lanes), height, paths, glyph: glyphOf(node, x, mid), ...(ring ? { ring } : {}) };
}

function glyphOf(node: PkGraphNode, x: number, mid: number): PkGraphGlyph {
  switch (node.kind) {
    case 'compaction':
      return {
        shape: 'square',
        classes: 'compaction',
        x: x - GRAPH_NODE_RADIUS,
        y: mid - GRAPH_NODE_RADIUS,
        size: GRAPH_NODE_RADIUS * 2,
      };
    case 'branch_summary':
      return { shape: 'circle', classes: 'summary', x, y: mid, size: GRAPH_NODE_RADIUS };
    case 'group':
      return { shape: 'circle', classes: node.dashed ? 'summary' : '', x, y: mid, size: GRAPH_NODE_RADIUS };
    case 'ghost':
      return { shape: 'circle', classes: 'ghost', x, y: mid, size: GRAPH_NODE_RADIUS };
    default:
      return {
        shape: 'circle',
        classes: node.isLeaf ? 'leaf' : node.onActivePath ? 'on' : '',
        x,
        y: mid,
        size: GRAPH_NODE_RADIUS,
      };
  }
}
