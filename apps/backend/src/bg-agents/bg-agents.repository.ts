import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import type { CleanupIntent } from './process-job';

export type AgentPermission = 'read-only' | 'edit' | 'isolated';
/** `active`: running or waiting in the durable store. `blocked`: held until the user decides (a cleanup, a crash loop). */
export type AgentStatus = 'active' | 'blocked' | 'done' | 'failed' | 'stopped';

/** One row of `bg_agents`; `id` is the pi-durable conversation id, `model` is `provider/modelId` or null. */
export interface BgAgentRow {
  id: string;
  threadId: string;
  name: string;
  role: string;
  model: string | null;
  permission: AgentPermission;
  brief: string;
  /** The durable submission of the brief, waited on again after a restart. */
  submissionId: string | null;
  status: AgentStatus;
  createdAt: number;
  finishedAt: number | null;
  cost: number;
  report: string | null;
  cleanup: CleanupIntent | null;
  /** When the agent was found unfinished at a start, or failed, newest last (the crash-loop limit). */
  failures: number[];
  ownerEpoch: number;
}

/** The columns a later write may change. */
export type BgAgentPatch = Partial<Pick<BgAgentRow, 'submissionId' | 'status' | 'finishedAt' | 'cost' | 'report' | 'cleanup' | 'failures' | 'permission'>>;
type NewRow = Omit<BgAgentRow, 'ownerEpoch' | 'failures' | 'cleanup' | 'cost' | 'finishedAt' | 'report'>;

/** Row fields to their columns; the two JSON columns are parsed on the way out. */
const COLUMNS: Record<keyof BgAgentRow, string> = {
  id: 'id', threadId: 'thread_id', name: 'name', role: 'role', model: 'model', permission: 'permission', brief: 'brief',
  submissionId: 'submission_id', status: 'status', createdAt: 'created_at', finishedAt: 'finished_at', cost: 'cost', report: 'report',
  cleanup: 'cleanup_json', failures: 'failures_json', ownerEpoch: 'owner_epoch',
};
const JSON_COLUMNS = new Set<keyof BgAgentRow>(['cleanup', 'failures']);

const parse = <T>(json: unknown, fallback: T): T => {
  try {
    return typeof json === 'string' ? (JSON.parse(json) as T) : fallback;
  } catch {
    return fallback;
  }
};
const toRow = (raw: Record<string, unknown>): BgAgentRow =>
  Object.fromEntries(
    (Object.entries(COLUMNS) as [keyof BgAgentRow, string][]).map(([key, column]) => [key, JSON_COLUMNS.has(key) ? parse(raw[column], key === 'failures' ? [] : null) : raw[column]]),
  ) as unknown as BgAgentRow;

/** `bg_agents`: the index and history of the background agents, fenced by the store owner's epoch. */
@Injectable()
export class BgAgentsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  insert(row: NewRow, epoch: number): void {
    const keys = Object.keys(row) as (keyof NewRow)[];
    this.db
      .prepare(`INSERT INTO bg_agents (${keys.map((key) => COLUMNS[key]).join(', ')}, owner_epoch) VALUES (${keys.map(() => '?').join(', ')}, ?)`)
      .run(...keys.map((key) => row[key] ?? null), epoch);
  }

  get(id: string): BgAgentRow | undefined {
    const raw = this.db.prepare('SELECT * FROM bg_agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return raw && toRow(raw);
  }

  byThread(threadId: string): BgAgentRow[] {
    return (this.db.prepare('SELECT * FROM bg_agents WHERE thread_id = ? ORDER BY created_at, rowid').all(threadId) as Record<string, unknown>[]).map(toRow);
  }

  /** The agents a start has to resume or hold: everything that is not finished. */
  unfinished(): BgAgentRow[] {
    return (this.db.prepare("SELECT * FROM bg_agents WHERE status IN ('active', 'blocked') ORDER BY created_at, rowid").all() as Record<string, unknown>[]).map(toRow);
  }

  /** Writes the patch with this owner's epoch; false when a newer owner wrote the row already (the write is dropped). */
  update(id: string, epoch: number, patch: BgAgentPatch): boolean {
    const keys = Object.keys(patch) as (keyof BgAgentPatch)[];
    const values = keys.map((key) => (JSON_COLUMNS.has(key) ? JSON.stringify(patch[key]) : (patch[key] ?? null)));
    const sets = keys.map((key) => `${COLUMNS[key]} = ?`);
    return this.db.prepare(`UPDATE bg_agents SET ${[...sets, 'owner_epoch = ?'].join(', ')} WHERE id = ? AND owner_epoch <= ?`).run(...values, epoch, id, epoch).changes > 0;
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM bg_agents WHERE id = ?').run(id);
  }
}
