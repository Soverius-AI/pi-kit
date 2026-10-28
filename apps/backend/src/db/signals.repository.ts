import { Injectable } from '@nestjs/common';
import type { TranscriptAnswer } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

const VALUE_CHARS = 300;

export interface StoredAnswer extends TranscriptAnswer {
  at: number;
}

/** What the Meat Proxy Score needs that no other table kept: the dialogs the person answered (`thread_dialog_answers`), read through the plugin API; they go with the thread. */
@Injectable()
export class SignalsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  // ---- dialog answers

  noteAnswer(threadId: string, at: number, answer: TranscriptAnswer): void {
    this.db
      .prepare(
        'INSERT INTO thread_dialog_answers (thread_id, at, method, title, status, confirmed, value) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        threadId,
        at,
        answer.method,
        answer.title.slice(0, 300),
        answer.status,
        answer.confirmed === undefined ? null : answer.confirmed ? 1 : 0,
        answer.value === undefined ? null : answer.value.slice(0, VALUE_CHARS),
      );
  }

  /** The answers the person gave in the thread, oldest first. */
  answers(threadId: string): StoredAnswer[] {
    const rows = this.db
      .prepare(
        'SELECT at, method, title, status, confirmed, value FROM thread_dialog_answers WHERE thread_id = ? ORDER BY at, id',
      )
      .all(threadId) as {
      at: number;
      method: TranscriptAnswer['method'];
      title: string;
      status: TranscriptAnswer['status'];
      confirmed: number | null;
      value: string | null;
    }[];
    return rows.map((r) => ({
      at: r.at,
      method: r.method,
      title: r.title,
      status: r.status,
      ...(r.confirmed === null ? {} : { confirmed: r.confirmed === 1 }),
      ...(r.value === null ? {} : { value: r.value }),
    }));
  }
}
