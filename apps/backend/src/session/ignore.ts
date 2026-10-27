import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Folders never worth offering or watching when there is no git to say what is ignored: dependencies, build output and tool caches. */
export const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nx', '.angular', '.cache', 'coverage', '__pycache__', '.venv', 'target',
  '.pnpm-store', 'bower_components', '.turbo', '.parcel-cache', '.svelte-kit', '.nuxt', '.gradle', '.terraform', '.tox', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.direnv', '.dart_tool',
]);

/**
 * What git ignores under `root`, relative to it: whole ignored directories (without the trailing `/`) and ignored files outside them.
 * Empty when `root` is not in a repository or git fails. The watcher skips these, so a cache or build folder of any name costs no watches.
 */
export function gitIgnoredPaths(root: string): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory', '-z'],
      { cwd: root, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => resolve(error ? new Set() : new Set(stdout.split('\0').filter(Boolean).map((path) => path.replace(/\/$/, '')))),
    );
  });
}

/** Names from a root `.gitignore` that need no glob matching (`foo`, `foo/`, `/foo`). */
export function rootIgnores(root: string): Set<string> {
  const file = join(root, '.gitignore');
  if (!existsSync(file)) return new Set();
  const names = new Set<string>();
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || /[*?[\]]/.test(line)) continue;
    names.add(line.replace(/^\//, '').replace(/\/$/, ''));
  }
  return names;
}

/**
 * The only things inside `.git` the watcher looks at. The index changes on `git add` and reset, HEAD and the reflog on checkout and
 * commit (a commit does not always rewrite the index, so without the reflog and the branch refs a commit made in a terminal would
 * leave stale badges), `refs/heads` and `packed-refs` when a branch moves.
 */
const GIT_WATCHED = new Set(['.git', '.git/index', '.git/HEAD', '.git/logs', '.git/logs/HEAD', '.git/refs', '.git/refs/heads', '.git/packed-refs']);
const gitWatched = (rel: string): boolean => GIT_WATCHED.has(rel) || rel.startsWith('.git/refs/heads/');

/**
 * Should the watcher (and so the live refresh) skip this path? `rel` is relative to the folder with `/` separators.
 * `.git` is skipped except for the files that change when a commit, checkout, add or reset happens in a terminal (the badges must follow); build and
 * dependency folders, the names a root `.gitignore` lists and the paths git ignores (`gitIgnoredPaths`) are skipped so a `node_modules`
 * never costs a thousand handles.
 */
export function watchIgnored(rel: string, names: ReadonlySet<string>, ignoredPaths: ReadonlySet<string> = new Set()): boolean {
  if (!rel || rel === '.') return false;
  const segments = rel.split('/');
  if (segments[0] === '.git') return !gitWatched(rel);
  if (segments.some((segment) => SKIP_DIRS.has(segment) || names.has(segment))) return true;
  if ([...names].some((name) => name.includes('/') && (rel === name || rel.startsWith(`${name}/`)))) return true;
  if (ignoredPaths.size === 0) return false;
  for (let i = 1; i <= segments.length; i++) if (ignoredPaths.has(segments.slice(0, i).join('/'))) return true;
  return false;
}
