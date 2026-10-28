import { Injectable } from '@nestjs/common';
import { redact } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

export type ThreadOrigin = 'app' | 'cli';

/** The first user message and the title are text the person typed: key shapes in them are masked before they are kept (the thread list shows them). */
const mask = <T extends string | null | undefined>(text: T): T =>
  typeof text === 'string' ? (redact(text) as T) : text;

export interface ThreadRow {
  id: string;
  sessionPath: string;
  /** The project's folder: the main checkout for a thread that runs in a worktree, else the folder pi runs in. */
  cwd: string;
  title: string | null;
  preview: string | null;
  pinned: boolean;
  archived: boolean;
  origin: ThreadOrigin;
  parentSessionPath: string | null;
  messageCount: number;
  createdAt: number;
  lastOpenedAt: number | null;
  updatedAt: number;
  logMtime: number | null;
  forkCount: number;
  forkCountAt: number | null;
  leafId: string | null;
  leafMtime: number | null;
  /** When the user last looked at the thread; null for a thread the CLI made after the app started and nobody opened. */
  seenAt: number | null;
  /** Share of the model's context window in use after the last response, whole percent; null while unknown. */
  contextPct: number | null;
  /** The session file's mtime `contextPct` was measured for. */
  contextAt: number | null;
  /** The first line of the last assistant message, short and redacted, read for the session file as it was at `lastLineAt`. */
  lastLine: string | null;
  lastLineAt: number | null;
  /** The worktree folder pi runs in, while the thread's worktree exists. */
  worktreePath: string | null;
  /** The branch the worktree was created on, and the branch it was cut from and merges back into. */
  branch: string | null;
  baseBranch: string | null;
  /** The folder pi's session file names (the worktree, or, once it was removed, the folder that no longer exists); `cwd` is the project. */
  sessionCwd: string;
  /** The commit the folder was on when the thread started; null for a thread outside a repository or one whose base was not found. */
  baseCommit: string | null;
  /** Where `baseCommit` comes from; null until it was looked at once (`none`: looked, nothing found). */
  baseSource: 'start' | 'estimated' | 'none' | null;
}

interface RawThread {
  id: string;
  session_path: string;
  cwd: string;
  title: string | null;
  preview: string | null;
  pinned: number;
  archived: number;
  origin: ThreadOrigin;
  parent_session_path: string | null;
  message_count: number;
  created_at: number;
  last_opened_at: number | null;
  updated_at: number;
  log_mtime: number | null;
  fork_count: number;
  fork_count_at: number | null;
  leaf_id: string | null;
  leaf_mtime: number | null;
  seen_at: number | null;
  context_pct: number | null;
  context_at: number | null;
  last_line: string | null;
  last_line_at: number | null;
  worktree_path: string | null;
  branch: string | null;
  project_cwd: string | null;
  base_branch: string | null;
  base_commit: string | null;
  base_source: 'start' | 'estimated' | 'none' | null;
}

const toRow = (r: RawThread): ThreadRow => ({
  id: r.id,
  sessionPath: r.session_path,
  cwd: r.project_cwd ?? r.cwd,
  title: r.title,
  preview: r.preview,
  pinned: r.pinned === 1,
  archived: r.archived === 1,
  origin: r.origin,
  parentSessionPath: r.parent_session_path,
  messageCount: r.message_count,
  createdAt: r.created_at,
  lastOpenedAt: r.last_opened_at,
  updatedAt: r.updated_at,
  logMtime: r.log_mtime,
  forkCount: r.fork_count,
  forkCountAt: r.fork_count_at,
  leafId: r.leaf_id,
  leafMtime: r.leaf_mtime,
  seenAt: r.seen_at,
  contextPct: r.context_pct,
  contextAt: r.context_at,
  lastLine: r.last_line,
  lastLineAt: r.last_line_at,
  worktreePath: r.worktree_path,
  branch: r.branch,
  baseBranch: r.base_branch,
  sessionCwd: r.cwd,
  baseCommit: r.base_commit,
  baseSource: r.base_source,
});

/** What a thread keeps about its worktree. */
export interface WorktreeFacts {
  path: string;
  /** Null for a detached worktree: "Create branch here" gives it one. */
  branch: string | null;
  /** The main checkout the worktree belongs to. */
  projectCwd: string;
  /** The branch it was cut from and merges back into. */
  base: string;
}

/** What a reconcile pass knows about a pi session. */
export interface SessionFacts {
  id: string;
  sessionPath: string;
  cwd: string;
  /** pi's `session_info` name. */
  title: string | undefined;
  preview: string;
  parentSessionPath: string | undefined;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * `threads`: one row per pi session the app knows, with what the sidebar shows (title, preview, counts, pins,
 * archive), what the reconcile pass learnt from the session file, and the thread's worktree and base commit.
 */
@Injectable()
export class ThreadsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  get(id: string): ThreadRow | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as RawThread | undefined;
    return row && toRow(row);
  }

  getBySessionPath(path: string): ThreadRow | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE session_path = ?').get(path) as RawThread | undefined;
    return row && toRow(row);
  }

  list(options: { cwd?: string; includeArchived?: boolean } = {}): ThreadRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (options.cwd) {
      where.push('COALESCE(project_cwd, cwd) = ?');
      args.push(options.cwd);
    }
    if (!options.includeArchived) where.push('archived = 0');
    const sql = `SELECT * FROM threads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, updated_at DESC`;
    return (this.db.prepare(sql).all(...args) as RawThread[]).map(toRow);
  }

  all(): ThreadRow[] {
    return (this.db.prepare('SELECT * FROM threads').all() as RawThread[]).map(toRow);
  }

  /** A thread the app creates: no session file yet, so counts are zero. */
  insertDraft(thread: {
    id: string;
    sessionPath: string;
    cwd: string;
    title?: string;
    parentSessionPath?: string;
    worktree?: WorktreeFacts;
    baseCommit?: string | null;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO threads (id, session_path, cwd, title, origin, parent_session_path, created_at, last_opened_at, updated_at, seen_at, worktree_path, branch, project_cwd, base_branch, base_commit, base_source)
         VALUES (?, ?, ?, ?, 'app', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.sessionPath,
        thread.cwd,
        thread.title ?? null,
        thread.parentSessionPath ?? null,
        now,
        now,
        now,
        now,
        thread.worktree?.path ?? null,
        thread.worktree?.branch ?? null,
        thread.worktree?.projectCwd ?? null,
        thread.worktree?.base ?? null,
        thread.baseCommit ?? null,
        // A thread the app starts has been looked at: its base is HEAD now, or there is none (not a repository).
        thread.baseCommit ? 'start' : 'none',
      );
  }

  /** The base commit of a thread, and where it came from. */
  setBase(id: string, commit: string | null, source: 'start' | 'estimated' | 'none'): void {
    this.db.prepare('UPDATE threads SET base_commit = ?, base_source = ? WHERE id = ?').run(commit, source, id);
  }

  /** The thread whose worktree is this folder, if any (a session that the pi command line starts in a worktree folder belongs to the same project). */
  worktreeAt(path: string): ThreadRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE worktree_path = ? OR (project_cwd IS NOT NULL AND cwd = ?) LIMIT 1')
      .get(path, path) as RawThread | undefined;
    return row && toRow(row);
  }

  /** The folders that are the worktree of a thread right now. */
  worktreePaths(): string[] {
    return (
      this.db.prepare('SELECT DISTINCT worktree_path FROM threads WHERE worktree_path IS NOT NULL').all() as {
        worktree_path: string;
      }[]
    ).map((r) => r.worktree_path);
  }

  /** The worktree is gone (removed after a merge, or by the user): the thread carries on in its project's folder. */
  clearWorktree(id: string): void {
    this.db.prepare('UPDATE threads SET worktree_path = NULL WHERE id = ?').run(id);
  }

  /** The thread works in the project's folder for good (a hand off): no worktree, no branch, no base. The session file keeps naming the old folder. */
  clearWorktreeFully(id: string): void {
    this.db.prepare('UPDATE threads SET worktree_path = NULL, branch = NULL, base_branch = NULL WHERE id = ?').run(id);
  }

  /** The thread moved into a worktree of its project (a hand off to a worktree): the session file stays where it is and names the project folder. */
  setWorktree(id: string, facts: WorktreeFacts): void {
    this.db
      .prepare('UPDATE threads SET worktree_path = ?, branch = ?, project_cwd = ?, base_branch = ? WHERE id = ?')
      .run(facts.path, facts.branch, facts.projectCwd, facts.base, id);
  }

  /** A detached worktree got a branch. */
  setBranch(id: string, branch: string): void {
    this.db.prepare('UPDATE threads SET branch = ? WHERE id = ?').run(branch, id);
  }

  /** A thread without a message is placed in a worktree: its session is created again in the worktree's folder, so the file and `cwd` change with it. */
  relocateDraft(id: string, to: { sessionPath: string; worktree: WorktreeFacts }): void {
    this.db
      .prepare(
        'UPDATE threads SET session_path = ?, cwd = ?, worktree_path = ?, branch = ?, project_cwd = ?, base_branch = ? WHERE id = ?',
      )
      .run(
        to.sessionPath,
        to.worktree.path,
        to.worktree.path,
        to.worktree.branch,
        to.worktree.projectCwd,
        to.worktree.base,
        id,
      );
  }

  /**
   * Upserts what pi's session list says. A new row is a session the app did not create (`cli`).
   * pinned/archived are ours and never overwritten; the title only changes when pi has a name.
   */
  upsertFromSession(facts: SessionFacts, seenAt: number | null = null): 'inserted' | 'updated' {
    const existing = this.get(facts.id);
    if (!existing) {
      // A session the pi command line started in one of our worktree folders belongs to that worktree's project.
      const sibling = this.worktreeAt(facts.cwd);
      this.db
        .prepare(
          `INSERT INTO threads (id, session_path, cwd, title, preview, origin, parent_session_path, message_count, created_at, updated_at, seen_at, worktree_path, branch, project_cwd, base_branch)
           VALUES (?, ?, ?, ?, ?, 'cli', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          facts.id,
          facts.sessionPath,
          facts.cwd,
          mask(facts.title ?? null),
          mask(facts.preview),
          facts.parentSessionPath ?? null,
          facts.messageCount,
          facts.createdAt,
          facts.updatedAt,
          seenAt,
          sibling?.worktreePath ?? null,
          sibling?.branch ?? null,
          sibling ? sibling.cwd : null,
          sibling?.baseBranch ?? null,
        );
      return 'inserted';
    }
    this.db
      .prepare(
        `UPDATE threads SET session_path = ?, cwd = ?, title = COALESCE(?, title), preview = ?, message_count = ?,
                parent_session_path = COALESCE(?, parent_session_path), updated_at = ? WHERE id = ?`,
      )
      .run(
        facts.sessionPath,
        facts.cwd,
        mask(facts.title ?? null),
        mask(facts.preview),
        facts.messageCount,
        facts.parentSessionPath ?? null,
        facts.updatedAt,
        facts.id,
      );
    return 'updated';
  }

  update(id: string, patch: { title?: string | null; pinned?: boolean; archived?: boolean }): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push('title = ?');
      args.push(patch.title);
    }
    if (patch.pinned !== undefined) {
      sets.push('pinned = ?');
      args.push(patch.pinned ? 1 : 0);
    }
    if (patch.archived !== undefined) {
      sets.push('archived = ?');
      args.push(patch.archived ? 1 : 0);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  }

  setSessionPath(id: string, path: string): void {
    this.db.prepare('UPDATE threads SET session_path = ? WHERE id = ?').run(path, id);
  }

  /** The user looked at the thread: no unread dot, no "cli" badge until something changes again. */
  markSeen(id: string, at = Date.now()): void {
    this.db.prepare('UPDATE threads SET seen_at = ? WHERE id = ?').run(at, id);
  }

  /** The context share after the last response, measured for the session file as it was at `fileMtime`. */
  setContext(id: string, pct: number | null, fileMtime: number | null): void {
    this.db.prepare('UPDATE threads SET context_pct = ?, context_at = ? WHERE id = ?').run(pct, fileMtime, id);
  }

  /** The last assistant line of the active branch, read for the session file as it was at `fileMtime` (masked like the title and the preview). */
  setLastLine(id: string, line: string | null, fileMtime: number | null): void {
    this.db.prepare('UPDATE threads SET last_line = ?, last_line_at = ? WHERE id = ?').run(mask(line), fileMtime, id);
  }

  touchOpened(id: string): void {
    this.db.prepare('UPDATE threads SET last_opened_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /** After a run: the session file's new mtime, message count and, if pi just created it, the preview. */
  recordRunEnd(
    id: string,
    facts: { logMtime: number | null; messageCount: number; preview: string | undefined; lastLine?: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE threads SET log_mtime = ?, message_count = ?, preview = COALESCE(preview, ?), updated_at = ? WHERE id = ?`,
      )
      .run(facts.logMtime, facts.messageCount, mask(facts.preview ?? null), Date.now(), id);
    if (facts.lastLine !== undefined) this.setLastLine(id, facts.lastLine, facts.logMtime);
  }

  setLogMtime(id: string, mtime: number | null): void {
    this.db.prepare('UPDATE threads SET log_mtime = ? WHERE id = ?').run(mtime, id);
  }

  /** The tree's number of extra branches, computed for the session file as it was at `fileMtime`. */
  setForkCount(id: string, forkCount: number, fileMtime: number | null): void {
    this.db.prepare('UPDATE threads SET fork_count = ?, fork_count_at = ? WHERE id = ?').run(forkCount, fileMtime, id);
  }

  /** Where the app moved the leaf, valid while the session file still has `fileMtime` (pi writes no leaf of its own). */
  setLeaf(id: string, leafId: string | null, fileMtime: number | null): void {
    this.db.prepare('UPDATE threads SET leaf_id = ?, leaf_mtime = ? WHERE id = ?').run(leafId, fileMtime, id);
  }

  /**
   * Removes the thread and everything the app keeps for it, in one transaction. What outlives a thread on purpose: an approved
   * skill draft (the skill exists as a file), the uses of skills (`skill_uses`, history of the skill) and the attendant's
   * activity (`attendant_actions` keeps the title). Background agents go through `ThreadsService.onDeleted`: they have a process to stop.
   */
  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM thread_events WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM runs WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM agent_spans WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM thread_outcomes WHERE thread_id = ?').run(id);
      // An approved draft is the record of a skill that exists as a file: it outlives the thread it was learned from.
      this.db.prepare("DELETE FROM skill_drafts WHERE thread_id = ? AND state <> 'approved'").run(id);
      this.db.prepare('DELETE FROM thread_dialog_answers WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM review_comments WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM feedback WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM thread_meta WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM thread_suggestions WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM file_leases WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
    })();
  }
}
