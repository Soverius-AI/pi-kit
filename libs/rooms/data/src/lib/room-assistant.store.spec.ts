import { inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiClient, EntryApiClient, provideMockApi, roomAssistantMemory, roomAssistantStatus } from '@pi-kit/api';
import type { Room, RoomAssistantStatus } from '@pi-kit/protocol';
import { OpenRoomStore } from './open-room.store';
import { RoomAssistantStore } from './room-assistant.store';

const value: RoomAssistantStatus = {
  policy: { enabled: false, timezone: 'Europe/Vienna', quietStart: null, quietEnd: null, dailyLimit: 10 },
  memory: [],
  commitments: [],
  folders: [],
  workspace: '/room/workspace',
  work: [],
  files: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('room assistant request ownership', () => {
  const room = signal<Room | undefined>(undefined);
  const status = vi.fn<() => Promise<RoomAssistantStatus>>();
  const memory = vi.fn();
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
    status.mockResolvedValue(value);
    memory.mockResolvedValue(value);
    TestBed.configureTestingModule({
      providers: [
        RoomAssistantStore,
        { provide: OpenRoomStore, useValue: { room } },
        ...provideMockApi([
          [roomAssistantStatus, status, () => []],
          [roomAssistantMemory, memory, (options) => [options.path, options.body]],
        ]),
        {
          provide: EntryApiClient,
          useFactory: () => {
            const api = inject(ApiClient);
            return { forOwner: () => api.client };
          },
        },
      ],
    });
  });

  it('refreshes a completed mutation without waiting for or accepting an older read', async () => {
    const old = deferred<RoomAssistantStatus>();
    const current = { ...value, memory: [{ key: 'hours', text: 'after 11', updatedBy: 'owner', updatedAt: 1 }] };
    status.mockResolvedValue(current).mockImplementationOnce(() => old.promise);
    const store = TestBed.inject(RoomAssistantStore);
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(await store.memory({ key: 'hours', text: 'after 11' })).toBe(true);
    expect(store.status()?.memory).toEqual(current.memory);
    old.resolve(value);
    await old.promise;
    await Promise.resolve();
    expect(store.status()?.memory).toEqual(current.memory);
  });

  it('does not let an old room mutation clear the new room mutation busy state', async () => {
    const old = deferred<RoomAssistantStatus>();
    const next = deferred<RoomAssistantStatus>();
    memory.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
    const store = TestBed.inject(RoomAssistantStore);
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()).toBeDefined());
    const first = store.memory({ key: 'old', text: 'old room' });
    await vi.waitFor(() => expect(memory).toHaveBeenCalledTimes(1));
    const previous = room();
    if (!previous) throw new Error('Missing fixture room.');
    room.set({ ...previous, id: 'room-b', hostInstanceId: 'host-b' });
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()).toBeDefined());
    const second = store.memory({ key: 'new', text: 'new room' });
    await vi.waitFor(() => expect(memory).toHaveBeenCalledTimes(2));
    old.resolve(value);
    expect(await first).toBe(false);
    expect(store.busy()).toBe(true);
    next.resolve(value);
    expect(await second).toBe(true);
    expect(store.busy()).toBe(false);
    expect(memory).toHaveBeenLastCalledWith({ roomId: 'room-b' }, { key: 'new', text: 'new room' });
  });
});
