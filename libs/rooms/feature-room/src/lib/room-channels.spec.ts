import { inject, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ApiClient, EntryApiClient, provideMockApi, roomChannelStatus, roomChannelSettings } from '@pi-kit/api';
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
    status.mockImplementation((channel: RoomChannel) => Promise.resolve(initial(channel)));
    TestBed.configureTestingModule({
      providers: [
        { provide: OpenRoomStore, useValue: { room } },
        ...provideMockApi([
          [roomChannelStatus, status, (options) => [options.path?.['channel']]],
          [roomChannelSettings, settings, (options) => [options.path?.['channel'], options.body]],
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
    click('room-channel-cancel');
    await fixture.whenStable();
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
    click('room-channel-back');
    await fixture.whenStable();
    expect(root.querySelector('pk-room-phone')).toBeNull();
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
    expect(root.querySelector('[data-testid=room-phone]')?.getAttribute('data-channel')).toBe('telegram');
    fixture.destroy();
    const reopened = TestBed.createComponent(RoomChannels);
    await reopened.whenStable();
    expect(reopened.nativeElement.querySelector('[data-testid=room-phone]')?.getAttribute('data-channel')).toBe(
      'telegram',
    );
    expect(TestBed.inject(RoomChannelsStore).screen()).toBe('telegram');
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
    click('room-channel-back');
    await fixture.whenStable();
    expect(root.querySelector('[data-testid=room-channel-manage-telegram]')?.textContent).toContain('Wait 19 seconds');
  });
});
