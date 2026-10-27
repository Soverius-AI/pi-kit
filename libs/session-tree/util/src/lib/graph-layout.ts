import type { Translate } from '@pi-kit/i18n';
import { GRAPH_BAND, GRAPH_ROW, type PkGraphNode } from '@pi-kit/design-system';
import type { SessionTree, TreeRow, TreeSubPart } from '@pi-kit/protocol';
import { compactNumber } from '@pi-kit/ui';

/**
 * The session graph as the panel shows it: the rows `GET /api/threads/:id/tree` returns, with the
 * abandoned branches folded into group rows or expanded, filtered by "Find a turn", and the lane lines of what is left worked
 * out again. The server assigns lanes to the whole tree; folding and filtering are view state, so the lines are derived here from
 * the rows that are shown (`run` says which rows share a lane, `parentId` where a lane forks from). Pure and tested.
 */

export interface GraphView {
  /** "Fold side branches": abandoned branches show as one group row each. */
  fold: boolean;
  /** Group ids (the first row of a branch) the user expanded while folding is on. */
  expanded: ReadonlySet<string>;
  /** "Find a turn": only matching rows are shown. */
  query: string;
}

export interface GraphActions {
  go: boolean;
  edit: boolean;
  fork: boolean;
  label: boolean;
  more: boolean;
}

export interface GraphItem {
  /** Unique within the list (`row:<id>` or `group:<id>`). */
  key: string;
  type: 'row' | 'group' | 'band';
  /** The row this item stands for (a group's first row). */
  row: TreeRow;
  /** Row id the selection and the keyboard use; a group row is not selectable (a click folds or unfolds it). */
  selectId: string | undefined;
  node: PkGraphNode;
  /** px: 36 for a row, 28 for a compaction band. */
  height: number;
  /** Part of an abandoned branch: tinted. */
  side: boolean;
  number: string;
  title: string;
  /** Title split at the filter's matches. */
  titleParts: { text: string; hit: boolean }[];
  label?: string;
  /** The turn's tool calls (names in 500) and the rest of the sub line (model when it changed, tokens). */
  tools: TreeSubPart[];
  tail: string;
  /** Group rows: the branch summary as the sub line. */
  summary?: string;
  /** Group rows: `▸` folded, `▾` expanded. */
  chevron?: '▸' | '▾';
  time: string;
  /** The ring's exact figure: "88 % of context, 231k of 262k". */
  timeTitle?: string;
  dim: boolean;
  current: boolean;
  actions: GraphActions;
  /** Context ring percentage of a turn, for the screen reader label. */
  match: boolean;
}

export interface GraphLayout {
  items: GraphItem[];
  /** Columns of the lane cell: the widest lane shown plus one. */
  lanes: number;
  /** Number of rows hidden by folding (groups) or by the filter. */
  hidden: number;
}

const NO_ACTIONS: GraphActions = { go: false, edit: false, fork: false, label: false, more: false };

/** 24-hour clock time of an ISO timestamp, in the user's time zone; empty if there is none. */
export function formatClock(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** `gemma-4-26b at medium`, or the model alone. */
export function modelLine(translate: Translate, row: Pick<TreeRow, 'model' | 'thinking'>): string {
  if (!row.model) return '';
  return row.thinking && row.thinking !== 'off'
    ? translate('session-tree.graphLayout.at', {
        value1: row.model,
        value2: translate('common.effortValue.' + row.thinking),
      })
    : row.model;
}

/** The tooltip of the time and ring: "88 % of context, 231k of 262k". */
export function contextTitle(
  translate: Translate,
  row: Pick<TreeRow, 'contextPct' | 'contextTokens' | 'contextWindow'>,
): string | undefined {
  if (row.contextPct === undefined || row.contextTokens === undefined || row.contextWindow === undefined)
    return undefined;
  return translate('session-tree.graphLayout.ofContextOf', {
    value1: row.contextPct,
    value2: compactNumber(row.contextTokens),
    value3: compactNumber(row.contextWindow),
  });
}

/** The part of a sub line after the tool calls: the model when it changed, then the tokens. */
export function subTail(translate: Translate, row: TreeRow): string {
  const parts: string[] = [];
  if (row.modelChanged) parts.push(modelLine(translate, row));
  if (row.kind === 'turn' && row.tokens > 0) parts.push(compactNumber(row.tokens));
  return parts.filter(Boolean).join(', ');
}

/** Splits `text` around the (case-insensitive) occurrences of `query`. */
export function highlight(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (let found = lower.indexOf(q); found >= 0; found = lower.indexOf(q, at)) {
    if (found > at) parts.push({ text: text.slice(at, found), hit: false });
    parts.push({ text: text.slice(found, found + q.length), hit: true });
    at = found + q.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts.length > 0 ? parts : [{ text, hit: false }];
}

/** Does the filter match this row (title, label, turn number, the tools and files it touched, the model)? */
export function rowMatches(row: TreeRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.kind === 'ghost') return false;
  const haystack = [
    row.preview,
    row.label ?? '',
    row.number,
    row.model ?? '',
    ...row.sub.flatMap((s) => [s.name, s.target ?? '']),
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(q);
}

const titleOf = (translate: Translate, row: TreeRow): string =>
  row.kind === 'root'
    ? translate('session-tree.graphLayout.start')
    : row.kind === 'ghost'
      ? translate('session-tree.graphLayout.nextTurnContinuesHere')
      : row.preview;

function actionsOf(row: TreeRow): GraphActions {
  if (row.kind === 'ghost') return NO_ACTIONS;
  return {
    go: !row.isLeaf && row.endId !== null,
    edit: row.kind === 'turn',
    fork: row.endId !== null && row.kind !== 'root',
    label: true,
    more: row.endId !== null,
  };
}

interface Draft {
  item: Omit<GraphItem, 'node'>;
  node: PkGraphNode;
  run: string;
  /** Row id of the row this one forks from, for the first item of a side lane. */
  forkFrom: string | null;
  rowId: string | null;
}

/** The items to show for `tree` under `view`, with the lane lines of exactly those items. */
export function layoutGraph(translate: Translate, tree: SessionTree, view: GraphView): GraphLayout {
  const rows = tree.rows;
  const query = view.query.trim();
  const groups = new Map<string, { turns: number; last: TreeRow }>();
  for (const row of rows) {
    if (!row.group) continue;
    const g = groups.get(row.group) ?? { turns: 0, last: row };
    if (row.kind === 'turn') g.turns += 1;
    g.last = row;
    groups.set(row.group, g);
  }

  const drafts: Draft[] = [];
  let hidden = 0;
  for (const row of rows) {
    if (query) {
      if (!rowMatches(row, query)) {
        hidden += 1;
        continue;
      }
    } else if (row.group && view.fold) {
      const open = view.expanded.has(row.group);
      if (row.id === row.group)
        drafts.push(groupDraft(translate, row, groups.get(row.group) as { turns: number; last: TreeRow }, open));
      if (!open) {
        hidden += 1;
        continue;
      }
    }
    drafts.push(rowDraft(translate, row, query));
  }

  // ---- lane lines of what is shown
  const n = drafts.length;
  const through: Set<number>[] = drafts.map(() => new Set());
  const forks: Set<number>[] = drafts.map(() => new Set());
  const up = new Array<boolean>(n).fill(false);
  const down = new Array<boolean>(n).fill(false);
  const index = new Map<string, number>();
  drafts.forEach((d, i) => d.rowId !== null && index.set(d.rowId, i));
  const runs = new Map<string, number[]>();
  drafts.forEach((d, i) => {
    const members = runs.get(d.run);
    if (members) members.push(i);
    else runs.set(d.run, [i]);
  });
  for (const [run, members] of runs) {
    const first = members[0];
    const last = members[members.length - 1];
    const lane = drafts[first].node.lane;
    // A side lane's line starts at the row it forks from (if that is shown), a curve into the lane there.
    const forkFrom = drafts[first].forkFrom;
    const parent = run !== 'root' && forkFrom !== null ? index.get(forkFrom) : undefined;
    const start = parent !== undefined && parent < first ? parent : first;
    if (start !== first) forks[start].add(lane);
    for (let i = start + 1; i < last; i++) if (drafts[i].run !== run) through[i].add(lane);
    members.forEach((at, j) => {
      up[at] = j > 0 || start !== first;
      down[at] = j < members.length - 1;
    });
  }

  let widest = 0;
  const items: GraphItem[] = drafts.map((d, i) => {
    widest = Math.max(widest, d.node.lane);
    const node: PkGraphNode = {
      ...d.node,
      through: [...through[i]].sort((a, b) => a - b),
      forks: [...forks[i]].sort((a, b) => a - b),
      up: up[i],
      down: down[i],
    };
    return { ...d.item, node };
  });
  return { items, lanes: widest + 1, hidden };
}

function rowDraft(translate: Translate, row: TreeRow, query: string): Draft {
  const band = row.kind === 'compaction';
  const title = titleOf(translate, row);
  const dim = row.kind === 'root' || row.kind === 'ghost' || row.kind === 'branch_summary' || row.kind === 'compaction';
  const item: Omit<GraphItem, 'node'> = {
    key: `row:${row.id}`,
    type: band ? 'band' : 'row',
    row,
    selectId: row.kind === 'ghost' ? undefined : row.id,
    height: band ? GRAPH_BAND : GRAPH_ROW,
    side: row.group !== undefined,
    number: row.number,
    title,
    titleParts: highlight(title, query),
    ...(row.label ? { label: row.label } : {}),
    tools: row.sub,
    tail: subTail(translate, row),
    time: row.isLeaf && row.kind !== 'ghost' ? 'current' : formatClock(row.time ?? row.timestamp),
    ...(contextTitle(translate, row) ? { timeTitle: contextTitle(translate, row) as string } : {}),
    dim,
    current: row.isLeaf && row.kind !== 'ghost',
    actions: actionsOf(row),
    match: query !== '',
  };
  const node: PkGraphNode = {
    kind: row.kind === 'label' ? 'turn' : row.kind,
    lane: row.lane,
    through: [],
    forks: [],
    up: false,
    down: false,
    onActivePath: row.onActivePath,
    isLeaf: row.isLeaf,
    ...(row.kind === 'turn' && row.contextPct !== undefined ? { contextPct: row.contextPct } : {}),
  };
  return { item, node, run: row.run, forkFrom: row.parentId, rowId: row.id };
}

function groupDraft(
  translate: Translate,
  head: TreeRow,
  group: { turns: number; last: TreeRow },
  open: boolean,
): Draft {
  const turns = `${group.turns} ${group.turns === 1 ? translate('common.words.turn') : translate('common.words.turns')}`;
  const title = translate('session-tree.graphLayout.branchGroup', {
    letter: head.groupLetter ? ` ${head.groupLetter}` : '',
    turns,
    summary: head.summary ? translate('session-tree.graphLayout.summarised') : '',
  });
  const item: Omit<GraphItem, 'node'> = {
    key: `group:${head.id}`,
    type: 'row',
    row: head,
    selectId: undefined,
    height: GRAPH_ROW,
    side: true,
    number: '',
    title,
    titleParts: [{ text: title, hit: false }],
    tools: [],
    tail: '',
    ...(head.summary ? { summary: head.summary } : {}),
    chevron: open ? '▾' : '▸',
    time: formatClock(group.last.time ?? group.last.timestamp),
    dim: true,
    current: false,
    actions: NO_ACTIONS,
    match: false,
  };
  const node: PkGraphNode = {
    kind: 'group',
    lane: head.lane,
    through: [],
    forks: [],
    up: false,
    down: false,
    onActivePath: false,
    isLeaf: false,
    ...(head.summary ? { dashed: true } : {}),
  };
  return { item, node, run: head.run, forkFrom: head.parentId, rowId: null };
}

/** Items the user can select: everything except group rows and the ghost. */
export const isSelectable = (item: Pick<GraphItem, 'selectId'>): boolean => item.selectId !== undefined;

/** The next selectable item index from `from` in `direction`, staying put at the ends. */
export function stepSelection(items: readonly Pick<GraphItem, 'selectId'>[], from: number, direction: 1 | -1): number {
  for (let i = from + direction; i >= 0 && i < items.length; i += direction) if (isSelectable(items[i])) return i;
  return from;
}

/** The first selectable item index, scanning from the start (`direction` 1) or the end (-1). */
export function edgeSelection(items: readonly Pick<GraphItem, 'selectId'>[], direction: 1 | -1): number {
  const order = direction === 1 ? items.keys() : [...items.keys()].reverse();
  for (const i of order) if (isSelectable(items[i])) return i;
  return 0;
}

/** "Turn 7 of 11": the foot's position in the session. */
export function positionLine(translate: Translate, tree: Pick<SessionTree, 'rows' | 'turns' | 'leafRowId'>): string {
  const leaf = tree.rows.find((r) => r.id === tree.leafRowId);
  if (!leaf || leaf.kind !== 'turn' || !leaf.turn) return translate('session-tree.graphLayout.atTheStart');
  return translate('session-tree.graphLayout.turnOf', { value1: leaf.turn, value2: tree.turns });
}
