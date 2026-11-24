import { Injectable, computed, inject, signal } from '@angular/core';
import type { RoomChannel } from '@pi-kit/protocol';
import { OpenRoomStore } from './open-room.store';
import { RoomPhoneStore } from './room-phone.store';

type ChannelScreen = 'list' | 'choose' | RoomChannel;

/** Ephemeral setup state survives closing the sidebar; credentials stay in the editor. */
@Injectable({ providedIn: 'root' })
export class RoomChannelsStore {
  private readonly room = inject(OpenRoomStore);
  private readonly screens = signal<Record<string, ChannelScreen>>({});
  private readonly key = computed(() => {
    const room = this.room.room();
    return room ? JSON.stringify([room.hostInstanceId, room.id]) : '';
  });
  readonly providers = (['telegram', 'whatsapp', 'signal', 'slack'] as const).map((channel) => {
    const store = new RoomPhoneStore();
    store.channel.set(channel);
    return { channel, store };
  });
  readonly screen = computed(() => this.screens()[this.key()] ?? 'list');
  readonly selected = computed(() => this.providers.find((provider) => provider.channel === this.screen()));
  readonly existing = computed(() =>
    this.providers.filter(({ store }) => {
      const status = store.status();
      return (
        store.command() ||
        store.busy() ||
        store.error() ||
        status?.error ||
        status?.configured ||
        status?.binding ||
        status?.candidate ||
        (status && status.connection !== 'disconnected')
      );
    }),
  );
  readonly loading = computed(() => this.providers.every(({ store }) => !store.status() && !store.error()));

  show(screen: ChannelScreen): void {
    const key = this.key();
    if (!key) return;
    this.screens.update((screens) => {
      const entries = Object.entries(screens)
        .filter(([entry]) => entry !== key)
        .slice(-31);
      return { ...Object.fromEntries(entries), [key]: screen };
    });
  }
}
