import { Injectable } from '@nestjs/common';
import type { AttendantAction, AttendantKind, AttendantUsage, ThreadSuggestion } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

export interface ThreadMetaRow {
  threadId: string;
  summary: string | null;
  /** The session file's mtime the summary describes. */
  summaryFor: number | null;
  /** The session file's mtime when the attendant last went over the thread. */
  lookedFor: number | null;
}

export interface NewAction {
  kind: AttendantKind;
  status: 'done' | 'skipped' | 'error';
  threadId: string | null;
  threadTitle: string | null;
  text: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

interface RawMeta {
  thread_id: string;
  summary: string | null;
  summary_for: number | null;
  looked_for: number | null;
}

/** `thread_meta`, `attendant_actions` and `thread_suggestions`: what the attendant knows, did, and proposes. */
@Injectable()
export class AttendantRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  // ---- thread_meta

  meta(threadId: string): ThreadMetaRow | undefined {
    const r = this.db.prepare('SELECT * FROM thread_meta WHERE thread_id = ?').get(threadId) as RawMeta | undefined;
    return r && toMeta(r);
  }

  /** Summaries of every thread that has one (the sidebar's meta line), by thread id. */
  summaries(): Map<string, string> {
    const rows = this.db.prepare('SELECT thread_id, summary FROM thread_meta WHERE summary IS NOT NULL').all() as { thread_id: string; summary: string }[];
    return new Map(rows.map((r) => [r.thread_id, r.summary]));
  }

  setSummary(threadId: string, summary: string, fileMtime: number | null): void {
    this.db
      .prepare(
        `INSERT INTO thread_meta (thread_id, summary, summary_for) VALUES (?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET summary = excluded.summary, summary_for = excluded.summary_for`,
      )
      .run(threadId, summary, fileMtime);
  }

  markLooked(threadId: string, fileMtime: number | null): void {
    this.db
      .prepare(
        `INSERT INTO thread_meta (thread_id, looked_for) VALUES (?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET looked_for = excluded.looked_for`,
      )
      .run(threadId, fileMtime);
  }

  // ---- actions

  addAction(action: NewAction): number {
    const result = this.db
      .prepare(
        `INSERT INTO attendant_actions (at, kind, status, thread_id, thread_title, text, model, input_tokens, output_tokens, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), action.kind, action.status, action.threadId, action.threadTitle, action.text, action.model ?? null, action.inputTokens ?? 0, action.outputTokens ?? 0, action.cost ?? 0);
    return Number(result.lastInsertRowid);
  }

  actions(limit = 100): AttendantAction[] {
    const rows = this.db.prepare('SELECT * FROM attendant_actions ORDER BY id DESC LIMIT ?').all(limit) as {
      id: number;
      at: number;
      kind: AttendantKind;
      status: 'done' | 'skipped' | 'error';
      thread_id: string | null;
      thread_title: string | null;
      text: string;
      model: string | null;
      input_tokens: number;
      output_tokens: number;
      cost: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      kind: r.kind,
      status: r.status,
      threadId: r.thread_id,
      threadTitle: r.thread_title,
      text: r.text,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cost: r.cost,
    }));
  }

  /** What the model requests since `since` (local midnight) cost and used. */
  usageSince(since: number): AttendantUsage {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output
         FROM attendant_actions WHERE at >= ? AND status != 'skipped' AND model IS NOT NULL`,
      )
      .get(since) as { cost: number; calls: number; input: number; output: number };
    return { cost: row.cost, calls: row.calls, inputTokens: row.input, outputTokens: row.output };
  }

  // ---- suggestions

  addSuggestion(suggestion: { threadId: string; kind: ThreadSuggestion['kind']; target: string; text: string; reason?: string }): number {
    // One open suggestion per target: a newer proposal replaces the older one.
    this.db.prepare("UPDATE thread_suggestions SET state = 'dismissed' WHERE thread_id = ? AND kind = ? AND target = ? AND state = 'open'").run(suggestion.threadId, suggestion.kind, suggestion.target);
    const result = this.db
      .prepare('INSERT INTO thread_suggestions (thread_id, kind, target, text, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(suggestion.threadId, suggestion.kind, suggestion.target, suggestion.text, suggestion.reason ?? null, Date.now());
    return Number(result.lastInsertRowid);
  }

  /** A suggestion for this target was made before (open, accepted or dismissed): the attendant does not propose it again. */
  hasSuggestion(threadId: string, kind: ThreadSuggestion['kind'], target: string): boolean {
    return this.db.prepare('SELECT 1 FROM thread_suggestions WHERE thread_id = ? AND kind = ? AND target = ? LIMIT 1').get(threadId, kind, target) !== undefined;
  }

  /** Open suggestions of one thread, newest first. */
  openSuggestions(threadId: string): ThreadSuggestion[] {
    return this.suggestionRows('SELECT * FROM thread_suggestions WHERE thread_id = ? AND state = \'open\' ORDER BY id DESC', threadId);
  }

  /** Open suggestions of every thread, by thread id. */
  allOpenSuggestions(): Map<string, ThreadSuggestion[]> {
    const rows = this.db.prepare("SELECT * FROM thread_suggestions WHERE state = 'open' ORDER BY id DESC").all() as RawSuggestion[];
    const out = new Map<string, ThreadSuggestion[]>();
    for (const r of rows) out.set(r.thread_id, [...(out.get(r.thread_id) ?? []), toSuggestion(r)]);
    return out;
  }

  suggestion(id: number): (ThreadSuggestion & { threadId: string; state: string }) | undefined {
    const r = this.db.prepare('SELECT * FROM thread_suggestions WHERE id = ?').get(id) as RawSuggestion | undefined;
    return r && { ...toSuggestion(r), threadId: r.thread_id, state: r.state };
  }

  setSuggestionState(id: number, state: 'accepted' | 'dismissed'): void {
    this.db.prepare('UPDATE thread_suggestions SET state = ? WHERE id = ?').run(state, id);
  }

  /** The `learn` suggestion of a skill draft is settled with the draft: approved is accepted, discarded is dismissed. */
  closeLearn(draftId: string, state: 'accepted' | 'dismissed'): void {
    this.db.prepare("UPDATE thread_suggestions SET state = ? WHERE kind = 'learn' AND target = ? AND state = 'open'").run(state, draftId);
  }

  /** An answer suggestion goes stale when its dialog is gone: every open one of the thread that is not in `liveDialogIds` is dismissed. Returns how many. */
  expireAnswers(threadId: string, liveDialogIds: readonly string[]): number {
    const open = this.openSuggestions(threadId).filter((s) => s.kind === 'answer' && !liveDialogIds.includes(s.target));
    for (const s of open) this.setSuggestionState(s.id, 'dismissed');
    return open.length;
  }

  /** Prompt predictions belong to a particular conversation state, never to the next run or branch. */
  expirePrompts(threadId?: string): void {
    if (threadId) this.db.prepare("UPDATE thread_suggestions SET state = 'dismissed' WHERE kind = 'prompt' AND state = 'open' AND thread_id = ?").run(threadId);
    else this.db.prepare("UPDATE thread_suggestions SET state = 'dismissed' WHERE kind = 'prompt' AND state = 'open'").run();
  }

  private suggestionRows(sql: string, ...args: unknown[]): ThreadSuggestion[] {
    return (this.db.prepare(sql).all(...args) as RawSuggestion[]).map(toSuggestion);
  }
}

interface RawSuggestion {
  id: number;
  thread_id: string;
  kind: ThreadSuggestion['kind'];
  target: string;
  text: string;
  reason: string | null;
  state: string;
}

const toSuggestion = (r: RawSuggestion): ThreadSuggestion => ({ id: r.id, kind: r.kind, target: r.target, text: r.text, ...(r.reason ? { reason: r.reason } : {}) });

const toMeta = (r: RawMeta): ThreadMetaRow => ({
  threadId: r.thread_id,
  summary: r.summary,
  summaryFor: r.summary_for,
  lookedFor: r.looked_for,
});
