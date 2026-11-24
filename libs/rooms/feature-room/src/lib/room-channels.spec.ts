import { inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ApiClient,
  EntryApiClient,
  provideMockApi,
  roomChannelStatus,
  roomChannelSettings,
  roomChannelBegin,
  roomChannelUnlink,
  roomChannelDisconnect,
} from '@pi-kit/api';
import type { Room, RoomChannel, RoomChannelStatus } from '@pi-kit/protocol';
import { OpenRoomStore, RoomChannelsStore } from '@pi-kit/rooms/data';
import { RoomChannels } from './room-channels';

const initial = (channel: RoomChannel): RoomChannelStatus => ({
  channel,
  connection: 'disconnected',
  configured: false,
  qr: null,
  error: null,
  binding: null,
  candidate: null,
  expiresAt: null,
  queued: 0,
  needsReview: 0,
  review: [],
});

describe('room channel wizard', () => {
  const room = signal<Room | undefined>(undefined);
  const status = vi.fn();
  const settings = vi.fn();
  const begin = vi.fn();
  const unlink = vi.fn();
  const disconnect = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    begin.mockResolvedValue({ code: 'a'.repeat(24), expiresAt: Date.now() + 600000 });
    room.set({
      id: 'room-a',
      hostInstanceId: 'host-a',
      title: 'Personal',
      repository: '',
      baseCommit: '',
      createdAt: 1,
      waiting: 0,
    });
    status.mockImplementation((channel: RoomChannel) => Promise.resolve(initial(channel)));
    TestBed.configureTestingModule({
      providers: [
        { provide: OpenRoomStore, useValue: { room } },
        ...provideMockApi([
          [roomChannelStatus, status, (options) => [options.path?.['channel']]],
          [roomChannelSettings, settings, (options) => [options.path?.['channel'], options.body]],
          [roomChannelBegin, begin, (options) => [options.path?.['channel']]],
          [roomChannelUnlink, unlink, (options) => [options.path?.['channel'], options.path?.['roomId']]],
          [roomChannelDisconnect, disconnect, (options) => [options.path?.['channel'], options.path?.['roomId']]],
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
  afterEach(() => vi.restoreAllMocks());
  function setup() {
    const fixture = TestBed.createComponent(RoomChannels);
    const root = fixture.nativeElement as HTMLElement;
    const click = (id: string) => {
      const button = root.querySelector<HTMLButtonElement>(`[data-testid=${id}]`);
      if (!button) throw new Error(`Missing ${id}`);
      button.click();
    };
    return { fixture, root, click };
  }

  it('selects one provider, supports cancellation, and never expands unrelated provider forms', async () => {
    const { fixture, root, click } = setup();
    await fixture.whenStable();
    expect(root.querySelector('pk-room-phone')).toBeNull();
    click('room-channel-add');
    await fixture.whenStable();
    expect(root.querySelectorAll('[data-testid^=room-channel-select-]')).toHaveLength(4);
    expect(root.querySelector('input')).toBeNull();
    expect(root.querySelector('pk-room-dialog')).not.toBeNull();
    click('room-dialog-close');
    await fixture.whenStable();
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    expect(root.querySelector('[data-testid=room-channel-picker]')).toBeNull();
    expect(settings).not.toHaveBeenCalled();
    click('room-channel-add');
    await fixture.whenStable();
    click('room-channel-select-telegram');
    await fixture.whenStable();
    expect(root.querySelectorAll('pk-room-phone')).toHaveLength(1);
    expect(root.querySelector('[data-testid=room-phone]')?.getAttribute('data-channel')).toBe('telegram');
    expect(root.querySelector('[data-testid=room-telegram-bot-token]')).not.toBeNull();
    expect(root.querySelector('[data-testid=room-slack-app-token]')).toBeNull();
    expect(root.querySelector('[data-testid=room-phone]')?.tagName).toBe('DIV');
    expect(
      [...root.querySelectorAll('input, select, textarea')].every((field) => field.closest('pk-room-dialog')),
    ).toBe(true);
    expect(root.querySelector('[data-testid=room-channel-back]')?.closest('footer')).not.toBeNull();
    click('room-channel-back');
    await fixture.whenStable();
    expect(root.querySelector('pk-room-phone')).toBeNull();
    expect(root.querySelector('[data-testid=room-channel-picker]')).not.toBeNull();
    click('room-dialog-close');
    await fixture.whenStable();
    expect(root.querySelector('input, select, textarea')).toBeNull();
  });

  it('keeps configured and connected channels manageable while preserving setup across room navigation and sidebar remount', async () => {
    status.mockImplementation((channel: RoomChannel) =>
      Promise.resolve({
        ...initial(channel),
        ...(channel === 'telegram' ? { configured: true } : {}),
        ...(channel === 'slack'
          ? {
              connection: 'connected',
              binding: { group: 'g', groupName: 'My workspace', sender: 'owner', senderName: 'Owner' },
            }
          : {}),
      }),
    );
    const { fixture, root, click } = setup();
    await fixture.whenStable();
    await vi.waitFor(() => expect(root.querySelector('[data-testid=room-channel-manage-telegram]')).not.toBeNull());
    expect(root.querySelector('[data-testid=room-channel-manage-slack]')?.textContent).toContain('My workspace');
    expect(root.querySelector('[data-testid=room-channel-manage-signal]')).toBeNull();
    click('room-channel-manage-telegram');
    await fixture.whenStable();
    const original = room()!;
    room.set({ ...original, id: 'room-b' });
    await fixture.whenStable();
    expect(root.querySelector('pk-room-phone')).toBeNull();
    room.set(original);
    await fixture.whenStable();
    expect(root.querySelector('pk-room-phone')).toBeNull();
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid=room-channel-manage-telegram]')?.textContent).toContain('Continue setup'),
    );
    fixture.destroy();
    const reopened = TestBed.createComponent(RoomChannels);
    await reopened.whenStable();
    expect(reopened.nativeElement.querySelector('pk-room-dialog')).toBeNull();
    expect(reopened.nativeElement.querySelector('pk-room-phone')).toBeNull();
    expect(TestBed.inject(RoomChannelsStore).screen()).toBe('telegram');
    await vi.waitFor(() =>
      expect(reopened.nativeElement.querySelector('[data-testid=room-channel-manage-telegram]')).not.toBeNull(),
    );
    reopened.nativeElement.querySelector('[data-testid=room-channel-manage-telegram]').click();
    await reopened.whenStable();
    expect(reopened.nativeElement.querySelector('[data-testid=room-phone]')?.getAttribute('data-channel')).toBe(
      'telegram',
    );
  });

  it('keeps a failed setup open with actionable errors, and exposes status failures from the overview', async () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    settings.mockRejectedValue(new Error('Too many attempts. Wait 19 seconds.'));
    const { fixture, root, click } = setup();
    await fixture.whenStable();
    click('room-channel-add');
    await fixture.whenStable();
    click('room-channel-select-telegram');
    await fixture.whenStable();
    const token = root.querySelector<HTMLInputElement>('[data-testid=room-telegram-bot-token]')!;
    token.value = '123456:example-draft';
    token.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    token.closest('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('Wait 19 seconds');
    expect(token.value).toBe('123456:example-draft');
    for (const [poll, milliseconds] of interval.mock.calls) {
      if (milliseconds === 2500 && typeof poll === 'function') poll();
    }
    await fixture.whenStable();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('Wait 19 seconds');
    click('room-dialog-close');
    await fixture.whenStable();
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    expect(root.querySelector('[data-testid=room-channel-manage-telegram]')?.textContent).toContain('Wait 19 seconds');
  });

  it('shows local decorative provider marks and branded rows and tiles while retaining text labels', async () => {
    status.mockImplementation((channel: RoomChannel) => Promise.resolve({ ...initial(channel), configured: true }));
    const { fixture, root, click } = setup();
    await fixture.whenStable();
    await vi.waitFor(() => expect(root.querySelectorAll('[data-testid^=room-channel-manage-]')).toHaveLength(4));
    const providers: RoomChannel[] = ['telegram', 'whatsapp', 'signal', 'slack'];
    for (const channel of providers) {
      const row = root.querySelector(`[data-testid=room-channel-manage-${channel}]`);
      const logo = row?.querySelector(`[data-provider-logo=${channel}]`);
      expect(row?.getAttribute('data-provider')).toBe(channel);
      expect(row?.querySelector('strong')?.textContent?.trim()).toBeTruthy();
      expect(logo?.getAttribute('aria-hidden')).toBe('true');
      expect(logo?.tagName).toBe('IMG');
      expect(logo?.getAttribute('alt')).toBe('');
      expect(logo?.getAttribute('src')).toBe(`brands/rooms/${channel}.svg`);
    }
    expect(root.querySelector('.status')).toBeNull();
    expect(root.querySelectorAll('.channel-meta')).toHaveLength(8);
    click('room-channel-add');
    await fixture.whenStable();
    for (const channel of providers) {
      const tile = root.querySelector(`[data-testid=room-channel-select-${channel}]`);
      expect(tile?.getAttribute('data-provider')).toBe(channel);
      expect(tile?.querySelector(`[data-provider-logo=${channel}][aria-hidden=true]`)).not.toBeNull();
      expect(tile?.querySelector('strong')?.textContent?.trim()).toBeTruthy();
    }
    expect(root.querySelector('img[src^=http], svg[data-provider-logo]')).toBeNull();
  });

  it('offers room removal and host-wide disconnect in the fixed footer, confirms effects, and preserves their distinct API scope', async () => {
    const bound: RoomChannelStatus = {
      ...initial('slack'),
      connection: 'connected',
      configured: true,
      binding: { group: 'g', groupName: 'Personal group', sender: 'owner', senderName: 'Owner' },
    };
    status.mockImplementation((channel: RoomChannel) =>
      Promise.resolve(channel === 'slack' ? bound : initial(channel)),
    );
    unlink.mockResolvedValue({ ...bound, binding: null });
    disconnect.mockResolvedValue({ ...bound, binding: null, connection: 'disconnected' });
    const { fixture, root, click } = setup();
    await fixture.whenStable();
    await vi.waitFor(() => expect(root.querySelector('[data-testid=room-channel-manage-slack]')).not.toBeNull());
    click('room-channel-manage-slack');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-channel-remove]')?.closest('footer')).not.toBeNull();
    expect(root.querySelector('[data-testid=room-channel-disconnect]')?.closest('footer')).not.toBeNull();
    expect(
      [...root.querySelectorAll('pk-room-phone button')].some((button) =>
        /Unlink|Disconnect/.test(button.textContent ?? ''),
      ),
    ).toBe(false);
    click('room-channel-remove');
    await fixture.whenStable();
    expect(unlink).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid=room-channel-action-hint]')?.textContent).toContain(
      'Other rooms stay connected',
    );
    click('room-channel-action-cancel');
    await fixture.whenStable();
    expect(unlink).not.toHaveBeenCalled();
    click('room-channel-remove');
    await fixture.whenStable();
    click('room-channel-action-confirm');
    await fixture.whenStable();
    expect(unlink).toHaveBeenCalledExactlyOnceWith('slack', 'room-a');
    expect(disconnect).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid=room-channel-remove]')).toBeNull();
    click('room-channel-disconnect');
    await fixture.whenStable();
    expect(disconnect).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid=room-channel-action-hint]')?.textContent).toContain('every room');
    expect(root.querySelector('[data-testid=room-channel-action-hint]')?.textContent).toContain('saved credentials');
    click('room-channel-action-confirm');
    await fixture.whenStable();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith('slack', 'room-a');
    expect(root.querySelector('[data-testid=room-channel-action-confirm]')).toBeNull();
    expect(root.querySelector('[data-testid=room-channel-disconnect]')).toBeNull();
  });

  it('can remove pending pairing without disconnecting the host account', async () => {
    const connected: RoomChannelStatus = { ...initial('telegram'), connection: 'connected', configured: true };
    status.mockImplementation((channel: RoomChannel) =>
      Promise.resolve(channel === 'telegram' ? connected : initial(channel)),
    );
    unlink.mockResolvedValue(connected);
    const { fixture, root, click } = setup();
    await fixture.whenStable();
    await vi.waitFor(() => expect(root.querySelector('[data-testid=room-channel-manage-telegram]')).not.toBeNull());
    click('room-channel-manage-telegram');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-channel-remove]')).toBeNull();
    await TestBed.inject(RoomChannelsStore).selected()?.store.act('begin');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-phone-command]')).not.toBeNull();
    click('room-channel-remove');
    await fixture.whenStable();
    click('room-channel-action-confirm');
    await fixture.whenStable();
    expect(unlink).toHaveBeenCalledExactlyOnceWith('telegram', 'room-a');
    expect(disconnect).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid=room-phone-command]')).toBeNull();
    expect(root.querySelector('[data-testid=room-channel-disconnect]')).not.toBeNull();
  });

  it('keeps failed destructive operations reviewable and clears confirmation when changing host', async () => {
    status.mockImplementation((channel: RoomChannel) =>
      Promise.resolve({ ...initial(channel), connection: 'connected' }),
    );
    disconnect.mockRejectedValue(new Error('Host is offline; connection was not changed.'));
    const { fixture, root, click } = setup();
    await fixture.whenStable();
    await vi.waitFor(() => expect(root.querySelector('[data-testid=room-channel-manage-telegram]')).not.toBeNull());
    click('room-channel-manage-telegram');
    await fixture.whenStable();
    click('room-channel-disconnect');
    await fixture.whenStable();
    click('room-channel-action-confirm');
    await fixture.whenStable();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('Host is offline');
    expect(root.querySelector('[data-testid=room-channel-action-confirm]')).not.toBeNull();
    const original = room()!;
    room.set({ ...original, hostInstanceId: 'host-b' });
    await fixture.whenStable();
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    room.set(original);
    await fixture.whenStable();
    await vi.waitFor(() => expect(root.querySelector('[data-testid=room-channel-manage-telegram]')).not.toBeNull());
    click('room-channel-manage-telegram');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-channel-action-confirm]')).toBeNull();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('keeps status polling errors visible in the compact overview without opening a setup form', async () => {
    status.mockRejectedValue(new Error('The room host is unavailable.'));
    const { fixture, root } = setup();
    await fixture.whenStable();
    await vi.waitFor(() => expect(root.querySelector('[role=alert]')?.textContent).toContain('host is unavailable'));
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    expect(root.querySelector('input, select, textarea, section details')).toBeNull();
    expect(root.querySelectorAll('[data-testid^=room-channel-manage-]')).toHaveLength(4);
  });

  it('preserves pairing when closing setup but closes and clears secret drafts on a same-id host change', async () => {
    status.mockImplementation((channel: RoomChannel) =>
      Promise.resolve({
        ...initial(channel),
        ...(channel === 'telegram'
          ? {
              connection: 'connected',
              configured: true,
              identity: { id: '123456', username: 'RoomBot', name: 'Room bot' },
            }
          : {}),
      }),
    );
    const { fixture, root, click } = setup();
    await fixture.whenStable();
    await vi.waitFor(() => expect(root.querySelector('[data-testid=room-channel-manage-telegram]')).not.toBeNull());
    click('room-channel-manage-telegram');
    await fixture.whenStable();
    await TestBed.inject(RoomChannelsStore).selected()?.store.act('begin');
    await fixture.whenStable();
    const command = root.querySelector('[data-testid=room-phone-command]')?.textContent;
    expect(command).toContain('/room_link@RoomBot ' + 'a'.repeat(24));
    click('room-dialog-close');
    await fixture.whenStable();
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    expect(root.querySelector('[data-testid=room-channel-manage-telegram]')?.textContent).toContain('Continue setup');
    click('room-channel-manage-telegram');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-phone-command]')?.textContent).toBe(command);
    const token = root.querySelector<HTMLInputElement>('[data-testid=room-telegram-bot-token]');
    if (!token) throw new Error('Missing token field.');
    token.value = 'unsaved-private-token';
    token.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    const original = room()!;
    room.set({ ...original, hostInstanceId: 'host-b' });
    await fixture.whenStable();
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    room.set(original);
    await fixture.whenStable();
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    click('room-channel-manage-telegram');
    await fixture.whenStable();
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLInputElement>('[data-testid=room-telegram-bot-token]')?.value).toBe(''),
    );
    expect(root.querySelector('[data-testid=room-phone-command]')?.textContent).toBe(command);
    expect(settings).not.toHaveBeenCalled();
  });

  it('keeps Close available during a save and does not reopen setup when the pending save completes', async () => {
    let finish: ((value: RoomChannelStatus) => void) | undefined;
    settings.mockImplementation(
      () =>
        new Promise<RoomChannelStatus>((resolve) => {
          finish = resolve;
        }),
    );
    const { fixture, root, click } = setup();
    await fixture.whenStable();
    click('room-channel-add');
    await fixture.whenStable();
    click('room-channel-select-telegram');
    await fixture.whenStable();
    const token = root.querySelector<HTMLInputElement>('[data-testid=room-telegram-bot-token]');
    if (!token) throw new Error('Missing token field.');
    token.value = '123456:pending-private-token';
    token.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    token.closest('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    expect(root.querySelector('[role=dialog]')?.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector<HTMLButtonElement>('[data-testid=room-dialog-close]')?.disabled).toBe(false);
    click('room-dialog-close');
    await fixture.whenStable();
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    finish?.({ ...initial('telegram'), configured: true });
    await fixture.whenStable();
    expect(root.querySelector('pk-room-dialog')).toBeNull();
    expect(root.querySelector('input, select, textarea')).toBeNull();
    expect(root.querySelector('[data-testid=room-channel-manage-telegram]')).not.toBeNull();
  });
});
