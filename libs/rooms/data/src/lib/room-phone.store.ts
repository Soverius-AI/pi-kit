import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import {
  EntryApiClient,
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
import { OpenRoomStore } from './open-room.store';

@Injectable()
export class RoomPhoneStore {
  private readonly room = inject(OpenRoomStore);
  private readonly api = inject(EntryApiClient);
  private version = 0;
  private destroyed = false;
  readonly visible = signal(false);
  readonly status = signal<RoomPhoneStatus | undefined>(undefined);
  readonly command = signal<string | undefined>(undefined);
  readonly busy = signal(false);
  readonly error = signal<string | undefined>(undefined);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.version++;
    });
    effect((cleanup) => {
      const room = this.room.room();
      const visible = this.visible();
      this.version++;
      this.status.set(undefined);
      this.command.set(undefined);
      this.error.set(undefined);
      if (!room || !visible) return;
      void this.refresh();
      const timer = setInterval(() => {
        if (!this.busy()) void this.refresh();
      }, 2500);
      cleanup(() => clearInterval(timer));
    });
  }

  async act(
    action: 'connect' | 'disconnect' | 'begin' | 'confirm' | 'unlink' | 'review' | 'test',
    item?: ReviewRoomPhone,
  ): Promise<void> {
    const options = this.options();
    if (!options || this.busy()) return;
    const version = ++this.version;
    this.busy.set(true);
    this.error.set(undefined);
    try {
      if (item) {
        const status = await unwrap(roomPhoneDismiss({ ...options, body: item }));
        if (this.current(version)) this.status.set(status);
      } else if (action === 'begin') {
        const link = await unwrap(roomPhoneBegin(options));
        if (this.current(version)) this.command.set(`/room-link ${link.code}`);
      } else {
        const candidate = this.status()?.candidate;
        if (action === 'confirm' && !candidate) return;
        const result =
          action === 'connect'
            ? roomPhoneConnect(options)
            : action === 'disconnect'
              ? roomPhoneDisconnect(options)
              : action === 'unlink'
                ? roomPhoneUnlink(options)
                : action === 'test'
                  ? roomPhoneTest(options)
                  : candidate
                    ? roomPhoneConfirm({ ...options, body: { group: candidate.group, sender: candidate.sender } })
                    : undefined;
        if (!result) return;
        const status = await unwrap(result);
        if (this.current(version)) {
          this.status.set(status);
          this.command.set(undefined);
        }
      }
    } catch (error) {
      if (this.current(version)) this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      // Room changes invalidate results but must not leave the panel busy forever.
      this.busy.set(false);
    }
  }

  async saveUrl(appUrl: string): Promise<void> {
    const options = this.options();
    if (!options || this.busy()) return;
    const version = ++this.version;
    this.busy.set(true);
    this.error.set(undefined);
    try {
      const status = await unwrap(roomPhoneConfig({ ...options, body: { appUrl } }));
      if (this.current(version)) this.status.set(status);
    } catch (error) {
      if (this.current(version)) this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }

  private async refresh(): Promise<void> {
    const options = this.options();
    if (!options) return;
    const version = ++this.version;
    try {
      const status = await unwrap(roomPhoneStatus(options));
      if (this.current(version)) {
        this.status.set(status);
        this.error.set(undefined);
      }
    } catch (error) {
      if (this.current(version)) this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  private current(version: number): boolean {
    return !this.destroyed && version === this.version;
  }
  private options() {
    const room = this.room.room();
    return room ? { client: this.api.forOwner(room.hostInstanceId), path: { roomId: room.id } } : undefined;
  }
}
