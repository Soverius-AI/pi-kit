import { signal } from '@angular/core';
import type { SessionTree, ThreadsEvent, ThreadSummary, TreeRow } from '@pi-kit/protocol';

/** A graph row with sensible defaults; override what the test is about. */
export function row(id: string, over: Partial<TreeRow> = {}): TreeRow {
  return {
    id,
    endId: `${id}-end`,
    parentId: null,
    kind: 'turn',
    lane: 0,
    parentLane: null,
    through: [],
    forks: [],
    up: false,
    down: false,
    childCount: 0,
    onActivePath: true,
    isLeaf: false,
    tokens: 0,
    preview: id,
    number: '1',
    turn: 1,
    entryCount: 1,
    sub: [],
    modelChanged: false,
    run: 'root',
    ...over,
  } as TreeRow;
}

export function tree(rows: TreeRow[], leafRowId = rows[rows.length - 1]?.id ?? 'root'): SessionTree {
  return {
    rows,
    leafId: leafRowId,
    leafRowId,
    lanes: 1,
    turns: rows.filter((r) => r.kind === 'turn').length,
    forks: 0,
  } as SessionTree;
}

/** A thread state with nothing going on; override what the test is about. */
export function idleState(over: Partial<ThreadSummary['state']> = {}): ThreadSummary['state'] {
  return {
    activity: 'idle',
    question: null,
    context: null,
    lastRun: null,
    unread: false,
    unseen: false,
    cli: false,
    summary: null,
    suggestions: [],
    outcome: null,
    draft: null,
    ...over,
  };
}

export function thread(id: string, over: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id,
    cwd: '/a',
    title: id,
    updatedAt: 1,
    pinned: false,
    lastOpenedAt: null,
    state: idleState(),
    ...over,
  } as unknown as ThreadSummary;
}

/** The part of `ThreadsStore` other stores read, as plain signals a test can drive. */
export function fakeThreads(initial: { selected?: ThreadSummary; workspace?: string } = {}) {
  const selected = signal<ThreadSummary | undefined>(initial.selected);
  const workspace = signal<string | undefined>(initial.workspace ?? initial.selected?.cwd);
  const statusListeners = new Set<(event: ThreadsEvent) => void>();
  return {
    selected,
    workspace,
    selectedId: () => selected()?.id,
    cwd: () => selected()?.cwd ?? workspace(),
    folder: () => (selected()?.worktree?.exists ? selected()?.worktree?.path : (selected()?.cwd ?? workspace())),
    workspaceName: () => workspace()?.slice(1),
    workspaces: signal([]),
    threads: signal<ThreadSummary[]>([]),
    watchTick: signal(0),
    watchLast: signal<{ paths: readonly string[]; overflow: boolean } | undefined>(undefined),
    refresh: vi.fn(async () => undefined),
    select: vi.fn(),
    stepThread: vi.fn(),
    jumpToProject: vi.fn(),
    fork: vi.fn(async () => thread('forked')),
    want: vi.fn(),
    /** Selects (or clears) the thread the way the real store does. */
    open(next: ThreadSummary | undefined): void {
      selected.set(next);
    },
    /** The status channel's lines, as the real store hands them to other domains' stores. */
    onStatusEvent(listener: (event: ThreadsEvent) => void): () => void {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    /** A line of the status channel, as the backend would push it. */
    pushStatus(event: ThreadsEvent): void {
      for (const listener of [...statusListeners]) listener(event);
    },
  };
}
