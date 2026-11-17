import { Injectable } from '@nestjs/common';
import type { ReviewComment } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

/** `review_comments`: the pending batch of review comments. */
@Injectable()
export class ChangesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  // ---- pending review comments

  async comments(threadId: string): Promise<ReviewComment[]> {
    const rows = (await this.db
      .prepare('SELECT id, file, side, line, snippet, text FROM review_comments WHERE thread_id = ? ORDER BY position')
      .all(threadId)) as ReviewComment[];
    return rows.map((r) => ({ id: r.id, file: r.file, side: r.side, line: r.line, snippet: r.snippet, text: r.text }));
  }

  /** Replaces the thread's pending batch with the renderer's. */
  async replaceComments(threadId: string, comments: readonly ReviewComment[]): Promise<void> {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO review_comments (thread_id, id, position, file, side, line, snippet, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    await this.db.transaction(async () => {
      await this.db.prepare('DELETE FROM review_comments WHERE thread_id = ?').run(threadId);
      for (const [position, c] of comments.entries()) {
        await insert.run(threadId, c.id, position, c.file, c.side, c.line, c.snippet, c.text);
      }
    })();
  }

  async clearComments(threadId: string): Promise<void> {
    await this.db.prepare('DELETE FROM review_comments WHERE thread_id = ?').run(threadId);
  }
}
