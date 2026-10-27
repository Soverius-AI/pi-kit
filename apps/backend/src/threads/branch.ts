import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * The `HEAD` of the repository a folder is in, read from the repository's `HEAD` file with no process spawned: the folder itself or the nearest parent that has a
 * `.git` (a folder, or the file a linked working tree has). `branch` is the checked-out branch, null when `HEAD` is detached (then `short` is the short commit).
 * Null when the folder is not inside a git working tree or the repository cannot be read.
 */
export function readHead(cwd: string): { branch: string | null; detached: boolean; short: string | null } | null {
  try {
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      const dotGit = join(dir, '.git');
      let stat;
      try {
        stat = statSync(dotGit);
      } catch {
        if (dirname(dir) === dir) return null;
        continue;
      }
      let gitDir = dotGit;
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
        if (!pointer) return null;
        gitDir = resolve(dir, pointer[1].trim());
      }
      const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      if (ref) return { branch: ref[1], detached: false, short: null };
      return /^[0-9a-f]{7,64}$/i.test(head) ? { branch: null, detached: true, short: head.slice(0, 7) } : null;
    }
  } catch {
    return null;
  }
}

/**
 * The branch a project's folder has checked out (a project row of the sidebar shows it). A detached `HEAD` shows the short commit. Null when the folder is not
 * inside a git working tree or the repository cannot be read.
 */
export function currentBranch(cwd: string): string | null {
  const head = readHead(cwd);
  return head ? (head.branch ?? head.short) : null;
}
