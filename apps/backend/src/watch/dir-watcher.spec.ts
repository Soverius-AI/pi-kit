import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchIgnored } from '../session/ignore';
import { type DirWatcher, watchDirectories } from './dir-watcher';

describe('watchDirectories (the Linux watcher: one watch per directory)', () => {
  let dir: string;
  let watcher: DirWatcher | undefined;
  let paths: string[];
  let limits: Error[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pk-dirwatch-'));
    mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg', 'lib'), { recursive: true });
    mkdirSync(join(dir, '.pnpm-store', 'v10', 'files'), { recursive: true });
    mkdirSync(join(dir, 'generated', 'out'), { recursive: true });
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, 'src', `f${i}.ts`), 'x');
    writeFileSync(join(dir, 'src', 'deep', 'a.ts'), 'a');
    paths = [];
    limits = [];
  });
  afterEach(() => {
    watcher?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (ignoredPaths = new Set<string>()) => {
    watcher = watchDirectories(dir, {
      ignored: (rel) => watchIgnored(rel, new Set(), ignoredPaths),
      onPath: (rel) => paths.push(rel),
      onOverflow: () => paths.push('<overflow>'),
      onLimit: (error) => limits.push(error),
    });
    return watcher;
  };
  const until = async (check: () => boolean, poke?: () => void) => {
    for (let i = 0; i < 100 && !check(); i++) {
      poke?.();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  /** macOS starts a watch's event stream a moment after `watch()` returns (inotify does not): a change to `src` is reported before the test makes one it relies on. */
  const live = () => until(() => paths.includes('src/f0.ts'), () => appendFileSync(join(dir, 'src', 'f0.ts'), 'x'));

  it('watches every directory but no file, and skips dependency folders, tool caches and what git ignores', async () => {
    const w = start(new Set(['generated']));
    await w.ready;
    expect(w.watched().sort()).toEqual(['', 'src', 'src/deep']);
    expect(limits).toEqual([]);
  }, 20_000);

  it('reports a change to a file in a nested directory by its relative path', async () => {
    const w = start();
    await w.ready;
    await until(() => paths.includes('src/deep/a.ts'), () => appendFileSync(join(dir, 'src', 'deep', 'a.ts'), 'more'));
    expect(paths).toContain('src/deep/a.ts');
    expect(paths.some((path) => path.startsWith('node_modules'))).toBe(false);
  }, 20_000);

  it('watches a directory that appears, reports what it holds, and drops it when it goes', async () => {
    const w = start();
    await w.ready;
    await live();
    mkdirSync(join(dir, 'src', 'fresh'));
    writeFileSync(join(dir, 'src', 'fresh', 'b.ts'), 'b');
    await until(() => w.watched().includes('src/fresh'));
    expect(w.watched()).toContain('src/fresh');
    await until(() => paths.includes('src/fresh/b.ts'), () => appendFileSync(join(dir, 'src', 'fresh', 'b.ts'), 'more'));
    expect(paths).toContain('src/fresh/b.ts');
    rmSync(join(dir, 'src', 'fresh'), { recursive: true, force: true });
    await until(() => !w.watched().includes('src/fresh'));
    expect(w.watched()).not.toContain('src/fresh');
  }, 20_000);

  it('does not watch a dependency folder that appears later', async () => {
    const w = start();
    await w.ready;
    await live();
    mkdirSync(join(dir, 'src', 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(dir, 'src', 'later'));
    await until(() => w.watched().includes('src/later'));
    expect(w.watched().some((path) => path.includes('node_modules'))).toBe(false);
  }, 20_000);

  it('stops everything on close', async () => {
    const w = start();
    await w.ready;
    w.close();
    expect(w.watched()).toEqual([]);
  }, 20_000);
});
