// What the worktree tests and screenshots need besides the scratch project: a repository of their own on `main` with a few source files, so merging a
// worktree back never trips over what the other tests left uncommitted in the shared scratch project, and a helper to commit on it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const IDENTITY = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com'];

/** `git` in a folder, failing loudly (the tests build their world with it). */
export function gitIn(folder, ...args) {
  const result = spawnSync('git', [...IDENTITY, ...args], { cwd: folder, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${folder}: ${result.stderr}`);
  return result.stdout;
}

/** A small repository on `main`: a reporting adapter with a map module, an index and a README. Returns its folder. */
export function writeWorktreeProject({ base, name = 'reporting-adapter', branch = 'main' }) {
  const folder = join(base, name);
  mkdirSync(join(folder, 'src'), { recursive: true });
  writeFileSync(join(folder, 'README.md'), `# ${name}\n\nMaps report rows to the shape the dashboard wants.\n`);
  writeFileSync(join(folder, 'src', 'map.ts'), "export function mapRow(row: { id: number; total: number }): { key: string; value: number } {\n  return { key: String(row.id), value: row.total };\n}\n");
  writeFileSync(join(folder, 'src', 'index.ts'), "import { mapRow } from './map';\n\nexport const rows = [{ id: 1, total: 10 }].map(mapRow);\n");
  gitIn(folder, 'init', '-q', '-b', branch);
  gitIn(folder, 'add', '-A');
  gitIn(folder, 'commit', '-q', '-m', 'init');
  return folder;
}

/** Writes a file in a folder (creating the folders above it) and commits that file there, whatever else is uncommitted. */
export function commitFile(folder, relative, text, message) {
  const path = join(folder, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  gitIn(folder, 'add', '--', relative);
  gitIn(folder, 'commit', '-q', '-m', message, '--', relative);
  return gitIn(folder, 'rev-parse', '--short', 'HEAD').trim();
}
