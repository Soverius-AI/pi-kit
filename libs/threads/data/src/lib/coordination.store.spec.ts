import { Subject } from 'rxjs';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { coordinationGet, provideMockApi } from '@pi-kit/api';
import type { Coordination } from '@pi-kit/protocol';

import { CoordinationStore } from './coordination.store';
import { ThreadsStore } from './threads.store';

const lease = (path: string, title = 'Fix e2e') => ({ path, threadId: 'o1', title, since: 1, at: 2 });

describe('CoordinationStore', () => {
  let answer: Coordination;
  let selectedId: ReturnType<typeof signal<string | undefined>>;
  let folderChanges: Subject<{ paths: readonly string[]; overflow: boolean; headMoved: boolean }>;
  const api = { coordination: vi.fn(async () => answer) };

  const make = () => TestBed.inject(CoordinationStore);

  beforeEach(() => {
    vi.useFakeTimers();
    answer = {
      leases: [lease('src/map.ts')],
      others: [{ title: 'Fix e2e', state: 'running', relation: 'same-folder' }],
    };
    selectedId = signal<string | undefined>('t1');
    folderChanges = new Subject();
    api.coordination.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: { selectedId: () => selectedId(), folderChanges } },
        ...provideMockApi([[coordinationGet, api.coordination, (o) => [o.path?.['id'], o.signal]]]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('reads nothing until a panel wants the chips, then reads the open thread’s leases and the other agents', async () => {
    const store = make();
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.coordination).not.toHaveBeenCalled();
    store.want('files', true);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.coordination).toHaveBeenCalledWith('t1', expect.any(AbortSignal));
    expect(store.leaseOf('src/map.ts')?.title).toBe('Fix e2e');
    expect(store.leaseOf('src/other.ts')).toBeUndefined();
    expect(store.active().map((o) => o.title)).toEqual(['Fix e2e']);
  });

  it('leaves out idle agents from "Also working here" but keeps a pi in a terminal', async () => {
    answer = {
      leases: [],
      others: [
        { title: 'Idle one', state: 'idle', relation: 'worktree' },
        { title: 'pi session', state: 'terminal', relation: 'same-folder' },
      ],
    };
    const store = make();
    store.want('review', true);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.others()).toHaveLength(2);
    expect(store.active().map((o) => o.state)).toEqual(['terminal']);
  });

  it('reads again when the folder changes, when another thread opens, and every 20 seconds', async () => {
    const store = make();
    store.want('files', true);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    api.coordination.mockClear();
    folderChanges.next({ paths: [], overflow: true, headMoved: false });
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.coordination).toHaveBeenCalledTimes(1);
    selectedId.set('t2');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.coordination).toHaveBeenLastCalledWith('t2', expect.any(AbortSignal));
    api.coordination.mockClear();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.coordination).toHaveBeenCalledTimes(1);
  });

  it('stops reading when no panel wants the chips, and keeps the last ones when a read fails', async () => {
    const store = make();
    store.want('files', true);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    api.coordination.mockRejectedValueOnce(new Error('offline'));
    await store.refresh();
    expect(store.leaseOf('src/map.ts')).toBeDefined();
    store.want('files', false);
    TestBed.tick();
    api.coordination.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.coordination).not.toHaveBeenCalled();
  });

  it('clears the chips when no thread is open', async () => {
    const store = make();
    store.want('files', true);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    selectedId.set(undefined);
    await store.refresh();
    expect(store.leases()).toEqual([]);
    expect(store.others()).toEqual([]);
  });
});
