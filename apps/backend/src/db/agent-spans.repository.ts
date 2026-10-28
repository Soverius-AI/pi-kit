import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service';

/** A stretch of a background agent's work in its thread's folder, with the snapshots around it (`agent_spans`). */
export interface AgentSpanRow {
  id: number;
  agentId: string;
  threadId: string;
  folder: string;
  shadowDir: string;
  shadowPrefix: string;
  startTree: string;
  /** `null` while the agent works. */
  endTree: string | null;
  startedAt: number;
  endedAt: number | null;
}

/** The columns as `AgentSpanRow` names them. */
const COLUMNS = `id, agent_id AS agentId, thread_id AS threadId, folder, shadow_dir AS shadowDir, shadow_prefix AS shadowPrefix,
  start_tree AS startTree, end_tree AS endTree, started_at AS startedAt, ended_at AS endedAt`;

/** The snapshots around the work of background agents in their thread's folder; they go with the thread, and after 30 days as runs' do. */
@Injectable()
export class AgentSpansRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  start(span: Omit<AgentSpanRow, 'id' | 'endTree' | 'endedAt'>): void {
    this.db
      .prepare(
        'INSERT INTO agent_spans (agent_id, thread_id, folder, shadow_dir, shadow_prefix, start_tree, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(span.agentId, span.threadId, span.folder, span.shadowDir, span.shadowPrefix, span.startTree, span.startedAt);
  }

  /** The agent's stretch of work that has not ended. */
  open(agentId: string): AgentSpanRow | undefined {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM agent_spans WHERE agent_id = ? AND end_tree IS NULL ORDER BY id DESC LIMIT 1`)
      .get(agentId) as AgentSpanRow | undefined;
  }

  end(id: number, tree: string, at: number): void {
    this.db.prepare('UPDATE agent_spans SET end_tree = ?, ended_at = ? WHERE id = ?').run(tree, at, id);
  }

  /** The thread's stretches of agent work, oldest first. */
  ofThread(threadId: string): AgentSpanRow[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM agent_spans WHERE thread_id = ? ORDER BY started_at, id`)
      .all(threadId) as AgentSpanRow[];
  }
}
