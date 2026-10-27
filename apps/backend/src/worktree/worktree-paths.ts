import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

/** Where thread worktrees go unless a project (Settings › Projects) or `PI_KIT_WORKTREE_ROOT` says otherwise: outside every repository, so no ignore rule or watcher sees them. */
export const DEFAULT_WORKTREE_ROOT = '~/.pi-kit/worktrees';

/** Branches of thread worktrees live under this prefix. */
export const BRANCH_PREFIX = 'pi-kit/';

const expandHome = (path: string, home: string): string => (path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path);

/** Lower case, letters and digits, single dashes, at most `max` characters; empty when the text has nothing usable. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/g, '');
}

/** The folder name of a project inside the worktree root. */
export function repoSlug(projectCwd: string): string {
  return slugify(basename(projectCwd), 40) || 'project';
}

/** The slug of a thread's worktree folder and branch: from its title when it has one, else from its id. */
export function threadSlug(title: string | undefined, threadId: string): string {
  return slugify(title ?? '', 40) || `thread-${threadId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase()}`;
}

/** `<prefix><slug>`; the prefix is the project's, `pi-kit/` unless it says otherwise (an empty prefix is allowed). */
export const branchName = (slug: string, prefix: string = BRANCH_PREFIX): string => `${prefix}${slug}`;

/** A prefix as a person types it: trimmed, no leading slash, and a `/` at the end unless it ends in a character that already separates (`-`, `_`, `/`) or is empty. */
export function normalizePrefix(prefix: string | null | undefined): string {
  if (prefix === null || prefix === undefined) return BRANCH_PREFIX;
  const trimmed = prefix.trim().replace(/^\/+/, '').replace(/\s+/g, '-');
  if (trimmed === '') return '';
  return /[/_-]$/.test(trimmed) ? trimmed : `${trimmed}/`;
}

/**
 * What a new worktree's folder and branch are named after, and the branch: `detached` has no branch; a `typed` name is the branch exactly as typed (the folder is its
 * slug); otherwise `<prefix><slug>` where the slug comes from `name` (the first message), else the title, else the thread id. `slug` is the folder's name.
 */
export function worktreeNames(options: { name?: string; title?: string; threadId: string; prefix?: string; typed?: string; detached?: boolean }): { slug: string; branch: (slug: string) => string | null } {
  const source = options.typed ? options.typed : (options.name ?? options.title);
  const slug = threadSlug(source, options.threadId);
  if (options.detached) return { slug, branch: () => null };
  if (options.typed) return { slug, branch: () => options.typed ?? null };
  return { slug, branch: (candidate) => branchName(candidate, options.prefix) };
}

/** `origin/main` is cut from the remote's `main` and merges back into the local `main`. */
export const localBaseName = (base: string): string => base.replace(/^origin\//, '');

/**
 * The worktree root: the project's own setting, else `PI_KIT_WORKTREE_ROOT`, else `~/.pi-kit/worktrees`. A relative setting is resolved against the
 * project's folder (it is a path inside or next to the project the person typed), `~` against the home folder.
 */
export function resolveRoot(options: { setting?: string | null; env?: NodeJS.ProcessEnv; home?: string; projectCwd?: string }): string {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const chosen = options.setting?.trim() || env['PI_KIT_WORKTREE_ROOT']?.trim() || DEFAULT_WORKTREE_ROOT;
  const expanded = expandHome(chosen, home);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(options.projectCwd ?? home, expanded);
}

/** The branch a worktree is cut from: what the person asked for, else the project's setting, else the branch that is checked out. `undefined` on a detached `HEAD` with no setting. */
export function resolveBase(options: { requested?: string | null; setting?: string | null; current?: string | null }): string | undefined {
  return options.requested?.trim() || options.setting?.trim() || options.current?.trim() || undefined;
}

/**
 * A free folder name and branch for the slug: `slug`, then `slug-2`, `slug-3`, ... until neither the folder nor the branch is taken. `taken` answers for
 * both (the caller checks the disk and the repository).
 */
export function uniqueSlug(slug: string, taken: (candidate: string) => boolean): string {
  if (!taken(slug)) return slug;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`No free worktree name for ${slug}.`);
}

/** `<root>/<repo-slug>/<thread-slug>`. */
export const worktreePath = (root: string, projectCwd: string, slug: string): string => join(root, repoSlug(projectCwd), slug);
