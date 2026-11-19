import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';

export interface A2aTaskRow {
  owner: string;
  id: string;
  contextId: string;
  state: string;
  task: unknown;
  updatedAt: number;
}

@Injectable()
export class A2aTasksRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async save(row: Omit<A2aTaskRow, 'updatedAt'>, updatedAt = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO a2a_tasks (owner, id, context_id, state, task_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner, id) DO UPDATE SET context_id = excluded.context_id, state = excluded.state, task_json = excluded.task_json, updated_at = excluded.updated_at`,
      )
      .run(row.owner, row.id, row.contextId, row.state, JSON.stringify(row.task), updatedAt);
  }

  async load(owner: string, id: string): Promise<A2aTaskRow | undefined> {
    const row = (await this.db
      .prepare('SELECT owner, id, context_id, state, task_json, updated_at FROM a2a_tasks WHERE owner = ? AND id = ?')
      .get(owner, id)) as RawRow | undefined;
    return row ? this.toRow(row) : undefined;
  }

  async list(
    owner: string,
    filter: { contextId?: string; state?: string; after?: number },
    limit: number,
    offset: number,
  ): Promise<{ rows: A2aTaskRow[]; total: number }> {
    const where = ['owner = ?'];
    const args: unknown[] = [owner];
    if (filter.contextId) {
      where.push('context_id = ?');
      args.push(filter.contextId);
    }
    if (filter.state) {
      where.push('state = ?');
      args.push(filter.state);
    }
    if (filter.after !== undefined) {
      where.push('updated_at > ?');
      args.push(filter.after);
    }
    const clause = where.join(' AND ');
    const total = (await this.db.prepare(`SELECT COUNT(*) AS n FROM a2a_tasks WHERE ${clause}`).get(...args)) as {
      n: number;
    };
    const rows = (await this.db
      .prepare(
        `SELECT owner, id, context_id, state, task_json, updated_at FROM a2a_tasks WHERE ${clause} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset)) as RawRow[];
    return { rows: rows.map((row) => this.toRow(row)), total: Number(total.n) };
  }

  async savePush(
    push: { owner: string; taskId: string; id: string; config: unknown; wireVersion: string },
    createdAt = Date.now(),
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO a2a_push_configs (owner, task_id, id, config_json, wire_version, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner, task_id, id) DO UPDATE SET config_json = excluded.config_json, wire_version = excluded.wire_version`,
      )
      .run(push.owner, push.taskId, push.id, JSON.stringify(push.config), push.wireVersion, createdAt);
  }

  async pushes(owner: string, taskId: string): Promise<{ config: unknown; wireVersion: string }[]> {
    const rows = (await this.db
      .prepare(
        'SELECT config_json, wire_version FROM a2a_push_configs WHERE owner = ? AND task_id = ? ORDER BY created_at, id',
      )
      .all(owner, taskId)) as { config_json: string; wire_version: string }[];
    return rows.map((row) => ({ config: JSON.parse(row.config_json) as unknown, wireVersion: row.wire_version }));
  }

  async deletePush(owner: string, taskId: string, id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM a2a_push_configs WHERE owner = ? AND task_id = ? AND id = ?')
      .run(owner, taskId, id);
  }

  private toRow(row: RawRow): A2aTaskRow {
    return {
      owner: row.owner,
      id: row.id,
      contextId: row.context_id,
      state: row.state,
      task: JSON.parse(row.task_json) as unknown,
      updatedAt: Number(row.updated_at),
    };
  }
}

interface RawRow {
  owner: string;
  id: string;
  context_id: string;
  state: string;
  task_json: string;
  updated_at: number;
}
