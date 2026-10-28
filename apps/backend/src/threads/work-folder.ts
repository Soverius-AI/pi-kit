import { existsSync } from 'node:fs';
import type { ThreadRow } from '../db/threads.repository';

/** The folder pi works in for the row: its worktree while that exists, else the project's folder. */
export function workFolderOf(row: ThreadRow): string {
  return row.worktreePath && existsSync(row.worktreePath) ? row.worktreePath : row.cwd;
}
