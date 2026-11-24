import { Injectable } from '@angular/core';
import {
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
  type ApiResult,
} from '@pi-kit/api';
import type {
  RoomAssistantStatus,
  RoomAssistantPolicy,
  RoomFactInput,
  RoomCommitmentInput,
  ChangeRoomCommitment,
  RoomFolderInput,
} from '@pi-kit/protocol';
import { RoomPanelState, type RoomPanelOptions } from './room-panel-state';

@Injectable()
export class RoomAssistantStore {
  private readonly panel = new RoomPanelState<RoomAssistantStatus>(
    (options) => unwrap(roomAssistantStatus(options)),
    5000,
  );
  readonly visible = this.panel.visible;
  readonly roomId = this.panel.roomId;
  readonly context = this.panel.context;
  readonly status = this.panel.status;
  readonly busy = this.panel.busy;
  readonly error = this.panel.error;

  load(): Promise<void> {
    return this.panel.refresh();
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
    await this.panel.mutate(
      (options) => unwrap(roomAssistantFile({ ...options, query: { path } })),
      (file) => {
        const bytes = Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
        const link = document.createElement('a');
        link.href = url;
        link.download = file.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      },
    );
  }
  private change<T>(action: (options: RoomPanelOptions) => Promise<ApiResult<T>>): Promise<boolean> {
    return this.panel.mutate((options) => unwrap(action(options)), undefined, true);
  }
}
