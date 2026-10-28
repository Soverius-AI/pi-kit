import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Folders never worth offering or polling when there is no git to say what is ignored: dependencies, build output and tool caches. */
export const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nx',
  '.angular',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'target',
  '.pnpm-store',
  'bower_components',
  '.turbo',
  '.parcel-cache',
  '.svelte-kit',
  '.nuxt',
  '.gradle',
  '.terraform',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.direnv',
  '.dart_tool',
]);

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
