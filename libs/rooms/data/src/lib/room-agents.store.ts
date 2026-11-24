import { Injectable, computed, inject, signal } from '@angular/core';
import {
  EntryApiClient,
  settingsModels,
  roomParticipantsList,
  roomParticipantsTargets,
  roomParticipantsAdd,
  roomParticipantsUpdate,
  roomParticipantsRemove,
  unwrap,
} from '@pi-kit/api';
import type { RoomParticipants, RoomParticipantTargets, RoomParticipantInput, SettingsModel } from '@pi-kit/protocol';
import { RoomPanelState } from './room-panel-state';

@Injectable()
export class RoomAgentsStore {
  private readonly roster = new RoomPanelState<RoomParticipants>(
    (options) => unwrap(roomParticipantsList(options)),
    5000,
  );
  private readonly destinations = new RoomPanelState<RoomParticipantTargets>(
    (options) => unwrap(roomParticipantsTargets(options)),
    15000,
  );
  private readonly api = inject(EntryApiClient);
  private readonly modelOwner = signal<string | undefined>(undefined);
  private readonly catalogue = new RoomPanelState<SettingsModel[]>(
    (options) => {
      const owner = this.modelOwner();
      if (!owner) return Promise.resolve([]);
      return unwrap(settingsModels({ client: this.api.forOwner(owner), signal: options.signal }));
    },
    60000,
    {},
    () => this.modelOwner() ?? '',
  );
  readonly models = this.catalogue.status;
  readonly modelsError = this.catalogue.error;
  readonly modelsLoading = computed(() => this.catalogue.visible() && !this.models() && !this.modelsError());
  showModels(owner: string | undefined): void {
    this.modelOwner.set(owner);
    this.catalogue.visible.set(!!owner);
  }
  retryModels(): Promise<void> {
    this.modelsError.set(undefined);
    return this.catalogue.refresh();
  }
  readonly visible = this.roster.visible;
  readonly targetsVisible = this.destinations.visible;
  readonly context = this.roster.context;
  readonly status = this.roster.status;
  readonly targets = this.destinations.status;
  readonly busy = this.roster.busy;
  readonly error = this.roster.error;
  readonly targetsError = this.destinations.error;
  refresh(): Promise<void> {
    return this.roster.refresh();
  }
  refreshTargets(): Promise<void> {
    return this.destinations.refresh();
  }
  add(body: RoomParticipantInput): Promise<boolean> {
    return this.roster.mutate(
      (options) => unwrap(roomParticipantsAdd({ ...options, body })),
      (result) => this.status.set(result),
    );
  }
  update(role: string, body: RoomParticipantInput): Promise<boolean> {
    return this.roster.mutate(
      (options) => unwrap(roomParticipantsUpdate({ ...options, path: { ...options.path, role }, body })),
      (result) => this.status.set(result),
    );
  }
  remove(role: string): Promise<boolean> {
    return this.roster.mutate(
      (options) => unwrap(roomParticipantsRemove({ ...options, path: { ...options.path, role } })),
      (result) => this.status.set(result),
    );
  }
}
