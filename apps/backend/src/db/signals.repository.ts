import { Injectable } from '@nestjs/common';
import type { OutsideEdit, TranscriptAnswer } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

/** The most files kept per thread: a checkout of another branch would otherwise record the whole tree. */
export const MAX_OUTSIDE_PATHS = 500;
const VALUE_CHARS = 300;

export interface StoredAnswer extends TranscriptAnswer {
  at: number;
}

/**
 * What the Meat Proxy Score needs that no other table kept: the files that changed in a thread's folder while pi was not writing (`thread_outside_edits`,
 * a change by hand) and the dialogs the person answered (`thread_dialog_answers`). Both are read through the plugin API; both go with the thread.
 */
@Injectable()
export class SignalsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  // ---- outside edits

  /** Notes that the watcher saw `path` change at `at` while the thread was idle: the first sighting inserts, later ones move `last_at` and count. */
  noteOutsideEdit(threadId: string, path: string, at: number): void {
    const known = this.db.prepare('SELECT COUNT(*) AS n FROM thread_outside_edits WHERE thread_id = ?').get(threadId) as { n: number };
    const exists = this.db.prepare('SELECT 1 FROM thread_outside_edits WHERE thread_id = ? AND path = ?').get(threadId, path);
    if (!exists && known.n >= MAX_OUTSIDE_PATHS) return;
    this.db
      .prepare(
        `INSERT INTO thread_outside_edits (thread_id, path, first_at, last_at, count) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (thread_id, path) DO UPDATE SET last_at = excluded.last_at, count = count + 1`,
      )
      .run(threadId, path, at, at);
  }

  outsideEdits(threadId: string): OutsideEdit[] {
    const rows = this.db.prepare('SELECT path, first_at, last_at, count FROM thread_outside_edits WHERE thread_id = ? ORDER BY first_at, path').all(threadId) as {
      path: string;
      first_at: number;
      last_at: number;
      count: number;
    }[];
    return rows.map((r) => ({ path: r.path, firstAt: r.first_at, lastAt: r.last_at, count: r.count }));
  }

  // ---- dialog answers

  noteAnswer(threadId: string, at: number, answer: TranscriptAnswer): void {
    this.db
      .prepare('INSERT INTO thread_dialog_answers (thread_id, at, method, title, status, confirmed, value) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(threadId, at, answer.method, answer.title.slice(0, 300), answer.status, answer.confirmed === undefined ? null : answer.confirmed ? 1 : 0, answer.value === undefined ? null : answer.value.slice(0, VALUE_CHARS));
  }

  /** The answers the person gave in the thread, oldest first. */
  answers(threadId: string): StoredAnswer[] {
    const rows = this.db.prepare('SELECT at, method, title, status, confirmed, value FROM thread_dialog_answers WHERE thread_id = ? ORDER BY at, id').all(threadId) as {
      at: number;
      method: TranscriptAnswer['method'];
      title: string;
      status: TranscriptAnswer['status'];
      confirmed: number | null;
      value: string | null;
    }[];
    return rows.map((r) => ({ at: r.at, method: r.method, title: r.title, status: r.status, ...(r.confirmed === null ? {} : { confirmed: r.confirmed === 1 }), ...(r.value === null ? {} : { value: r.value }) }));
  }
}
