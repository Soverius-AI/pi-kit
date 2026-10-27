import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { type SkillDraft, type SkillDraftMaker, type SkillDraftState, type SkillScope, SkillVerificationSchema, type SkillVerification, type ThreadDraftBadge, verifiedResult } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

interface RawDraft {
  id: string;
  thread_id: string;
  name: string;
  text: string;
  scope: SkillScope;
  state: SkillDraftState;
  verification: string | null;
  made_by: SkillDraftMaker;
  model: string | null;
  path: string | null;
  created_at: number;
  decided_at: number | null;
}

const toDraft = (r: RawDraft): SkillDraft => {
  let verification: SkillVerification | null;
  try {
    const parsed = r.verification ? SkillVerificationSchema.safeParse(JSON.parse(r.verification) as unknown) : undefined;
    verification = parsed?.success ? parsed.data : null;
  } catch {
    verification = null;
  }
  return {
    id: r.id,
    threadId: r.thread_id,
    name: r.name,
    text: r.text,
    scope: r.scope,
    state: r.state,
    verification,
    madeBy: r.made_by,
    model: r.model,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    path: r.path,
  };
};

export const draftBadge = (draft: (Pick<SkillDraft, 'id' | 'name' | 'state' | 'madeBy'> & { verification?: SkillVerification | null }) | undefined): ThreadDraftBadge | null =>
  draft
    ? { id: draft.id, name: draft.name, state: draft.state, madeBy: draft.madeBy, verification: draft.verification?.state === 'running' ? 'running' : (verifiedResult(draft.verification) ?? null) }
    : null;

export interface NewDraft {
  threadId: string;
  name: string;
  text: string;
  scope: SkillScope;
  madeBy: SkillDraftMaker;
  model?: string | null;
}

/**
 * `skill_drafts`: one draft per thread. A draft is a row, never a folder: the state machine is `pending` to `approved` or `discarded`, and a
 * discarded draft can be reopened (back to `pending`). Nothing here touches a skills folder; the learn service's approve is the only writer of one.
 */
@Injectable()
export class SkillDraftsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  get(id: string): SkillDraft | undefined {
    const row = this.db.prepare('SELECT * FROM skill_drafts WHERE id = ?').get(id) as RawDraft | undefined;
    return row && toDraft(row);
  }

  forThread(threadId: string): SkillDraft | undefined {
    const row = this.db.prepare('SELECT * FROM skill_drafts WHERE thread_id = ?').get(threadId) as RawDraft | undefined;
    return row && toDraft(row);
  }

  pending(): SkillDraft[] {
    return (this.db.prepare("SELECT * FROM skill_drafts WHERE state = 'pending' ORDER BY created_at DESC").all() as RawDraft[]).map(toDraft);
  }

  /** Drafts whose verification is running, including any left over after a restart. */
  verifying(): SkillDraft[] {
    return (this.db.prepare("SELECT * FROM skill_drafts WHERE json_extract(verification, '$.state') = 'running'").all() as RawDraft[]).map(toDraft);
  }

  /** Every thread's draft, by thread id (a pass over the thread list). */
  all(): Map<string, SkillDraft> {
    return new Map((this.db.prepare('SELECT * FROM skill_drafts').all() as RawDraft[]).map((r) => [r.thread_id, toDraft(r)]));
  }

  /** A new pending draft. A thread has one: a second `insert` for it throws (the caller checks `forThread` first). */
  insert(draft: NewDraft, now = Date.now()): SkillDraft {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO skill_drafts (id, thread_id, name, text, scope, state, made_by, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, draft.threadId, draft.name, draft.text, draft.scope, 'pending', draft.madeBy, draft.model ?? null, now);
    return this.get(id) as SkillDraft;
  }

  /** The person's edits of a draft (name, text, scope). */
  edit(id: string, edit: { name?: string; text?: string; scope?: SkillScope }): SkillDraft | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    this.db
      .prepare('UPDATE skill_drafts SET name = ?, text = ?, scope = ? WHERE id = ?')
      .run(edit.name ?? current.name, edit.text ?? current.text, edit.scope ?? current.scope, id);
    return this.get(id);
  }

  setState(id: string, state: SkillDraftState, options: { path?: string | null; now?: number } = {}): SkillDraft | undefined {
    const decided = state === 'pending' ? null : (options.now ?? Date.now());
    this.db.prepare('UPDATE skill_drafts SET state = ?, decided_at = ?, path = ? WHERE id = ?').run(state, decided, state === 'approved' ? (options.path ?? null) : null, id);
    return this.get(id);
  }

  setVerification(id: string, report: SkillVerification | null): void {
    this.db.prepare('UPDATE skill_drafts SET verification = ? WHERE id = ?').run(report ? JSON.stringify(report) : null, id);
  }

  /** Drafts that were approved, oldest first: the learned skills. Retired ones are included; `retiredAt(id)` says which. */
  approved(): SkillDraft[] {
    return (this.db.prepare("SELECT * FROM skill_drafts WHERE state = 'approved' ORDER BY decided_at ASC").all() as RawDraft[]).map(toDraft);
  }

  /** When the draft's skill was retired, or null while it is live. */
  retiredAt(id: string): number | null {
    const row = this.db.prepare('SELECT retired_at FROM skill_drafts WHERE id = ?').get(id) as { retired_at: number | null } | undefined;
    return row?.retired_at ?? null;
  }

  /** Records the retirement of an approved draft's skill (`at`), or its restoration (`null`). */
  setRetired(id: string, at: number | null): void {
    this.db.prepare('UPDATE skill_drafts SET retired_at = ? WHERE id = ?').run(at, id);
  }
}
