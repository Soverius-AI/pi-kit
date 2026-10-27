import { Injectable } from '@nestjs/common';
import type { UseOutcome } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

/** The uses of one learned skill, grouped for its record. */
export interface SkillUseSummary {
  uses: number;
  mergedAfterUse: number;
  lastUsedAt: number | null;
  /** One entry per thread that used it: when it last did and the outcome it ended with (the latest marked on any of its uses). */
  threads: { threadId: string; lastUseAt: number; outcome: UseOutcome | null }[];
}

interface RawUse {
  thread_id: string;
  at: number;
  outcome: UseOutcome | null;
}

/**
 * `skill_uses`: every prompt that used a learned skill, keyed by the thread the skill was learned from (so a copy of the skill in a worktree counts for
 * it). A use is written when the prompt is sent; when its thread lands an outcome, the thread's uses are marked with the outcome's kind, which is what "merged after use" counts.
 */
@Injectable()
export class SkillUsesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  record(use: { learnedFrom: string; threadId: string }, now = Date.now()): void {
    // The outcome comes later: a use is "followed by" the outcome its thread lands after it, so a new use starts with none.
    this.db.prepare('INSERT INTO skill_uses (learned_from, thread_id, at, outcome) VALUES (?, ?, ?, ?)').run(use.learnedFrom, use.threadId, now, null);
  }

  /** The thread landed an outcome (or a later one replaced it): all its uses carry its kind. */
  markOutcome(threadId: string, kind: UseOutcome): number {
    return this.db.prepare('UPDATE skill_uses SET outcome = ? WHERE thread_id = ?').run(kind, threadId).changes;
  }

  summary(learnedFrom: string): SkillUseSummary {
    const rows = this.db.prepare('SELECT thread_id, at, outcome FROM skill_uses WHERE learned_from = ? ORDER BY at ASC, id ASC').all(learnedFrom) as RawUse[];
    const threads = new Map<string, { threadId: string; lastUseAt: number; outcome: UseOutcome | null }>();
    let merged = 0;
    for (const row of rows) {
      if (row.outcome === 'merged') merged += 1;
      const known = threads.get(row.thread_id);
      threads.set(row.thread_id, { threadId: row.thread_id, lastUseAt: row.at, outcome: row.outcome ?? known?.outcome ?? null });
    }
    return { uses: rows.length, mergedAfterUse: merged, lastUsedAt: rows.length > 0 ? rows[rows.length - 1].at : null, threads: [...threads.values()] };
  }
}
