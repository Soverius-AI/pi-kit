import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { PACKAGE_KINDS, type PackageBrings, type PackageKind, type PackageOrigin, originOfSource } from '@pi-kit/protocol';

/** Rules of the package list that need no pi and no disk, so the unit tests pin them: what a source is, what it is called, which package a resource belongs to. */

/** The packages that ship with pi-kit (`packages/pi-kit-learn`, `packages/pi-kit-meat-proxy`, `packages/pi-computer-use`). */
export const BUNDLED_PACKAGES = ['@pi-kit/learn', '@pi-kit/meat-proxy', '@pi-kit/computer-use'] as const;

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}

/**
 * What a source stands for, ignoring the version or ref: `npm:name`, `git:host/path`, or the absolute folder. `npm:pi-subagents@0.4` and `npm:pi-subagents` are the same package,
 * `https://github.com/x/y.git`, `git:github.com/x/y` and `git@github.com:x/y` are the same repository.
 */
export function sourceIdentity(source: string, base = process.cwd()): string {
  const s = source.trim();
  switch (originOfSource(s)) {
    case 'npm': {
      const spec = s.slice(4);
      const at = spec.lastIndexOf('@');
      return `npm:${at > 0 ? spec.slice(0, at) : spec}`;
    }
    case 'git': {
      const cleaned = s
        .replace(/^git:/, '')
        .replace(/^git\+/, '')
        .replace(/^(https?|ssh):\/\//, '')
        .replace(/^git@/, '')
        .replace(/^([^/:]+):(?!\/)/, '$1/')
        .replace(/\.git(?=@|$)/, '');
      const at = cleaned.lastIndexOf('@');
      return `git:${(at > 0 ? cleaned.slice(0, at) : cleaned).replace(/^[^@/]*@/, '').toLowerCase()}`;
    }
    default:
      return `folder:${resolve(base, expandHome(s))}`;
  }
}

/** The name a package is shown under when its `package.json` cannot say: the npm name, the repository, or the folder. */
export function nameOfSource(source: string): string {
  const s = source.trim();
  switch (originOfSource(s)) {
    case 'npm':
      return sourceIdentity(s).slice(4);
    case 'git':
      return basename(sourceIdentity(s).slice(4));
    default:
      return basename(s.replace(/[\\/]+$/, '')) || s;
  }
}

/** `npm`, `git` or `folder`, and `bundled` for one of the packages that ship with pi-kit. */
export function originOf(source: string, packageName: string | undefined): PackageOrigin {
  return packageName && (BUNDLED_PACKAGES as readonly string[]).includes(packageName) ? 'bundled' : originOfSource(source);
}

/** A resource's name as the lists show it: a skill is its folder, an extension its file (or folder for an `index`), a prompt or theme its file without the extension. */
export function resourceName(kind: PackageKind, path: string): string {
  const file = basename(path);
  const folder = basename(dirname(path));
  if (kind === 'skills') return file === 'SKILL.md' ? folder : file.replace(/\.md$/, '');
  if (kind === 'extensions') return /^index\.[tj]s$/.test(file) && !['extensions', 'src'].includes(folder) ? folder : file.replace(/\.(ts|js|mjs|cjs)$/, '');
  return file.replace(/\.(md|json)$/, '');
}

export const NAMES_SHOWN = 12;

export function emptyBrings(): PackageBrings {
  return { extensions: 0, skills: 0, prompts: 0, themes: 0, names: { extensions: [], skills: [], prompts: [], themes: [] } };
}

/** Adds one resource to a package's counts (once per path). */
export function addResource(brings: PackageBrings, kind: PackageKind, path: string): void {
  const name = resourceName(kind, path);
  brings[kind] += 1;
  if (brings.names[kind].length < NAMES_SHOWN && !brings.names[kind].includes(name)) brings.names[kind].push(name);
}

/** Resources of pi's `resolve()` grouped by the package they come from (`<scope>:<source>`). */
export function groupBrings(resolved: Record<PackageKind, readonly { path: string; metadata: { scope: string; origin: string; source: string } }[]>): Map<string, PackageBrings> {
  const groups = new Map<string, PackageBrings>();
  for (const kind of PACKAGE_KINDS) {
    const seen = new Set<string>();
    for (const res of resolved[kind]) {
      if (res.metadata.origin !== 'package') continue;
      const key = `${res.metadata.scope}:${res.metadata.source}`;
      const once = `${key}\0${kind}\0${res.path}`;
      if (seen.has(once)) continue;
      seen.add(once);
      const brings = groups.get(key) ?? emptyBrings();
      addResource(brings, kind, res.path);
      groups.set(key, brings);
    }
  }
  return groups;
}

/** A settings entry as pi writes it: the source alone, or an object with filters for what to load. */
export type PackageEntry = string | ({ source: string } & Partial<Record<PackageKind, string[]>> & Record<string, unknown>);

export const sourceOfEntry = (entry: PackageEntry): string => (typeof entry === 'string' ? entry : entry.source);

/** Off means pi keeps the entry and loads nothing from it: every kind is filtered to an empty list (docs/packages.md, "Select package resources"). */
export function isEntryEnabled(entry: PackageEntry): boolean {
  if (typeof entry === 'string') return true;
  return !PACKAGE_KINDS.every((kind) => Array.isArray(entry[kind]) && entry[kind].length === 0);
}

/** The entry switched on or off: off filters every kind to nothing, on drops those four filters (the entry is the source alone again when nothing else is left). Other fields stay. */
export function entryWithEnabled(entry: PackageEntry, enabled: boolean): PackageEntry {
  const base: { source: string } & Record<string, unknown> = typeof entry === 'string' ? { source: entry } : { ...entry };
  if (enabled) {
    for (const kind of PACKAGE_KINDS) if (Array.isArray(base[kind]) && (base[kind] as unknown[]).length === 0) delete base[kind];
    return Object.keys(base).length === 1 ? base.source : (base as PackageEntry);
  }
  for (const kind of PACKAGE_KINDS) base[kind] = [];
  return base as PackageEntry;
}

/** The folder a "From a folder" source names: `~` expanded, relative to `base`. */
export const folderOf = (source: string, base: string): string => (isAbsolute(expandHome(source)) ? expandHome(source) : resolve(base, expandHome(source)));

/** A source typed in the wizard, made one `pi install` takes: a GitHub address without a scheme becomes a git source; `owner/name@1.2` is not guessed. */
export function normalizeSource(input: string): string {
  const s = input.trim();
  if (/^github\.com\//.test(s) || /^gitlab\.com\//.test(s)) return `git:${s}`;
  return s;
}
