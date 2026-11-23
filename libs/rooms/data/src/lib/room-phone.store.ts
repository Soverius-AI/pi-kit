import { Injectable, signal } from '@angular/core';
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
import type { ReviewRoomPhone, RoomChannelStatus, RoomChannel } from '@pi-kit/protocol';
import { RoomPanelState, type RoomPanelOptions } from './room-panel-state';

@Injectable()
export class RoomPhoneStore {
  readonly channel = signal<RoomChannel>('whatsapp');
  private commandExpiresAt: number | undefined;
  readonly command = signal<string | undefined>(undefined);
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
          this.command.set(`${this.channel() === 'slack' ? '!' : '/'}room-link ${link.code}`);
          this.commandExpiresAt = link.expiresAt;
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
  private clearCommand(): void {
    this.command.set(undefined);
    this.commandExpiresAt = undefined;
    this.commandExpired.set(false);
  }
  private expireCommand(): void {
    if (this.commandExpiresAt !== undefined && Date.now() >= this.commandExpiresAt) {
      this.command.set(undefined);
      this.commandExpiresAt = undefined;
      this.commandExpired.set(true);
    }
  }
}
