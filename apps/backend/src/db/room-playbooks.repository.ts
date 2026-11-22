import { Injectable } from '@nestjs/common';
import { redact, type RoomAction, type RoomMemoryEntry } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

interface ActionRow {
  id: string;
  room_id: string;
  kind: RoomAction['kind'];
  name: string;
  payload_json: string;
  summary: string;
  state: RoomAction['state'];
  result: string | null;
  created_at: number;
  decided_at: number | null;
}

@Injectable()
export class RoomPlaybooksRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async remember(scope: string, key: string, text: string, by: string, now = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO room_memory (scope, key, text, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope, key) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(scope, key, redact(text) as string, by, now);
  }

  async forget(scope: string, key: string): Promise<void> {
    await this.db.prepare('DELETE FROM room_memory WHERE scope = ? AND key = ?').run(scope, key);
  }

  async memory(scopes: readonly string[]): Promise<RoomMemoryEntry[]> {
    if (!scopes.length) return [];
    const rows = (await this.db
      .prepare(
        `SELECT scope, key, text, updated_by, updated_at FROM room_memory WHERE scope IN (${scopes.map(() => '?').join(', ')}) ORDER BY updated_at, rowid`,
      )
      .all(...scopes)) as { scope: string; key: string; text: string; updated_by: string; updated_at: number }[];
    return rows.map((row) => ({
      scope: row.scope.startsWith('room:') ? 'room' : 'playbook',
      key: row.key,
      text: row.text,
      updatedBy: row.updated_by,
      updatedAt: Number(row.updated_at),
    }));
  }

  async insertAction(
    action: Pick<RoomAction, 'id' | 'kind' | 'name' | 'summary' | 'payload'> & { roomId: string },
    now = Date.now(),
  ): Promise<RoomAction> {
    await this.db
      .prepare(
        "INSERT INTO room_actions (id, room_id, kind, name, payload_json, summary, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(
        action.id,
        action.roomId,
        action.kind,
        action.name,
        JSON.stringify(action.payload),
        redact(action.summary) as string,
        now,
      );
    return (await this.action(action.roomId, action.id)) as RoomAction;
  }

  async action(roomId: string, id: string): Promise<RoomAction | undefined> {
    const row = (await this.db.prepare('SELECT * FROM room_actions WHERE id = ? AND room_id = ?').get(id, roomId)) as
      ActionRow | undefined;
    return row ? this.toAction(row) : undefined;
  }

  async actions(roomId: string): Promise<RoomAction[]> {
    const rows = (await this.db
      .prepare('SELECT * FROM room_actions WHERE room_id = ? ORDER BY created_at')
      .all(roomId)) as ActionRow[];
    return rows.map((row) => this.toAction(row));
  }

  async decide(
    roomId: string,
    id: string,
    state: Exclude<RoomAction['state'], 'pending'>,
    result: string | null,
    now = Date.now(),
  ): Promise<boolean> {
    const changed = await this.db
      .prepare(
        "UPDATE room_actions SET state = ?, result = ?, decided_at = ? WHERE id = ? AND room_id = ? AND state = 'pending'",
      )
      .run(state, result === null ? null : (redact(result) as string), now, id, roomId);
    return Number(changed.changes) > 0;
  }

  async unseen(roomId: string, triggerId: string, keys: readonly string[], now = Date.now()): Promise<string[]> {
    return await this.db.transaction(async () => {
      const fresh: string[] = [];
      const insert = this.db.prepare(
        'INSERT INTO room_trigger_seen (room_id, trigger_id, item_key, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      );
      for (const key of keys) {
        const done = await insert.run(roomId, triggerId, key, now);
        if (Number(done.changes) > 0) fresh.push(key);
      }
      return fresh;
    })();
  }

  /** Like `unseen`, but marks nothing seen. */
  async peekUnseen(roomId: string, triggerId: string, keys: readonly string[]): Promise<string[]> {
    const fresh: string[] = [];
    const seen = this.db.prepare(
      'SELECT 1 FROM room_trigger_seen WHERE room_id = ? AND trigger_id = ? AND item_key = ?',
    );
    for (const key of keys) if (!(await seen.get(roomId, triggerId, key))) fresh.push(key);
    return fresh;
  }

  async lastRuns(roomId: string): Promise<Map<string, number>> {
    const rows = (await this.db
      .prepare('SELECT trigger_id, ran_at FROM room_trigger_runs WHERE room_id = ?')
      .all(roomId)) as { trigger_id: string; ran_at: number }[];
    return new Map(rows.map((row) => [row.trigger_id, Number(row.ran_at)]));
  }

  async setLastRun(roomId: string, triggerId: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO room_trigger_runs (room_id, trigger_id, ran_at) VALUES (?, ?, ?) ON CONFLICT (room_id, trigger_id) DO UPDATE SET ran_at = excluded.ran_at',
      )
      .run(roomId, triggerId, at);
  }

  async addConsultThread(threadId: string, roomId: string, role: string, now = Date.now()): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO room_consult_threads (thread_id, room_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      )
      .run(threadId, roomId, role, now);
  }

  async consultThread(roomId: string, role: string): Promise<string | undefined> {
    const row = (await this.db
      .prepare(
        'SELECT thread_id FROM room_consult_threads WHERE room_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(roomId, role)) as { thread_id: string } | undefined;
    return row?.thread_id;
  }

  async countActions(roomId: string, name: string, since: number): Promise<number> {
    const row = (await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM room_actions WHERE room_id = ? AND name = ? AND kind = 'call' AND created_at >= ? AND state != 'discarded'",
      )
      .get(roomId, name, since)) as { count: number };
    return row.count;
  }

  async isConsultThread(threadId: string): Promise<boolean> {
    return !!(await this.db.prepare('SELECT 1 FROM room_consult_threads WHERE thread_id = ?').get(threadId));
  }

  private toAction(row: ActionRow): RoomAction {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      summary: row.summary,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      state: row.state,
      result: row.result,
      createdAt: Number(row.created_at),
      decidedAt: row.decided_at === null ? null : Number(row.decided_at),
    };
  }
}
