import { z } from 'zod';

/**
 * The git decoration of the Files panel. One letter per changed file, the same tints as the Changes
 * panel (modified warning, added success, deleted error) plus untracked, conflict and renamed. Pure and shared: the backend
 * turns `git status --porcelain` columns into badges, the renderer words and tints them and derives the folder dots.
 */

export const GitBadgeSchema = z.enum(['A', 'M', 'D', 'U', 'C', 'R']);
export type GitBadge = z.infer<typeof GitBadgeSchema>;

export const FileStatusEntrySchema = z.object({
  /** Relative to the workspace folder, `/` separators. */
  path: z.string(),
  badge: GitBadgeSchema,
  /** The change is in the index (staged); false for work tree only changes and untracked files. */
  staged: z.boolean(),
  /** A rename: the path the file had before. */
  from: z.string().optional(),
});
export type FileStatusEntry = z.infer<typeof FileStatusEntrySchema>;

/** `GET /api/workspaces/:id/status`: git's view of the folder, and the files pi changed in the thread. */
export const WorkspaceStatusSchema = z.object({
  /** The folder is inside a git work tree (otherwise `entries` is empty and only the thread marker exists). */
  git: z.boolean(),
  entries: z.array(FileStatusEntrySchema),
  /** Files pi edited or wrote in the thread (the "changed in this thread" marker, from `change_baselines` and the session), relative paths. */
  thread: z.array(z.string()),
  /** More files changed than the list carries. */
  truncated: z.boolean().optional(),
}).meta({ id: 'WorkspaceStatus' });
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

/** What the badge letter stands for, its tint (a daisyUI colour name) and its order when a folder has to pick one. */
export const GIT_BADGES: Record<GitBadge, { label: string; tone: 'success' | 'warning' | 'error' | 'info'; severity: number }> = {
  C: { label: 'Conflict', tone: 'error', severity: 6 },
  D: { label: 'Deleted', tone: 'error', severity: 5 },
  M: { label: 'Modified', tone: 'warning', severity: 4 },
  R: { label: 'Renamed', tone: 'info', severity: 3 },
  A: { label: 'Added', tone: 'success', severity: 2 },
  U: { label: 'Untracked', tone: 'success', severity: 1 },
};

/** Index and work tree columns of `git status --porcelain=v1` as one badge. */
export function badgeOf(x: string, y: string): GitBadge {
  if (x === '?' && y === '?') return 'U';
  // The unmerged states: both sides added or deleted, or either column `U`.
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'C';
  if (x === 'R' || y === 'R') return 'R';
  if (x === 'A' || y === 'A' || x === 'C' || y === 'C') return 'A';
  if (x === 'D' || y === 'D') return 'D';
  return 'M';
}

/**
 * Parses `git status --porcelain=v1 -z --untracked-files=all` output. Git reports paths from the repository root; `prefix` is
 * `git rev-parse --show-prefix` of the folder, and files above the folder are left out. A rename or copy entry is followed by
 * the origin path as its own NUL separated item.
 */
export function parseStatusZ(output: string, prefix = ''): FileStatusEntry[] {
  const items = output.split('\0');
  const entries: FileStatusEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.length < 4) continue;
    const x = item[0];
    const y = item[1];
    let from: string | undefined;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') from = items[++i];
    if (x === '!' && y === '!') continue;
    const path = item.slice(3);
    if (prefix && !path.startsWith(prefix)) continue;
    const origin = from === undefined ? undefined : prefix && from.startsWith(prefix) ? from.slice(prefix.length) : from;
    entries.push({
      path: path.slice(prefix.length),
      badge: badgeOf(x, y),
      staged: x !== ' ' && x !== '?' && x !== '!',
      ...(origin !== undefined ? { from: origin } : {}),
    });
  }
  return entries;
}

/** Every folder above the given files, as `a` and `a/b` (no trailing slash; the root is not listed). */
export function dirtyFolders(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    let slash = path.lastIndexOf('/');
    while (slash > 0) {
      const dir = path.slice(0, slash);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      slash = dir.lastIndexOf('/');
    }
  }
  return dirs;
}

/** The most severe badge inside each folder, for the tint of the folder dot. */
export function folderBadges(entries: readonly FileStatusEntry[]): Map<string, GitBadge> {
  const out = new Map<string, GitBadge>();
  for (const entry of entries) {
    let slash = entry.path.lastIndexOf('/');
    while (slash > 0) {
      const dir = entry.path.slice(0, slash);
      const known = out.get(dir);
      if (!known || GIT_BADGES[entry.badge].severity > GIT_BADGES[known].severity) out.set(dir, entry.badge);
      slash = dir.lastIndexOf('/');
    }
  }
  return out;
}

// ---- the live refresh stream (chokidar)

/** One line of `GET /api/workspaces/:id/watch` (newline-delimited JSON). */
export const WatchEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({
    type: z.literal('change'),
    /** Paths (relative to the folder) that changed in the debounce window, capped; `overflow` when more changed than are listed. */
    paths: z.array(z.string()),
    overflow: z.boolean(),
    at: z.number(),
  }),
  z.object({ type: z.literal('ping') }),
]).meta({ id: 'WatchEvent' });
export type WatchEvent = z.infer<typeof WatchEventSchema>;

// ---- file operations of the context menu

export const FsCreateSchema = z.object({ path: z.string().min(1), dir: z.boolean() }).strict().meta({ id: 'FsCreate' });
export const FsRenameSchema = z.object({ from: z.string().min(1), to: z.string().min(1) }).strict().meta({ id: 'FsRename' });
/** Asks for `confirm: true`: this removes the file or folder from the disk. */
export const FsDeleteSchema = z.object({ path: z.string().min(1), confirm: z.literal(true) }).strict().meta({ id: 'FsDelete' });
export type FsCreate = z.infer<typeof FsCreateSchema>;
export type FsRename = z.infer<typeof FsRenameSchema>;

/** `GET /api/workspaces/:id/status?thread=`. */
export const WorkspaceStatusQuerySchema = z.object({ thread: z.string().optional() });

/** What creating or renaming an entry answers with: its path, relative to the folder. */
export const FsEntryPathSchema = z.object({ path: z.string() }).meta({ id: 'FsEntryPath' });
