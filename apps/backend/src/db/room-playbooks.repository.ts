import { Injectable } from '@nestjs/common';
import { redact, redactValue, type RoomAction, type RoomMemoryEntry } from '@pi-kit/protocol';
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

export interface RoomActionSettlement {
  state: 'done' | 'failed' | 'discarded';
  result: string | null;
  note: string;
  nudge: string;
}

@Injectable()
export class RoomPlaybooksRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async remember(scope: string, key: string, text: string, by: string, now = Date.now()): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO room_memory (scope, key, text, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope, key) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by, updated_at = excluded.updated_at
         WHERE ?=0 OR room_memory.text<>''`,
      )
      .run(scope, key, redact(text) as string, by, now, by === 'lead' && scope.startsWith('room:') ? 1 : 0);
    return Number(result.changes) > 0;
  }

  async forget(scope: string, key: string, by = 'owner', now = Date.now()): Promise<void> {
    // Retain only the key and deletion metadata, never the forgotten fact.
    await this.db
      .prepare(
        `INSERT INTO room_memory(scope,key,text,updated_by,updated_at) VALUES (?,?,'',?,?)
      ON CONFLICT(scope,key) DO UPDATE SET text='',updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      )
      .run(scope, key, by, now);
  }

  /** Legacy secret-shaped keys cannot be retained even as deletion metadata. */
  async purge(scope: string, key: string): Promise<void> {
    await this.db.prepare('DELETE FROM room_memory WHERE scope=? AND key=?').run(scope, key);
  }

  async forgotten(scopes: readonly string[]): Promise<Pick<RoomMemoryEntry, 'scope' | 'key'>[]> {
    if (!scopes.length) return [];
    const rows = await this.db
      .prepare(
        `SELECT scope,key FROM room_memory WHERE scope IN (${scopes.map(() => '?').join(',')}) AND text='' ORDER BY updated_at,rowid`,
      )
      .all<{ scope: string; key: string }>(...scopes);
    return rows.map((row) => ({
      scope: row.scope.startsWith('room:') ? ('room' as const) : ('playbook' as const),
      key: row.key,
    }));
  }

  async memory(scopes: readonly string[]): Promise<RoomMemoryEntry[]> {
    if (!scopes.length) return [];
    const rows = (await this.db
      .prepare(
        `SELECT scope, key, text, updated_by, updated_at FROM room_memory WHERE scope IN (${scopes.map(() => '?').join(', ')}) AND text<>'' ORDER BY updated_at, rowid`,
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
        "UPDATE room_actions SET state = ?, result = ?, decided_at = ? WHERE id = ? AND room_id = ? AND state = 'pending' AND (? <> 'discarded' OR NOT EXISTS(SELECT 1 FROM room_action_executions x WHERE x.action_id=room_actions.id))",
      )
      .run(state, result === null ? null : (redact(result) as string), now, id, roomId, state);
    return Number(changed.changes) > 0;
  }

  async claimExecution(roomId: string, actionId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO room_action_executions(action_id,started_at)
      SELECT id,? FROM room_actions WHERE room_id=? AND id=? AND state='pending' ON CONFLICT DO NOTHING`,
      )
      .run(Date.now(), roomId, actionId);
    return Number(result.changes) === 1;
  }
  async execution(roomId: string, actionId: string): Promise<{ settlement: RoomActionSettlement | null } | undefined> {
    const row = await this.db
      .prepare(
        `SELECT x.settlement_json FROM room_action_executions x
      JOIN room_actions a ON a.id=x.action_id WHERE a.room_id=? AND a.id=?`,
      )
      .get<{ settlement_json: string | null }>(roomId, actionId);
    return row
      ? { settlement: row.settlement_json ? (JSON.parse(row.settlement_json) as RoomActionSettlement) : null }
      : undefined;
  }
  async saveExecution(actionId: string, settlement: RoomActionSettlement): Promise<RoomActionSettlement> {
    if (settlement.state === 'discarded') throw new Error('Discard is not an external execution outcome.');
    await this.db
      .prepare('UPDATE room_action_executions SET settlement_json=? WHERE action_id=? AND settlement_json IS NULL')
      .run(JSON.stringify(redactValue(settlement)), actionId);
    const saved = await this.db
      .prepare('SELECT settlement_json FROM room_action_executions WHERE action_id=?')
      .get<{ settlement_json: string | null }>(actionId);
    if (!saved?.settlement_json) throw new Error('The approved execution journal is missing.');
    return JSON.parse(saved.settlement_json) as RoomActionSettlement;
  }
  async reviewLegacyDiscardedExecution(
    roomId: string,
    actionId: string,
    review: Omit<RoomActionSettlement, 'state'>,
  ): Promise<void> {
    // Older builds could journal a discard while an approved external operation was running.
    // It is not a confirmed external outcome: repair only that invalid legacy state to owner review.
    await this.db
      .prepare(
        `UPDATE room_action_executions SET settlement_json=? WHERE action_id=? AND json_extract(settlement_json,'$.state')='discarded' AND EXISTS(SELECT 1 FROM room_actions a WHERE a.id=room_action_executions.action_id AND a.room_id=? AND a.state='pending')`,
      )
      .run(JSON.stringify(redactValue({ ...review, state: 'failed' })), actionId, roomId);
  }
  async unfinishedExecutions(): Promise<{ roomId: string; actionId: string }[]> {
    return this.db
      .prepare(
        `SELECT a.room_id AS roomId,a.id AS actionId FROM room_action_executions x
      JOIN room_actions a ON a.id=x.action_id WHERE a.state='pending'`,
      )
      .all();
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
