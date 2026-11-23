import { Injectable, signal } from '@angular/core';
import {
  roomPhoneBegin,
  roomPhoneConfirm,
  roomPhoneConnect,
  roomPhoneDisconnect,
  roomPhoneDismiss,
  roomPhoneStatus,
  roomPhoneUnlink,
  roomPhoneConfig,
  roomPhoneTest,
  unwrap,
} from '@pi-kit/api';
import type { ReviewRoomPhone, RoomPhoneStatus } from '@pi-kit/protocol';
import { RoomPanelState } from './room-panel-state';

@Injectable()
export class RoomPhoneStore {
  private commandExpiresAt: number | undefined;
  readonly command = signal<string | undefined>(undefined);
  readonly commandExpired = signal(false);
  private readonly panel = new RoomPanelState<RoomPhoneStatus>((options) => unwrap(roomPhoneStatus(options)), 2500, {
    reset: () => this.clearCommand(),
    tick: () => this.expireCommand(),
  });
  readonly visible = this.panel.visible;
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
          (options) => unwrap(roomPhoneDismiss({ ...options, body: item })),
          (status) => this.status.set(status),
        );
      return;
    }
    if (action === 'begin') {
      await this.panel.mutate(
        (options) => unwrap(roomPhoneBegin(options)),
        (link) => {
          this.command.set(`/room-link ${link.code}`);
          this.commandExpiresAt = link.expiresAt;
          this.commandExpired.set(false);
          this.expireCommand();
        },
      );
      return;
    }
    const apply = (status: RoomPhoneStatus) => {
      this.status.set(status);
      this.clearCommand();
    };
    if (action === 'confirm') {
      const candidate = this.status()?.candidate;
      if (candidate)
        await this.panel.mutate(
          (options) =>
            unwrap(roomPhoneConfirm({ ...options, body: { group: candidate.group, sender: candidate.sender } })),
          apply,
        );
      return;
    }
    const operation = {
      connect: roomPhoneConnect,
      disconnect: roomPhoneDisconnect,
      unlink: roomPhoneUnlink,
      test: roomPhoneTest,
    }[action];
    await this.panel.mutate((options) => unwrap(operation(options)), apply);
  }

  async saveUrl(appUrl: string): Promise<void> {
    await this.panel.mutate(
      (options) => unwrap(roomPhoneConfig({ ...options, body: { appUrl } })),
      (status) => this.status.set(status),
    );
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
