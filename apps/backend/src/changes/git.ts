import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { type FileStatusEntry, parseStatusZ } from '@pi-kit/protocol';

const run = promisify(execFile);

/**
 * The environment of every git call: `GIT_OPTIONAL_LOCKS=0` is git's documented switch for tools that run `git status` in the
 * background. Without it `status` refreshes the index and takes `index.lock` while it does, which can make the user's own `git commit`
 * in a terminal fail, and rewrites `.git/index`, which the folder watcher would then report as a change (a loop).
 */
export const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

/**
 * A reading git call that runs longer than this is killed, so a stuck repository cannot pile up processes behind the refreshes. Commands that
 * write (add, checkout, rm, init) pass `timeout: 0`: killing one half-way would leave `.git/index.lock` behind and break every later git command.
 */
export const GIT_TIMEOUT_MS = 30_000;

/** What `baseRevision()` answers in a repository without commits, where there is no `HEAD` to compare with. */
export const NO_HEAD = 'no-head';

/** Runs git in `cwd`; resolves with stdout, rejects with git's own message. */
export async function git(
  cwd: string,
  args: readonly string[],
  options: { allowFail?: boolean; timeout?: number; env?: Record<string, string> } = {},
): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', cwd, '-c', 'core.quotepath=off', ...args], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'utf8',
      env: options.env ? { ...GIT_ENV, ...options.env } : GIT_ENV,
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return stdout;
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number; message: string };
    // `git diff --no-index` and a few others exit 1 when there is something to report.
    if (options.allowFail && typeof e.stdout === 'string') return e.stdout;
    throw new Error((e.stderr || e.message).trim(), { cause: error });
  }
}

/** Is `cwd` inside a git work tree? */
export async function isWorkTree(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

/** The revision to compare the work tree with: `HEAD`, or `NO_HEAD` before the first commit (every file is then a new file). */
export async function baseRevision(cwd: string): Promise<string> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return 'HEAD';
  } catch {
    return NO_HEAD;
  }
}

export interface StatusEntry {
  /** Relative to `cwd`. */
  path: string;
  /** Index and work tree columns of `git status --porcelain`. */
  x: string;
  y: string;
}

/**
 * Entries of `git status --porcelain=v1 -z --untracked-files=all` under `cwd`. Git reports paths from the repository
 * root; they are made relative to `cwd`, and files above it (in the same repository) are left out.
 */
export async function statusEntries(cwd: string): Promise<StatusEntry[]> {
  const prefix = (await git(cwd, ['rev-parse', '--show-prefix'])).trim();
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.']);
  const entries: StatusEntry[] = [];
  for (const item of out.split('\0')) {
    if (item.length < 4) continue;
    const path = item.slice(3);
    if (prefix && !path.startsWith(prefix)) continue;
    entries.push({ x: item[0], y: item[1], path: path.slice(prefix.length) });
  }
  return entries;
}

/**
 * What the Files panel decorates: every changed file under `cwd` with its badge letter, renames detected (the
 * Changes panel's `statusEntries` turns them into a delete and an add), untracked files listed one by one.
 */
export async function statusBadges(cwd: string): Promise<FileStatusEntry[]> {
  const prefix = (await git(cwd, ['rev-parse', '--show-prefix'])).trim();
  const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--find-renames', '--', '.']);
  return parseStatusZ(out, prefix);
}

/** `git diff <base> --numstat`: added and removed lines per file (`null` for a binary file), relative to `cwd`. */
export async function numstat(
  cwd: string,
  base: string,
  head?: string,
): Promise<Map<string, { added: number; removed: number } | null>> {
  if (base === NO_HEAD) return new Map();
  const out = await git(cwd, [
    'diff',
    base,
    ...(head ? [head] : []),
    '--numstat',
    '-z',
    '--no-renames',
    '--relative',
    '--no-ext-diff',
    '--',
    '.',
  ]);
  const map = new Map<string, { added: number; removed: number } | null>();
  for (const item of out.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(item);
    if (!match) continue;
    map.set(match[3], match[1] === '-' ? null : { added: Number(match[1]), removed: Number(match[2]) });
  }
  return map;
}

/** The unified diff of one file against `base` (staged and unstaged together). */
export function diffFile(cwd: string, base: string, path: string, head?: string): Promise<string> {
  return git(cwd, [
    'diff',
    base,
    ...(head ? [head] : []),
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    '--relative',
    '-U3',
    '--',
    path,
  ]);
}

/** `git diff --name-status -z base head`: the status letter of every file the two commits differ in, relative to `cwd` (a rename is a delete and an add). */
export async function nameStatusRange(cwd: string, base: string, head: string): Promise<Map<string, 'A' | 'M' | 'D'>> {
  const out = await git(cwd, [
    'diff',
    '--name-status',
    '-z',
    '--no-renames',
    '--relative',
    '--no-ext-diff',
    base,
    head,
    '--',
    '.',
  ]);
  const items = out.split('\0');
  const map = new Map<string, 'A' | 'M' | 'D'>();
  for (let i = 0; i + 1 < items.length; i += 2) {
    const letter = items[i];
    map.set(items[i + 1], letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M');
  }
  return map;
}

export async function inHead(cwd: string, path: string): Promise<boolean> {
  try {
    await git(cwd, ['cat-file', '-e', `HEAD:./${path}`]);
    return true;
  } catch {
    return false;
  }
}

export async function isTracked(cwd: string, path: string): Promise<boolean> {
  return await git(cwd, ['ls-files', '--error-unmatch', '--', path]).then(
    () => true,
    () => false,
  );
}

/** `git add -A` for the whole folder, or only `files`. */
export async function stage(cwd: string, files?: readonly string[]): Promise<void> {
  if (files && files.length > 0) await git(cwd, ['add', '-A', '--', ...files], { timeout: 0 });
  else await git(cwd, ['add', '-A', '--', '.'], { timeout: 0 });
}

/** Puts a file back to what `HEAD` has; a file that is new (not in `HEAD`) is removed from the index and the disk. */
export async function restoreToHead(cwd: string, path: string): Promise<'restored' | 'removed'> {
  if (await inHead(cwd, path)) {
    await git(cwd, ['checkout', 'HEAD', '--', path], { timeout: 0 });
    return 'restored';
  }
  if (await isTracked(cwd, path)) await git(cwd, ['rm', '-f', '--quiet', '--', path], { timeout: 0 });
  return 'removed';
}
