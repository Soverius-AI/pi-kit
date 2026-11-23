import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { RoomPhoneStore } from '@pi-kit/rooms/data';
import type { RoomChannelStatus } from '@pi-kit/protocol';
import { RoomPhone } from './room-phone';

describe('room messaging setup', () => {
  const initial: RoomChannelStatus = {
    channel: 'whatsapp',
    connection: 'disconnected',
    qr: null,
    error: null,
    binding: null,
    candidate: null,
    expiresAt: null,
    queued: 0,
    needsReview: 0,
    review: [],
  };
  function setup() {
    const store = {
      channel: signal('whatsapp'),
      context: signal({ id: 'room-a', host: 'host-a' }),
      visible: signal(false),
      busy: signal(false),
      error: signal(undefined),
      status: signal<RoomChannelStatus>(initial),
      command: signal(undefined),
      commandExpired: signal(false),
      settings: vi.fn().mockResolvedValue(true),
      act: vi.fn(),
      saveUrl: vi.fn(),
    };
    TestBed.overrideComponent(RoomPhone, { set: { providers: [{ provide: RoomPhoneStore, useValue: store }] } });
    const fixture = TestBed.createComponent(RoomPhone);
    return { fixture, store, root: fixture.nativeElement as HTMLElement };
  }

  it('shows connection, conversation and round-trip verification as distinct steps', async () => {
    const { fixture, store, root } = setup();
    await fixture.whenStable();
    const current = () => root.querySelector('[aria-current=step]')?.textContent;
    expect(current()).toContain('Connect assistant identity');
    expect(root.textContent).toContain('dedicated assistant account');
    store.status.set({ ...initial, connection: 'connected' });
    await fixture.whenStable();
    expect(current()).toContain('Link this room');
    store.status.set({
      ...initial,
      connection: 'connected',
      binding: { group: 'g', groupName: 'Personal', sender: 'owner', senderName: 'Owner' },
    });
    await fixture.whenStable();
    expect(current()).toContain('Verify a reply');
    store.status.update((value) => ({ ...value, verifiedAt: Date.now() }));
    await fixture.whenStable();
    expect(current()).toBeUndefined();
  });

  it('clears saved Slack credential drafts and clears unfinished drafts when switching channels', async () => {
    const { fixture, store, root } = setup();
    fixture.componentRef.setInput('channel', 'slack');
    store.status.set({ ...initial, channel: 'slack', configured: false });
    await fixture.whenStable();
    const app = root.querySelector<HTMLInputElement>('[data-testid=room-slack-app-token]');
    const bot = root.querySelector<HTMLInputElement>('[data-testid=room-slack-bot-token]');
    if (!app || !bot) throw new Error('Missing Slack credential inputs.');
    for (const [input, value] of [
      [app, 'xapp-draft'],
      [bot, 'xoxb-draft'],
    ] as const) {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    await fixture.whenStable();
    app.closest('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    expect(store.settings).toHaveBeenCalledExactlyOnceWith({ appToken: 'xapp-draft', botToken: 'xoxb-draft' });
    expect(app.value).toBe('');
    expect(bot.value).toBe('');
    app.value = 'other-host-secret';
    app.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    store.context.set({ id: 'room-b', host: 'host-b' });
    await fixture.whenStable();
    expect(app.value).toBe('');
    app.value = 'unsaved-secret';
    app.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    fixture.componentRef.setInput('channel', 'signal');
    await fixture.whenStable();
    fixture.componentRef.setInput('channel', 'slack');
    await fixture.whenStable();
    expect(root.querySelector<HTMLInputElement>('[data-testid=room-slack-app-token]')?.value).toBe('');
  });

  it('allows the first Signal connection to probe the local CLI before availability is known', async () => {
    const { fixture, store, root } = setup();
    fixture.componentRef.setInput('channel', 'signal');
    store.status.set({
      ...initial,
      channel: 'signal',
      dependency: { available: false, path: null, version: null, error: null },
    });
    await fixture.whenStable();
    const connect = [...root.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Link Signal assistant'),
    );
    expect(connect?.disabled).toBe(false);
    connect?.click();
    expect(store.act).toHaveBeenCalledWith('connect');
  });
  it('preserves replacement credentials entered while a previous save is pending', async () => {
    const { fixture, store, root } = setup();
    fixture.componentRef.setInput('channel', 'slack');
    store.status.set({ ...initial, channel: 'slack', configured: false });
    let finish: ((saved: boolean) => void) | undefined;
    store.settings.mockImplementationOnce(
      () =>
        new Promise<boolean>((done) => {
          finish = done;
        }),
    );
    await fixture.whenStable();
    const app = root.querySelector<HTMLInputElement>('[data-testid=room-slack-app-token]');
    const bot = root.querySelector<HTMLInputElement>('[data-testid=room-slack-bot-token]');
    if (!app || !bot) throw new Error('Missing Slack credential inputs.');
    app.value = 'submitted-app';
    app.dispatchEvent(new Event('input'));
    bot.value = 'submitted-bot';
    bot.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    app.closest('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await fixture.whenStable();
    expect(finish).toBeDefined();
    app.value = 'replacement-app';
    app.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    finish?.(true);
    await fixture.whenStable();
    expect(app.value).toBe('replacement-app');
    expect(bot.value).toBe('submitted-bot');
  });
});
