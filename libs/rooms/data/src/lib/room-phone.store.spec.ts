import { inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  EntryApiClient,
  provideMockApi,
  roomPhoneStatus,
  roomPhoneConfirm,
  roomPhoneBegin,
  roomPhoneConfig,
  roomPhoneTest,
} from '@pi-kit/api';
import type { Room, RoomPhoneStatus } from '@pi-kit/protocol';
import { OpenRoomStore } from './open-room.store';
import { RoomPhoneStore } from './room-phone.store';

describe('room phone setup', () => {
  const room = signal<Room | undefined>(undefined);
  const status = vi.fn<() => Promise<RoomPhoneStatus>>();
  const confirm = vi.fn();
  const forOwner = vi.fn();
  const config = vi.fn();
  const test = vi.fn();
  const begin = vi.fn();
  const value: RoomPhoneStatus = {
    connection: 'connected',
    qr: null,
    error: null,
    binding: null,
    candidate: null,
    expiresAt: null,
    queued: 0,
    needsReview: 0,
    review: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    room.set({
      id: 'room-a',
      hostInstanceId: 'host-a',
      title: 'Personal',
      repository: 'repo',
      baseCommit: 'a'.repeat(40),
      createdAt: 1,
      waiting: 0,
    });
    status.mockResolvedValue(value);
    confirm.mockResolvedValue(value);
    config.mockResolvedValue({ ...value, appUrl: 'https://phone.example.test/' });
    test.mockResolvedValue(value);
    begin.mockImplementation(async () => ({ code: 'link-code', expiresAt: Date.now() + 600_000 }));
    TestBed.configureTestingModule({
      providers: [
        RoomPhoneStore,
        { provide: OpenRoomStore, useValue: { room } },
        ...provideMockApi([
          [roomPhoneStatus, status, () => []],
          [roomPhoneConfirm, confirm, (options) => [options.path, options.body]],
          [roomPhoneBegin, begin, () => []],
          [roomPhoneConfig, config, (options) => [options.path, options.body]],
          [roomPhoneTest, test, (options) => [options.path]],
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

  afterEach(() => vi.restoreAllMocks());

  it('removes an expired command and tells the owner to request a new code', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const interval = vi.spyOn(globalThis, 'setInterval');
    begin.mockResolvedValueOnce({ code: 'expires', expiresAt: 2000 });
    const store = TestBed.inject(RoomPhoneStore);
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()).toBeDefined());
    await store.act('begin');
    expect(store.command()).toBe('/room-link expires');
    now.mockReturnValue(2000);
    const poll = interval.mock.calls.find((call) => call[1] === 2500)?.[0];
    if (typeof poll !== 'function') throw new Error('Missing phone status poll.');
    poll();
    expect(store.command()).toBeUndefined();
    expect(store.commandExpired()).toBe(true);
  });

  it('fetches setup only when opened, from the room host, and requires explicit confirmation', async () => {
    const candidate = { group: 'group-a', groupName: 'Personal', sender: 'owner@lid', senderName: 'Owner' };
    status.mockResolvedValue({ ...value, candidate });
    const store = TestBed.inject(RoomPhoneStore);
    TestBed.tick();
    expect(status).not.toHaveBeenCalled();
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()?.candidate).toEqual(candidate));
    expect(forOwner).toHaveBeenCalledWith('host-a');
    expect(confirm).not.toHaveBeenCalled();
    await store.act('confirm');
    expect(confirm).toHaveBeenCalledWith({ roomId: 'room-a' }, { group: 'group-a', sender: 'owner@lid' });
  });

  it('discards a stale QR/status response when the owner switches rooms', async () => {
    let resolve: ((value: RoomPhoneStatus) => void) | undefined;
    status.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const store = TestBed.inject(RoomPhoneStore);
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    const current = room();
    if (!current) throw new Error('The fixture room is missing.');
    room.set({ ...current, id: 'room-b', hostInstanceId: 'host-b' });
    TestBed.tick();
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    resolve?.({ ...value, qr: 'old-account-qr' });
    await vi.waitFor(() => expect(store.status()).toEqual(value));
    expect(forOwner).toHaveBeenLastCalledWith('host-b');
  });

  it('clears the link command when leaving a room', async () => {
    const store = TestBed.inject(RoomPhoneStore);
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()).toBeDefined());
    await store.act('begin');
    expect(store.command()).toBe('/room-link link-code');
    room.set(undefined);
    TestBed.tick();
    expect(store.command()).toBeUndefined();
    expect(store.status()).toBeUndefined();
  });
  it('saves private room links and requests an explicit phone round trip on the room host', async () => {
    const store = TestBed.inject(RoomPhoneStore);
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()).toBeDefined());
    await store.saveUrl('https://phone.example.test/');
    expect(config).toHaveBeenCalledExactlyOnceWith({ roomId: 'room-a' }, { appUrl: 'https://phone.example.test/' });
    expect(store.status()?.appUrl).toBe('https://phone.example.test/');
    await store.act('test');
    expect(test).toHaveBeenCalledExactlyOnceWith({ roomId: 'room-a' });
    expect(forOwner).toHaveBeenLastCalledWith('host-a');
  });
});
