import type { SessionTree, TreeRow } from '@pi-kit/protocol';

/** A row with sensible defaults for the specs of the tree model and the graph layout. */
export const row = (patch: Partial<TreeRow> & Pick<TreeRow, 'id'>): TreeRow => ({
  endId: patch.id,
  parentId: null,
  kind: 'turn',
  lane: 0,
  parentLane: 0,
  through: [],
  forks: [],
  up: true,
  down: true,
  childCount: 1,
  onActivePath: true,
  isLeaf: false,
  tokens: 4200,
  preview: 'Map tool_execution events',
  number: '1',
  turn: 1,
  entryCount: 2,
  sub: [],
  modelChanged: false,
  run: 'root',
  ...patch,
});

export const treeOf = (rows: TreeRow[], patch: Partial<SessionTree> = {}): SessionTree => ({
  rows,
  leafId: 'x',
  leafRowId: rows.find((r) => r.isLeaf)?.id ?? 'root',
  lanes: 2,
  turns: rows.filter((r) => r.kind === 'turn').length,
  forks: 1,
  ...patch,
});
