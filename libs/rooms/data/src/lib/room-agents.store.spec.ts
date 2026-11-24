import { inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  EntryApiClient,
  provideMockApi,
  settingsModels,
  roomParticipantsList,
  roomParticipantsTargets,
  roomParticipantsAdd,
  roomParticipantsRemove,
} from '@pi-kit/api';
import type { Room, RoomParticipants, RoomParticipantTargets } from '@pi-kit/protocol';
import { OpenRoomStore } from './open-room.store';
import { RoomAgentsStore } from './room-agents.store';

const empty: RoomParticipants = { members: [] };
const destinations: RoomParticipantTargets = { machines: [], agents: [] };
describe('room agent request ownership', () => {
  const room = signal<Room | undefined>(undefined);
  const list = vi.fn();
  const targets = vi.fn();
  const models = vi.fn();
  const add = vi.fn();
  const remove = vi.fn();
  const forOwner = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    room.set({
      id: 'room-a',
      hostInstanceId: 'host-a',
      title: 'Personal',
      repository: '',
      baseCommit: '',
      createdAt: 1,
      waiting: 0,
    });
    list.mockResolvedValue(empty);
    targets.mockResolvedValue(destinations);
    models.mockResolvedValue([
      { provider: 'selected', id: 'model', name: 'Selected host model', available: true, reasoning: false },
    ]);
    add.mockResolvedValue(empty);
    remove.mockResolvedValue(empty);
    TestBed.configureTestingModule({
      providers: [
        RoomAgentsStore,
        { provide: OpenRoomStore, useValue: { room } },
        ...provideMockApi([
          [settingsModels, models, () => []],
          [roomParticipantsList, list, (options) => [options.path]],
          [roomParticipantsTargets, targets, (options) => [options.path]],
          [roomParticipantsAdd, add, (options) => [options.path, options.body]],
          [roomParticipantsRemove, remove, (options) => [options.path]],
        ]),
        {
          provide: EntryApiClient,
          useFactory: () => {
            const api = inject(ApiClient);
            forOwner.mockReturnValue(api.client);
            return { forOwner };
          },
        },
      ],
    });
  });
  function open() {
    const store = TestBed.inject(RoomAgentsStore);
    store.visible.set(true);
    store.targetsVisible.set(true);
    TestBed.tick();
    return store;
  }
  it('routes roster mutations to the room owner and preserves request bodies', async () => {
    const store = open();
    await vi.waitFor(() => expect(store.status()).toEqual(empty));
    const body = { role: 'reviewer', instructions: 'Review outputs.', agent: { local: true } };
    expect(await store.add(body)).toBe(true);
    expect(add).toHaveBeenCalledExactlyOnceWith({ roomId: 'room-a' }, body);
    expect(forOwner).toHaveBeenCalledWith('host-a');
  });
  it('allows roster removal while target discovery is still waiting', async () => {
    let finish: (value: RoomParticipantTargets) => void = () => undefined;
    targets.mockImplementationOnce(
      () =>
        new Promise<RoomParticipantTargets>((resolve) => {
          finish = resolve;
        }),
    );
    const store = open();
    await vi.waitFor(() => expect(targets).toHaveBeenCalledTimes(1));
    expect(await store.remove('researcher')).toBe(true);
    expect(remove).toHaveBeenCalledExactlyOnceWith({ roomId: 'room-a', role: 'researcher' });
    finish(destinations);
  });
  it('fences a stale roster response and mutation when switching hosts', async () => {
    let finish: (value: RoomParticipants) => void = () => undefined;
    list.mockImplementationOnce(
      () =>
        new Promise<RoomParticipants>((resolve) => {
          finish = resolve;
        }),
    );
    const store = open();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const previous = room()!;
    room.set({ ...previous, hostInstanceId: 'host-b' });
    expect(await store.add({ role: 'reviewer', instructions: '', agent: { local: true } })).toBe(false);
    expect(add).not.toHaveBeenCalled();
    TestBed.tick();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    finish({ members: [{ role: 'old-host', instructions: '', agent: { local: true }, source: 'room' }] });
    await vi.waitFor(() => expect(store.status()).toEqual(empty));
    expect(forOwner).toHaveBeenLastCalledWith('host-b');
  });
  it('retains mutation failures through successful roster polling', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    try {
      const store = open();
      await vi.waitFor(() => expect(store.status()).toBeDefined());
      add.mockRejectedValueOnce(new Error('Unavailable host.'));
      expect(await store.add({ role: 'reviewer', instructions: '', agent: { local: true } })).toBe(false);
      for (const [poll, milliseconds] of interval.mock.calls) {
        if (milliseconds === 5000 && typeof poll === 'function') poll();
      }
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
      expect(store.error()).toBe('Unavailable host.');
    } finally {
      interval.mockRestore();
    }
  });
  it('loads models from the selected execution owner without changing unrelated model settings', async () => {
    const store = open();
    await vi.waitFor(() => expect(store.status()).toBeDefined());
    store.showModels('paired-host');
    TestBed.tick();
    await vi.waitFor(() => expect(store.models()?.[0]?.provider).toBe('selected'));
    expect(forOwner).toHaveBeenLastCalledWith('paired-host');
    expect(models).toHaveBeenCalledExactlyOnceWith();
  });
  it('discards a stale catalog when changing execution hosts and when changing room context', async () => {
    let finish: (value: unknown) => void = () => undefined;
    models.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const store = open();
    store.showModels('host-a');
    TestBed.tick();
    await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(1));
    store.showModels('host-b');
    TestBed.tick();
    await vi.waitFor(() => expect(store.models()?.[0]?.provider).toBe('selected'));
    finish([{ provider: 'old', id: 'model', name: 'Old host model', available: true, reasoning: false }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.models()?.[0]?.provider).toBe('selected');
    const previous = room()!;
    room.set({ ...previous, id: 'room-b', hostInstanceId: 'new-room-owner' });
    TestBed.tick();
    await vi.waitFor(() => expect(models).toHaveBeenCalledTimes(3));
    expect(forOwner).toHaveBeenLastCalledWith('host-b');
    store.showModels(undefined);
    TestBed.tick();
    expect(store.models()).toBeUndefined();
  });
  it('surfaces model catalog errors and supports an explicit retry', async () => {
    models.mockRejectedValueOnce(new Error('Host catalog unavailable.'));
    const store = open();
    store.showModels('paired-host');
    TestBed.tick();
    await vi.waitFor(() => expect(store.modelsError()).toBe('Host catalog unavailable.'));
    await store.retryModels();
    expect(store.modelsError()).toBeUndefined();
    expect(store.models()?.[0]?.name).toBe('Selected host model');
  });
});
