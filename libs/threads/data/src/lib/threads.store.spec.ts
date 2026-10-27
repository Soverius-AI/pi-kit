import { TestBed } from '@angular/core/testing';
import {
  appSettingsSetSetting,
  appSettingsSettings,
  provideMockApi,
  threadsClone,
  threadsCreate,
  threadsFork,
  threadsList,
  threadsPatch,
  threadsRemove,
  threadsSeen,
  workspacesAddWorkspace,
  workspacesOrderWorkspaces,
  workspacesPatchWorkspace,
  workspacesWorkspaces,
} from '@pi-kit/api';
import type { ThreadState, ThreadSummary, ThreadsEvent, WatchEvent, Workspace } from '@pi-kit/protocol';

import { TrustStore } from './trust.store';

import { ThreadsStore } from './threads.store';

const ws = (cwd: string, over: Partial<Workspace> = {}): Workspace =>
  ({
    cwd,
    name: cwd.slice(1),
    lastOpenedAt: 1,
    threadCount: 0,
    collapsed: false,
    hidden: false,
    attendant: true,
    agents: false,
    branch: 'main',
    ...over,
  }) as Workspace;
const idle: ThreadState = {
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
};
const thread = (id: string, cwd = '/a', over: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({
    id,
    cwd,
    title: id,
    updatedAt: 1,
    pinned: false,
    lastOpenedAt: null,
    state: idle,
    running: false,
    waiting: false,
    lastRun: null,
    ...over,
  }) as unknown as ThreadSummary;

describe('ThreadsStore', () => {
  let saved: Record<string, unknown>;
  let threads: ThreadSummary[];
  let workspaces: Workspace[];
  let trustGate: Promise<void>;
  let emit: ((event: WatchEvent) => void) | undefined;
  let watchEnds: (() => void) | undefined;
  let watchFails: ((error: Error) => void) | undefined;
  let status: ((event: ThreadsEvent) => void) | undefined;
  let statusEnds: (() => void) | undefined;
  let statusFails: ((error: Error) => void) | undefined;

  const api = {
    workspaces: vi.fn(async () => workspaces),
    list: vi.fn(async (workspace: string | undefined, archived: boolean) => {
      void [workspace, archived];
      return threads;
    }),
    create: vi.fn(async (cwd: string) => ({ ...thread('new', cwd) })),
    patch: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    fork: vi.fn(async () => thread('forked')),
    clone: vi.fn(async () => thread('cloned')),
    markSeen: vi.fn(async () => undefined),
    // As the backend answers: the projects after the change.
    patchWorkspace: vi.fn(
      async (patch: { cwd: string; collapsed?: boolean; hidden?: boolean; attendant?: boolean }) => {
        const { cwd, ...flags } = patch;
        workspaces = workspaces.map((w) => (w.cwd === cwd ? { ...w, ...flags } : w));
        return workspaces;
      },
    ),
    orderWorkspaces: vi.fn(async (order: string[]) => {
      workspaces = order.map((cwd) => workspaces.find((w) => w.cwd === cwd) as Workspace);
      return workspaces;
    }),
    events: vi.fn((onEvent: (event: ThreadsEvent) => void, signal: AbortSignal) => {
      status = onEvent;
      return new Promise<void>((resolve, reject) => {
        statusEnds = resolve;
        statusFails = reject;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }),
  };
  const settings = { all: vi.fn(async () => saved), set: vi.fn(async () => undefined) };
  const workspaceApi = {
    addWorkspace: vi.fn(async () => undefined),
    watch: vi.fn((_cwd: string, onEvent: (e: WatchEvent) => void, signal: AbortSignal) => {
      emit = onEvent;
      return new Promise<void>((resolve, reject) => {
        watchEnds = resolve;
        watchFails = reject;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }),
  };
  const trust = { ensure: vi.fn(() => trustGate) };

  const make = () => TestBed.inject(ThreadsStore);

  beforeEach(() => {
    vi.useFakeTimers();
    saved = {};
    workspaces = [ws('/a'), ws('/b')];
    threads = [thread('t1'), thread('t2')];
    trustGate = Promise.resolve();
    emit = undefined;
    watchEnds = undefined;
    watchFails = undefined;
    status = undefined;
    statusEnds = undefined;
    statusFails = undefined;
    for (const fn of [...Object.values(api), ...Object.values(settings), ...Object.values(workspaceApi), trust.ensure])
      fn.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TrustStore, useValue: trust },
        ...provideMockApi(
          [
            [workspacesWorkspaces, api.workspaces, (o) => [o.signal]],
            [threadsList, api.list, (o) => [o.query?.['workspace'], o.query?.['archived'] === '1', o.signal]],
            [threadsCreate, api.create, (o) => [o.body?.['cwd'], o.body?.['worktree'], o.body?.['local']]],
            [threadsPatch, api.patch, (o) => [o.path?.['id'], o.body]],
            [threadsRemove, api.remove, (o) => [o.path?.['id'], o.query?.['worktree']]],
            [threadsFork, api.fork, (o) => [o.path?.['id'], o.body?.['entryId']]],
            [threadsClone, api.clone, (o) => [o.path?.['id']]],
            [threadsSeen, api.markSeen, (o) => [o.path?.['id']]],
            [workspacesPatchWorkspace, api.patchWorkspace, (o) => [o.body]],
            [workspacesOrderWorkspaces, api.orderWorkspaces, (o) => [o.body?.['order']]],
            [appSettingsSettings, settings.all, () => []],
            [appSettingsSetSetting, settings.set, (o) => [o.path?.['key'], o.body?.['value']]],
            [workspacesAddWorkspace, workspaceApi.addWorkspace, (o) => [o.body?.['cwd']]],
          ],
          [
            [/^\/api\/threads\/events$/, api.events, (_path, onLine, signal) => [onLine, signal]],
            [
              /^\/api\/workspaces\/[^/]+\/watch$/,
              workspaceApi.watch,
              (path, onLine, signal) => [decodeURIComponent(path.split('/')[3]), onLine, signal],
            ],
          ],
        ),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('init lists the threads of every project and restores the remembered thread, whose folder becomes the current project', async () => {
    threads = [thread('t1', '/a'), thread('t2', '/b')];
    saved = { workspace: '/a', thread: 't2' };
    const store = make();
    await store.init();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.list).toHaveBeenCalledWith(undefined, false, expect.any(AbortSignal));
    expect(store.selectedId()).toBe('t2');
    expect(store.workspace()).toBe('/b');
    expect(store.workspaceName()).toBe('b');
    expect(store.cwd()).toBe('/b');
    expect(store.error()).toBeUndefined();
  });

  it('init asks about trust when there is no thread to restore, and falls back to the first project', async () => {
    saved = { workspace: '/gone' };
    const store = make();
    await store.init();
    expect(store.workspace()).toBe('/a');
    expect(trust.ensure).toHaveBeenCalledWith('/a');
    expect(store.selectedId()).toBeUndefined();
  });

  it.each([false, true])(
    'restores selection after a status refresh supersedes startup, unless the user navigated (%s)',
    async (navigate) => {
      saved = { workspace: '/a', thread: 't2' };
      let finishStartup!: (value: ThreadSummary[]) => void;
      let finishRefresh!: (value: ThreadSummary[]) => void;
      api.list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishStartup = resolve;
          }),
      );
      api.list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      );
      const store = make();
      const startup = store.init();
      await vi.advanceTimersByTimeAsync(0);
      const refresh = store.refresh();
      finishStartup(threads);
      await startup;
      if (navigate) store.select('t1');
      await vi.advanceTimersByTimeAsync(0);
      finishRefresh(threads);
      await refresh;
      await vi.advanceTimersByTimeAsync(0);
      expect(store.selectedId()).toBe(navigate ? 't1' : 't2');
    },
  );

  it('an init that fails shows the message', async () => {
    api.workspaces.mockRejectedValueOnce(new Error('backend down'));
    const store = make();
    await store.init();
    expect(store.error()).toBe('backend down');
    expect(store.failed()).toBe(true);
  });

  it('polls the list every five seconds while the status channel is away, and only now and then while it is connected', async () => {
    const store = make();
    await store.init();
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    const before = api.list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.list.mock.calls.length).toBe(before + 1);
    expect(store.threads()).toHaveLength(2);
    status?.({ type: 'snapshot', states: { t1: idle, t2: idle } });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.statusConnected()).toBe(true);
    const connected = api.list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000 * 6);
    expect(api.list.mock.calls.length).toBe(connected);
    await vi.advanceTimersByTimeAsync(5000 * 6);
    expect(api.list.mock.calls.length).toBe(connected + 1);
  });

  it('select waits for the trust answer, and the newest select wins', async () => {
    const store = make();
    await store.init();
    let answer!: () => void;
    trustGate = new Promise<void>((resolve) => (answer = resolve));
    store.select('t1');
    store.select('t2');
    expect(store.selectedId()).toBeUndefined();
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.selectedId()).toBe('t2');
    expect(settings.set).toHaveBeenLastCalledWith('thread', 't2');
  });

  it('opening a thread of another project makes that project current and unfolds it', async () => {
    workspaces = [ws('/a'), ws('/b', { collapsed: true })];
    threads = [thread('t1', '/a'), thread('t2', '/b')];
    const store = make();
    await store.init();
    store.select('t2');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.workspace()).toBe('/b');
    expect(settings.set).toHaveBeenCalledWith('workspace', '/b');
    expect(api.patchWorkspace).toHaveBeenCalledWith({ cwd: '/b', collapsed: false });
    expect(trust.ensure).toHaveBeenCalledWith('/b');
  });

  it('selectWorkspace clears the selection, remembers and asks about trust', async () => {
    const store = make();
    await store.init();
    store.select('t1');
    await vi.advanceTimersByTimeAsync(0);
    await store.selectWorkspace('/b');
    expect(store.selectedId()).toBeUndefined();
    expect(store.workspace()).toBe('/b');
    expect(settings.set).toHaveBeenCalledWith('workspace', '/b');
    expect(trust.ensure).toHaveBeenLastCalledWith('/b');
  });

  it('archiving the selected thread deselects it; a failed write is the error and is thrown', async () => {
    const store = make();
    await store.init();
    store.select('t1');
    await vi.advanceTimersByTimeAsync(0);
    await store.setArchived('t1', true);
    expect(api.patch).toHaveBeenCalledWith('t1', { archived: true });
    expect(store.selectedId()).toBeUndefined();
    api.patch.mockRejectedValueOnce(new Error('read-only'));
    await expect(store.rename('t2', 'x')).rejects.toThrow('read-only');
    expect(store.error()).toBe('read-only');
  });

  it('create makes a thread in the current project, or in the one it is given, and refreshes', async () => {
    const store = make();
    await store.init();
    expect((await store.create())?.id).toBe('new');
    expect(api.create).toHaveBeenLastCalledWith('/a', undefined, undefined);
    await store.create('/b');
    expect(api.create).toHaveBeenLastCalledWith('/b', undefined, undefined);
  });

  describe('projects', () => {
    it('are the known folders in the sidebar order, each with its threads (pinned first, then newest), its counts and its strongest state', async () => {
      workspaces = [ws('/a'), ws('/b'), ws('/c', { hidden: true })];
      threads = [
        thread('old', '/a', { updatedAt: 1 }),
        thread('new', '/a', { updatedAt: 9 }),
        thread('pin', '/a', { updatedAt: 0, pinned: true }),
        thread('ask', '/b', { state: { ...idle, activity: 'waiting', question: 'Proceed?' } }),
        thread('busy', '/b', { state: { ...idle, activity: 'running' } }),
        thread('full', '/c', { state: { ...idle, context: 96 } }),
      ];
      const store = make();
      await store.init();
      expect(store.visibleProjects().map((p) => p.workspace.cwd)).toEqual(['/a', '/b']);
      expect(store.hiddenProjects().map((p) => p.workspace.cwd)).toEqual(['/c']);
      const [a, b] = store.visibleProjects();
      expect(a.threads.map((t) => t.id)).toEqual(['pin', 'new', 'old']);
      expect(a.strongest).toBeUndefined();
      expect(b.counts).toEqual({ running: 1, waiting: 1 });
      expect(b.strongest).toBe('waiting');
      expect(store.projects()[2].context).toBe(96);
    });

    it('fold, hide and the attendant opt-out go to the backend, and the sidebar follows at once', async () => {
      const store = make();
      await store.init();
      const call = store.setCollapsed('/a', true);
      expect(store.workspaces()[0].collapsed).toBe(true);
      await call;
      expect(api.patchWorkspace).toHaveBeenCalledWith({ cwd: '/a', collapsed: true });
      await store.setHidden('/b', true);
      expect(api.patchWorkspace).toHaveBeenCalledWith({ cwd: '/b', hidden: true });
      await store.setAttendant('/a', false);
      expect(api.patchWorkspace).toHaveBeenCalledWith({ cwd: '/a', attendant: false });
    });

    it('move before another project, to the end, one step at a time, and not when nothing changes', async () => {
      workspaces = [ws('/a'), ws('/b'), ws('/c')];
      const store = make();
      await store.init();
      await store.moveProject('/c', '/a');
      expect(api.orderWorkspaces).toHaveBeenLastCalledWith(['/c', '/a', '/b']);
      expect(store.workspaces().map((w) => w.cwd)).toEqual(['/c', '/a', '/b']);
      await store.moveProject('/c', undefined);
      expect(api.orderWorkspaces).toHaveBeenLastCalledWith(['/a', '/b', '/c']);
      api.orderWorkspaces.mockClear();
      await store.moveProject('/a', '/b');
      expect(api.orderWorkspaces).not.toHaveBeenCalled();
      await store.stepProject('/b', -1);
      expect(api.orderWorkspaces).toHaveBeenLastCalledWith(['/b', '/a', '/c']);
      await store.stepProject('/b', -1);
      expect(api.orderWorkspaces).toHaveBeenCalledTimes(1);
    });

    it('a hidden project keeps its place when its neighbours move', async () => {
      workspaces = [ws('/a'), ws('/h', { hidden: true }), ws('/b')];
      const store = make();
      await store.init();
      await store.stepProject('/b', -1);
      expect(api.orderWorkspaces).toHaveBeenLastCalledWith(['/b', '/a', '/h']);
    });

    it('⌘1…⌘9 jump to the nth project: its last opened thread, else it becomes current and unfolds', async () => {
      workspaces = [ws('/a'), ws('/b', { collapsed: true })];
      threads = [thread('t1', '/a', { lastOpenedAt: 5 }), thread('t2', '/a', { lastOpenedAt: 9 })];
      const store = make();
      await store.init();
      store.jumpToProject(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.selectedId()).toBe('t2');
      store.jumpToProject(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.workspace()).toBe('/b');
      expect(store.selectedId()).toBeUndefined();
      expect(api.patchWorkspace).toHaveBeenCalledWith({ cwd: '/b', collapsed: false });
      store.jumpToProject(8);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.workspace()).toBe('/b');
    });

    it('⌘[ and ⌘] step through the open project’s threads in the sidebar order and stop at the ends', async () => {
      threads = [
        thread('x', '/a', { updatedAt: 1 }),
        thread('y', '/a', { updatedAt: 2 }),
        thread('z', '/a', { updatedAt: 3 }),
        thread('other', '/b'),
      ];
      const store = make();
      await store.init();
      store.select('y');
      await vi.advanceTimersByTimeAsync(0);
      store.stepThread(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.selectedId()).toBe('x'); // newest first: z, y, x
      store.stepThread(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.selectedId()).toBe('x');
      store.stepThread(-1);
      await vi.advanceTimersByTimeAsync(0);
      store.stepThread(-1);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.selectedId()).toBe('z');
      store.stepThread(-1);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.selectedId()).toBe('z');
    });
  });

  describe('the status channel', () => {
    it('a snapshot and then a state line change a thread’s state without a list request', async () => {
      const store = make();
      await store.init();
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.events).toHaveBeenCalledTimes(1);
      const lists = api.list.mock.calls.length;
      status?.({ type: 'snapshot', states: { t1: idle, t2: { ...idle, context: 96 } } });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.threads()[1].state.context).toBe(96);
      status?.({
        type: 'state',
        id: 't1',
        state: { ...idle, activity: 'waiting', question: 'Proceed with the test?' },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.threads()[0].state.question).toBe('Proceed with the test?');
      expect(store.threads()[0].waiting).toBe(true);
      expect(store.threads()[0].running).toBe(false);
      status?.({ type: 'state', id: 't1', state: { ...idle, lastRun: 'aborted' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.threads()[0].lastRun).toBe('aborted');
      expect(api.list.mock.calls.length).toBe(lists);
    });

    it('hands every line to the stores of other domains that listen (the agents of a thread)', async () => {
      const store = make();
      await store.init();
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      const seen: string[] = [];
      const stop = store.onStatusEvent((event) => seen.push(event.type));
      status?.({ type: 'agents', id: 't1', agents: [] });
      status?.({ type: 'ping' });
      await vi.advanceTimersByTimeAsync(0);
      stop();
      status?.({ type: 'ping' });
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual(['agents', 'ping']);
    });

    it('a deleted thread goes, a "list" line and a snapshot that names an unknown thread read the list again', async () => {
      const store = make();
      await store.init();
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      status?.({ type: 'gone', id: 't2' });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.threads().map((t) => t.id)).toEqual(['t1']);
      const lists = api.list.mock.calls.length;
      status?.({ type: 'list' });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.list.mock.calls.length).toBe(lists + 1);
      status?.({ type: 'snapshot', states: { t1: idle, brandnew: idle } });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(api.list.mock.calls.length).toBe(lists + 2);
      status?.({ type: 'ping' });
      await vi.advanceTimersByTimeAsync(0);
    });

    it('opening a thread, or a run ending in the thread you are looking at, tells the backend you have seen it', async () => {
      const store = make();
      await store.init();
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      store.select('t1');
      await vi.advanceTimersByTimeAsync(0);
      expect(api.markSeen).not.toHaveBeenCalled(); // nothing to clear
      status?.({ type: 'state', id: 't1', state: { ...idle, unread: true, unseen: true, lastRun: 'finished' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(api.markSeen).toHaveBeenCalledWith('t1');
      expect(store.selected()?.state.unread).toBe(false);
      // another thread finishing is news, and stays so until it is opened
      status?.({ type: 'state', id: 't2', state: { ...idle, unread: true, unseen: true, lastRun: 'finished' } });
      await vi.advanceTimersByTimeAsync(0);
      expect(api.markSeen).toHaveBeenCalledTimes(1);
      expect(store.threads()[1].state.unread).toBe(true);
    });

    it.each(['EOF', 'error'])(
      'reconnects the status channel after %s, backs off on refusal and resets after recovery',
      async (ending) => {
        const store = make();
        await store.init();
        TestBed.tick();
        await vi.advanceTimersByTimeAsync(0);
        status?.({ type: 'snapshot', states: { t1: idle, t2: idle } });
        await vi.advanceTimersByTimeAsync(0);
        expect(store.statusConnected()).toBe(true);
        if (ending === 'EOF') statusEnds?.();
        else statusFails?.(new Error('connection lost'));
        await vi.advanceTimersByTimeAsync(0);
        expect(store.statusConnected()).toBe(false);
        api.events.mockRejectedValueOnce(new Error('connection refused'));
        await vi.advanceTimersByTimeAsync(999);
        expect(api.events).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(api.events).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1999);
        expect(api.events).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(api.events).toHaveBeenCalledTimes(3);
        const lists = api.list.mock.calls.length;
        status?.({ type: 'snapshot', states: { t1: { ...idle, context: 75 }, t2: idle, added: idle } });
        await vi.advanceTimersByTimeAsync(0);
        expect(store.statusConnected()).toBe(true);
        expect(api.list.mock.calls.length).toBe(lists + 1);
        // Recovery starts the next disconnect at the first delay again.
        statusEnds?.();
        await vi.advanceTimersByTimeAsync(999);
        expect(api.events).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(1);
        expect(api.events).toHaveBeenCalledTimes(4);
      },
    );
  });

  describe('the watch stream', () => {
    it('opens while a panel wants it, bumps the tick on events, and closes a grace period after the last lets go', async () => {
      const store = make();
      await store.init();
      TestBed.tick();
      expect(workspaceApi.watch).not.toHaveBeenCalled();
      store.want('files', true);
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(workspaceApi.watch).toHaveBeenCalledTimes(1);
      emit?.({ type: 'ready' } as WatchEvent);
      await vi.advanceTimersByTimeAsync(0);
      emit?.({ type: 'change', paths: ['src/a.ts'], overflow: false } as WatchEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.watchConnected()).toBe(true);
      expect(store.watchTick()).toBe(2);
      expect(store.watchLast()).toEqual({ paths: ['src/a.ts'], overflow: false });

      store.want('files', false);
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(2900);
      TestBed.tick();
      expect(store.watchHeld()).toBe(true);
      await vi.advanceTimersByTimeAsync(200);
      TestBed.tick();
      expect(store.watchHeld()).toBe(false);
    });

    it.each(['EOF', 'error'])(
      'reconnects the folder watch after %s and abandons its pending retry when the folder changes',
      async (ending) => {
        const store = make();
        await store.init();
        store.want('changes', true);
        TestBed.tick();
        await vi.advanceTimersByTimeAsync(0);
        emit?.({ type: 'ready' } as WatchEvent);
        await vi.advanceTimersByTimeAsync(0);
        if (ending === 'EOF') watchEnds?.();
        else watchFails?.(new Error('connection lost'));
        await vi.advanceTimersByTimeAsync(0);
        expect(store.watchConnected()).toBe(false);
        await vi.advanceTimersByTimeAsync(999);
        expect(workspaceApi.watch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(workspaceApi.watch).toHaveBeenCalledTimes(2);
        emit?.({ type: 'ready' } as WatchEvent);
        await vi.advanceTimersByTimeAsync(0);
        const oldEmit = emit;
        watchEnds?.();
        await vi.advanceTimersByTimeAsync(1000);
        expect(workspaceApi.watch).toHaveBeenCalledTimes(2);
        await store.selectWorkspace('/b');
        TestBed.tick();
        await vi.advanceTimersByTimeAsync(0);
        emit?.({ type: 'ready' } as WatchEvent);
        await vi.advanceTimersByTimeAsync(0);
        const tick = store.watchTick();
        oldEmit?.({ type: 'change', paths: ['old-folder.ts'], overflow: false, at: Date.now() });
        await vi.advanceTimersByTimeAsync(2000);
        expect(store.watchTick()).toBe(tick);
        expect(workspaceApi.watch.mock.calls.map(([cwd]) => cwd)).toEqual(['/a', '/a', '/b']);
        expect(workspaceApi.watch.mock.calls[1][2].aborted).toBe(true);
        // Demand ending closes the current transport after the shared panel grace.
        store.want('changes', false);
        TestBed.tick();
        await vi.advanceTimersByTimeAsync(3000);
        TestBed.tick();
        expect(workspaceApi.watch.mock.calls[2][2].aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(10000);
        expect(workspaceApi.watch).toHaveBeenCalledTimes(3);
      },
    );
  });
});
