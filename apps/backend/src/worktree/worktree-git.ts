import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type FileStatusEntry, parseStatusZ } from '@pi-kit/protocol';
import { GIT_ENV } from '../changes/git';

const exec = promisify(execFile);

export interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git in `cwd` and says how it went instead of throwing: a merge that stops on conflicts is an answer, not an error. */
export async function run(cwd: string, args: readonly string[], options: { identity?: boolean; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<GitResult> {
  const prefix = options.identity ? ['-c', 'user.name=pi-kit', '-c', 'user.email=pi-kit@localhost'] : [];
  try {
    const { stdout, stderr } = await exec('git', ['-C', cwd, '-c', 'core.quotepath=off', ...prefix, ...args], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', ...options.env },
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number | string; message: string };
    return { ok: false, code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: (e.stderr || e.message || '').trim() };
  }
}

/** stdout of a git command that must work; its own message otherwise. */
export async function out(cwd: string, args: readonly string[], options?: { identity?: boolean; timeoutMs?: number; env?: Record<string, string> }): Promise<string> {
  const result = await run(cwd, args, options);
  if (!result.ok) throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}

/** The checked-out branch, or null on a detached `HEAD`. */
export async function branchOf(cwd: string): Promise<string | null> {
  const result = await run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return result.ok ? result.stdout.trim() || null : null;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await run(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok;
}

/** The top of the work tree `cwd` is in. */
export async function toplevel(cwd: string): Promise<string | null> {
  const result = await run(cwd, ['rev-parse', '--show-toplevel']);
  return result.ok ? result.stdout.trim() : null;
}

/** `git worktree add <path> -b <branch> <start>`; without a branch the worktree is detached at `start`. */
export async function addWorktree(project: string, path: string, branch: string | null, start: string): Promise<void> {
  await out(project, ['worktree', 'add', '--quiet', ...(branch ? [path, '-b', branch] : ['--detach', path]), start]);
}

/** Is this a name git accepts for a branch? */
export async function validBranchName(cwd: string, name: string): Promise<boolean> {
  if (name.startsWith('-')) return false;
  return (await run(cwd, ['check-ref-format', '--branch', name])).ok;
}

/** The local branches and, per branch, the other work tree (not `cwd`'s own) that has it checked out. */
export async function localBranches(cwd: string): Promise<{ name: string; heldBy: string | null }[]> {
  const [names, trees] = await Promise.all([out(cwd, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads']), listWorktrees(cwd).catch(() => [])]);
  const top = await toplevel(cwd);
  const held = new Map<string, string>();
  for (const tree of trees) if (tree.branch && tree.path !== top) held.set(tree.branch, tree.path);
  return names
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean)
    .map((name) => ({ name, heldBy: held.get(name) ?? null }));
}

/** `origin/<branch>` and the other remotes' branches, without the `HEAD` pointer. */
export async function remoteBranches(cwd: string): Promise<string[]> {
  const result = await run(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  return result.ok ? result.stdout.split('\n').map((n) => n.trim()).filter((n) => n && !n.endsWith('/HEAD') && n.includes('/')) : [];
}

/**
 * The folder's uncommitted changes (staged, unstaged and untracked, ignored files left out) as a binary patch against `HEAD`, made through a temporary index so
 * neither the index nor the working tree of `cwd` is touched ("carry changes"). `files` are the paths it changes.
 */
export async function workingTreePatch(cwd: string): Promise<{ patch: string; files: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'pk-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await out(cwd, ['read-tree', 'HEAD'], { env });
    await out(cwd, ['add', '-A', '--', ':/'], { env });
    const tree = (await out(cwd, ['write-tree'], { env })).trim();
    const files = (await out(cwd, ['diff-tree', '-r', '--name-only', '--no-renames', 'HEAD', tree])).split('\n').filter(Boolean);
    if (files.length === 0) return { patch: '', files };
    return { patch: await out(cwd, ['diff-tree', '-p', '-r', '--binary', '--full-index', '--no-renames', 'HEAD', tree]), files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Applies a patch of `workingTreePatch` to the working tree of `cwd` (as uncommitted changes; new files are untracked). The failure is git's message. */
export async function applyPatch(cwd: string, patch: string): Promise<void> {
  if (!patch) return;
  const dir = mkdtempSync(join(tmpdir(), 'pk-patch-'));
  const file = join(dir, 'changes.patch');
  try {
    writeFileSync(file, patch);
    await out(cwd, ['apply', '--binary', '--whitespace=nowarn', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `git worktree remove`, without `force` only when the worktree is clean; the branch is deleted when `deleteBranch` names it (merged branches only: `-d`). */
export async function removeWorktree(project: string, path: string, options: { force?: boolean; deleteBranch?: string } = {}): Promise<void> {
  await out(project, ['worktree', 'remove', ...(options.force ? ['--force'] : []), path]);
  if (options.deleteBranch) await run(project, ['branch', options.force ? '-D' : '-d', options.deleteBranch]);
}

export interface ListedWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain`. */
export async function listWorktrees(project: string): Promise<ListedWorktree[]> {
  const text = await out(project, ['worktree', 'list', '--porcelain']);
  const list: ListedWorktree[] = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean);
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!path) continue;
    list.push({
      path,
      head: lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? null,
      branch: lines.find((l) => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? null,
      bare: lines.includes('bare'),
      locked: lines.some((l) => l.startsWith('locked')),
      prunable: lines.some((l) => l.startsWith('prunable')),
    });
  }
  return list;
}

/** Changed files of a work tree: staged, unstaged and untracked, with the badge the Files panel uses. */
export async function changedFiles(cwd: string): Promise<FileStatusEntry[]> {
  return parseStatusZ(await out(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--find-renames']), '');
}

/** Tracked files that differ from `HEAD` (untracked files do not block a merge in the main checkout). */
export async function trackedChanges(cwd: string): Promise<number> {
  const text = await out(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  return text.split('\0').filter((item) => item.length >= 4).length;
}

/** Commits on `base` that the branch lacks (`behind`) and commits on the branch that `base` lacks (`ahead`). */
export async function aheadBehind(cwd: string, base: string): Promise<{ ahead: number; behind: number }> {
  const result = await run(cwd, ['rev-list', '--left-right', '--count', `${base}...HEAD`]);
  if (!result.ok) return { ahead: 0, behind: 0 };
  const [behind, ahead] = result.stdout.trim().split(/\s+/).map(Number);
  return { ahead: ahead || 0, behind: behind || 0 };
}

/** Files with unresolved conflicts. */
export async function conflictedFiles(cwd: string): Promise<string[]> {
  const result = await run(cwd, ['diff', '--name-only', '--diff-filter=U']);
  return result.ok ? result.stdout.split('\n').filter(Boolean) : [];
}

/**
 * Conflicted files the person has not resolved yet: git keeps a file unmerged until it is staged, so a file counts as resolved when it has no conflict
 * markers left (a binary file never does: it stays until it is staged). Merging back stages the resolved ones.
 */
export async function unresolvedFiles(cwd: string): Promise<string[]> {
  const unmerged = await conflictedFiles(cwd);
  return unmerged.filter((file) => {
    try {
      const text = readFileSync(join(cwd, file), 'latin1');
      return text.includes('\0') || /^<{7}( |$)/m.test(text);
    } catch {
      // Deleted by the resolution: nothing left to resolve.
      return false;
    }
  });
}

/** A merge or a rebase that stopped and waits for the person. */
export async function operationInProgress(cwd: string): Promise<'merge' | 'rebase' | null> {
  const gitPath = async (name: string): Promise<string | null> => {
    const result = await run(cwd, ['rev-parse', '--git-path', name]);
    if (!result.ok) return null;
    const path = result.stdout.trim();
    return isAbsolute(path) ? path : resolve(cwd, path);
  };
  const merge = await gitPath('MERGE_HEAD');
  if (merge && existsSync(merge)) return 'merge';
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const path = await gitPath(name);
    if (path && existsSync(path)) return 'rebase';
  }
  return null;
}

export async function hasRemote(cwd: string): Promise<boolean> {
  const result = await run(cwd, ['remote']);
  return result.ok && result.stdout.trim().length > 0;
}

/** Is `ancestor` contained in `descendant`? */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await run(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])).ok;
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok;
}

/** Whether git has a committer identity to write commits with. */
export async function hasIdentity(cwd: string): Promise<boolean> {
  const [name, email] = await Promise.all([run(cwd, ['config', 'user.name']), run(cwd, ['config', 'user.email'])]);
  return name.ok && email.ok && name.stdout.trim() !== '' && email.stdout.trim() !== '';
}

/** `git add -A` and `git commit` in the worktree; a missing git identity falls back to "pi-kit" so a commit never fails for that alone. */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await out(cwd, ['add', '-A', '--', '.']);
  const identity = !(await hasIdentity(cwd));
  await out(cwd, ['commit', '--quiet', '-m', message], { identity });
  return (await out(cwd, ['rev-parse', '--short', 'HEAD'])).trim();
}

export async function headCommit(cwd: string): Promise<string> {
  return (await out(cwd, ['rev-parse', '--short', 'HEAD'])).trim();
}
