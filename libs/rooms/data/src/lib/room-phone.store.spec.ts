import { inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  EntryApiClient,
  provideMockApi,
  roomChannelStatus,
  roomChannelConfirm,
  roomChannelBegin,
  roomChannelConfig,
  roomChannelTest,
  roomChannelSettings,
} from '@pi-kit/api';
import type { Room, RoomChannelStatus } from '@pi-kit/protocol';
import { OpenRoomStore } from './open-room.store';
import { RoomPhoneStore } from './room-phone.store';

describe('room phone setup', () => {
  const room = signal<Room | undefined>(undefined);
  const status = vi.fn<() => Promise<RoomChannelStatus>>();
  const confirm = vi.fn();
  const forOwner = vi.fn();
  const config = vi.fn();
  const test = vi.fn();
  const begin = vi.fn();
  const settings = vi.fn();
  const value: RoomChannelStatus = {
    channel: 'whatsapp',
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
    settings.mockResolvedValue(value);
    begin.mockImplementation(async () => ({ code: 'link-code', expiresAt: Date.now() + 600_000 }));
    TestBed.configureTestingModule({
      providers: [
        RoomPhoneStore,
        { provide: OpenRoomStore, useValue: { room } },
        ...provideMockApi([
          [roomChannelStatus, status, () => []],
          [roomChannelConfirm, confirm, (options) => [options.path, options.body]],
          [roomChannelBegin, begin, () => []],
          [roomChannelConfig, config, (options) => [options.path, options.body]],
          [roomChannelTest, test, (options) => [options.path]],
          [roomChannelSettings, settings, (options) => [options.path, options.body]],
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

  it('waits for a slow status request instead of repeatedly invalidating its response', async () => {
    let resolve: ((value: RoomChannelStatus) => void) | undefined;
    status.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const interval = vi.spyOn(globalThis, 'setInterval');
    const store = TestBed.inject(RoomPhoneStore);
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    const poll = interval.mock.calls.find((call) => call[1] === 2500)?.[0];
    if (typeof poll !== 'function') throw new Error('Missing status poll.');
    poll();
    poll();
    poll();
    expect(status).toHaveBeenCalledTimes(1);
    resolve?.(value);
    await vi.waitFor(() => expect(store.status()).toEqual(value));
    poll();
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });

  it('retains a pending link command when only room metadata changes', async () => {
    const store = TestBed.inject(RoomPhoneStore);
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()).toBeDefined());
    await store.act('begin');
    const current = room();
    if (!current) throw new Error('Missing room.');
    room.set({ ...current, title: 'Renamed room' });
    TestBed.tick();
    expect(store.command()).toBe('/room-link link-code');
  });

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
    expect(confirm).toHaveBeenCalledWith(
      { roomId: 'room-a', channel: 'whatsapp' },
      { group: 'group-a', sender: 'owner@lid' },
    );
  });

  it('discards a stale QR/status response when the owner switches rooms', async () => {
    let resolve: ((value: RoomChannelStatus) => void) | undefined;
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
  it('blocks an old credential form from targeting a new host before effects clear its draft', async () => {
    let resolve: ((value: RoomChannelStatus) => void) | undefined;
    status.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const store = TestBed.inject(RoomPhoneStore);
    store.channel.set('slack');
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    const previous = room();
    if (!previous) throw new Error('Missing room.');
    room.set({ ...previous, id: 'room-b', hostInstanceId: 'host-b' });
    expect(await store.settings({ appToken: 'old-host-app', botToken: 'old-host-bot' })).toBe(false);
    expect(settings).not.toHaveBeenCalled();
    resolve?.({ ...value, channel: 'slack', qr: 'old-host-qr' });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.status()?.qr).not.toBe('old-host-qr');
    TestBed.tick();
    await vi.waitFor(() => expect(forOwner).toHaveBeenLastCalledWith('host-b'));
  });
  it('fences pending responses and clears link commands when changing messaging channel', async () => {
    const store = TestBed.inject(RoomPhoneStore);
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()).toBeDefined());
    await store.act('begin');
    expect(store.command()).toBe('/room-link link-code');
    let resolve: ((value: RoomChannelStatus) => void) | undefined;
    config.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const saving = store.saveUrl('https://old.example.test/');
    await vi.waitFor(() => expect(resolve).toBeDefined());
    status.mockResolvedValue({ ...value, channel: 'slack' });
    store.channel.set('slack');
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()?.channel).toBe('slack'));
    expect(store.command()).toBeUndefined();
    resolve?.({ ...value, appUrl: 'https://old.example.test/' });
    await saving;
    expect(store.status()?.channel).toBe('slack');
    expect(store.status()?.appUrl).toBeUndefined();
    await store.act('begin');
    expect(store.command()).toBe('!room-link link-code');
    await store.settings({ appToken: 'draft-app-token', botToken: 'draft-bot-token' });
    expect(settings).toHaveBeenCalledExactlyOnceWith(
      { roomId: 'room-a', channel: 'slack' },
      { values: { appToken: 'draft-app-token', botToken: 'draft-bot-token' } },
    );
  });
  it('saves private room links and requests an explicit phone round trip on the room host', async () => {
    const store = TestBed.inject(RoomPhoneStore);
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()).toBeDefined());
    await store.saveUrl('https://phone.example.test/');
    expect(config).toHaveBeenCalledExactlyOnceWith(
      { roomId: 'room-a', channel: 'whatsapp' },
      { appUrl: 'https://phone.example.test/' },
    );
    expect(store.status()?.appUrl).toBe('https://phone.example.test/');
    await store.act('test');
    expect(test).toHaveBeenCalledExactlyOnceWith({ roomId: 'room-a', channel: 'whatsapp' });
    expect(forOwner).toHaveBeenLastCalledWith('host-a');
  });
  it('builds a Telegram group-selection link for the verified bot and removes it when the challenge expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const telegram: RoomChannelStatus = {
      ...value,
      channel: 'telegram',
      identity: { id: '123', username: 'MyRoomBot', name: 'Room assistant' },
    };
    status.mockResolvedValue(telegram);
    begin.mockResolvedValue({ code: 'abcdef0123456789', expiresAt: 2000 });
    const store = TestBed.inject(RoomPhoneStore);
    store.channel.set('telegram');
    store.visible.set(true);
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()).toEqual(telegram));
    await store.act('begin');
    expect(store.command()).toBe('/room_link@MyRoomBot abcdef0123456789');
    expect(store.groupLink()).toBe('https://t.me/MyRoomBot?startgroup=abcdef0123456789');
    now.mockReturnValue(2000);
    const poll = interval.mock.calls.find((call) => call[1] === 2500)?.[0];
    if (typeof poll !== 'function') throw new Error('Missing status poll.');
    poll();
    expect(store.command()).toBeUndefined();
    expect(store.groupLink()).toBeUndefined();
    expect(store.commandExpired()).toBe(true);
  });
});
