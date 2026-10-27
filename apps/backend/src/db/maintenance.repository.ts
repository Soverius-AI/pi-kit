import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from './database.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Attendant activity older than this goes: Settings shows the newest hundred and today's usage. */
export const ACTIONS_KEEP_MS = 90 * DAY_MS;
/** A terminal screen nobody opened for this long goes. */
export const TERMINAL_KEEP_MS = 30 * DAY_MS;
/**
 * The copies of files from before pi's first edit go when the thread's session has not changed for this long. They can be the biggest rows
 * in the database (up to 2 MB a file); without them "This thread" rebuilds the earlier text from the session's edits, or compares with
 * git's HEAD and says so.
 */
export const BASELINES_KEEP_MS = 30 * DAY_MS;

export interface Pruned {
  actions: number;
  runs: number;
  suggestions: number;
  terminals: number;
  events: number;
  baselines: number;
}

/**
 * Keeps the tables that grow with use from growing for ever. It runs once after startup and then once a day: attendant activity older than
 * 90 days, finished runs except each thread's newest (the lock and the sidebar read only that one), settled follow-up prompts except each
 * thread's newest (the one "was this proposed before?" asks about), terminal screens of folders that are no longer a project or a thread's
 * folder or were not opened for 30 days, replay logs whose thread or background agent is gone, and the change baselines of threads whose
 * session has not changed for 30 days.
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
        .prepare("DELETE FROM runs WHERE status <> 'running' AND rowid NOT IN (SELECT MAX(rowid) FROM runs GROUP BY thread_id)")
        .run().changes;
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
        (this.db.prepare('SELECT id FROM threads UNION SELECT id FROM bg_agents').all() as { id: string }[]).map((row) => row.id),
      );
      const remove = this.db.prepare('DELETE FROM thread_events WHERE thread_id = ?');
      let events = 0;
      for (const { thread_id } of this.db.prepare('SELECT DISTINCT thread_id FROM thread_events').all() as { thread_id: string }[]) {
        if (!owners.has(thread_id)) events += remove.run(thread_id).changes;
      }
      const baselines = this.db
        .prepare('DELETE FROM change_baselines WHERE thread_id IN (SELECT id FROM threads WHERE updated_at < ?)')
        .run(now - BASELINES_KEEP_MS).changes;
      return { actions, runs, suggestions, terminals, events, baselines };
    })();
  }
}
