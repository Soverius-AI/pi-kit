import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from './database.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Attendant activity older than this goes: Settings shows the newest hundred and today's usage. */
export const ACTIONS_KEEP_MS = 90 * DAY_MS;
/** A terminal screen nobody opened for this long goes. */
export const TERMINAL_KEEP_MS = 30 * DAY_MS;

/**
 * A run with snapshots of its folder is kept this long: "This thread", the score and the attribution of a commit read what changed from them.
 * The private repositories prune the trees after as long (`ShadowRepo`).
 */
export const RUN_SNAPSHOTS_KEEP_MS = 30 * DAY_MS;

export interface Pruned {
  actions: number;
  runs: number;
  agentSpans: number;
  suggestions: number;
  terminals: number;
  events: number;
}

/**
 * Keeps the tables that grow with use from growing for ever. It runs once after startup and then once a day: attendant activity older than
 * 90 days, finished runs except each thread's newest (the lock and the sidebar read only that one) and those with snapshots of their folder
 * from the last 30 days, settled follow-up prompts except each
 * thread's newest (the one "was this proposed before?" asks about), terminal screens of folders that are no longer a project or a thread's
 * folder or were not opened for 30 days and replay logs whose thread or background agent is gone.
 */
@Injectable()
export class MaintenanceRepository implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceRepository.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  onApplicationBootstrap(): void {
    const run = () => {
      try {
        const pruned = this.prune();
        const total = Object.values(pruned).reduce((sum, n) => sum + n, 0);
        if (total > 0) this.logger.log(`Pruned ${JSON.stringify(pruned)}`);
      } catch (error) {
        this.logger.warn(`Pruning the database failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    // Not in the way of startup: the first pass waits a minute.
    this.timer = setTimeout(() => {
      run();
      this.timer = setInterval(run, DAY_MS);
      this.timer.unref();
    }, 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.timer);
    clearInterval(this.timer);
  }

  prune(now = Date.now()): Pruned {
    return this.db.transaction(() => {
      const actions = this.db.prepare('DELETE FROM attendant_actions WHERE at < ?').run(now - ACTIONS_KEEP_MS).changes;
      const runs = this.db
        .prepare(
          `DELETE FROM runs WHERE status <> 'running' AND rowid NOT IN (SELECT MAX(rowid) FROM runs GROUP BY thread_id)
             AND (start_tree IS NULL OR started_at < ?)`,
        )
        .run(now - RUN_SNAPSHOTS_KEEP_MS).changes;
      // The work of background agents is snapshotted like runs, and kept as long.
      const agentSpans = this.db
        .prepare('DELETE FROM agent_spans WHERE started_at < ?')
        .run(now - RUN_SNAPSHOTS_KEEP_MS).changes;
      const suggestions = this.db
        .prepare(
          "DELETE FROM thread_suggestions WHERE kind = 'prompt' AND state <> 'open' AND id NOT IN (SELECT MAX(id) FROM thread_suggestions WHERE kind = 'prompt' GROUP BY thread_id)",
        )
        .run().changes;
      const terminals = this.db
        .prepare(
          `DELETE FROM terminal_replay WHERE updated_at < ? OR cwd NOT IN (
             SELECT cwd FROM workspaces WHERE forgotten = 0 UNION SELECT cwd FROM threads UNION SELECT worktree_path FROM threads WHERE worktree_path IS NOT NULL)`,
        )
        .run(now - TERMINAL_KEEP_MS).changes;
      // Logs are keyed by a thread id or a background agent id; the distinct ids come from the index, not from a scan of the events.
      const owners = new Set(
        (this.db.prepare('SELECT id FROM threads UNION SELECT id FROM bg_agents').all() as { id: string }[]).map(
          (row) => row.id,
        ),
      );
      const remove = this.db.prepare('DELETE FROM thread_events WHERE thread_id = ?');
      let events = 0;
      for (const { thread_id } of this.db.prepare('SELECT DISTINCT thread_id FROM thread_events').all() as {
        thread_id: string;
      }[]) {
        if (!owners.has(thread_id)) events += remove.run(thread_id).changes;
      }
      return { actions, runs, agentSpans, suggestions, terminals, events };
    })();
  }
}
