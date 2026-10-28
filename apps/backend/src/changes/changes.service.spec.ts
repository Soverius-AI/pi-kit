import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChangesRepository } from '../db/changes.repository';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import type { PiSessionService } from '../pi/pi-session.service';
import { RunSnapshotsService } from '../snapshots/run-snapshots.service';
import type { OutcomesService } from '../threads/outcomes.service';
import type { ThreadsService } from '../threads/threads.service';
import { FolderChangesService } from '../folder-changes/folder-changes.service';
import { ChangesService } from './changes.service';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

/** The service with a throwaway repository and database, and real snapshots around the thread's runs. */
function setup(options: { git?: boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-changes-')));
  const cwd = join(base, 'project');
  mkdirSync(cwd);
  if (options.git !== false) {
    sh(cwd, 'init', '-q');
    sh(cwd, 'config', 'user.email', 't@example.com');
    sh(cwd, 'config', 'user.name', 'T');
  }
  const database = new DatabaseService({ dataDir: join(base, 'data') });
  const log = new EventLogRepository(database);
  const repo = new ChangesRepository(database);
  const sessions = { has: () => true, isStreaming: () => false } as unknown as PiSessionService;
  const threads = { cwdOf: () => cwd } as unknown as ThreadsService;
  let range: { base: string; head: string } | undefined;
  const outcomes = { range: () => range } as unknown as OutcomesService;
  const snapshots = new RunSnapshotsService(
    log,
    { get: () => ({ cwd, worktreePath: null }) } as never,
    new FolderChangesService(),
    {
      dataDir: join(base, 'data'),
    } as never,
  );
  snapshots.onModuleInit();
  const service = new ChangesService(repo, sessions, threads, outcomes, snapshots);
  const write = (rel: string, text: string) => {
    mkdirSync(join(cwd, rel, '..'), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  };
  let runs = 0;
  /** One run of thread t1: the snapshot before it, `work` as pi's edits, the snapshot after it. */
  const run = async (work: () => void) => {
    const id = `r${++runs}`;
    log.beginRun('t1', id);
    await snapshots.whenStarted('t1');
    work();
    log.endRun(id, 'finished');
    await until(() => log.runsOf('t1').find((r) => r.runId === id)?.endTree != null);
  };
  return { cwd, repo, service, write, run, setRange: (r: { base: string; head: string } | undefined) => (range = r) };
}

describe('This thread: what its runs changed, from the snapshots around them', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.write('a.ts', 'one\ntwo\nthree\n');
    ctx.write('other.ts', 'o\n');
    sh(ctx.cwd, 'add', '.');
    sh(ctx.cwd, 'commit', '-q', '-m', 'init');
  });

  it('lists the files its runs changed, with the run that first changed each, and diffs one', async () => {
    await ctx.run(() => ctx.write('a.ts', 'one\nTWO\nthree\nfour\n'));
    await ctx.run(() => ctx.write('new.ts', 'x\ny\n'));
    const list = await ctx.service.list('t1', 'thread');
    expect(list.git).toBe(true);
    expect(list.files).toEqual([
      { path: 'a.ts', status: 'M', added: 2, removed: 1, run: 1 },
      { path: 'new.ts', status: 'A', added: 2, removed: 0, run: 2 },
    ]);
    const model = await ctx.service.file('t1', 'thread', 'a.ts');
    expect(model.hunks[0].lines.filter((l) => l.kind !== 'ctx').map((l) => `${l.kind}:${l.text}`)).toEqual([
      'del:two',
      'add:TWO',
      'add:four',
    ]);
  });

  it('compares with the folder now: a later edit by hand to the same file shows, a file only the person changed does not', async () => {
    await ctx.run(() => ctx.write('a.ts', 'one\nTWO\nthree\n'));
    ctx.write('a.ts', 'one\nTWO\nthree\nmine\n');
    ctx.write('other.ts', 'changed by hand\n');
    expect((await ctx.service.list('t1', 'thread')).files).toEqual([
      { path: 'a.ts', status: 'M', added: 2, removed: 1, run: 1 },
    ]);
  });

  it('leaves out a file that ends up as it started', async () => {
    await ctx.run(() => ctx.write('a.ts', 'changed\n'));
    ctx.write('a.ts', 'one\ntwo\nthree\n'); // the user put it back
    expect((await ctx.service.list('t1', 'thread')).files).toEqual([]);
  });

  it('reverts a file to the snapshot before the thread changed it, and deletes a file the thread created', async () => {
    await ctx.run(() => {
      ctx.write('a.ts', 'one\nTWO\nthree\n');
      ctx.write('new.ts', 'x\n');
    });
    await ctx.service.revert('t1', 'thread', 'a.ts');
    expect(readFileSync(join(ctx.cwd, 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\n');
    await ctx.service.revert('t1', 'thread', 'new.ts');
    expect(existsSync(join(ctx.cwd, 'new.ts'))).toBe(false);
    expect((await ctx.service.list('t1', 'thread')).files).toEqual([]);
    expect(sh(ctx.cwd, 'status', '--porcelain')).toBe('');
  });

  it('has nothing for a thread that never ran here', async () => {
    expect((await ctx.service.list('t1', 'thread')).files).toEqual([]);
    expect((await ctx.service.file('t1', 'thread', 'a.ts')).note).toMatch(/has not changed/);
  });

  it('refuses paths that leave the folder', async () => {
    await expect(ctx.service.revert('t1', 'thread', '../x')).rejects.toThrow(/outside/);
    await expect(ctx.service.file('t1', 'worktree', '/etc/passwd')).rejects.toThrow();
  });
});

describe('Working tree: git diff of the folder', () => {
  it('lists modified, new and deleted files with their counts, and diffs one', async () => {
    const ctx = setup();
    ctx.write('keep.ts', 'a\nb\n');
    ctx.write('gone.ts', 'x\n');
    ctx.write('src/mod.ts', '1\n2\n3\n');
    sh(ctx.cwd, 'add', '.');
    sh(ctx.cwd, 'commit', '-q', '-m', 'init');
    ctx.write('src/mod.ts', '1\nTWO\n3\n4\n');
    ctx.write('fresh.ts', 'n1\nn2\n');
    execFileSync('rm', [join(ctx.cwd, 'gone.ts')]);

    const list = await ctx.service.list('t1', 'worktree');
    expect(list.files).toEqual([
      { path: 'fresh.ts', status: 'A', added: 2, removed: 0 },
      { path: 'gone.ts', status: 'D', added: 0, removed: 1 },
      { path: 'src/mod.ts', status: 'M', added: 2, removed: 1 },
    ]);
    const mod = await ctx.service.file('t1', 'worktree', 'src/mod.ts');
    expect(mod.hunks[0].lines.filter((l) => l.kind !== 'ctx').map((l) => `${l.kind}:${l.text}`)).toEqual([
      'del:2',
      'add:TWO',
      'add:4',
    ]);
    expect(await ctx.service.file('t1', 'worktree', 'fresh.ts')).toMatchObject({ status: 'A', added: 2 });
    expect(await ctx.service.file('t1', 'worktree', 'gone.ts')).toMatchObject({ status: 'D', removed: 1 });
  });

  it('reverts a modified file to HEAD, removes an untracked one, and stages everything', async () => {
    const ctx = setup();
    ctx.write('a.ts', 'orig\n');
    sh(ctx.cwd, 'add', '.');
    sh(ctx.cwd, 'commit', '-q', '-m', 'init');
    ctx.write('a.ts', 'changed\n');
    ctx.write('u.ts', 'u\n');

    await ctx.service.revert('t1', 'worktree', 'a.ts');
    expect(readFileSync(join(ctx.cwd, 'a.ts'), 'utf8')).toBe('orig\n');
    await ctx.service.revert('t1', 'worktree', 'u.ts');
    expect(existsSync(join(ctx.cwd, 'u.ts'))).toBe(false);

    ctx.write('b.ts', 'b\n');
    ctx.write('a.ts', 'again\n');
    expect(await ctx.service.stage('t1', 'worktree')).toEqual({ staged: 2 });
    expect(sh(ctx.cwd, 'diff', '--cached', '--name-only').trim().split('\n').sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('works in a repository without commits, and says there is no working tree outside git', async () => {
    const fresh = setup();
    fresh.write('first.ts', 'x\n');
    expect((await fresh.service.list('t1', 'worktree')).files).toEqual([
      { path: 'first.ts', status: 'A', added: 1, removed: 0 },
    ]);

    const plain = setup({ git: false });
    const list = await plain.service.list('t1', 'worktree');
    expect(list).toMatchObject({ git: false, files: [] });
    expect(list.note).toMatch(/need a git repository/);
    expect(await plain.service.list('t1', 'thread')).toMatchObject({ git: false, files: [] });
    await expect(plain.service.stage('t1', 'worktree')).rejects.toThrow(/not a git repository/);
  });
});

describe('Outcome: git diff base..head of the thread outcome', () => {
  /** A base commit, then a commit that modifies, adds and deletes, and a later one that is not part of the range. */
  function twoCommits() {
    const ctx = setup();
    ctx.write('keep.ts', 'a\nb\n');
    ctx.write('gone.ts', 'x\n');
    ctx.write('src/mod.ts', '1\n2\n3\n');
    sh(ctx.cwd, 'add', '.');
    sh(ctx.cwd, 'commit', '-q', '-m', 'init');
    const base = sh(ctx.cwd, 'rev-parse', 'HEAD').trim();
    ctx.write('src/mod.ts', '1\nTWO\n3\n4\n');
    ctx.write('fresh.ts', 'n1\nn2\n');
    execFileSync('rm', [join(ctx.cwd, 'gone.ts')]);
    sh(ctx.cwd, 'add', '-A');
    sh(ctx.cwd, 'commit', '-q', '-m', 'the result');
    const head = sh(ctx.cwd, 'rev-parse', 'HEAD').trim();
    ctx.write('later.ts', 'after the outcome\n');
    sh(ctx.cwd, 'add', '-A');
    sh(ctx.cwd, 'commit', '-q', '-m', 'later');
    return { ctx, base, head };
  }

  it('lists the files the two commits differ in, with the numbers git gives, and diffs one', async () => {
    const { ctx, base, head } = twoCommits();
    ctx.setRange({ base, head });
    const list = await ctx.service.list('t1', 'outcome');
    expect(list.source).toBe('outcome');
    expect(list.git).toBe(true);
    expect(list.files).toEqual([
      { path: 'fresh.ts', status: 'A', added: 2, removed: 0 },
      { path: 'gone.ts', status: 'D', added: 0, removed: 1 },
      { path: 'src/mod.ts', status: 'M', added: 2, removed: 1 },
    ]);
    // The same set of files git itself names for base..head, and the later commit is not in it.
    expect(sh(ctx.cwd, 'diff', '--name-only', `${base}..${head}`).trim().split('\n')).toEqual(
      list.files.map((f) => f.path),
    );
    const mod = await ctx.service.file('t1', 'outcome', 'src/mod.ts');
    expect(mod.hunks[0].lines.filter((l) => l.kind !== 'ctx').map((l) => `${l.kind}:${l.text}`)).toEqual([
      'del:2',
      'add:TWO',
      'add:4',
    ]);
    expect(await ctx.service.file('t1', 'outcome', 'fresh.ts')).toMatchObject({ status: 'A', added: 2 });
    expect(await ctx.service.file('t1', 'outcome', 'gone.ts')).toMatchObject({ status: 'D', removed: 1 });
    expect(await ctx.service.file('t1', 'outcome', 'later.ts')).toMatchObject({
      hunks: [],
      note: expect.stringMatching(/did not change/),
    });
  });

  it('says why there is nothing when the thread has no outcome, or the folder is not a repository', async () => {
    const { ctx } = twoCommits();
    const none = await ctx.service.list('t1', 'outcome');
    expect(none.files).toEqual([]);
    expect(none.note).toMatch(/no outcome yet/);
    expect(await ctx.service.file('t1', 'outcome', 'src/mod.ts')).toMatchObject({
      hunks: [],
      note: expect.stringMatching(/no outcome/),
    });
    const plain = setup({ git: false });
    expect((await plain.service.list('t1', 'outcome')).git).toBe(false);
  });
});

describe('pending review comments', () => {
  it('are replaced as a whole and come back in order', () => {
    const ctx = setup({ git: false });
    const a = { id: 'a', file: 'x.ts', side: 'new' as const, line: 3, snippet: 's', text: 'one' };
    const b = { id: 'b', file: 'y.ts', side: 'old' as const, line: 1, snippet: 't', text: 'two' };
    ctx.service.putComments('t1', [b, a]);
    expect(ctx.service.comments('t1')).toEqual([b, a]);
    ctx.service.putComments('t1', [a]);
    expect(ctx.service.comments('t1')).toEqual([a]);
    ctx.repo.clearComments('t1');
    expect(ctx.service.comments('t1')).toEqual([]);
  });
});
