import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  EntryApiClient,
  roomsClones,
  roomsCreate,
  roomsDirectory,
  roomsHosts,
  roomsPlaybooks,
  roomsPost,
  roomsStart,
  unwrap,
  type TypedClient,
} from '@pi-kit/api';
import { ViewPrefs } from '@pi-kit/data-access';
import { OpenRoomStore } from './open-room.store';
import type {
  CreateRoom,
  PlaybookSummary,
  Room,
  RoomClone,
  RoomDirectoryEntry,
  RoomStartPreview,
  RoomWorkerCandidate,
} from '@pi-kit/protocol';

@Injectable({ providedIn: 'root' })
export class RoomsStore {
  private readonly api = inject(EntryApiClient);
  private readonly prefs = inject(ViewPrefs);
  private readonly open = inject(OpenRoomStore);
  private generation = 0;

  readonly enabled = computed(() => this.prefs.roomsPreview());
  readonly entries = signal<RoomDirectoryEntry[]>([]);
  readonly rooms = computed<Room[]>(() => this.entries().map((entry) => entry.room));
  readonly waiting = computed(() =>
    this.entries().reduce((total, entry) => total + (entry.hostReachable ? entry.room.waiting : 0), 0),
  );
  readonly loading = signal(false);
  readonly error = signal<string | undefined>(undefined);
  readonly hasRooms = computed(() => this.enabled() && this.rooms().length > 0);

  constructor() {
    effect((onCleanup) => {
      const on = this.enabled();
      untracked(() => (on ? void this.refresh() : this.clear()));
      if (!on) return;
      const timer = setInterval(() => void this.refresh(), 30_000);
      onCleanup(() => clearInterval(timer));
    });
    effect(() => {
      if (this.open.listChanges() > 0 && untracked(() => this.enabled())) untracked(() => void this.refresh());
    });
  }

  hostClient(room: Room): TypedClient {
    return this.api.forOwner(room.hostInstanceId);
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    try {
      const entries = await unwrap(roomsDirectory({ client: this.api.client }));
      if (generation !== this.generation) return;
      this.entries.set(entries);
      this.error.set(undefined);
    } catch {
      if (generation === this.generation) this.error.set('unavailable');
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  start(threadId: string, ownerId?: string): Promise<RoomStartPreview> {
    const client = ownerId ? this.api.forOwner(ownerId) : this.api.client;
    return unwrap(roomsStart({ client, query: { threadId } }));
  }

  entry(roomId: string): RoomDirectoryEntry | undefined {
    return this.entries().find((entry) => entry.room.id === roomId);
  }

  clones(repository: string, baseCommit: string, host?: RoomWorkerCandidate): Promise<RoomClone[]> {
    const client = host && !host.local ? this.api.forOwner(host.environmentId) : this.api.client;
    return unwrap(roomsClones({ client, query: { repository, baseCommit } }));
  }

  playbooks(
    query: { repository: string; baseCommit?: string; threadId?: string },
    host?: RoomWorkerCandidate,
  ): Promise<PlaybookSummary[]> {
    const client = host && !host.local ? this.api.forOwner(host.environmentId) : this.api.client;
    return unwrap(roomsPlaybooks({ client, query }));
  }

  hosts(): Promise<RoomWorkerCandidate[]> {
    return unwrap(roomsHosts({ client: this.api.client }));
  }

  async create(input: CreateRoom, host?: RoomWorkerCandidate): Promise<Room> {
    const client = host && !host.local ? this.api.forOwner(host.environmentId) : this.api.client;
    const room = await unwrap(roomsCreate({ client, body: input }));
    const entry: RoomDirectoryEntry = {
      room,
      hostName: host?.name ?? '',
      local: !host || host.local,
      hostReachable: true,
      lastSeenAt: Date.now(),
    };
    this.entries.update((entries) => [entry, ...entries.filter((existing) => existing.room.id !== room.id)]);
    return room;
  }

  /** A message to the lead of a room that is not open yet (the first one, right after it was started). */
  async askLead(room: Room, text: string): Promise<void> {
    await unwrap(
      roomsPost({ client: this.hostClient(room), path: { roomId: room.id }, body: { text, route: 'lead' } }),
    );
  }

  private clear(): void {
    this.generation++;
    this.entries.set([]);
    this.loading.set(false);
    this.error.set(undefined);
  }
}
