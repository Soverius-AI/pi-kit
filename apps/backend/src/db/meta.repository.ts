import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { BranchMode, CarryChanges, RemoveFolder, SetupScript, StartMode } from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

export interface WorkspaceRow {
  cwd: string;
  name: string;
  lastOpenedAt: number;
  /** The sidebar's order. */
  sortOrder: number;
  collapsed: boolean;
  hidden: boolean;
  /** The attendant is opted out of this project. */
  attendantOff: boolean;
  /** The project switched background agents off (they are on unless it did). */
  agentsOff: boolean;
  /** Where this project's thread worktrees go and the branch they are cut from; null: the defaults. */
  worktreeRoot: string | null;
  worktreeBase: string | null;
  /** where a new thread starts and how a new worktree is made; null: the default. `scripts` null: never configured (the lockfile suggests one); `[]`: none. */
  wtStart: StartMode | null;
  wtAllowSwitch: boolean | null;
  wtCarry: CarryChanges | null;
  wtBranchMode: BranchMode | null;
  wtBranchPrefix: string | null;
  wtRemove: RemoveFolder | null;
  scripts: SetupScript[] | null;
}

/** What `setWorktreeSettings` takes: `undefined` leaves a field alone, `null` puts it back to the default. */
export interface WorktreeSettingsPatch {
  root?: string | null;
  base?: string | null;
  setup?: string | null;
  start?: StartMode | null;
  allowSwitch?: boolean | null;
  carry?: CarryChanges | null;
  branchMode?: BranchMode | null;
  branchPrefix?: string | null;
  remove?: RemoveFolder | null;
  scripts?: SetupScript[] | null;
}

function parseScripts(json: string | null): SetupScript[] | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? (value as SetupScript[]) : null;
  } catch {
    return null;
  }
}

/** `workspaces` (known folders) and `settings` (UI preferences). */
@Injectable()
export class MetaRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** The projects in the order the sidebar lists them. */
  listWorkspaces(): WorkspaceRow[] {
    const rows = this.db
      .prepare('SELECT cwd, name, last_opened_at, sort_order, collapsed, hidden, attendant_off, agents_off, worktree_root, worktree_base, wt_start, wt_allow_switch, wt_carry, wt_branch_mode, wt_branch_prefix, wt_remove, wt_scripts FROM workspaces WHERE forgotten = 0 ORDER BY sort_order ASC, last_opened_at DESC, cwd ASC')
      .all() as {
      cwd: string;
      name: string;
      last_opened_at: number;
      sort_order: number;
      collapsed: number;
      hidden: number;
      attendant_off: number;
      agents_off: number;
      worktree_root: string | null;
      worktree_base: string | null;
      wt_start: StartMode | null;
      wt_allow_switch: number | null;
      wt_carry: CarryChanges | null;
      wt_branch_mode: BranchMode | null;
      wt_branch_prefix: string | null;
      wt_remove: RemoveFolder | null;
      wt_scripts: string | null;
    }[];
    return rows.map((r) => ({
      cwd: r.cwd,
      name: r.name,
      lastOpenedAt: r.last_opened_at,
      sortOrder: r.sort_order,
      collapsed: r.collapsed === 1,
      hidden: r.hidden === 1,
      attendantOff: r.attendant_off === 1,
      agentsOff: r.agents_off === 1,
      worktreeRoot: r.worktree_root,
      worktreeBase: r.worktree_base,
      wtStart: r.wt_start,
      wtAllowSwitch: r.wt_allow_switch === null ? null : r.wt_allow_switch === 1,
      wtCarry: r.wt_carry,
      wtBranchMode: r.wt_branch_mode,
      wtBranchPrefix: r.wt_branch_prefix,
      wtRemove: r.wt_remove,
      scripts: parseScripts(r.wt_scripts),
    }));
  }

  /**
   * One project's worktree settings; a blank value is stored as "use the default". The single `setup` command is a shorthand for the first
   * setup script: it replaces that script's command (blank removes the script), or becomes the only script when none were configured.
   */
  setWorktreeSettings(cwd: string, patch: WorktreeSettingsPatch): boolean {
    const sets: string[] = [];
    const args: unknown[] = [];
    const text = (value: string | null | undefined): string | null | undefined => (value === undefined ? undefined : value === null || value.trim() === '' ? null : value.trim());
    const put = (column: string, value: unknown): void => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      args.push(value);
    };
    const row = this.listWorkspaces().find((w) => w.cwd === cwd);
    if (!row) return false;
    put('worktree_root', text(patch.root));
    put('worktree_base', text(patch.base));
    put('wt_start', patch.start);
    put('wt_allow_switch', patch.allowSwitch === undefined ? undefined : patch.allowSwitch === null ? null : patch.allowSwitch ? 1 : 0);
    put('wt_carry', patch.carry);
    put('wt_branch_mode', patch.branchMode);
    put('wt_branch_prefix', patch.branchPrefix);
    put('wt_remove', patch.remove);
    let scripts = patch.scripts;
    const setup = text(patch.setup);
    if (scripts === undefined && setup !== undefined) {
      // The single command is the first script's. Never configured: it becomes the only script, or "none" when blank.
      const current = row.scripts ?? [];
      scripts = setup === null ? current.slice(1) : [{ ...(current[0] ?? { id: 'setup', name: 'Setup' }), command: setup }, ...current.slice(1)];
    }
    if (scripts !== undefined) {
      put('wt_scripts', scripts === null ? null : JSON.stringify(scripts));
    }
    if (sets.length === 0) return true;
    return this.db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE cwd = ?`).run(...args, cwd).changes > 0;
  }

  /** A project's sidebar flags; false when the folder is not a known workspace. */
  patchWorkspace(cwd: string, patch: { collapsed?: boolean; hidden?: boolean; attendantOff?: boolean; agentsOff?: boolean }): boolean {
    const sets: string[] = [];
    const args: unknown[] = [];
    const flags: [string, boolean | undefined][] = [
      ['collapsed', patch.collapsed],
      ['hidden', patch.hidden],
      ['attendant_off', patch.attendantOff],
      ['agents_off', patch.agentsOff],
    ];
    for (const [column, value] of flags) {
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      args.push(value ? 1 : 0);
    }
    if (sets.length === 0) return this.listWorkspaces().some((w) => w.cwd === cwd);
    return this.db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE cwd = ?`).run(...args, cwd).changes > 0;
  }

  /** Numbers the projects 1..n in the given order; folders the list does not name keep their relative order after it. */
  orderWorkspaces(order: readonly string[]): void {
    const known = this.listWorkspaces().map((w) => w.cwd);
    const named = order.filter((cwd) => known.includes(cwd));
    const rest = known.filter((cwd) => !named.includes(cwd));
    const set = this.db.prepare('UPDATE workspaces SET sort_order = ? WHERE cwd = ?');
    this.db.transaction(() => [...named, ...rest].forEach((cwd, index) => set.run(index + 1, cwd)))();
  }

  /**
   * A known workspace folder from a route parameter (`:id` is the URL-encoded path and Express has decoded it); the panels
   * only ever touch folders the app knows, never an arbitrary path a request names.
   */
  requireWorkspace(cwd: string): string {
    if (!existsSync(cwd) || !(this.listWorkspaces().some((w) => w.cwd === cwd) || this.isWorktree(cwd))) throw new NotFoundException(`Workspace ${cwd} is not known.`);
    return cwd;
  }

  /** The folder is the worktree of a thread: the Files, Terminal and watch panels work in it as in a project. */
  isWorktree(cwd: string): boolean {
    return this.db.prepare('SELECT 1 FROM threads WHERE worktree_path = ? LIMIT 1').get(cwd) !== undefined;
  }

  /**
   * Remembers a folder; `openedAt` only moves forward. A folder the person forgot (Settings › Projects) comes back when they open it again (the default); the pass
   * that reads pi's session files is `passive`, so threads that are still on disk do not bring a forgotten project back.
   */
  touchWorkspace(cwd: string, openedAt = Date.now(), options: { passive?: boolean } = {}): void {
    this.db
      .prepare(
        // A new project goes to the end of the sidebar.
        `INSERT INTO workspaces (cwd, name, last_opened_at, sort_order, forgotten) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM workspaces), 0)
         ON CONFLICT (cwd) DO UPDATE SET last_opened_at = MAX(last_opened_at, excluded.last_opened_at), forgotten = CASE WHEN ? = 1 THEN forgotten ELSE 0 END`,
      )
      .run(cwd, basename(cwd) || cwd, openedAt, options.passive ? 1 : 0);
  }

  /** Takes a folder off the list of projects without touching its threads or files; false when it is not listed. Its settings are kept for when it is added again. */
  forgetWorkspace(cwd: string): boolean {
    return this.db.prepare('UPDATE workspaces SET forgotten = 1 WHERE cwd = ? AND forgotten = 0').run(cwd).changes > 0;
  }

  getSetting(key: string): unknown {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json')
      .run(key, JSON.stringify(value));
  }

  allSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[];
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json)]));
  }

  learningThreads(): Record<string, string> {
    return (this.getSetting('learning-threads') as Record<string, string> | undefined) ?? {};
  }

  learningSource(threadId: string): string | undefined {
    return this.learningThreads()[threadId];
  }

  markLearningThread(threadId: string, sourceId: string): void {
    this.setSetting('learning-threads', { ...this.learningThreads(), [threadId]: sourceId });
  }

  // ---- verification threads

  /** The threads that are verification runs, each with the draft it replays. They are marked here, not in `threads`, so the table stays as it is (the attendant, the outcomes and the learning service ask). */
  verificationThreads(): Record<string, string> {
    return (this.getSetting(VERIFICATION_THREADS) as Record<string, string> | undefined) ?? {};
  }

  isVerificationThread(threadId: string): boolean {
    return Object.hasOwn(this.verificationThreads(), threadId);
  }

  markVerificationThread(threadId: string, draftId: string): void {
    const marks = { ...this.verificationThreads(), [threadId]: draftId };
    // The newest few hundred; an older one is a thread long gone.
    this.setSetting(VERIFICATION_THREADS, Object.fromEntries(Object.entries(marks).slice(-500)));
  }
}

const VERIFICATION_THREADS = 'learn-verification-threads';
