import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statusBadges } from '../changes/git';
import { FilesService } from './files.service';
import { FsService } from './fs.service';

/** A scratch repository: the state of the exit criterion (added, modified, deleted, untracked, renamed). */
let cwd: string;
const git = (...args: string[]) => {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
};

beforeAll(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pk-deco-')));
  mkdirSync(join(cwd, 'src', 'lib'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'keep.ts'), 'keep\n');
  writeFileSync(join(cwd, 'src', 'edit.ts'), 'one\n');
  writeFileSync(join(cwd, 'src', 'lib', 'gone.ts'), 'gone\n');
  writeFileSync(join(cwd, 'src', 'lib', 'staged-gone.ts'), 'gone too\n');
  writeFileSync(join(cwd, 'src', 'before.ts'), 'the same long enough content to be seen as a rename\nline two\nline three\n');
  writeFileSync(join(cwd, '.gitignore'), 'dist/\n.env\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  // the working tree
  writeFileSync(join(cwd, 'src', 'edit.ts'), 'one\ntwo\n'); // modified
  rmSync(join(cwd, 'src', 'lib', 'gone.ts')); // deleted, not staged
  git('rm', '-q', 'src/lib/staged-gone.ts'); // deleted and staged
  writeFileSync(join(cwd, 'src', 'added.ts'), 'added\n');
  git('add', 'src/added.ts'); // added
  writeFileSync(join(cwd, 'notes.md'), 'untracked\n'); // untracked
  git('mv', 'src/before.ts', 'src/after.ts'); // renamed
  mkdirSync(join(cwd, 'dist'));
  writeFileSync(join(cwd, 'dist', 'out.js'), 'ignored\n');
  writeFileSync(join(cwd, '.env'), 'SECRET=1\n');
});
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

describe('statusBadges', () => {
  it('reports each kind of change with its badge, and renames with their origin', async () => {
    const byPath = Object.fromEntries((await statusBadges(cwd)).map((e) => [e.path, e]));
    expect(byPath['src/edit.ts']).toMatchObject({ badge: 'M', staged: false });
    expect(byPath['src/added.ts']).toMatchObject({ badge: 'A', staged: true });
    expect(byPath['src/lib/gone.ts']).toMatchObject({ badge: 'D', staged: false });
    expect(byPath['src/lib/staged-gone.ts']).toMatchObject({ badge: 'D', staged: true });
    expect(byPath['notes.md']).toMatchObject({ badge: 'U', staged: false });
    expect(byPath['src/after.ts']).toMatchObject({ badge: 'R', staged: true, from: 'src/before.ts' });
    expect(byPath['src/keep.ts']).toBeUndefined();
    expect(byPath['dist/out.js']).toBeUndefined();
  });
});

describe('FilesService in a repository', () => {
  const files = new FilesService();
  it('keeps a deleted file in the tree, marked missing, whether or not the deletion is staged', async () => {
    const lib = await files.children(cwd, 'src/lib');
    expect(lib.map((n) => [n.name, n.missing ?? false])).toEqual([['gone.ts', true], ['staged-gone.ts', true]]);
    const src = await files.children(cwd, 'src');
    expect(src.find((n) => n.name === 'edit.ts')).toMatchObject({ size: 8 });
    expect(src.find((n) => n.name === 'edit.ts')?.missing).toBeUndefined();
  });
  it('hides what git ignores and lists it, greyed, with "show ignored"', async () => {
    expect((await files.children(cwd)).map((n) => n.name)).not.toContain('dist');
    const shown = await files.children(cwd, '', { showIgnored: true });
    expect(shown.filter((n) => n.ignored).map((n) => n.name).sort()).toEqual(['.env', 'dist']);
    const inside = await files.children(cwd, 'dist', { showIgnored: true });
    expect(inside).toMatchObject([{ name: 'out.js', ignored: true }]);
  });
  it('shows a folder with nothing in it (just made) but not a folder that holds only ignored files', async () => {
    mkdirSync(join(cwd, 'src', 'empty', 'deeper'), { recursive: true });
    const names = (await files.children(cwd, 'src')).map((n) => n.name);
    expect(names).toContain('empty');
    expect((await files.children(cwd, 'src/empty')).map((n) => n.name)).toEqual(['deeper']);
    expect((await files.children(cwd)).map((n) => n.name)).not.toContain('dist');
    rmSync(join(cwd, 'src', 'empty'), { recursive: true });
  });
  it('forgets its list when told the folder changed', async () => {
    writeFileSync(join(cwd, 'later.txt'), 'x');
    expect((await files.children(cwd)).map((n) => n.name)).not.toContain('later.txt');
    files.refresh(cwd);
    expect((await files.children(cwd)).map((n) => n.name)).toContain('later.txt');
    rmSync(join(cwd, 'later.txt'));
    files.refresh(cwd);
  });
});

describe('FsService', () => {
  const files = new FilesService();
  const fs = new FsService(files);
  it('creates a file or a folder, with missing parents, and never overwrites', () => {
    expect(fs.create(cwd, 'docs/guide/intro.md', false)).toEqual({ path: 'docs/guide/intro.md' });
    expect(existsSync(join(cwd, 'docs', 'guide', 'intro.md'))).toBe(true);
    expect(fs.create(cwd, 'tmp-folder', true)).toEqual({ path: 'tmp-folder' });
    expect(() => fs.create(cwd, 'docs/guide/intro.md', false)).toThrow(/exists already/);
  });
  it('renames, refusing an existing target and a missing source', () => {
    fs.rename(cwd, 'docs/guide/intro.md', 'docs/guide/start.md');
    expect(existsSync(join(cwd, 'docs', 'guide', 'start.md'))).toBe(true);
    expect(() => fs.rename(cwd, 'docs/guide/start.md', 'notes.md')).toThrow(/exists already/);
    expect(() => fs.rename(cwd, 'nope.md', 'x.md')).toThrow(/does not exist/);
  });
  it('deletes a file or a folder with its content', () => {
    fs.delete(cwd, 'docs');
    fs.delete(cwd, 'tmp-folder');
    expect(existsSync(join(cwd, 'docs'))).toBe(false);
    expect(existsSync(join(cwd, 'tmp-folder'))).toBe(false);
    expect(() => fs.delete(cwd, 'docs')).toThrow(/does not exist/);
  });
  it('stays inside the folder and out of .git', () => {
    expect(() => fs.create(cwd, '../escape.txt', false)).toThrow(/outside/);
    expect(() => fs.rename(cwd, 'notes.md', '../escape.txt')).toThrow(/outside/);
    expect(() => fs.delete(cwd, '/etc/hosts')).toThrow(/not a path inside/);
    expect(() => fs.delete(cwd, '.git')).toThrow(/git’s own/);
    expect(() => fs.create(cwd, '.git/hooks/x', false)).toThrow(/git’s own/);
    expect(readFileSync(join(cwd, 'notes.md'), 'utf8')).toBe('untracked\n');
  });

  it.each(['create', 'rename-source', 'rename-target', 'delete'] as const)('rejects normalized protected paths for %s', (operation) => {
    for (const path of ['src/..', 'src/../.git', 'src/../.git/config']) {
      const root = mkdtempSync(join(tmpdir(), 'pk-fs-protected-'));
      try {
        mkdirSync(join(root, 'src'));
        mkdirSync(join(root, '.git'));
        writeFileSync(join(root, '.git', 'config'), 'repository config');
        writeFileSync(join(root, 'notes.md'), 'notes');
        const mutate = () => {
          if (operation === 'create') fs.create(root, path, false);
          else if (operation === 'rename-source') fs.rename(root, path, 'moved');
          else if (operation === 'rename-target') fs.rename(root, 'notes.md', path);
          else fs.delete(root, path);
        };
        expect(mutate).toThrow(path === 'src/..' ? /inside the workspace/ : /git’s own/);
        expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('repository config');
        expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('notes');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('rejects mutations through symlink aliases of protected targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'pk-fs-alias-'));
    try {
      mkdirSync(join(root, '.git'));
      writeFileSync(join(root, '.git', 'config'), 'repository config');
      symlinkSync(join(root, '.git'), join(root, 'metadata'), 'dir');
      symlinkSync(root, join(root, 'workspace'), 'dir');
      expect(() => fs.create(root, 'metadata/hooks/new-hook', false)).toThrow(/git’s own/);
      expect(() => fs.delete(root, 'metadata/config')).toThrow(/git’s own/);
      expect(() => fs.rename(root, 'metadata/config', 'config')).toThrow(/git’s own/);
      expect(() => fs.delete(root, 'workspace')).toThrow(/inside the workspace/);
      expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('repository config');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
