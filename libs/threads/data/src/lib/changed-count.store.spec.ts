import { Subject } from 'rxjs';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideMockApi, workspaceStatusStatus } from '@pi-kit/api';
import { ClockStore } from '@pi-kit/data-access';
import { ChangedCountStore } from './changed-count.store';
import { ThreadsStore } from './threads.store';

describe('ChangedCountStore (the badge of "Working tree changes")', () => {
  const folder = signal<string | undefined>('/a');
  const threads = signal<{ id: string; state: { activity: string } }[]>([]);
  let folderChanges = new Subject<{ paths: readonly string[]; overflow: boolean; headMoved: boolean }>();
  const now = signal(1_000_000);
  const api = { status: vi.fn(async (_folder: string) => ({ entries: [{}, {}, {}], thread: [] })) };

  const make = () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: { folder, threads, folderChanges } },
        { provide: ClockStore, useValue: { now } },
        ...provideMockApi([
          [workspaceStatusStatus, api.status, (o) => [o.path?.['id'], o.query?.['thread'], o.signal]],
        ]),
      ],
    });
    const store = TestBed.inject(ChangedCountStore);
    TestBed.tick();
    return store;
  };
  const settle = async (ms = 0): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    TestBed.tick();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    folder.set('/a');
    threads.set([]);
    folderChanges = new Subject();
    api.status.mockClear();
    api.status.mockResolvedValue({ entries: [{}, {}, {}], thread: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('counts the changed files of the folder in view, at once for a folder it has not read', async () => {
    const store = make();
    await settle();
    expect(api.status).toHaveBeenCalledWith('/a', undefined, expect.any(AbortSignal));
    expect(store.count()).toBe(3);
  });

  it('reads another folder at once, and the same folder again after a short settle, once for a burst of changes', async () => {
    const store = make();
    await settle();
    api.status.mockResolvedValue({ entries: [{}], thread: [] });
    folder.set('/b');
    await settle();
    expect(store.count()).toBe(1);
    expect(api.status).toHaveBeenLastCalledWith('/b', undefined, expect.any(AbortSignal));
    api.status.mockClear();
    api.status.mockResolvedValue({ entries: [], thread: [] });
    folderChanges.next({ paths: [], overflow: true, headMoved: false });
    await settle();
    folderChanges.next({ paths: [], overflow: true, headMoved: false });
    await settle(100);
    folderChanges.next({ paths: [], overflow: true, headMoved: false });
    await settle(100);
    expect(api.status).not.toHaveBeenCalled();
    await settle(1000);
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(store.count()).toBe(0);
  });

  it('hides another folder’s count immediately and ignores its delayed response after switching again', async () => {
    const store = make();
    await settle();
    expect(store.count()).toBe(3);
    let finish!: (status: { entries: object[]; thread: never[] }) => void;
    api.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    folder.set('/b');
    expect(store.count()).toBe(0);
    await settle();
    expect(store.folder()).toBe('/b');
    expect(store.count()).toBe(0);
    api.status.mockResolvedValueOnce({ entries: [{}], thread: [] });
    folder.set('/c');
    await settle();
    expect(store.count()).toBe(1);
    finish({ entries: [{}, {}, {}, {}], thread: [] });
    await settle();
    expect(store.folder()).toBe('/c');
    expect(store.count()).toBe(1);
  });

  it('reads again when a run starts or ends, and every ten seconds', async () => {
    make();
    await settle();
    api.status.mockClear();
    threads.set([{ id: 't1', state: { activity: 'running' } }]);
    await settle(1000);
    expect(api.status).toHaveBeenCalledTimes(1);
    threads.set([{ id: 't1', state: { activity: 'idle' } }]);
    await settle(1000);
    expect(api.status).toHaveBeenCalledTimes(2);
    now.set(now() + 11_000);
    await settle(1000);
    expect(api.status).toHaveBeenCalledTimes(3);
  });

  it('is 0 when there is no folder, and when the folder is not a repository or the read fails', async () => {
    const store = make();
    await settle();
    expect(store.count()).toBe(3);
    api.status.mockRejectedValueOnce(new Error('not a git working tree'));
    folder.set('/plain');
    await settle();
    expect(store.count()).toBe(0);
    folder.set('/a');
    await settle();
    expect(store.count()).toBe(3);
    folder.set(undefined);
    await settle();
    expect(store.count()).toBe(0);
  });
});
