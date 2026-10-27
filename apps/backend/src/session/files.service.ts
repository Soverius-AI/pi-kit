import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Injectable, Optional } from '@nestjs/common';
import { type FileMatch, type FileNode, fuzzyScore } from '@pi-kit/protocol';
import { GIT_ENV } from '../changes/git';
import { WatchService } from '../watch/watch.service';
import { SKIP_DIRS, rootIgnores } from './ignore';

const run = promisify(execFile);

const MAX_FILES = 50_000;
const CACHE_MS = 5000;
/** A folder with more entries than this is listed without size and time (one stat each is what the column costs). */
const STAT_LIMIT = 3000;

interface Index {
  files: string[];
  /** The folder is inside a git work tree (otherwise the list is a bounded walk). */
  git: boolean;
}

/**
 * `@file` completion and the Files panel's tree: paths under a workspace folder, ignore-aware. In a git repository the list
 * is `git ls-files --cached --others --exclude-standard` (tracked plus untracked-but-not-ignored, so
 * `.gitignore` and the global excludes apply) plus files whose deletion is staged; otherwise a bounded walk that honours a root `.gitignore`
 * (plain names and `dir/` entries) and skips the usual build folders. Lists are cached for a few seconds, and forgotten when the
 * folder watcher reports a change.
 */
@Injectable()
export class FilesService {
  private readonly cache = new Map<string, { at: number; index: Promise<Index> }>();
  private readonly ignoredCache = new Map<string, { at: number; list: Promise<string[]> }>();

  constructor(@Optional() watch?: WatchService) {
    watch?.onBatch((cwd) => this.refresh(cwd));
  }

  async search(cwd: string, query: string, limit = 50): Promise<FileMatch[]> {
    const { files } = await this.index(cwd);
    const entries: FileMatch[] = [...files.map((path) => ({ path })), ...directories(files).map((path) => ({ path, dir: true }))];
    const q = query.trim().replace(/^\.?\//, '');
    if (q === '') {
      // No query: the top level first, shallow before deep.
      return entries
        .filter((e) => !e.path.replace(/\/$/, '').includes('/'))
        .sort((a, b) => Number(b.dir ?? false) - Number(a.dir ?? false) || a.path.localeCompare(b.path))
        .slice(0, limit);
    }
    const scored: { entry: FileMatch; score: number }[] = [];
    for (const entry of entries) {
      const base = entry.path.replace(/\/$/, '').split('/').pop() as string;
      const whole = fuzzyScore(q, entry.path);
      if (whole < 0) continue;
      // A hit on the file name itself beats one spread over the folders.
      const name = fuzzyScore(q, base);
      scored.push({ entry, score: whole + (name >= 0 ? 12 + name : 0) - (entry.dir ? 1 : 0) });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  /**
   * The entries directly under `dir` (relative to the folder, '' for the root), folders first, with size and modification time.
   * It reads the same ignore-aware index as `@` completion, so the panel never shows what git ignores unless `showIgnored` asks for
   * it (then ignored entries are listed too, marked `ignored`). A file that git still knows but the disk no longer has is `missing`.
   */
  async children(cwd: string, dir = '', options: { showIgnored?: boolean } = {}): Promise<FileNode[]> {
    const { files, git } = await this.index(cwd);
    const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
    const names = new Map<string, { dir: boolean; ignored: boolean }>();
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) names.set(rest, { dir: names.get(rest)?.dir ?? false, ignored: false });
      else names.set(rest.slice(0, slash), { dir: true, ignored: false });
    }
    // A folder with no file in it (just made with "New folder") is in no file list, but the panel should show it.
    for (const entry of safeReaddir(join(cwd, dir.replace(/\/$/, '')))) {
      if (entry.isDirectory() && !names.has(entry.name) && entry.name !== '.git' && !SKIP_DIRS.has(entry.name) && holdsNoFile(join(cwd, prefix, entry.name))) {
        names.set(entry.name, { dir: true, ignored: false });
      }
    }
    if (options.showIgnored) {
      const ignored = git ? await this.ignoredPaths(cwd) : [];
      for (const [name, entry] of this.ignoredChildren(cwd, dir, prefix, ignored, git)) if (!names.has(name)) names.set(name, entry);
    }
    const nodes: FileNode[] = [...names].map(([name, entry]) => ({ name, path: `${prefix}${name}`, dir: entry.dir, ...(entry.ignored ? { ignored: true } : {}) }));
    nodes.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return nodes.length <= STAT_LIMIT ? Promise.all(nodes.map((node) => withStat(cwd, node))) : nodes;
  }

  /** Forget the cached index (after a revert or a write the panel should see, and when the watcher saw a change). */
  refresh(cwd: string): void {
    this.cache.delete(cwd);
    this.ignoredCache.delete(cwd);
  }

  private index(cwd: string): Promise<Index> {
    const hit = this.cache.get(cwd);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.index;
    const index = listFiles(cwd);
    this.cache.set(cwd, { at: Date.now(), index });
    return index;
  }

  /** Ignored files and folders (`dist/`, `.env`, `src/gen/a.js`) of a git folder, folders collapsed to their name with a trailing slash. */
  private ignoredPaths(cwd: string): Promise<string[]> {
    const hit = this.ignoredCache.get(cwd);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
    const list = run('git', ['-C', cwd, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { maxBuffer: 128 * 1024 * 1024, encoding: 'utf8', env: GIT_ENV })
      .then(({ stdout }) => stdout.split('\0').filter(Boolean))
      .catch(() => []);
    this.ignoredCache.set(cwd, { at: Date.now(), list });
    return list;
  }

  /** What "Show ignored" adds under `dir`. */
  private ignoredChildren(cwd: string, dir: string, prefix: string, ignored: readonly string[], git: boolean): Map<string, { dir: boolean; ignored: boolean }> {
    const out = new Map<string, { dir: boolean; ignored: boolean }>();
    const base = dir.replace(/\/$/, '');
    // Inside an ignored folder everything is ignored: read the disk.
    const inside = base !== '' && (git ? ignored.some((p) => p.endsWith('/') && (base === p.slice(0, -1) || base.startsWith(p))) : isUnderSkipped(cwd, base));
    if (inside) {
      for (const entry of safeReaddir(join(cwd, base))) if (entry.name !== '.git') out.set(entry.name, { dir: entry.isDirectory(), ignored: true });
      return out;
    }
    if (git) {
      for (const path of ignored) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const trailing = rest.endsWith('/');
        const clean = trailing ? rest.slice(0, -1) : rest;
        const slash = clean.indexOf('/');
        if (slash < 0) out.set(clean, { dir: trailing, ignored: true });
        else out.set(clean.slice(0, slash), { dir: true, ignored: true });
      }
      return out;
    }
    const names = rootIgnores(cwd);
    for (const entry of safeReaddir(join(cwd, base))) {
      if (entry.name === '.git') continue;
      if (SKIP_DIRS.has(entry.name) || names.has(entry.name)) out.set(entry.name, { dir: entry.isDirectory(), ignored: true });
    }
    return out;
  }
}

const safeReaddir = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** Is this folder empty, or only folders with nothing in them? Stops at the first file, so a big ignored folder costs one read. */
function holdsNoFile(dir: string, depth = 0): boolean {
  if (depth > 6) return false;
  for (const entry of safeReaddir(dir)) {
    if (!entry.isDirectory()) return false;
    if (!holdsNoFile(join(dir, entry.name), depth + 1)) return false;
  }
  return true;
}

/** Without git: is `base` a folder the walk skips (or inside one)? */
function isUnderSkipped(cwd: string, base: string): boolean {
  const names = rootIgnores(cwd);
  return base.split('/').some((segment) => SKIP_DIRS.has(segment) || names.has(segment));
}

async function withStat(cwd: string, node: FileNode): Promise<FileNode> {
  try {
    const info = await stat(join(cwd, node.path));
    return { ...node, ...(node.dir ? {} : { size: info.size }), mtime: Math.round(info.mtimeMs) };
  } catch {
    // Known to git, gone from the disk: a deleted file keeps its row (with the D badge) until it is committed or restored.
    return node.dir ? node : { ...node, missing: true };
  }
}

async function listFiles(cwd: string): Promise<Index> {
  try {
    const { stdout } = await run('git', ['-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      maxBuffer: 128 * 1024 * 1024,
      env: GIT_ENV,
    });
    // A deletion that is staged (`git rm`) is no longer in the index, but the panel keeps showing it until it is committed.
    const staged = await run('git', ['-C', cwd, 'diff', '--cached', '--name-only', '--diff-filter=D', '--relative', '-z', '--', '.'], { maxBuffer: 16 * 1024 * 1024, env: GIT_ENV })
      .then(({ stdout: out }) => out.split('\0').filter(Boolean))
      .catch(() => []);
    return { files: [...new Set([...stdout.split('\0').filter(Boolean), ...staged])].slice(0, MAX_FILES), git: true };
  } catch {
    return { files: walk(cwd), git: false };
  }
}

function walk(root: string): string[] {
  const ignored = rootIgnores(root);
  const out: string[] = [];
  const visit = (dir: string, prefix: string, depth: number): void => {
    if (out.length >= MAX_FILES || depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || ignored.has(entry.name)) continue;
      if (entry.isDirectory()) visit(join(dir, entry.name), `${prefix}${entry.name}/`, depth + 1);
      else if (entry.isFile()) out.push(`${prefix}${entry.name}`);
    }
  };
  visit(root, '', 0);
  return out;
}

/** Every folder that holds a file, as `a/b/`. */
function directories(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  return [...dirs];
}
