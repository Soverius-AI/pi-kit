import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';

/** `terminal_replay`: the last screen of each workspace's terminal, in the database so one key covers it. Written already redacted. */
@Injectable()
export class TerminalReplayRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async get(cwd: string): Promise<{ data: string; updatedAt: number } | undefined> {
    const row = (await this.db.prepare('SELECT data, updated_at FROM terminal_replay WHERE cwd = ?').get(cwd)) as
      { data: string; updated_at: number } | undefined;
    return row && { data: row.data, updatedAt: row.updated_at };
  }

  async set(cwd: string, data: string, now = Date.now()): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO terminal_replay (cwd, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (cwd) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      )
      .run(cwd, data, now);
  }
}
