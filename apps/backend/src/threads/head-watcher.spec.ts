import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HeadWatcher } from './head-watcher';

describe('HeadWatcher', () => {
  let base: string;
  let moved: string[];
  let watcher: HeadWatcher;
  const repo = (name: string, commit = true): string => {
    const dir = join(base, name);
    mkdirSync(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    if (commit) commitIn(dir, 'init');
    return dir;
  };
  const commitIn = (dir: string, message: string): void => {
    writeFileSync(join(dir, `${message}.txt`), message);
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message], {
      cwd: dir,
    });
  };
  const until = async (done: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  };
  const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 800));

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-head-')));
    moved = [];
    watcher = new HeadWatcher((folder) => moved.push(folder));
  });
  afterEach(() => {
    watcher.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it('hears a commit, also one made right after the watch started', async () => {
    const dir = repo('a');
    watcher.watch(dir);
    commitIn(dir, 'right-away');
    await until(() => moved.includes(dir));
    expect(moved).toContain(dir);
  });

  it('watches one folder at a time: the one watched last', async () => {
    const a = repo('a');
    const b = repo('b');
    watcher.watch(a);
    watcher.watch(b);
    await settled();
    moved.length = 0;
    commitIn(a, 'in-a');
    await settled();
    expect(moved).not.toContain(a);
    commitIn(b, 'in-b');
    await until(() => moved.includes(b));
    expect(moved).toContain(b);
  });

  it('follows a repository to its first commit', async () => {
    const dir = repo('fresh', false);
    watcher.watch(dir);
    await settled();
    moved.length = 0;
    commitIn(dir, 'first');
    await until(() => moved.includes(dir));
    expect(moved).toContain(dir);
  });
});
