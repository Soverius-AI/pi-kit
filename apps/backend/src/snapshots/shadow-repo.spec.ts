import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UNTRACKED_BYTES, ShadowRegistry, ShadowRepo } from './shadow-repo';

// Counts the commands that write a shadow index while they run: there must never be two at once on one index.
const writers = vi.hoisted(() => ({ now: 0, max: 0 }));
vi.mock('../changes/git', async (importOriginal) => {
  const real = await importOriginal<typeof import('../changes/git')>();
  return {
    ...real,
    git: async (...args: Parameters<typeof real.git>) => {
      const writes =
        args[2]?.env?.['GIT_INDEX_FILE'] !== undefined && ['add', 'write-tree', 'checkout'].includes(args[1][0]);
      if (writes) writers.max = Math.max(writers.max, ++writers.now);
      try {
        return await real.git(...args);
      } finally {
        if (writes) writers.now--;
      }
    },
  };
});

describe('ShadowRepo', () => {
  let base: string;
  let repo: string;
  let data: string;
  let registry: ShadowRegistry;
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  const write = (path: string, text: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pk-shadow-'));
    repo = join(base, 'repo');
    data = join(base, 'data');
    registry = new ShadowRegistry();
    mkdirSync(repo);
    sh(repo, 'init', '-q');
    write('src/a.ts', 'one\ntwo\n');
    write('.gitignore', 'dist/\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'base');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }));

  it('records edits, new and deleted files between two snapshots, with line counts', async () => {
    const shadow = (await ShadowRepo.open(repo, data, registry))!;
    const before = await shadow.capture();
    write('src/a.ts', 'one\nTWO\nthree\n');
    write('src/new.ts', 'n\n');
    write('notes.md', 'x\n');
    const after = await shadow.capture();
    rmSync(join(repo, 'notes.md'));
    expect(await shadow.changes(before, after)).toEqual([
      { path: 'notes.md', status: 'A', added: 1, removed: 0 },
      { path: 'src/a.ts', status: 'M', added: 2, removed: 1 },
      { path: 'src/new.ts', status: 'A', added: 1, removed: 0 },
    ]);
    expect(await shadow.changes(before, after, ['src/a.ts'])).toHaveLength(1);
    expect(await shadow.patch(before, after, 'src/a.ts')).toContain('+TWO');
  });

  it('never records node_modules or what .gitignore ignores, and leaves the project’s .git alone', async () => {
    const index = join(repo, '.git', 'index');
    const indexBefore = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs };
    const shadow = (await ShadowRepo.open(repo, data, registry))!;
    const before = await shadow.capture();
    write('node_modules/pkg/index.js', 'x');
    write('dist/out.js', 'x');
    write('src/a.ts', 'changed\n');
    const after = await shadow.capture();
    expect((await shadow.changes(before, after)).map((c) => c.path)).toEqual(['src/a.ts']);
    expect(readFileSync(index)).toEqual(indexBefore.bytes);
    expect(statSync(index).mtimeMs).toBe(indexBefore.mtime);
    expect(existsSync(join(repo, '.git', 'index.lock'))).toBe(false);
  });

  it('works for a subfolder, with paths relative to it', async () => {
    const shadow = (await ShadowRepo.open(join(repo, 'src'), data, registry))!;
    const before = await shadow.capture();
    write('src/a.ts', 'edited\n');
    write('outside.md', 'not in the folder\n');
    expect((await shadow.changes(before, await shadow.capture())).map((c) => c.path)).toEqual(['a.ts']);
  });

  it('restores a file as a snapshot has it, and deletes one the snapshot does not have', async () => {
    const shadow = (await ShadowRepo.open(repo, data, registry))!;
    const before = await shadow.capture();
    write('src/a.ts', 'broken\n');
    write('src/new.ts', 'n\n');
    await shadow.restore(before, 'src/a.ts');
    await shadow.restore(before, 'src/new.ts');
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf8')).toBe('one\ntwo\n');
    expect(existsSync(join(repo, 'src/new.ts'))).toBe(false);
    expect(sh(repo, 'status', '--porcelain')).toBe('');
  });

  it('takes paths literally: restoring or diffing `pages/[id].tsx` leaves `pages/i.tsx` alone', async () => {
    const shadow = (await ShadowRepo.open(repo, data, registry))!;
    write('pages/[id].tsx', 'route\n');
    write('pages/i.tsx', 'other\n');
    const before = await shadow.capture();
    write('pages/[id].tsx', 'route edited\n');
    write('pages/i.tsx', 'other edited\n');
    const after = await shadow.capture();
    expect(await shadow.patch(before, after, 'pages/[id].tsx')).not.toContain('i.tsx');
    await shadow.restore(before, 'pages/[id].tsx');
    expect(readFileSync(join(repo, 'pages/[id].tsx'), 'utf8')).toBe('route\n');
    expect(readFileSync(join(repo, 'pages/i.tsx'), 'utf8')).toBe('other edited\n');
  });

  it('starts from a split index of the project', async () => {
    sh(repo, 'update-index', '--split-index');
    write('src/a.ts', 'edited\n');
    const shadow = (await ShadowRepo.open(repo, data, registry))!;
    const before = await shadow.capture();
    write('src/b.ts', 'b\n');
    expect((await shadow.changes(before, await shadow.capture())).map((c) => c.path)).toEqual(['src/b.ts']);
  });

  it('lets folders of one repository capture at the same time without breaking the shared index', async () => {
    const [root, sub] = await Promise.all([
      ShadowRepo.open(repo, data, registry),
      ShadowRepo.open(join(repo, 'src'), data, registry),
    ]);
    const before = await root!.capture();
    write('src/a.ts', 'changed\n');
    writers.max = 0;
    const trees = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? sub! : root!).capture()));
    expect(writers.max).toBe(1);
    for (const tree of trees) expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect((await root!.changes(before, trees[5])).map((c) => c.path)).toEqual(['src/a.ts']);
  });

  it('leaves untracked files over the size limit out of snapshots', async () => {
    const shadow = (await ShadowRepo.open(repo, data, registry))!;
    const before = await shadow.capture();
    write('big.bin', 'x'.repeat(MAX_UNTRACKED_BYTES + 1));
    write('small.txt', 'ok\n');
    expect((await shadow.changes(before, await shadow.capture())).map((c) => c.path)).toEqual(['small.txt']);
  });

  it('makes its repository again when it was deleted while in use', async () => {
    const shadow = (await ShadowRepo.open(repo, data, registry))!;
    await shadow.capture();
    rmSync(join(data, 'snapshots'), { recursive: true, force: true });
    expect(await shadow.capture()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses to restore from a snapshot that is gone, and leaves the file alone', async () => {
    const shadow = (await ShadowRepo.open(repo, data, registry))!;
    write('src/a.ts', 'mine\n');
    await expect(shadow.restore('0'.repeat(40), 'src/a.ts')).rejects.toThrow(/gone/);
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf8')).toBe('mine\n');
  });

  it('reads its snapshots after the recorded folder is gone, but cannot write', async () => {
    const shadow = (await ShadowRepo.open(repo, data, registry))!;
    const before = await shadow.capture();
    write('src/a.ts', 'changed\n');
    const after = await shadow.capture();
    const stored = ShadowRepo.stored(shadow.location, registry)!;
    rmSync(join(repo, 'src'), { recursive: true, force: true });
    expect((await stored.changes(before, after)).map((c) => c.path)).toEqual(['src/a.ts']);
    await expect(stored.capture()).rejects.toThrow(/only be read/);
  });

  it('has nothing to say outside a git work tree', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(await ShadowRepo.open(plain, data, registry)).toBeUndefined();
  });
});
