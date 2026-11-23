import { Injectable } from '@nestjs/common';
import { redact, RoomFactInputSchema, type RoomFactInput, type RoomMemoryEntry } from '@pi-kit/protocol';
import { RoomPlaybooksRepository } from '../db/room-playbooks.repository';
import { RoomBus } from './room-bus';

@Injectable()
export class RoomMemory {
  constructor(
    private readonly notes: RoomPlaybooksRepository,
    private readonly bus: RoomBus,
  ) {}

  async change(roomId: string, input: RoomFactInput, by: string, scope = `room:${roomId}`): Promise<void> {
    input = RoomFactInputSchema.parse({ key: input.key, text: input.text });
    const now = Date.now();
    if (input.text.trim()) await this.notes.remember(scope, input.key, input.text, by, now);
    else await this.notes.forget(scope, input.key);
    const entry: RoomMemoryEntry = {
      scope: scope.startsWith('room:') ? 'room' : 'playbook',
      key: input.key,
      text: redact(input.text) as string,
      updatedBy: by,
      updatedAt: now,
    };
    this.bus.emit(roomId, { type: 'memory', entry });
  }
}
