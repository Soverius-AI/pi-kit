import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideMockApi, roomsCreate, roomsDirectory } from '@pi-kit/api';
import { ViewPrefs } from '@pi-kit/data-access';
import type { Room, RoomDirectoryEntry } from '@pi-kit/protocol';
import { RoomsStore } from './rooms.store';

const hostInstanceId = '0b6c5bb4-3b1e-4a36-9ad2-7f6f8a1c2d01';
const room = (id: string, title: string): Room => ({
  id,
  title,
  repository: 'github.com/acme/pi-kit',
  hostInstanceId,
  baseCommit: 'a'.repeat(40),
  createdAt: 1,
  waiting: 0,
});
const entry = (value: Room, hostReachable = true): RoomDirectoryEntry => ({
  room: value,
  hostName: 'Server',
  local: true,
  hostReachable,
  lastSeenAt: 1,
});

describe('RoomsStore', () => {
  const roomsPreview = signal(false);
  const hosted = vi.fn(async (): Promise<RoomDirectoryEntry[]> => []);
  const create = vi.fn(async (): Promise<Room> => room('5f0c6a43-8f1e-4a7b-9d4e-2c1b0a9f8e7d', 'Watcher fix on Linux'));

  beforeEach(() => {
    roomsPreview.set(false);
    hosted.mockReset().mockResolvedValue([entry(room('a6f1d2c3-4b5e-4f6a-8b7c-9d0e1f2a3b4c', 'Event batching'))]);
    create.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ViewPrefs, useValue: { roomsPreview } },
        ...provideMockApi([
          [roomsDirectory, hosted, () => []],
          [roomsCreate, create, (options) => [options.body]],
        ]),
      ],
    });
  });

  it('asks for nothing while Rooms (preview) is off', async () => {
    const store = TestBed.inject(RoomsStore);
    TestBed.tick();
    await Promise.resolve();
    expect(hosted).not.toHaveBeenCalled();
    expect(store.hasRooms()).toBe(false);
  });

  it('loads the rooms when the setting turns on and forgets them when it turns off', async () => {
    const store = TestBed.inject(RoomsStore);
    roomsPreview.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.rooms().map((value) => value.title)).toEqual(['Event batching']));
    expect(store.hasRooms()).toBe(true);
    roomsPreview.set(false);
    TestBed.tick();
    expect(store.rooms()).toEqual([]);
    expect(store.hasRooms()).toBe(false);
  });

  it('puts a created room first', async () => {
    const store = TestBed.inject(RoomsStore);
    roomsPreview.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.rooms()).toHaveLength(1));
    await store.create({ threadId: 't1', title: 'Watcher fix on Linux', summary: '' });
    expect(create).toHaveBeenCalledWith({ threadId: 't1', title: 'Watcher fix on Linux', summary: '' });
    expect(store.rooms().map((value) => value.title)).toEqual(['Watcher fix on Linux', 'Event batching']);
  });

  it('counts what waits in rooms whose host answers', async () => {
    hosted.mockResolvedValue([
      entry({ ...room('a6f1d2c3-4b5e-4f6a-8b7c-9d0e1f2a3b4c', 'Event batching'), waiting: 2 }),
      entry({ ...room('5f0c6a43-8f1e-4a7b-9d4e-2c1b0a9f8e7d', 'Offline'), waiting: 3 }, false),
    ]);
    const store = TestBed.inject(RoomsStore);
    roomsPreview.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.waiting()).toBe(2));
    expect(store.entry('5f0c6a43-8f1e-4a7b-9d4e-2c1b0a9f8e7d')?.hostReachable).toBe(false);
  });

  it('marks the list unavailable when the backend does not answer', async () => {
    hosted.mockRejectedValue(new Error('offline'));
    const store = TestBed.inject(RoomsStore);
    roomsPreview.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.error()).toBe('unavailable'));
    expect(store.loading()).toBe(false);
  });
});
