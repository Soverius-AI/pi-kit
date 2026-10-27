import { TestBed } from '@angular/core/testing';
import { provideMockApi, treeEntry, treeGet, treeLabel, treeNavigate, treeSummarize } from '@pi-kit/api';
import { ChatStore } from '@pi-kit/chat/api';
import { DialogStore, UiStore } from '@pi-kit/data-access';
import { fakeThreads, row, thread, tree } from '@pi-kit/testing';
import { ThreadsStore } from '@pi-kit/threads/api';
import { GraphStore } from './graph.store';

const rows = [
  row('root', { kind: 'root', endId: null, turn: null, number: '0' }),
  row('u1', { parentId: 'root', number: '1', turn: 1, timestamp: '2026-01-01T00:00:00Z' }),
  row('u2', { parentId: 'u1', number: '2', turn: 2, timestamp: '2026-01-01T00:01:00Z', isLeaf: true }),
  row('u2b', {
    parentId: 'u1',
    number: '2a',
    turn: 2,
    timestamp: '2026-01-01T00:02:00Z',
    onActivePath: false,
    lane: 1,
  }),
];

describe('GraphStore', () => {
  const api = {
    tree: vi.fn(async () => tree(rows, 'u2')),
    rawTree: vi.fn(async () => ({
      entries: [{ id: 'e1', type: 'message', message: { role: 'user', content: 'hi there' } }],
      leafId: 'e1',
    })),
    entryText: vi.fn(async () => ({ text: 'first question' })),
    navigate: vi.fn(async () => ({})),
    summarizeBranch: vi.fn(async () => ({})),
    label: vi.fn(async () => tree(rows, 'u2')),
  };
  const chat = { say: vi.fn(), reconnectAndWait: vi.fn(async () => undefined) };
  let threads: ReturnType<typeof fakeThreads>;

  const make = async () => {
    const store = TestBed.inject(GraphStore);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(130);
    return store;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    for (const fn of [...Object.values(api), chat.say, chat.reconnectAndWait]) fn.mockClear();
    threads = fakeThreads({ selected: thread('t1') });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        { provide: ChatStore, useValue: chat },
        ...provideMockApi([
          [treeGet, api.tree, (o) => [o.path?.['id'], o.signal], undefined, (o) => o.query?.['raw'] !== '1'],
          [treeGet, api.rawTree, (o) => [o.path?.['id']], undefined, (o) => o.query?.['raw'] === '1'],
          [treeEntry, api.entryText, (o) => [o.path?.['id'], o.path?.['entryId']]],
          [treeNavigate, api.navigate, (o) => [o.path?.['id'], o.body?.['targetId']]],
          [treeSummarize, api.summarizeBranch, (o) => [o.path?.['id'], o.body?.['targetId']]],
          [treeLabel, api.label, (o) => [o.path?.['id'], o.body?.['targetId'], o.body?.['label']]],
        ]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('fetches the tree of the selected thread and selects the leaf row', async () => {
    const graph = await make();
    expect(api.tree).toHaveBeenCalledWith('t1', expect.anything());
    expect(graph.tree()?.rows).toHaveLength(4);
    expect(graph.selectedId()).toBe('u2');
    expect(graph.loading()).toBe(false);
    expect(graph.summary()).not.toBe('');
  });

  it('a failed fetch is the error', async () => {
    api.tree.mockRejectedValueOnce(new Error('no session'));
    const graph = await make();
    expect(graph.error()).toBe('no session');
    expect(graph.tree()).toBeUndefined();
  });

  it('starts from nothing when another thread opens, and refetches when pi announces a new leaf', async () => {
    const graph = await make();
    graph.setQuery('abc');
    threads.open(thread('t2'));
    TestBed.tick();
    expect(graph.tree()).toBeUndefined();
    expect(graph.query()).toBe('');
    await vi.advanceTimersByTimeAsync(130);
    expect(api.tree).toHaveBeenLastCalledWith('t2', expect.anything());
    const calls = api.tree.mock.calls.length;
    TestBed.inject(UiStore).markTreeStale();
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(130);
    expect(api.tree.mock.calls.length).toBe(calls + 1);
  });

  it('remembers "Fold side branches" per thread', async () => {
    const graph = await make();
    expect(graph.fold()).toBe(true);
    graph.setFold(false);
    expect(localStorage.getItem('pk.graph.fold.t1')).toBe('0');
    threads.open(thread('t2'));
    TestBed.tick();
    expect(graph.fold()).toBe(true);
    threads.open(thread('t1'));
    TestBed.tick();
    expect(graph.fold()).toBe(false);
  });

  it('finds the sibling turns for branch navigation', async () => {
    const graph = await make();
    const branch = graph.branches().get('u2');
    expect(branch).toMatchObject({ index: 0, count: 2 });
    expect(graph.branches().get('u2b')?.index).toBe(1);
    expect(graph.branches().has('u1')).toBe(false);
  });

  it('the Entries view fetches the raw entries and lists them', async () => {
    const graph = await make();
    graph.setView('entries');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(130);
    expect(graph.entries()).toEqual([
      expect.objectContaining({ id: 'e1', type: 'user', text: 'hi there', leaf: true }),
    ]);
  });

  it('"Go here" moves the leaf, replays the transcript and selects the new leaf', async () => {
    const graph = await make();
    await graph.goHere(rows[1]);
    expect(api.navigate).toHaveBeenCalledWith('t1', 'u1-end');
    expect(chat.reconnectAndWait).toHaveBeenCalled();
    expect(graph.busy()).toBeUndefined();
    expect(threads.refresh).toHaveBeenCalled();
  });

  it('"Go here" on the leaf does nothing', async () => {
    const graph = await make();
    await graph.goHere(rows[2]);
    expect(api.navigate).not.toHaveBeenCalled();
  });

  it('edit and branch puts the text in the composer and cancel clears it', async () => {
    const graph = await make();
    const ui = TestBed.inject(UiStore);
    await graph.editAndBranch(rows[1]);
    expect(graph.branch()).toMatchObject({ entryId: 'u1', turn: 1, text: 'first question' });
    expect(ui.composerText()?.text).toBe('first question');
    graph.cancelBranch();
    expect(graph.branch()).toBeUndefined();
  });

  it("commitBranch moves to the edited turn's parent and waits for the transcript", async () => {
    const graph = await make();
    await graph.editAndBranch(rows[1]);
    await graph.commitBranch();
    expect(api.navigate).toHaveBeenCalledWith('t1', 'u1');
    expect(chat.reconnectAndWait).toHaveBeenCalled();
    expect(graph.branch()).toBeUndefined();
  });

  it('forks a row into a new thread and selects it', async () => {
    const graph = await make();
    await graph.forkToThread(rows[1]);
    expect(threads.fork).toHaveBeenCalledWith('t1', 'u1-end');
    expect(threads.select).toHaveBeenCalledWith('forked');
    expect(chat.say).toHaveBeenCalledWith('info', expect.stringContaining('into a new thread'));
  });

  it('labels a turn through the name prompt', async () => {
    const graph = await make();
    const dialogs = TestBed.inject(DialogStore);
    const pending = graph.label(rows[1]);
    dialogs.submitName(' keep ');
    await pending;
    expect(api.label).toHaveBeenCalledWith('t1', 'u1', 'keep');
  });

  it('toggles a folded group', async () => {
    const graph = await make();
    graph.toggleGroup('g1');
    expect(graph.expanded().has('g1')).toBe(true);
    graph.toggleGroup('g1');
    expect(graph.expanded().has('g1')).toBe(false);
  });
});
