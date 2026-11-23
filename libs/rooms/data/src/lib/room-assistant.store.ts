import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  EntryApiClient,
  roomAssistantStatus,
  roomAssistantPolicy,
  roomAssistantMemory,
  roomAssistantCreate,
  roomAssistantChange,
  roomAssistantFolder,
  roomAssistantRemoveFolder,
  roomAssistantWork,
  roomAssistantFile,
  unwrap,
  type TypedClient,
} from '@pi-kit/api';
import type {
  RoomAssistantStatus,
  RoomAssistantPolicy,
  RoomFactInput,
  RoomCommitmentInput,
  ChangeRoomCommitment,
  RoomFolderInput,
} from '@pi-kit/protocol';
import { OpenRoomStore } from './open-room.store';

@Injectable()
export class RoomAssistantStore {
  private readonly room = inject(OpenRoomStore);
  private readonly api = inject(EntryApiClient);
  private version = 0;
  private destroyed = false;
  readonly visible = signal(false);
  readonly roomId = computed(() => this.room.room()?.id);
  readonly status = signal<RoomAssistantStatus | undefined>(undefined);
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
      this.error.set(undefined);
      if (!room || !visible) return;
      void this.load();
      const timer = setInterval(() => {
        if (!this.busy()) void this.load();
      }, 5000);
      cleanup(() => clearInterval(timer));
    });
  }
  async load(): Promise<void> {
    const options = this.options();
    if (!options) return;
    const version = ++this.version;
    try {
      const status = await unwrap(roomAssistantStatus(options));
      if (this.current(version)) {
        this.status.set(status);
        this.error.set(undefined);
      }
    } catch (error) {
      if (this.current(version)) this.error.set(error instanceof Error ? error.message : String(error));
    }
  }
  policy(body: RoomAssistantPolicy): Promise<boolean> {
    return this.change((options) => roomAssistantPolicy({ ...options, body }));
  }
  memory(body: RoomFactInput): Promise<boolean> {
    return this.change((options) => roomAssistantMemory({ ...options, body }));
  }
  commitment(body: RoomCommitmentInput): Promise<boolean> {
    return this.change((options) => roomAssistantCreate({ ...options, body }));
  }
  updateCommitment(id: string, body: ChangeRoomCommitment): Promise<boolean> {
    return this.change((options) => roomAssistantChange({ ...options, path: { ...options.path, id }, body }));
  }
  folder(body: RoomFolderInput): Promise<boolean> {
    return this.change((options) => roomAssistantFolder({ ...options, body }));
  }
  removeFolder(id: string): Promise<boolean> {
    return this.change((options) => roomAssistantRemoveFolder({ ...options, path: { ...options.path, id } }));
  }
  work(id: string, retry: boolean): Promise<boolean> {
    return this.change((options) => roomAssistantWork({ ...options, path: { ...options.path, id }, body: { retry } }));
  }
  async download(path: string): Promise<void> {
    const options = this.options();
    if (!options) return;
    try {
      const file = await unwrap(roomAssistantFile({ ...options, query: { path } }));
      const bytes = Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    }
  }
  private async change(action: (options: Options) => Promise<unknown>): Promise<boolean> {
    const options = this.options();
    if (!options || this.busy()) return false;
    const version = ++this.version;
    this.busy.set(true);
    this.error.set(undefined);
    try {
      await unwrap(action(options) as Parameters<typeof unwrap>[0]);
      if (!this.current(version)) return false;
      await this.load();
      return !this.destroyed && this.room.room()?.id === options.path.roomId;
    } catch (error) {
      if (this.current(version)) this.error.set(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
  private current(version: number): boolean {
    return !this.destroyed && version === this.version;
  }
  private options(): Options | undefined {
    const room = this.room.room();
    return room ? { client: this.api.forOwner(room.hostInstanceId), path: { roomId: room.id } } : undefined;
  }
}
interface Options {
  client: TypedClient;
  path: { roomId: string };
}
