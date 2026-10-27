import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import Database from 'better-sqlite3-multiple-ciphers';
import { createTwoFilesPatch } from 'diff';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChangesRepository } from '../db/changes.repository';
import type { DatabaseService } from '../db/database.service';
import type { PiSessionService, ToolStart } from '../pi/pi-session.service';
import type { OutcomesService } from '../threads/outcomes.service';
import type { ThreadsService } from '../threads/threads.service';
import { ChangesService } from './changes.service';

const migration = readFileSync(join(__dirname, '..', 'db', 'migrations', '0001_init.sql'), 'utf8');

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

let n = 0;
const msg = (message: Record<string, unknown>): PiSessionEntry => ({ type: 'message', id: `e${++n}`, message });
const user = (text: string) => msg({ role: 'user', content: text });
const toolCall = (id: string, name: string, path: string) => msg({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: { path } }] });
const toolResult = (id: string, details?: Record<string, unknown>) => msg({ role: 'toolResult', toolCallId: id, toolName: 'edit', isError: false, content: [{ type: 'text', text: 'ok' }], ...(details ? { details } : {}) });

/** The service with a throwaway repository, an in-memory database and a stand-in for the open pi session. */
function setup(options: { git?: boolean } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pk-changes-')));
  if (options.git !== false) {
    sh(cwd, 'init', '-q');
    sh(cwd, 'config', 'user.email', 't@example.com');
    sh(cwd, 'config', 'user.name', 'T');
  }
  const db = new Database(':memory:');
  db.exec(migration);
  const repo = new ChangesRepository({ db } as unknown as DatabaseService);
  let branch: PiSessionEntry[] = [];
  const sessions = {
    has: () => true,
    isStreaming: () => false,
    branch: () => ({ entries: branch, path: undefined }),
    onToolStart: () => () => undefined,
  } as unknown as PiSessionService;
  const threads = { cwdOf: () => cwd, sessionPathOf: () => join(cwd, '.none') } as unknown as ThreadsService;
  let range: { base: string; head: string } | undefined;
  const outcomes = { range: () => range } as unknown as OutcomesService;
  const service = new ChangesService(repo, sessions, threads, outcomes);
  const start = (toolName: string, path: string): ToolStart => ({ threadId: 't1', cwd, toolName, args: { path } });
  return { cwd, repo, service, start, setRange: (r: { base: string; head: string } | undefined) => (range = r), setBranch: (b: PiSessionEntry[]) => (branch = b), write: (rel: string, text: string) => {
    mkdirSync(join(cwd, rel, '..'), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  } };
}

describe('This thread: the content before the first edit is captured when the tool starts', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.write('a.ts', 'one\ntwo\nthree\n');
    sh(ctx.cwd, 'add', '.');
    sh(ctx.cwd, 'commit', '-q', '-m', 'init');
  });

  it('keeps the first copy of an edited file and a note that a written file did not exist', () => {
    ctx.service.capture(ctx.start('edit', 'a.ts'));
    ctx.write('a.ts', 'one\nTWO\nthree\n'); // pi's edit lands
    ctx.service.capture(ctx.start('edit', 'a.ts')); // a second edit must not replace the first copy
    expect(ctx.repo.baseline('t1', 'a.ts')).toEqual({ existed: true, content: 'one\ntwo\nthree\n' });

    ctx.service.capture(ctx.start('write', 'new.ts'));
    expect(ctx.repo.baseline('t1', 'new.ts')).toEqual({ existed: false, content: '' });
  });

  it('ignores other tools and paths outside the folder', () => {
    ctx.service.capture(ctx.start('read', 'a.ts'));
    ctx.service.capture(ctx.start('edit', '../elsewhere.ts'));
    expect(ctx.repo.baseline('t1', 'a.ts')).toBeUndefined();
  });

  it('diffs against the captured copy, with the turn the file was first touched in', async () => {
    ctx.service.capture(ctx.start('edit', 'a.ts'));
    ctx.write('a.ts', 'one\nTWO\nthree\nfour\n');
    ctx.service.capture(ctx.start('write', 'new.ts'));
    ctx.write('new.ts', 'x\ny\n');
    ctx.setBranch([
      user('go'),
      toolCall('c1', 'edit', 'a.ts'),
      toolResult('c1', { patch: 'irrelevant' }),
      user('more'),
      toolCall('c2', 'write', 'new.ts'),
      toolResult('c2'),
    ]);
    const list = await ctx.service.list('t1', 'thread');
    expect(list.git).toBe(true);
    expect(list.files).toEqual([
      { path: 'a.ts', status: 'M', added: 2, removed: 1, turn: 1, baseline: 'captured' },
      { path: 'new.ts', status: 'A', added: 2, removed: 0, turn: 2, baseline: 'captured' },
    ]);
    const model = await ctx.service.file('t1', 'thread', 'a.ts');
    expect(model.hunks[0].lines.filter((l) => l.kind !== 'ctx').map((l) => `${l.kind}:${l.text}`)).toEqual(['del:two', 'add:TWO', 'add:four']);
  });

  it('lists a file a background agent wrote, from its baseline alone, in the thread\'s current turn', async () => {
    ctx.service.capture(ctx.start('write', 'test/new.test.ts'));
    ctx.write('test/new.test.ts', 'x\n');
    ctx.setBranch([user('go'), toolCall('c1', 'edit', 'a.ts'), toolResult('c1', { patch: 'irrelevant' }), user('more')]);
    const list = await ctx.service.list('t1', 'thread');
    expect(list.files.find((file) => file.path === 'test/new.test.ts')).toEqual({ path: 'test/new.test.ts', status: 'A', added: 1, removed: 0, turn: 2, baseline: 'captured' });
  });

  it('leaves out a file that ends up as it started', async () => {
    ctx.service.capture(ctx.start('edit', 'a.ts'));
    ctx.write('a.ts', 'changed\n');
    ctx.write('a.ts', 'one\ntwo\nthree\n'); // the user put it back
    ctx.setBranch([user('go'), toolCall('c1', 'edit', 'a.ts'), toolResult('c1', { patch: 'x' })]);
    expect((await ctx.service.list('t1', 'thread')).files).toEqual([]);
  });

  it('rebuilds the earlier version from the edit patches when it was not captured (a session from before, or from the CLI)', async () => {
    const before = 'one\ntwo\nthree\n';
    const after = 'one\nTWO\nthree\n';
    ctx.write('a.ts', after);
    ctx.setBranch([user('go'), toolCall('c1', 'edit', 'a.ts'), toolResult('c1', { patch: createTwoFilesPatch('a.ts', 'a.ts', before, after, '', '', { context: 3 }) })]);
    const [file] = (await ctx.service.list('t1', 'thread')).files;
    expect(file).toMatchObject({ path: 'a.ts', status: 'M', added: 1, removed: 1, baseline: 'reconstructed' });
    expect((await ctx.service.file('t1', 'thread', 'a.ts')).note).toMatch(/rebuilt/);
  });

  it('falls back to git HEAD for a file it cannot rebuild, and says so', async () => {
    ctx.write('a.ts', 'one\nTWO\nthree\n');
    // a `write` is the first step and nothing was captured: pi never reported what it replaced
    ctx.setBranch([user('go'), toolCall('c1', 'write', 'a.ts'), toolResult('c1')]);
    const [file] = (await ctx.service.list('t1', 'thread')).files;
    expect(file).toMatchObject({ path: 'a.ts', status: 'M', added: 1, removed: 1, baseline: 'git-head' });
    expect((await ctx.service.file('t1', 'thread', 'a.ts')).note).toMatch(/HEAD/);
  });

  it('shows a new file as added in full when there is neither a copy nor git to compare with', async () => {
    ctx.write('fresh.ts', 'a\nb\n');
    ctx.setBranch([user('go'), toolCall('c1', 'write', 'fresh.ts'), toolResult('c1')]);
    const [file] = (await ctx.service.list('t1', 'thread')).files;
    expect(file).toMatchObject({ path: 'fresh.ts', status: 'A', added: 2, baseline: 'empty' });
  });

  it('reverts a file to the captured copy, and deletes a file pi created', async () => {
    ctx.service.capture(ctx.start('edit', 'a.ts'));
    ctx.write('a.ts', 'one\nTWO\nthree\n');
    ctx.service.capture(ctx.start('write', 'new.ts'));
    ctx.write('new.ts', 'x\n');
    ctx.setBranch([user('go'), toolCall('c1', 'edit', 'a.ts'), toolResult('c1', { patch: 'x' }), toolCall('c2', 'write', 'new.ts'), toolResult('c2')]);

    await ctx.service.revert('t1', 'thread', 'a.ts');
    expect(readFileSync(join(ctx.cwd, 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\n');
    await ctx.service.revert('t1', 'thread', 'new.ts');
    expect(existsSync(join(ctx.cwd, 'new.ts'))).toBe(false);
    expect((await ctx.service.list('t1', 'thread')).files).toEqual([]);
  });

  it('refuses paths that leave the folder', async () => {
    ctx.setBranch([]);
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
    expect(mod.hunks[0].lines.filter((l) => l.kind !== 'ctx').map((l) => `${l.kind}:${l.text}`)).toEqual(['del:2', 'add:TWO', 'add:4']);
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
    expect((await fresh.service.list('t1', 'worktree')).files).toEqual([{ path: 'first.ts', status: 'A', added: 1, removed: 0 }]);

    const plain = setup({ git: false });
    const list = await plain.service.list('t1', 'worktree');
    expect(list).toMatchObject({ git: false, files: [] });
    expect(list.note).toMatch(/not a git repository/);
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
    expect(sh(ctx.cwd, 'diff', '--name-only', `${base}..${head}`).trim().split('\n')).toEqual(list.files.map((f) => f.path));
    const mod = await ctx.service.file('t1', 'outcome', 'src/mod.ts');
    expect(mod.hunks[0].lines.filter((l) => l.kind !== 'ctx').map((l) => `${l.kind}:${l.text}`)).toEqual(['del:2', 'add:TWO', 'add:4']);
    expect(await ctx.service.file('t1', 'outcome', 'fresh.ts')).toMatchObject({ status: 'A', added: 2 });
    expect(await ctx.service.file('t1', 'outcome', 'gone.ts')).toMatchObject({ status: 'D', removed: 1 });
    expect(await ctx.service.file('t1', 'outcome', 'later.ts')).toMatchObject({ hunks: [], note: expect.stringMatching(/did not change/) });
  });

  it('says why there is nothing when the thread has no outcome, or the folder is not a repository', async () => {
    const { ctx } = twoCommits();
    const none = await ctx.service.list('t1', 'outcome');
    expect(none.files).toEqual([]);
    expect(none.note).toMatch(/no outcome yet/);
    expect(await ctx.service.file('t1', 'outcome', 'src/mod.ts')).toMatchObject({ hunks: [], note: expect.stringMatching(/no outcome/) });
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
