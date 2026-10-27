import { Injectable } from '@nestjs/common';
import type { OutcomeKind } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

/** One thread's outcome. `files` are relative to the folder the thread works in. */
export interface OutcomeRow {
  threadId: string;
  kind: OutcomeKind;
  baseCommit: string;
  headCommit: string;
  mergeCommit: string | null;
  prUrl: string | null;
  at: number;
  files: string[];
  /** The score service writes these with `setAnnotations` when the thread is scored; `null` until then. */
  scores: unknown;
  hunkLabels: unknown;
}

interface RawOutcome {
  thread_id: string;
  kind: OutcomeKind;
  base_commit: string;
  head_commit: string;
  merge_commit: string | null;
  pr_url: string | null;
  at: number;
  files: string;
  scores: string | null;
  hunk_labels: string | null;
}

const parse = (json: string | null): unknown => {
  if (json === null) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

const toRow = (r: RawOutcome): OutcomeRow => ({
  threadId: r.thread_id,
  kind: r.kind,
  baseCommit: r.base_commit,
  headCommit: r.head_commit,
  mergeCommit: r.merge_commit,
  prUrl: r.pr_url,
  at: r.at,
  files: (parse(r.files) as string[] | null) ?? [],
  scores: parse(r.scores),
  hunkLabels: parse(r.hunk_labels),
});

/** `thread_outcomes`: the latest outcome of a thread, one row each. */
@Injectable()
export class OutcomesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  get(threadId: string): OutcomeRow | undefined {
    const row = this.db.prepare('SELECT * FROM thread_outcomes WHERE thread_id = ?').get(threadId) as RawOutcome | undefined;
    return row && toRow(row);
  }

  /** Every thread's outcome, for a pass over the thread list. */
  all(): Map<string, OutcomeRow> {
    return new Map((this.db.prepare('SELECT * FROM thread_outcomes').all() as RawOutcome[]).map((r) => [r.thread_id, toRow(r)]));
  }

  /** Writes the thread's outcome, replacing the one it had. The scores and labels kept there survive a replacement of the rest. */
  put(row: Omit<OutcomeRow, 'scores' | 'hunkLabels'>): void {
    this.db
      .prepare(
        `INSERT INTO thread_outcomes (thread_id, kind, base_commit, head_commit, merge_commit, pr_url, at, files)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET kind = excluded.kind, base_commit = excluded.base_commit, head_commit = excluded.head_commit,
           merge_commit = excluded.merge_commit, pr_url = excluded.pr_url, at = excluded.at, files = excluded.files`,
      )
      .run(row.threadId, row.kind, row.baseCommit, row.headCommit, row.mergeCommit, row.prUrl, row.at, JSON.stringify(row.files));
  }

  // ---- what the score service annotates: dedicated setters, so `put` never has to know about them

  /** Stores the labels and the scores of a thread's outcome; `undefined` leaves a column alone, `null` clears it. Returns false when the thread has no outcome. */
  setAnnotations(threadId: string, annotations: { hunkLabels?: unknown; scores?: unknown }): boolean {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (annotations.hunkLabels !== undefined) {
      sets.push('hunk_labels = ?');
      values.push(annotations.hunkLabels === null ? null : JSON.stringify(annotations.hunkLabels));
    }
    if (annotations.scores !== undefined) {
      sets.push('scores = ?');
      values.push(annotations.scores === null ? null : JSON.stringify(annotations.scores));
    }
    if (sets.length === 0) return this.get(threadId) !== undefined;
    return this.db.prepare(`UPDATE thread_outcomes SET ${sets.join(', ')} WHERE thread_id = ?`).run(...values, threadId).changes > 0;
  }
}
