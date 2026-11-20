import { Injectable, Logger } from '@nestjs/common';
import type { RoomEvent, RoomStreamLine } from '@pi-kit/protocol';
import { RoomsRepository } from '../db/rooms.repository';

type Listener = (line: RoomStreamLine) => void;

@Injectable()
export class RoomBus {
  private readonly logger = new Logger(RoomBus.name);
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly rooms: RoomsRepository) {}

  subscribe(roomId: string, listener: Listener): () => void {
    const set = this.listeners.get(roomId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(roomId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(roomId);
    };
  }

  async record(
    roomId: string,
    event: Pick<RoomEvent, 'kind' | 'actor' | 'text'> & {
      images?: number;
      taskId?: string | null;
      environmentId?: string | null;
      role?: string | null;
    },
  ): Promise<RoomEvent> {
    const stored = await this.rooms.append(roomId, event);
    this.emit(roomId, { type: 'event', event: stored });
    return stored;
  }

  emit(roomId: string, line: RoomStreamLine): void {
    for (const listener of this.listeners.get(roomId) ?? []) {
      try {
        listener(line);
      } catch (error) {
        this.logger.warn(`A room listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
