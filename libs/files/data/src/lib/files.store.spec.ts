import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideMockApi,
  sessionCreateEntry,
  sessionDeleteEntry,
  sessionOpenInEditor,
  sessionRenameEntry,
  sessionRevealInFileManager,
  sessionWorkspaceFiles,
  sessionWorkspaceTree,
  workspaceStatusStatus,
} from '@pi-kit/api';
import { ChatStore } from '@pi-kit/chat/api';
import { DialogStore, ToastStore, UiStore } from '@pi-kit/data-access';
import type { FileNode, WorkspaceStatus } from '@pi-kit/protocol';
import { ChangesStore } from '@pi-kit/review/api';
import { fakeThreads, thread } from '@pi-kit/testing';
import { ThreadsStore } from '@pi-kit/threads/api';
import { FilesStore } from './files.store';

const node = (path: string, dir = false): FileNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  dir,
  size: 10,
  mtime: 0,
});
const status = (over: Partial<WorkspaceStatus> = {}): WorkspaceStatus =>
  ({ git: true, entries: [], thread: [], ...over }) as WorkspaceStatus;
const key = (k: string, target: HTMLElement = document.createElement('div')) => {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: target });
  return event;
};

describe('FilesStore', () => {
  const tree: Record<string, FileNode[]> = {
    '': [node('src', true), node('README.md'), node('zeta.txt')],
    src: [node('src/a.ts'), node('src/b.ts')],
  };
  let currentStatus: WorkspaceStatus;
  const api = {
    tree: vi.fn(async (_cwd: string, dir = '') => tree[dir] ?? []),
    status: vi.fn(async () => currentStatus),
    search: vi.fn(async () => [{ path: 'src/a.ts', dir: false }]),
    openInEditor: vi.fn(async () => ({ opened: true })),
    reveal: vi.fn(async () => ({ opened: true })),
    createEntry: vi.fn(async () => ({ path: 'x' })),
    renameEntry: vi.fn(async () => ({ path: 'y' })),
    deleteEntry: vi.fn(async () => undefined),
  };
  const chat = { running: signal(false) };
  const changes = { openFile: vi.fn(), revert: vi.fn(async () => true) };
  let threads: ReturnType<typeof fakeThreads>;

  const make = async () => {
    const files = TestBed.inject(FilesStore);
    files.activate();
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    return files;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    currentStatus = status();
    chat.running.set(false);
    for (const fn of [...Object.values(api), changes.openFile, changes.revert]) fn.mockClear();
    threads = fakeThreads({ selected: thread('t1') });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        { provide: ChatStore, useValue: chat },
        { provide: ChangesStore, useValue: changes },
        ...provideMockApi([
          [
            sessionWorkspaceTree,
            api.tree,
            (o) => [o.path?.['id'], o.query?.['dir'], o.query?.['ignored'] === '1', o.signal],
          ],
          [workspaceStatusStatus, api.status, (o) => [o.path?.['id'], o.query?.['thread'], o.signal]],
          [sessionWorkspaceFiles, api.search, (o) => [o.path?.['id'], o.query?.['q'], o.signal]],
          [sessionOpenInEditor, api.openInEditor, (o) => [o.path?.['id'], o.body?.['path']]],
          [sessionRevealInFileManager, api.reveal, (o) => [o.path?.['id'], o.body?.['path']]],
          [sessionCreateEntry, api.createEntry, (o) => [o.path?.['id'], o.body?.['path'], o.body?.['dir']]],
          [sessionRenameEntry, api.renameEntry, (o) => [o.path?.['id'], o.body?.['from'], o.body?.['to']]],
          [sessionDeleteEntry, api.deleteEntry, (o) => [o.path?.['id'], o.body?.['path']]],
        ]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('does nothing until the panel is active, then lists the root and reads the badges', async () => {
    const files = TestBed.inject(FilesStore);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.tree).not.toHaveBeenCalled();
    files.activate();
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.tree).toHaveBeenCalledWith('/a', '', false, expect.any(AbortSignal));
    expect(api.status).toHaveBeenCalledWith('/a', 't1', expect.anything());
    expect(files.rows().map((r) => r.node.path)).toEqual(['src', 'README.md', 'zeta.txt']);
    expect(threads.want).toHaveBeenCalledWith('files', true);
    files.deactivate();
    expect(threads.want).toHaveBeenCalledWith('files', false);
  });

  it('opens a folder lazily and nests its rows', async () => {
    const files = await make();
    files.toggle(node('src', true));
    await vi.advanceTimersByTimeAsync(0);
    expect(files.rows().map((r) => [r.node.path, r.depth])).toEqual([
      ['src', 0],
      ['src/a.ts', 1],
      ['src/b.ts', 1],
      ['README.md', 0],
      ['zeta.txt', 0],
    ]);
    files.toggle(node('src', true));
    expect(files.rows()).toHaveLength(3);
  });

  it('a folder that cannot be read is the error', async () => {
    api.tree.mockRejectedValueOnce(new Error('EACCES'));
    const files = await make();
    expect(files.error()).toBe('EACCES');
  });

  it('starts from the root of another folder', async () => {
    const files = await make();
    files.toggle(node('src', true));
    files.setSelected('README.md');
    threads.open(thread('t2', { cwd: '/b' }));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.tree).toHaveBeenLastCalledWith('/b', '', false, expect.any(AbortSignal));
    expect(files.expanded().size).toBe(0);
    expect(files.selectedId()).toBeUndefined();
  });

  it('the arrow keys, Home/End and type-ahead move the selection and ask for the focus', async () => {
    const files = await make();
    const focus0 = files.focusRequests();
    files.onKey(key('ArrowDown'));
    expect(files.selectedId()).toBe('src');
    files.onKey(key('ArrowDown'));
    expect(files.selectedId()).toBe('README.md');
    files.onKey(key('ArrowUp'));
    expect(files.selectedId()).toBe('src');
    files.onKey(key('End'));
    expect(files.selectedId()).toBe('zeta.txt');
    files.onKey(key('Home'));
    expect(files.selectedId()).toBe('src');
    files.onKey(key('z'));
    expect(files.selectedId()).toBe('zeta.txt');
    expect(files.focusRequests()).toBeGreaterThan(focus0);
  });

  it('Right opens a folder and steps into it, Left steps back out', async () => {
    const files = await make();
    files.setSelected('src');
    files.onKey(key('ArrowRight'));
    await vi.advanceTimersByTimeAsync(0);
    expect(files.expanded().has('src')).toBe(true);
    files.onKey(key('ArrowRight'));
    expect(files.selectedId()).toBe('src/a.ts');
    files.onKey(key('ArrowLeft'));
    expect(files.selectedId()).toBe('src');
    files.onKey(key('ArrowLeft'));
    expect(files.expanded().has('src')).toBe(false);
  });

  it('keys typed in the filter input are left alone', async () => {
    const files = await make();
    files.onKey(key('ArrowDown', document.createElement('input')));
    expect(files.selectedId()).toBeUndefined();
  });

  it('Enter on a changed file opens its diff from the right source, on a plain file inserts @path, on a folder toggles it', async () => {
    currentStatus = status({
      entries: [{ path: 'README.md', badge: 'M', staged: false }] as never,
      thread: ['src/a.ts'],
    });
    const files = await make();
    files.enter(node('README.md'), new Event('keydown'));
    expect(changes.openFile).toHaveBeenLastCalledWith('README.md', 'worktree');
    files.enter(node('zeta.txt'), new Event('keydown'));
    expect(TestBed.inject(UiStore).composerInsert()?.text).toBe('@zeta.txt');
    files.enter(node('src', true), new Event('keydown'));
    expect(files.expanded().has('src')).toBe(true);
    files.showDiff('src/a.ts');
    expect(changes.openFile).toHaveBeenLastCalledWith('src/a.ts', 'thread');
  });

  it('adding to the message needs an open thread', async () => {
    threads.open(undefined);
    threads.workspace.set('/a');
    const files = await make();
    files.chooseMenu('x');
    files.openMenu(new MouseEvent('contextmenu', { clientX: 5, clientY: 6 }), node('zeta.txt'));
    expect(files.menu()?.node.path).toBe('zeta.txt');
    files.chooseMenu('mention');
    expect(TestBed.inject(ToastStore).items().at(-1)?.text).toMatch(/Open a thread/);
    expect(files.menu()).toBeUndefined();
  });

  it('the filter searches the index after a pause', async () => {
    const files = await make();
    files.setQuery('a.t');
    TestBed.tick();
    expect(files.searching()).toBe(true);
    await vi.advanceTimersByTimeAsync(130);
    expect(api.search).toHaveBeenCalledWith('/a', 'a.t', expect.anything());
    expect(files.matches().map((n) => n.path)).toEqual(['src/a.ts']);
    expect(files.rows().map((r) => r.node.path)).toEqual(['src/a.ts']);
    expect(files.clearFilter()).toBe(true);
    expect(files.clearFilter()).toBe(false);
    TestBed.tick();
    expect(files.matches()).toEqual([]);
  });

  it('"Show ignored" is remembered and reloads the open folders', async () => {
    const files = await make();
    files.toggle(node('src', true));
    await vi.advanceTimersByTimeAsync(0);
    api.tree.mockClear();
    files.setShowIgnored(true);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(localStorage.getItem('pk.files.showIgnored')).toBe('1');
    expect(api.tree).toHaveBeenCalledWith('/a', '', true, expect.any(AbortSignal));
    expect(api.tree).toHaveBeenCalledWith('/a', 'src', true, expect.any(AbortSignal));
  });

  it('a watcher batch reloads only the folders it touched; a git change reloads all', async () => {
    const files = await make();
    files.toggle(node('src', true));
    await vi.advanceTimersByTimeAsync(0);
    api.tree.mockClear();
    threads.watchLast.set({ paths: ['src/c.ts'], overflow: false });
    threads.watchTick.set(1);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.tree.mock.calls.map((c) => c[1])).toEqual(['src']);
    api.tree.mockClear();
    threads.watchLast.set({ paths: ['.git/index'], overflow: false });
    threads.watchTick.set(2);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.tree.mock.calls.map((c) => c[1]).sort()).toEqual(['', 'src']);
  });

  it('refreshes the badges when a run ends', async () => {
    await make();
    chat.running.set(true);
    TestBed.tick();
    api.status.mockClear();
    chat.running.set(false);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it('delete asks first, then removes the entry and reloads its folder', async () => {
    const files = await make();
    files.setSelected('zeta.txt');
    files.onKey(key('Delete'));
    expect(files.confirm()?.kind).toBe('delete');
    await files.confirmed();
    expect(api.deleteEntry).toHaveBeenCalledWith('/a', 'zeta.txt');
    expect(files.confirm()).toBeUndefined();
    expect(TestBed.inject(ToastStore).items().at(-1)?.text).toBe('Deleted zeta.txt.');
  });

  it.each(['menu', 'confirmation'])(
    'drops a previous folder’s pending %s before it can delete in the new folder',
    async (kind) => {
      const files = await make();
      files.openMenu(new MouseEvent('contextmenu'), node('zeta.txt'));
      if (kind === 'confirmation') files.chooseMenu('delete');
      threads.open(thread('t2', { cwd: '/b' }));
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(files.rows().some((row) => row.node.path === 'zeta.txt')).toBe(true);
      if (kind === 'menu') files.chooseMenu('delete');
      await files.confirmed();
      expect(api.deleteEntry).not.toHaveBeenCalled();
      expect(files.menu()).toBeUndefined();
      expect(files.confirm()).toBeUndefined();
    },
  );

  it('revert goes to the changes store on the working tree', async () => {
    currentStatus = status({ entries: [{ path: 'README.md', badge: 'M', staged: false }] as never });
    const files = await make();
    files.openMenu(new MouseEvent('contextmenu'), node('README.md'));
    files.chooseMenu('revert');
    expect(files.confirm()?.kind).toBe('revert');
    await files.confirmed();
    expect(changes.revert).toHaveBeenCalledWith('README.md', 'worktree');
  });

  it('new file asks for a name, creates it, opens the folder and selects it', async () => {
    const files = await make();
    const dialogs = TestBed.inject(DialogStore);
    files.openMenu(new MouseEvent('contextmenu'), node('src', true));
    files.chooseMenu('new-file');
    dialogs.submitName('c.ts');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.createEntry).toHaveBeenCalledWith('/a', 'src/c.ts', false);
    expect(files.expanded().has('src')).toBe(true);
    expect(files.selectedId()).toBe('src/c.ts');
  });

  it('a bad name is a toast and creates nothing', async () => {
    const files = await make();
    files.openMenu(new MouseEvent('contextmenu'), node('zeta.txt'));
    files.chooseMenu('rename');
    TestBed.inject(DialogStore).submitName('../b');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.renameEntry).not.toHaveBeenCalled();
    expect(TestBed.inject(ToastStore).items()).toHaveLength(1);
  });
  it('ignores an older directory failure without clearing the newer read’s busy state', async () => {
    const files = await make();
    let fail!: (error: Error) => void;
    let finish!: (nodes: FileNode[]) => void;
    api.tree.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const first = files.reloadLoaded();
    api.tree.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const second = files.reloadLoaded();
    fail(new Error('old failure'));
    await first;
    expect(files.error()).toBeUndefined();
    expect(files.loadingDirs().has('')).toBe(true);
    finish([node('latest.ts')]);
    await second;
    expect(files.rows().map((r) => r.node.path)).toEqual(['latest.ts']);
    expect(files.loadingDirs().size).toBe(0);
  });

  it('ignores an old show-ignored response in the same folder', async () => {
    const files = await make();
    let finish!: (nodes: FileNode[]) => void;
    api.tree.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const previous = files.reloadLoaded();
    files.setShowIgnored(true);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    finish([node('stale.ts')]);
    await previous;
    expect(files.rows().some((r) => r.node.path === 'stale.ts')).toBe(false);
  });

  it.each(['another folder', 'folder revisit', 'panel reopen'])(
    'keeps the current selection after a late create refresh across %s',
    async (navigation) => {
      const files = await make();
      let finish!: (nodes: FileNode[]) => void;
      api.tree.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      files.openMenu(new MouseEvent('contextmenu'), node('src', true));
      files.chooseMenu('new-file');
      TestBed.inject(DialogStore).submitName('c.ts');
      await vi.advanceTimersByTimeAsync(0);
      if (navigation === 'panel reopen') {
        files.deactivate();
        TestBed.tick();
        files.activate();
      } else {
        threads.open(thread('t2', { cwd: '/b' }));
      }
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      if (navigation === 'folder revisit') {
        threads.open(thread('t1'));
        TestBed.tick();
        await vi.advanceTimersByTimeAsync(0);
      }
      const selected = navigation === 'another folder' ? undefined : 'README.md';
      if (selected) files.setSelected(selected);
      finish([node('src/c.ts')]);
      await vi.advanceTimersByTimeAsync(0);
      expect(files.selectedId()).toBe(selected);
      expect(files.rows().some((r) => r.node.path === 'src/c.ts')).toBe(false);
    },
  );
});
