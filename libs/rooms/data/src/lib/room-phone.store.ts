import { Injectable, computed, signal } from '@angular/core';
import {
  roomChannelBegin,
  roomChannelConfirm,
  roomChannelConnect,
  roomChannelDisconnect,
  roomChannelDismiss,
  roomChannelStatus,
  roomChannelUnlink,
  roomChannelConfig,
  roomChannelTest,
  roomChannelSettings,
  unwrap,
} from '@pi-kit/api';
import type { ReviewRoomPhone, RoomChannelStatus, RoomChannel, RoomPhoneLink } from '@pi-kit/protocol';
import { RoomPanelState, type RoomPanelOptions } from './room-panel-state';

@Injectable()
export class RoomPhoneStore {
  readonly channel = signal<RoomChannel>('whatsapp');
  private readonly pendingLink = signal<RoomPhoneLink | undefined>(undefined);
  readonly command = computed(() => {
    const link = this.pendingLink();
    if (!link) return;
    const username = this.telegramUsername();
    const command =
      this.channel() === 'telegram'
        ? `/room_link${username ? '@' + username : ''}`
        : this.channel() === 'slack'
          ? '!room-link'
          : '/room-link';
    return `${command} ${link.code}`;
  });
  readonly commandExpired = signal(false);
  private readonly panel = new RoomPanelState<RoomChannelStatus>(
    (options) => unwrap(roomChannelStatus(this.options(options))),
    2500,
    {
      reset: () => this.clearCommand(),
      tick: () => this.expireCommand(),
    },
    () => this.channel(),
  );
  readonly visible = this.panel.visible;
  readonly context = this.panel.context;
  readonly status = this.panel.status;
  readonly busy = this.panel.busy;
  readonly error = this.panel.error;
  readonly groupLink = computed(() => {
    const username = this.telegramUsername();
    const link = this.pendingLink();
    if (!link || !username) return;
    return `https://t.me/${username}?startgroup=${encodeURIComponent(link.code)}`;
  });

  async act(
    action: 'connect' | 'disconnect' | 'begin' | 'confirm' | 'unlink' | 'review' | 'test',
    item?: ReviewRoomPhone,
  ): Promise<void> {
    if (action === 'review') {
      if (item)
        await this.panel.mutate(
          (options) => unwrap(roomChannelDismiss({ ...this.options(options), body: item })),
          (status) => this.status.set(status),
        );
      return;
    }
    if (action === 'begin') {
      await this.panel.mutate(
        (options) => unwrap(roomChannelBegin(this.options(options))),
        (link) => {
          this.pendingLink.set(link);
          this.commandExpired.set(false);
          this.expireCommand();
        },
      );
      return;
    }
    const apply = (status: RoomChannelStatus) => {
      this.status.set(status);
      this.clearCommand();
    };
    if (action === 'confirm') {
      const candidate = this.status()?.candidate;
      if (candidate)
        await this.panel.mutate(
          (options) =>
            unwrap(
              roomChannelConfirm({
                ...this.options(options),
                body: { group: candidate.group, sender: candidate.sender },
              }),
            ),
          apply,
        );
      return;
    }
    const operation = {
      connect: roomChannelConnect,
      disconnect: roomChannelDisconnect,
      unlink: roomChannelUnlink,
      test: roomChannelTest,
    }[action];
    await this.panel.mutate((options) => unwrap(operation(this.options(options))), apply);
  }

  async saveUrl(appUrl: string): Promise<void> {
    await this.panel.mutate(
      (options) => unwrap(roomChannelConfig({ ...this.options(options), body: { appUrl } })),
      (status) => this.status.set(status),
    );
  }
  async settings(values: Record<string, string>): Promise<boolean> {
    return this.panel.mutate(
      (options) => unwrap(roomChannelSettings({ ...this.options(options), body: { values } })),
      (status) => this.status.set(status),
    );
  }
  private options(options: RoomPanelOptions) {
    return { ...options, path: { ...options.path, channel: this.channel() } };
  }
  private telegramUsername(): string | undefined {
    const username = this.status()?.identity?.username;
    return this.channel() === 'telegram' && username && /^[A-Za-z0-9_]{1,64}$/.test(username) ? username : undefined;
  }
  private clearCommand(): void {
    this.pendingLink.set(undefined);
    this.commandExpired.set(false);
  }
  private expireCommand(): void {
    const link = this.pendingLink();
    if (link && Date.now() >= link.expiresAt) {
      this.pendingLink.set(undefined);
      this.commandExpired.set(true);
    }
  }
}
