import { TestBed } from '@angular/core/testing';
import { peersList, peersProjects, provideMockApi, workspacesWorkspaces } from '@pi-kit/api';
import type { PeerManager } from '@pi-kit/protocol';
import { EnvironmentsStore } from './environments.store';

const self = { instanceId: '0b6c5bb4-3b1e-4a36-9ad2-7f6f8a1c2d01', name: 'ms22.local' };
const peerId = 'f1a77d38-aa39-45b9-ac63-60a662a9737d';
const manager = (state?: 'pending' | 'active'): PeerManager =>
  ({
    self,
    keyInitialized: true,
    peers: state ? [{ peerId, name: 'Studio', state }] : [],
    requests: [],
  }) as unknown as PeerManager;

describe('EnvironmentsStore', () => {
  let answer: PeerManager;
  const list = vi.fn(async () => answer);
  const projects = vi.fn(async (): Promise<unknown[]> => []);
  beforeEach(() => {
    vi.useFakeTimers();
    list.mockClear();
    projects.mockReset().mockResolvedValue([]);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([
          [peersList, list, () => []],
          [peersProjects, projects, () => []],
          [workspacesWorkspaces, async () => [], () => []],
        ]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('looks again while a pairing waits for the other instance, and lists the peer once it is active', async () => {
    answer = manager('pending');
    const store = TestBed.inject(EnvironmentsStore);
    await store.refresh();
    expect(store.hasPeers()).toBe(false);
    answer = manager('active');
    await vi.advanceTimersByTimeAsync(3000);
    expect(store.hasPeers()).toBe(true);
    expect(store.groups().map((group) => group.name)).toEqual(['ms22.local', 'Studio']);
    const calls = list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list.mock.calls.length).toBe(calls);
  });

  it('tries an unavailable environment again until it answers', async () => {
    answer = manager('active');
    projects.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('locked'));
    const store = TestBed.inject(EnvironmentsStore);
    await store.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.groups().find((group) => !group.local)?.error).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.groups().find((group) => !group.local)?.error).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.groups().find((group) => !group.local)?.error).toBeUndefined();
    const calls = projects.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(projects.mock.calls.length).toBe(calls);
  });

  it('does not poll when nothing is in flight', async () => {
    answer = manager();
    const store = TestBed.inject(EnvironmentsStore);
    await store.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
