import { Injectable } from '@nestjs/common';
import { PlaybookParticipantSchema, type PlaybookParticipant } from '@pi-kit/protocol';
import { z } from 'zod';
import { DatabaseService } from './database.service';

const StateSchema = z.object({ members: z.array(PlaybookParticipantSchema), excluded: z.array(z.string()) }).strict();
export interface RoomParticipantState {
  members: PlaybookParticipant[];
  excluded: string[];
}

/** One canonical room-local roster, including room-only overrides of inherited playbook roles. */
@Injectable()
export class RoomParticipantsRepository {
  constructor(private readonly database: DatabaseService) {}
  async read(roomId: string): Promise<RoomParticipantState> {
    const row = await this.database.db
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get<{ value_json: string }>(`rooms.participants:${roomId}`);
    return row ? StateSchema.parse(JSON.parse(row.value_json)) : { members: [], excluded: [] };
  }
  async update(roomId: string, change: (state: RoomParticipantState) => RoomParticipantState): Promise<void> {
    await this.database.db
      .transaction(async () => {
        const value = StateSchema.parse(change(await this.read(roomId)));
        await this.database.db
          .prepare(
            'INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json',
          )
          .run(`rooms.participants:${roomId}`, JSON.stringify(value));
      })
      .immediate();
  }
}
