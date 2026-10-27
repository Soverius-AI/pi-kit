import type { SessionTree, TreeRow } from '@pi-kit/protocol';
import { type PiSessionEntry, userMessageText } from './session-messages';

/**
 * The session graph: pi's entry tree turned into the rows the side panel draws.
 * Pure functions over structurally typed entries; nothing here knows about pi's runtime or about Angular.
 *
 * 1. **Collapse.** Only `message`, `compaction`, `branch_summary` and `custom_message` entries are nodes; labels,
 *    model and thinking changes, usage, custom and session_info entries are transparent (their children hang
 *    from the nearest node above them). A *unit* is a maximal chain of nodes without forks that starts at a user
 *    message, a compaction, a branch summary or a node with siblings. A unit is one row: a turn is a user message
 *    and everything up to the next user message (assistant text, tool calls and results, model changes).
 * 2. **Order.** Depth first from the root, each fork's side branches first (oldest first) and the branch that
 *    continues the parent's lane (the active path; off it, the newest child) last. The row for pi's current leaf
 *    is followed by the ghost "next turn" row.
 * 3. **Lanes.** The root row, the active path and the ghost are lane 0. A side branch gets the lowest free lane to
 *    the right of its parent at the fork row and holds it until its last row, so each row knows the lanes that
 *    cross it (`through`) and the lanes it opens (`forks`); drawing needs nothing else.
 * 4. **Graph v2 facts.** Each row also says what the turn did (`sub`: its tool calls), when it ended
 *    (`time`), whether the model changed, which lane run and which abandoned-branch group it belongs to and, for the
 *    first row of a group, what a branch summary says about the branch. The panel folds and filters by itself.
 */

const HEAD_CHARS = 80;
/** Tool calls a row's sub line carries at most. */
const SUB_MAX = 8;
/** Characters of a branch summary shown as a group row's sub line. */
const SUMMARY_CHARS = 110;
/** The kinds of entry that are nodes of the graph. */
const NODE_TYPES = new Set(['message', 'compaction', 'branch_summary', 'custom_message']);

interface MessageLike {
  role?: string;
  content?: string | { type: string; text?: string }[];
  model?: string;
  provider?: string;
  thinkingLevel?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
}

/** Looks up a model's context window in tokens (`provider` may be unknown); `undefined` leaves the context ring off. */
export type ContextWindowLookup = (provider: string | undefined, model: string) => number | undefined;

export interface SessionTreeOptions {
  /** Where the context windows come from: the tree is pure, pi's model registry lives in the backend. */
  contextWindow?: ContextWindowLookup;
}

interface ToolCallBlock {
  type: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

const messageOf = (entry: PiSessionEntry): MessageLike | undefined =>
  entry.type === 'message' ? (entry['message'] as MessageLike | undefined) : undefined;

const isUserMessage = (entry: PiSessionEntry): boolean => messageOf(entry)?.role === 'user';
const isStarter = (entry: PiSessionEntry): boolean =>
  isUserMessage(entry) || entry.type === 'compaction' || entry.type === 'branch_summary';

interface Unit {
  /** First entry id, or `root`. */
  id: string;
  entries: PiSessionEntry[];
  parent: Unit | undefined;
  children: Unit[];
  kind: TreeRow['kind'];
  /** Turn units from the root to this unit, itself included. */
  depth: number;
  active: boolean;
}

/** `51234` becomes `51k`, `1500` `1.5k`, small numbers stay as they are. */
export function shortCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n / 1000)}k`;
}

/** Branch letters in the order the branches are met: a, b, ... z, aa, ab, ... */
export function branchLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

const head = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > HEAD_CHARS ? `${flat.slice(0, HEAD_CHARS)}…` : flat;
};

export function buildSessionTree(entries: readonly PiSessionEntry[], leafId: string | null, options: SessionTreeOptions = {}): SessionTree {
  const index = new Map<string, number>();
  entries.forEach((entry, i) => index.set(entry.id, i));
  const byId = (id: string | null | undefined): PiSessionEntry | undefined => (id != null && index.has(id) ? entries[index.get(id) as number] : undefined);

  // ---- nodes and their parents (transparent entries skipped)
  // The initial prompt anchors the root. Later prompt-section snapshots are bookkeeping:
  // a changed coordination section must not insert a phantom turn between sibling user messages.
  const initialSystemId = entries.find((entry) => messageOf(entry)?.role === 'system')?.id;
  const isNode = (entry: PiSessionEntry): boolean => NODE_TYPES.has(entry.type)
    && (messageOf(entry)?.role !== 'system' || entry.id === initialSystemId);
  const nodeParentMemo = new Map<string, string | null>();
  /** The nearest node strictly above the entry, `null` for a root (a parent that does not exist makes it one). */
  const nodeParent = (entry: PiSessionEntry): string | null => {
    const trail: PiSessionEntry[] = [entry];
    let result: string | null = null;
    let cursor = byId(entry.parentId);
    for (let guard = 0; cursor && guard <= entries.length; guard++) {
      if (isNode(cursor)) {
        result = cursor.id;
        break;
      }
      const known = nodeParentMemo.get(cursor.id);
      if (known !== undefined) {
        result = known;
        break;
      }
      trail.push(cursor);
      cursor = byId(cursor.parentId);
    }
    for (const t of trail) nodeParentMemo.set(t.id, result);
    return result;
  };
  /** The entry itself if it is a node, else the nearest node above it. */
  const nodeOf = (id: string | null | undefined): string | null => {
    const entry = byId(id);
    if (!entry) return null;
    return isNode(entry) ? entry.id : nodeParent(entry);
  };

  const children = new Map<string | null, PiSessionEntry[]>();
  for (const entry of entries) {
    if (!isNode(entry)) continue;
    const parent = nodeParent(entry);
    const list = children.get(parent) ?? [];
    list.push(entry);
    children.set(parent, list);
  }

  // ---- units
  const root: Unit = { id: 'root', entries: [], parent: undefined, children: [], kind: 'root', depth: 0, active: true };
  const unitOfNode = new Map<string, Unit>();
  const place = (entry: PiSessionEntry, unit: Unit): void => {
    unit.entries.push(entry);
    unitOfNode.set(entry.id, unit);
  };
  const open = (entry: PiSessionEntry, parent: Unit): Unit => {
    const kind: TreeRow['kind'] = entry.type === 'compaction' ? 'compaction' : entry.type === 'branch_summary' ? 'branch_summary' : 'turn';
    const unit: Unit = {
      id: entry.id,
      entries: [],
      parent,
      children: [],
      kind,
      depth: parent.depth + (kind === 'turn' ? 1 : 0),
      active: false,
    };
    parent.children.push(unit);
    place(entry, unit);
    return unit;
  };
  const work: { node: string | null; unit: Unit }[] = [{ node: null, unit: root }];
  while (work.length > 0) {
    const { node, unit } = work.pop() as { node: string | null; unit: Unit };
    const kids = children.get(node) ?? [];
    if (kids.length === 1 && !isStarter(kids[0])) {
      place(kids[0], unit);
      work.push({ node: kids[0].id, unit });
      continue;
    }
    // Pushed in reverse so units are created, and listed under their parent, in file order.
    for (const kid of [...kids].reverse()) work.push({ node: kid.id, unit: open(kid, unit) });
    unit.children.reverse(); // `open` ran in reverse file order
  }

  // ---- the active path
  const leafNode = nodeOf(leafId);
  const leafUnit = leafNode ? (unitOfNode.get(leafNode) ?? root) : root;
  for (let u: Unit | undefined = leafUnit; u; u = u.parent) u.active = true;

  const unitOfEntry = (id: string): Unit => {
    const node = nodeOf(id);
    return (node && unitOfNode.get(node)) || root;
  };

  // ---- labels (the latest entry per target wins; an empty label clears)
  const labels = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== 'label' || typeof entry['targetId'] !== 'string') continue;
    const label = entry['label'];
    if (typeof label === 'string' && label.trim()) labels.set(entry['targetId'], label.trim());
    else labels.delete(entry['targetId']);
  }
  const unitLabels = new Map<Unit, string>();
  for (const [target, label] of labels) {
    if (!byId(target)) continue;
    const unit = unitOfEntry(target);
    // A label on the unit's first entry shows; otherwise the latest one on a later entry of it.
    if (!unitLabels.has(unit) || target === unit.id) unitLabels.set(unit, label);
  }

  // ---- what the model was before a unit (nearest ancestor that has an assistant message)
  const modelMemo = new Map<Unit, { model?: string; thinking?: string } | null>();
  const modelOfUnit = (unit: Unit): { model?: string; thinking?: string } | null => {
    const known = modelMemo.get(unit);
    if (known !== undefined) return known;
    let model: string | undefined;
    let thinking: string | undefined;
    for (const entry of unit.entries) {
      const message = messageOf(entry);
      if (message?.role !== 'assistant') continue;
      if (message.model) model = message.model;
      if (message.thinkingLevel) thinking = message.thinkingLevel;
    }
    const found = model || thinking ? { model, thinking } : null;
    modelMemo.set(unit, found);
    return found;
  };
  const inherited = (from: Unit | undefined): { model?: string; thinking?: string } | undefined => {
    for (let u = from; u; u = u.parent) {
      const found = modelOfUnit(u);
      if (found) return found;
    }
    return undefined;
  };

  // ---- branch summaries: a summary names the leaf it was written for (`fromId`); the abandoned branch holding it gets the text
  const groupSummary = new Map<Unit, string>();
  for (const entry of entries) {
    if (entry.type !== 'branch_summary' || typeof entry['fromId'] !== 'string' || typeof entry['summary'] !== 'string') continue;
    let unit: Unit | undefined = unitOfEntry(entry['fromId']);
    if (!unit || unit.active) continue;
    while (unit.parent && !unit.parent.active) unit = unit.parent;
    const text = summaryText(entry['summary']);
    if (text) groupSummary.set(unit, text);
  }

  // ---- order and lanes
  const rows: TreeRow[] = [];
  const busy = new Set<number>([0]);
  const lanesBelow = (parent: number): number => {
    let lane = parent + 1;
    while (busy.has(lane)) lane += 1;
    return lane;
  };
  const laneOf = new Map<Unit, number>();
  let branches = 0;
  let maxLane = 1;
  let leafRowId = 'root';

  interface Group {
    id: string;
    letter: string;
  }
  type Task = { kind: 'unit'; unit: Unit; lane: number; letter: string; run: string; group?: Group } | { kind: 'free'; lane: number };
  const stack: Task[] = [{ kind: 'unit', unit: root, lane: 0, letter: '', run: 'root' }];
  while (stack.length > 0) {
    const task = stack.pop() as Task;
    if (task.kind === 'free') {
      busy.delete(task.lane);
      continue;
    }
    const { unit, lane, letter, run, group } = task;
    const isLeaf = unit === leafUnit;
    const primary = isLeaf ? undefined : unit.active ? unit.children.find((c) => c.active) : unit.children.at(-1);
    const side = unit.children.filter((c) => c !== primary);

    const through = [...busy].filter((l) => l !== lane).sort((a, b) => a - b);
    const forks: number[] = [];
    const sideTasks: Task[] = [];
    for (const child of side) {
      const childLane = lanesBelow(lane);
      busy.add(childLane);
      forks.push(childLane);
      maxLane = Math.max(maxLane, childLane);
      const childLetter = branchLetter(branches++);
      // A branch off the active path starts a group (folded into one row); deeper ones belong to the group they hang from.
      const childGroup: Group = unit.active ? { id: child.id, letter: childLetter.toUpperCase() } : (group as Group);
      sideTasks.push({ kind: 'unit', unit: child, lane: childLane, letter: childLetter, run: child.id, group: childGroup });
    }
    const row = describe(unit, {
      lane,
      letter,
      through,
      forks,
      isLeaf,
      label: unitLabels.get(unit),
      parentLane: unit.parent ? (laneOf.get(unit.parent) as number) : null,
      run,
      group,
      previous: inherited(unit.parent),
      summary: group && group.id === unit.id ? groupSummary.get(unit) : undefined,
      contextWindow: options.contextWindow,
    });
    laneOf.set(unit, lane);
    row.down = unit.children.length > 0 || isLeaf;
    rows.push(row);
    if (isLeaf) {
      leafRowId = row.id;
      rows.push({
        id: 'ghost',
        endId: null,
        parentId: row.id,
        kind: 'ghost',
        lane: 0,
        parentLane: lane,
        through: [...busy].filter((l) => l !== 0).sort((a, b) => a - b),
        forks: [],
        up: true,
        down: false,
        childCount: 0,
        onActivePath: true,
        isLeaf: false,
        tokens: 0,
        preview: 'Next turn goes here',
        number: '',
        turn: null,
        entryCount: 0,
        sub: [],
        modelChanged: false,
        run: 'root',
      });
      busy.delete(0);
    }

    // Stack is last in, first out: the continuing branch is pushed first so it is emitted after the side branches.
    if (primary) stack.push({ kind: 'unit', unit: primary, lane, letter, run, ...(group && !unit.active ? { group } : {}) });
    for (const t of sideTasks.reverse()) {
      stack.push({ kind: 'free', lane: t.lane });
      stack.push(t);
    }
  }

  // Forks are counted over the units, so the sidebar and the panel agree.
  const allUnits: Unit[] = [];
  const walk: Unit[] = [root];
  while (walk.length > 0) {
    const u = walk.pop() as Unit;
    allUnits.push(u);
    walk.push(...u.children);
  }
  const forks = allUnits.reduce((sum, u) => sum + Math.max(0, u.children.length - 1), 0);
  const turns = allUnits.filter((u) => u.kind === 'turn').length;

  return { rows, leafId, leafRowId, lanes: maxLane + 1, turns, forks };
}

interface RowFacts {
  run: string;
  group: { id: string; letter: string } | undefined;
  /** Model and thinking level of the nearest earlier turn on the path. */
  previous: { model?: string; thinking?: string } | undefined;
  /** The first row of a group: what a branch summary says. */
  summary: string | undefined;
  contextWindow: ContextWindowLookup | undefined;
  lane: number;
  letter: string;
  through: number[];
  forks: number[];
  isLeaf: boolean;
  label: string | undefined;
  parentLane: number | null;
}

function describe(unit: Unit, facts: RowFacts): TreeRow {
  const first = unit.entries[0];
  const last = unit.entries.at(-1);
  let tokens = 0;
  let model: string | undefined;
  let thinking: string | undefined;
  let context: { tokens: number; provider: string | undefined; model: string | undefined } | undefined;
  for (const entry of unit.entries) {
    const message = messageOf(entry);
    if (message?.role !== 'assistant') continue;
    const usage = message.usage;
    tokens += (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
    if (message.model) model = message.model;
    if (message.thinkingLevel) thinking = message.thinkingLevel;
    // The context after the turn is what the last answer was given with plus what it wrote: input, cache and output.
    if (usage) {
      const sum = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      context = { tokens: typeof usage.totalTokens === 'number' && usage.totalTokens > 0 ? usage.totalTokens : sum, provider: message.provider, model: message.model };
    }
  }
  const window = unit.kind === 'turn' && context?.model && context.tokens > 0 ? facts.contextWindow?.(context.provider, context.model) : undefined;

  let preview: string;
  switch (unit.kind) {
    case 'root':
      preview = unit.entries.some((e) => messageOf(e)?.role === 'system') ? 'Start, system prompt' : 'Start';
      break;
    case 'compaction': {
      const before = typeof first?.['tokensBefore'] === 'number' ? (first['tokensBefore'] as number) : undefined;
      preview = before !== undefined ? `Compacted, ${shortCount(before)} tokens summarised` : 'Compacted';
      break;
    }
    case 'branch_summary':
      preview = `Summary, ${summaryText(String(first?.['summary'] ?? '')).slice(0, 60) || 'of the branch you left'}`;
      break;
    default: {
      const message = first ? messageOf(first) : undefined;
      const text = message?.role === 'user' ? userMessageText(message.content as string | { type: string; text?: string }[]) : textOfAny(first);
      preview = head(text) || (message?.role === 'user' ? '(image)' : `(${message?.role ?? first?.type ?? 'entry'})`);
    }
  }

  const upper = unit.kind === 'branch_summary' ? facts.letter.toUpperCase() : facts.letter;
  const number = unit.kind === 'turn' ? `${unit.depth}${facts.letter}` : unit.kind === 'branch_summary' ? upper : '';

  return {
    id: unit.id,
    endId: last?.id ?? null,
    parentId: unit.parent?.id ?? null,
    kind: unit.kind,
    lane: facts.lane,
    parentLane: facts.parentLane,
    through: facts.through,
    forks: facts.forks,
    up: unit.parent !== undefined,
    down: false,
    childCount: unit.children.length,
    onActivePath: unit.active,
    isLeaf: facts.isLeaf,
    ...(facts.label ? { label: facts.label } : {}),
    tokens,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    preview,
    number,
    turn: unit.kind === 'turn' ? unit.depth : null,
    entryCount: unit.entries.length,
    ...(first?.timestamp ? { timestamp: first.timestamp } : {}),
    ...(last?.timestamp ? { time: last.timestamp } : {}),
    sub: unit.kind === 'turn' ? toolCalls(unit) : [],
    modelChanged: unit.kind === 'turn' && changed(facts.previous, model, thinking),
    run: facts.run,
    ...(facts.group ? { group: facts.group.id, groupLetter: facts.group.letter } : {}),
    ...(facts.summary ? { summary: facts.summary } : {}),
    ...(window && context ? { contextTokens: context.tokens, contextWindow: window, contextPct: Math.min(100, Math.round((context.tokens / window) * 100)) } : {}),
  };
}

/** The model or thinking level of a turn differs from the one before it (nothing before it: nothing changed). */
function changed(previous: RowFacts['previous'], model: string | undefined, thinking: string | undefined): boolean {
  if (!previous) return false;
  return (!!model && !!previous.model && model !== previous.model) || (!!thinking && !!previous.thinking && thinking !== previous.thinking);
}

const basename = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;

/** What a tool call is about, in a few characters: a file name, the program a shell command runs. */
function toolTarget(name: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const path = args['path'] ?? args['file_path'] ?? args['filePath'];
  if (typeof path === 'string' && path) return basename(path);
  if (name === 'bash' && typeof args['command'] === 'string') return shellProgram(args['command']);
  const pattern = args['pattern'] ?? args['query'];
  return typeof pattern === 'string' && pattern ? pattern.slice(0, 24) : undefined;
}

/** `cd app && npx vitest run` becomes `vitest`, `npm test` stays `npm test`: the program a command line is about. */
export function shellProgram(command: string): string | undefined {
  const segments = command
    .split(/&&|\|\||;|\n/)
    .map((part) => part.trim())
    .filter((part) => part && !/^cd\s/.test(part));
  const words = (segments[0] ?? '').split(/\s+/).filter((word) => word && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  let program = words[0];
  if (!program) return undefined;
  if (['npx', 'pnpm', 'bunx', 'yarn'].includes(program)) {
    const next = words.slice(1).find((word) => !word.startsWith('-'));
    if (next) return basename(next).slice(0, 24);
  }
  if (['npm', 'cargo', 'go', 'git', 'make'].includes(program) && words[1]) program = `${program} ${words[1]}`;
  return basename(program).slice(0, 24);
}

/** The tool calls of a turn in order; the same call twice in a row counts once. */
function toolCalls(unit: Unit): TreeRow['sub'] {
  const out: TreeRow['sub'] = [];
  for (const entry of unit.entries) {
    const message = messageOf(entry);
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content as ToolCallBlock[]) {
      if (block.type !== 'toolCall' || !block.name) continue;
      const target = toolTarget(block.name, block.arguments);
      const previous = out.at(-1);
      if (previous && previous.name === block.name && previous.target === target) continue;
      if (out.length < SUB_MAX) out.push({ name: block.name, ...(target ? { target } : {}) });
    }
  }
  return out;
}

/** The start of a branch summary as one line: headings and markers dropped, cut at a word. */
function summaryText(summary: string): string {
  const flat = summary
    .replace(/^#+.*$/gm, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= SUMMARY_CHARS) return flat;
  const cut = flat.slice(0, SUMMARY_CHARS);
  return `${cut.slice(0, Math.max(40, cut.lastIndexOf(' ')))}…`;
}

function textOfAny(entry: PiSessionEntry | undefined): string {
  if (!entry) return '';
  if (entry.type === 'custom_message') {
    const content = entry['content'];
    return typeof content === 'string' ? content : '';
  }
  const content = messageOf(entry)?.content;
  if (typeof content === 'string') return content;
  return (content ?? []).map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join(' ');
}
