import { Injectable } from '@nestjs/common';
import type { FeedbackEntry, FeedbackRating } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

/** `feedback`: the thumbs up / down on assistant messages. The primary key leads with the thread, so listing one thread needs no extra index. */
@Injectable()
export class FeedbackRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** The thread's ratings, oldest first. */
  list(threadId: string): FeedbackEntry[] {
    const rows = this.db
      .prepare('SELECT message_id, rating, updated_at FROM feedback WHERE thread_id = ? ORDER BY created_at, message_id')
      .all(threadId) as { message_id: string; rating: FeedbackRating; updated_at: number }[];
    return rows.map((r) => ({ messageId: r.message_id, rating: r.rating, updatedAt: r.updated_at }));
  }

  /** Sets or changes a message's rating; `null` clears it. */
  set(threadId: string, messageId: string, rating: FeedbackRating | null, now = Date.now()): void {
    if (rating === null) {
      this.db.prepare('DELETE FROM feedback WHERE thread_id = ? AND message_id = ?').run(threadId, messageId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO feedback (thread_id, message_id, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (thread_id, message_id) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at`,
      )
      .run(threadId, messageId, rating, now, now);
  }
}
