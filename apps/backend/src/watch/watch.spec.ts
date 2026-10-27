import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gitIgnoredPaths, watchIgnored } from '../session/ignore';
import { Batcher, type PathBatch } from './batcher';
import { WatchService } from './watch.service';

describe('Batcher (the 300 ms debounce of the live refresh)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const collect = (options?: ConstructorParameters<typeof Batcher>[1]) => {
    const batches: PathBatch[] = [];
    return { batches, batcher: new Batcher((b) => batches.push(b), options) };
  };

  it('emits one batch 300 ms after the last event, with every path once and sorted', () => {
    const { batches, batcher } = collect();
    batcher.add('b.ts');
    vi.advanceTimersByTime(200);
    batcher.add('a.ts');
    batcher.add('b.ts');
    vi.advanceTimersByTime(299);
    expect(batches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual([{ paths: ['a.ts', 'b.ts'], overflow: false }]);
  });

  it('starts a new window after a batch', () => {
    const { batches, batcher } = collect();
    batcher.add('a');
    vi.advanceTimersByTime(300);
    batcher.add('b');
    vi.advanceTimersByTime(300);
    expect(batches.map((b) => b.paths)).toEqual([['a'], ['b']]);
  });

  it('requests a full refresh when the OS cannot identify a changed path', () => {
    const { batches, batcher } = collect();
    batcher.invalidate();
    vi.advanceTimersByTime(300);
    expect(batches).toEqual([{ paths: [], overflow: true }]);
    batcher.add('a.ts');
    vi.advanceTimersByTime(300);
    expect(batches[1]).toEqual({ paths: ['a.ts'], overflow: false });
  });

  it('does not let a busy folder starve the panel: a window ends at most 1.5 s after its first event', () => {
    const { batches, batcher } = collect();
    for (let t = 0; t < 1400; t += 100) {
      batcher.add(`f${t}`);
      vi.advanceTimersByTime(100);
    }
    expect(batches).toEqual([]);
    batcher.add('last');
    vi.advanceTimersByTime(100);
    expect(batches).toHaveLength(1);
    expect(batches[0].paths).toContain('last');
  });

  it('caps the paths it keeps and says so', () => {
    const { batches, batcher } = collect({ quietMs: 300, maxWaitMs: 1500, maxPaths: 3 });
    for (const p of ['a', 'b', 'c', 'd', 'e']) batcher.add(p);
    vi.advanceTimersByTime(300);
    expect(batches[0]).toEqual({ paths: ['a', 'b', 'c'], overflow: true });
  });

  it('emits nothing when disposed, and flush() sends what is waiting', () => {
    const { batches, batcher } = collect();
    batcher.add('a');
    batcher.dispose();
    vi.advanceTimersByTime(1000);
    expect(batches).toEqual([]);
    batcher.add('b');
    batcher.flush();
    expect(batches).toEqual([{ paths: ['b'], overflow: false }]);
  });
});

describe('watchIgnored', () => {
  const names = new Set(['secret.log', 'tmp']);
  it('skips root-relative ignored directories containing slashes', () => {
    const paths = new Set(['.claude/worktrees', 'artifacts/screenshots']);
    expect(watchIgnored('.claude/worktrees', paths)).toBe(true);
    expect(watchIgnored('.claude/worktrees/task/src/app.ts', paths)).toBe(true);
    expect(watchIgnored('artifacts/screenshots/a.png', paths)).toBe(true);
    expect(watchIgnored('.claude/settings.json', paths)).toBe(false);
    expect(watchIgnored('artifacts/screenshots-source/a.ts', paths)).toBe(false);
  });
  it('skips dependency and build folders anywhere in the path, and what the root .gitignore names', () => {
    expect(watchIgnored('node_modules/x/index.js', names)).toBe(true);
    expect(watchIgnored('apps/web/node_modules/x/index.js', names)).toBe(true);
    expect(watchIgnored('apps/a/dist/main.js', names)).toBe(true);
    expect(watchIgnored('secret.log', names)).toBe(true);
    expect(watchIgnored('tmp/out.txt', names)).toBe(true);
    expect(watchIgnored('src/a.ts', names)).toBe(false);
    expect(watchIgnored('', names)).toBe(false);
  });
  it('skips tool caches such as a pnpm store inside the project', () => {
    expect(watchIgnored('.pnpm-store/v10/files/00/abc', names)).toBe(true);
    expect(watchIgnored('apps/web/.turbo/cache', names)).toBe(true);
  });
  it('skips what git ignores, by path from the folder and nothing of the same name elsewhere', () => {
    const ignored = new Set(['generated', 'apps/web/tmp-out', 'notes.local']);
    expect(watchIgnored('generated/x.ts', names, ignored)).toBe(true);
    expect(watchIgnored('apps/web/tmp-out', names, ignored)).toBe(true);
    expect(watchIgnored('apps/web/tmp-out/a/b.js', names, ignored)).toBe(true);
    expect(watchIgnored('notes.local', names, ignored)).toBe(true);
    expect(watchIgnored('src/generated/x.ts', names, ignored)).toBe(false);
    expect(watchIgnored('apps/web/src/a.ts', names, ignored)).toBe(false);
  });
  it('asks git what it ignores, and gets nothing outside a repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'pk-gitignored-'));
    try {
      expect(await gitIgnoredPaths(repo)).toEqual(new Set());
      spawnSync('git', ['init', '-q'], { cwd: repo });
      writeFileSync(join(repo, '.gitignore'), 'generated/\n*.local\n');
      mkdirSync(join(repo, 'generated', 'deep'), { recursive: true });
      writeFileSync(join(repo, 'generated', 'deep', 'a.js'), 'a');
      writeFileSync(join(repo, 'notes.local'), 'n');
      writeFileSync(join(repo, 'kept.ts'), 'k');
      expect(await gitIgnoredPaths(repo)).toEqual(new Set(['generated', 'notes.local']));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
  it('watches .git only for what changes on add, commit, checkout and reset: index, HEAD, the reflog and the branch refs', () => {
    for (const path of ['.git', '.git/index', '.git/HEAD', '.git/logs', '.git/logs/HEAD', '.git/refs', '.git/refs/heads', '.git/refs/heads/main', '.git/refs/heads/feature/x', '.git/packed-refs']) {
      expect(watchIgnored(path, names), path).toBe(false);
    }
    for (const path of ['.git/objects/ab/cdef', '.git/refs/tags/v1', '.git/logs/refs/heads/main', '.git/config', '.git/hooks/pre-commit']) {
      expect(watchIgnored(path, names), path).toBe(true);
    }
  });
});

describe('WatchService (a real folder)', () => {
  let dir: string;
  const service = new WatchService();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pk-watch-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'a');
  });
  afterEach(() => {
    service.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  });

  const next = (listen: (cb: (b: PathBatch) => void) => void): Promise<PathBatch> => new Promise((resolve) => listen(resolve));

  it.skipIf(process.platform !== 'darwin')('keeps native watch handles bounded for a large macOS workspace', async () => {
    for (let i = 0; i < 1000; i++) writeFileSync(join(dir, 'src', `file-${i}.ts`), 'x');
    const handles = () => process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap').length;
    const before = handles();
    service.subscribe(dir, () => undefined);
    await service.ready(dir);
    expect(handles() - before).toBeLessThanOrEqual(2);
  });

  it('never reports edits inside root or nested node_modules folders', async () => {
    const nested = join(dir, 'src', 'nested', 'node_modules', 'pkg');
    mkdirSync(nested, { recursive: true });
    const batches: PathBatch[] = [];
    service.subscribe(dir, (batch) => batches.push(batch));
    await service.ready(dir);
    writeFileSync(join(dir, 'node_modules', 'ignored.js'), 'x');
    writeFileSync(join(nested, 'ignored.js'), 'x');
    // FSEvents can deliver setup writes after subscribing. Observe an allowed
    // edit as well, so this tests filtering without assuming an empty stream
    // or passing because the watcher has not started delivering events yet.
    for (let i = 0; i < 30 && !batches.some((batch) => batch.paths.includes('src/a.ts')); i++) {
      appendFileSync(join(dir, 'src', 'a.ts'), 'more');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const paths = batches.flatMap((batch) => batch.paths);
    expect(paths).toContain('src/a.ts');
    expect(paths.some((path) => path.split('/').includes('node_modules'))).toBe(false);
    expect(batches.every((batch) => !batch.overflow)).toBe(true);
  }, 20_000);

  it('reports an outside edit as one batch, and leaves node_modules alone', async () => {
    const batch = next((cb) => service.subscribe(dir, cb));
    await service.ready(dir);
    writeFileSync(join(dir, 'node_modules', 'ignored.js'), 'x');
    // On macOS, fsevents can drop a change made in the first moments after chokidar reports "ready"
    // (seen on a cold run of this suite), which the app tolerates because the next change reports.
    // The test therefore keeps editing until the first batch arrives instead of trusting one write.
    let got: PathBatch | undefined;
    for (let i = 0; i < 30 && !got; i++) {
      appendFileSync(join(dir, 'src', 'a.ts'), 'more');
      got = await Promise.race([batch, new Promise<undefined>((r) => setTimeout(() => r(undefined), 500))]);
    }
    expect(got?.paths).toEqual(['src/a.ts']);
  }, 20_000);

  it('reports a commit made in a terminal (a commit does not always touch the index)', async () => {
    const sh = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir });
    sh('init', '-q');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'base');
    writeFileSync(join(dir, 'new.txt'), 'n');
    sh('add', 'new.txt');
    const batches: PathBatch[] = [];
    service.subscribe(dir, (b) => batches.push(b));
    await service.ready(dir);
    sh('commit', '-q', '-m', 'second');
    for (let i = 0; i < 30 && !batches.some((b) => b.paths.some((p) => p.startsWith('.git/'))); i++) await new Promise((r) => setTimeout(r, 100));
    expect(batches.flatMap((b) => b.paths).some((p) => p.startsWith('.git/'))).toBe(true);
  });

  it('shares one watcher per folder and closes it with the last listener', async () => {
    const off1 = service.subscribe(dir, () => undefined);
    const off2 = service.subscribe(dir, () => undefined);
    expect(service.watching()).toEqual([dir]);
    off1();
    expect(service.watching()).toEqual([dir]);
    off2();
    expect(service.watching()).toEqual([]);
  });

  it('tells every-batch listeners which folder changed (the file index forgets its cache here)', async () => {
    let seen: string | undefined;
    const off = service.onBatch((cwd) => { seen = cwd; });
    try {
      service.subscribe(dir, () => undefined);
      await service.ready(dir);
      // As above, macOS can drop the first edit just after "ready". Keep
      // editing until a batch arrives; this assertion is about its folder.
      for (let i = 0; i < 30 && seen !== dir; i++) {
        appendFileSync(join(dir, 'b.ts'), 'b');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(seen).toBe(dir);
    } finally {
      off();
    }
  }, 20_000);
});
