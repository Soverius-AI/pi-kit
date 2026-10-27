import { Injectable } from '@nestjs/common';
import type { ReviewComment } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

export interface BaselineRow {
  existed: boolean;
  /** `null`: the file was binary or too large to keep. */
  content: string | null;
}

/** `review_comments` (the pending batch) and `change_baselines` (files as they were before pi's first edit). */
@Injectable()
export class ChangesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  // ---- baselines

  baseline(threadId: string, path: string): BaselineRow | undefined {
    const row = this.db.prepare('SELECT existed, content FROM change_baselines WHERE thread_id = ? AND path = ?').get(threadId, path) as
      | { existed: number; content: string | null }
      | undefined;
    return row && { existed: row.existed === 1, content: row.content };
  }

  /** Keeps the first copy only: a later edit must not replace what the file was before the thread touched it. Returns true if this call stored it. */
  putBaseline(threadId: string, path: string, baseline: BaselineRow): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO change_baselines (thread_id, path, existed, content, captured_at) VALUES (?, ?, ?, ?, ?)')
      .run(threadId, path, baseline.existed ? 1 : 0, baseline.content, Date.now());
    return result.changes > 0;
  }

  /** The files the thread has a baseline of (the ones pi edited or wrote), with when each was first touched: what a commit is attributed. */
  touchedPaths(threadId: string): { path: string; at: number }[] {
    return (this.db.prepare('SELECT path, captured_at AS at FROM change_baselines WHERE thread_id = ?').all(threadId) as { path: string; at: number }[]).map((r) => ({ path: r.path, at: r.at }));
  }

  forgetBaseline(threadId: string, path: string): void {
    this.db.prepare('DELETE FROM change_baselines WHERE thread_id = ? AND path = ?').run(threadId, path);
  }

  // ---- pending review comments

  comments(threadId: string): ReviewComment[] {
    const rows = this.db
      .prepare('SELECT id, file, side, line, snippet, text FROM review_comments WHERE thread_id = ? ORDER BY position')
      .all(threadId) as ReviewComment[];
    return rows.map((r) => ({ id: r.id, file: r.file, side: r.side, line: r.line, snippet: r.snippet, text: r.text }));
  }

  /** Replaces the thread's pending batch with the renderer's. */
  replaceComments(threadId: string, comments: readonly ReviewComment[]): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO review_comments (thread_id, id, position, file, side, line, snippet, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM review_comments WHERE thread_id = ?').run(threadId);
      comments.forEach((c, position) => insert.run(threadId, c.id, position, c.file, c.side, c.line, c.snippet, c.text));
    })();
  }

  clearComments(threadId: string): void {
    this.db.prepare('DELETE FROM review_comments WHERE thread_id = ?').run(threadId);
  }
}
