import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { type ThreadRow, ThreadsRepository } from '../db/threads.repository';
import type { PiSessionService } from '../pi/pi-session.service';
import type { TrustService } from '../pi/trust.service';
import type { TerminalService } from '../terminal/terminal.service';
import type { OutcomesService } from '../threads/outcomes.service';
import type { ThreadStatusService } from '../threads/thread-status.service';
import { WorktreeService } from './worktree.service';

let base: string;
let project: string;
let db: DatabaseService;
let threads: ThreadsRepository;
let service: WorktreeService;
let recorder: { recordMerged: ReturnType<typeof vi.fn>; recordPullRequest: ReturnType<typeof vi.fn> };
let terminals: { start: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
let sessions: { has: () => boolean; isStreaming: () => boolean; dispose: ReturnType<typeof vi.fn> };
const oldRoot = process.env['PI_KIT_WORKTREE_ROOT'];
const oldGh = process.env['PI_KIT_GH'];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-wt-')));
  project = join(base, 'proj');
  mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'a.txt'), 'one\n');
  writeFileSync(join(project, 'b.txt'), 'bee\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'first');
  process.env['PI_KIT_WORKTREE_ROOT'] = join(base, 'worktrees');
  process.env['PI_KIT_GH'] = 'none';
  db = new DatabaseService({ dataDir: join(base, 'data') });
  const meta = new MetaRepository(db);
  meta.touchWorkspace(project);
  threads = new ThreadsRepository(db);
  terminals = { start: vi.fn(), write: vi.fn(), kill: vi.fn() };
  sessions = { has: () => false, isStreaming: () => false, dispose: vi.fn() };
  const trust = { useWorktrees: vi.fn() } as unknown as TrustService;
  const status = { touch: vi.fn(), listChanged: vi.fn() } as unknown as ThreadStatusService;
  recorder = { recordMerged: vi.fn(), recordPullRequest: vi.fn() };
  const outcomes = recorder as unknown as OutcomesService;
  service = new WorktreeService(meta, threads, sessions as unknown as PiSessionService, terminals as unknown as TerminalService, trust, status, outcomes);
});

afterEach(() => {
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
  if (oldRoot === undefined) delete process.env['PI_KIT_WORKTREE_ROOT'];
  else process.env['PI_KIT_WORKTREE_ROOT'] = oldRoot;
  if (oldGh === undefined) delete process.env['PI_KIT_GH'];
  else process.env['PI_KIT_GH'] = oldGh;
});

/** A thread in a new worktree, as ThreadsService makes it. */
async function newThread(id: string, title?: string): Promise<ThreadRow> {
  const facts = await service.create(project, { threadId: id, ...(title ? { title } : {}), request: {} });
  threads.insertDraft({ id, sessionPath: join(base, `${id}.jsonl`), cwd: facts.path, ...(title ? { title } : {}), worktree: facts });
  return threads.get(id) as ThreadRow;
}

describe('create', () => {
  it('adds <root>/<repo>/<thread-slug> on pi-kit/<thread-slug>, cut from the checked-out branch', async () => {
    const row = await newThread('11111111-aaaa', 'Fix the e2e tests');
    expect(row.worktreePath).toBe(join(base, 'worktrees', 'proj', 'fix-the-e2e-tests'));
    expect(row.branch).toBe('pi-kit/fix-the-e2e-tests');
    expect(row.baseBranch).toBe('main');
    expect(row.cwd).toBe(project);
    expect(existsSync(join(row.worktreePath as string, 'a.txt'))).toBe(true);
    expect(git(row.worktreePath as string, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('pi-kit/fix-the-e2e-tests');
    // The main checkout is untouched.
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  });

  it('numbers a name that is taken, and names a thread without a title after its id', async () => {
    const first = await newThread('22222222-aaaa', 'Same title');
    const second = await newThread('33333333-aaaa', 'Same title');
    expect(second.worktreePath).toBe(`${first.worktreePath}-2`);
    expect((await newThread('44444444-aaaa')).branch).toBe('pi-kit/thread-44444444');
  });

  it('cuts from the base the request or the project setting names', async () => {
    git(project, 'branch', 'develop');
    const facts = await service.create(project, { threadId: '55555555-aaaa', request: { base: 'develop' } });
    expect(facts.base).toBe('develop');
    expect(git(facts.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('pi-kit/thread-55555555');
  });

  it('runs the project setup command in the new folder through its terminal', async () => {
    const meta = new MetaRepository(db);
    meta.setWorktreeSettings(project, { setup: 'npm ci' });
    const facts = await service.create(project, { threadId: '66666666-aaaa', request: {} });
    expect(terminals.start).toHaveBeenCalledWith(facts.path, expect.any(Number), expect.any(Number));
    expect(terminals.write).toHaveBeenCalledWith(facts.path, 'npm ci\r');
  });

  it('refuses a folder that is not a repository, a repository without commits and an unknown base', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    await expect(service.create(plain, { threadId: 'x', request: {} })).rejects.toThrow(/not one/);
    const empty = join(base, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '-q', '-b', 'main');
    await expect(service.create(empty, { threadId: 'x', request: {} })).rejects.toThrow(/no commits/);
    await expect(service.create(project, { threadId: 'x', request: { base: 'nope' } })).rejects.toThrow(/does not exist/);
  });

  it('describes the worktree for the thread list', async () => {
    const row = await newThread('77777777-aaaa', 'Describe me');
    expect(service.describe(row)).toEqual({ path: row.worktreePath, branch: 'pi-kit/describe-me', base: 'main', exists: true });
    expect(service.settingsOf(project)).toMatchObject({ root: null, base: null, setup: null, git: true, defaultRoot: join(base, 'worktrees') });
  });
});

describe('merge back', () => {
  it('commits what is uncommitted with the message, merges with a merge commit on the base, and removes the worktree', async () => {
    const row = await newThread('88888888-aaaa', 'Reporting adapter');
    const path = row.worktreePath as string;
    writeFileSync(join(path, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(path, 'new.ts'), 'export {};\n');
    const state = await service.state(row);
    expect(state).toMatchObject({ exists: true, dirty: 2, ahead: 0, behind: 0, baseCheckedOut: true, branch: 'pi-kit/reporting-adapter', base: 'main', gh: false });
    const proposed = await service.message(row);
    expect(proposed.message.split('\n')[0]).toBe('Reporting adapter');
    expect(proposed.files).toBe(2);

    const result = await service.merge(row, { mode: 'merge', message: 'Add the adapter\n\nWith a new module.', remove: true });
    expect(result).toMatchObject({ status: 'merged', removed: true, conflicts: [] });
    expect(result.commit).toMatch(/^[0-9a-f]+$/);
    // The merge back tells the outcome store: the merge commit is the thread's outcome.
    expect(recorder.recordMerged).toHaveBeenCalledTimes(1);
    expect(recorder.recordMerged).toHaveBeenCalledWith(expect.objectContaining({ id: '88888888-aaaa' }), result.commit);
    // A merge commit on main: two parents, the branch's commit among them.
    const parents = git(project, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
    expect(parents).toHaveLength(3);
    expect(git(project, 'log', '-1', '--format=%s').trim()).toBe('Merge pi-kit/reporting-adapter into main');
    expect(git(project, 'log', '--format=%s', '--all').split('\n')).toContain('Add the adapter');
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(existsSync(join(project, 'new.ts'))).toBe(true);
    // The worktree and its merged branch are gone; the thread carries on in the project.
    expect(existsSync(path)).toBe(false);
    expect(git(project, 'branch', '--list', 'pi-kit/reporting-adapter').trim()).toBe('');
    const after = threads.get('88888888-aaaa') as ThreadRow;
    expect(after.worktreePath).toBeNull();
    expect(after.cwd).toBe(project);
    expect(sessions.dispose).toHaveBeenCalledWith('88888888-aaaa');
    expect(terminals.kill).toHaveBeenCalledWith(path);
  });

  it('keeps the worktree when it is not asked to remove it', async () => {
    const row = await newThread('99999999-aaaa', 'Keep it');
    writeFileSync(join(row.worktreePath as string, 'k.txt'), 'k\n');
    const result = await service.merge(row, { mode: 'merge', remove: false });
    expect(result.status).toBe('merged');
    expect(result.removed).toBe(false);
    expect(existsSync(row.worktreePath as string)).toBe(true);
    // Nothing more to merge: a second merge back says so.
    expect((await service.merge(row, { mode: 'merge', remove: false })).message).toMatch(/nothing/);
  });

  it('will not merge while the main checkout has another branch checked out or uncommitted changes', async () => {
    const row = await newThread('aaaaaaaa-aaaa', 'Blocked');
    writeFileSync(join(row.worktreePath as string, 'b.txt'), 'changed in the worktree\n');
    git(project, 'checkout', '-q', '-b', 'other');
    await expect(service.merge(row, { mode: 'merge', remove: false })).rejects.toThrow(/other checked out, not main/);
    git(project, 'checkout', '-q', 'main');
    writeFileSync(join(project, 'a.txt'), 'dirty in main\n');
    await expect(service.merge(row, { mode: 'merge', remove: false })).rejects.toThrow(/uncommitted changes/);
  });

  it('leaves the main checkout alone when the merge conflicts, and says which files', async () => {
    const row = await newThread('bbbbbbbb-aaaa', 'Conflicting');
    writeFileSync(join(row.worktreePath as string, 'a.txt'), 'from the worktree\n');
    writeFileSync(join(project, 'a.txt'), 'from main\n');
    git(project, 'commit', '-q', '-am', 'main moves');
    const result = await service.merge(row, { mode: 'merge', message: 'worktree edit', remove: true });
    expect(result).toMatchObject({ status: 'conflict', conflicts: ['a.txt'], removed: false });
    expect(existsSync(join(project, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('from main\n');
    expect(existsSync(row.worktreePath as string)).toBe(true);
  });

  it('refuses a pull request without gh', async () => {
    const row = await newThread('cccccccc-aaaa', 'No gh');
    await expect(service.merge(row, { mode: 'pr', remove: false })).rejects.toThrow(/no remote|gh/);
  });
});

describe('sync with base', () => {
  it('brings the base into the branch by merge, and reports up to date afterwards', async () => {
    const row = await newThread('dddddddd-aaaa', 'Sync me');
    writeFileSync(join(project, 'b.txt'), 'bee two\n');
    git(project, 'commit', '-q', '-am', 'main moves on');
    expect((await service.state(row)).behind).toBe(1);
    const result = await service.sync(row, 'merge');
    expect(result).toMatchObject({ status: 'synced', conflicts: [], fetched: false });
    expect(readFileSync(join(row.worktreePath as string, 'b.txt'), 'utf8')).toBe('bee two\n');
    expect((await service.state(row)).behind).toBe(0);
    expect((await service.sync(row, 'merge')).status).toBe('up-to-date');
  });

  it('can rebase instead', async () => {
    const row = await newThread('eeeeeeee-aaaa', 'Rebase me');
    const path = row.worktreePath as string;
    writeFileSync(join(path, 'mine.txt'), 'mine\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'mine');
    writeFileSync(join(project, 'b.txt'), 'bee two\n');
    git(project, 'commit', '-q', '-am', 'main moves on');
    expect((await service.sync(row, 'rebase')).status).toBe('synced');
    expect(git(path, 'log', '--format=%s').split('\n').slice(0, 2)).toEqual(['mine', 'main moves on']);
  });

  it('stops on conflicts and leaves them in the worktree, where abort undoes them', async () => {
    const row = await newThread('ffffffff-aaaa', 'Conflict me');
    const path = row.worktreePath as string;
    writeFileSync(join(path, 'a.txt'), 'worktree side\n');
    git(path, 'commit', '-q', '-am', 'worktree edit');
    writeFileSync(join(project, 'a.txt'), 'main side\n');
    git(project, 'commit', '-q', '-am', 'main edit');
    const result = await service.sync(row, 'merge');
    expect(result).toMatchObject({ status: 'conflict', conflicts: ['a.txt'] });
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toContain('<<<<<<<');
    const state = await service.state(row);
    expect(state.operation).toBe('merge');
    expect(state.conflicts).toEqual(['a.txt']);
    // A second sync does not pile on.
    await expect(service.sync(row, 'merge')).rejects.toThrow(/already waiting/);
    // Resolved by hand, merging back finishes the merge and the branch lands on the base.
    writeFileSync(join(path, 'a.txt'), 'both sides\n');
    const merged = await service.merge(row, { mode: 'merge', remove: false });
    expect(merged.status).toBe('merged');
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('both sides\n');
  });

  it('abort gives the merge up', async () => {
    const row = await newThread('abababab-aaaa', 'Abort me');
    const path = row.worktreePath as string;
    writeFileSync(join(path, 'a.txt'), 'worktree side\n');
    git(path, 'commit', '-q', '-am', 'worktree edit');
    writeFileSync(join(project, 'a.txt'), 'main side\n');
    git(project, 'commit', '-q', '-am', 'main edit');
    await service.sync(row, 'merge');
    await service.abort(row);
    expect((await service.state(row)).operation).toBeNull();
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('worktree side\n');
  });

  it('will not run while the thread is running', async () => {
    const row = await newThread('cdcdcdcd-aaaa', 'Busy');
    sessions.has = () => true;
    sessions.isStreaming = () => true;
    await expect(service.sync(row, 'merge')).rejects.toThrow(/Stop the run/);
  });
});

describe('remove', () => {
  it('removes a clean worktree', async () => {
    const row = await newThread('12121212-aaaa', 'Clean');
    expect(await service.remove(row, { force: false })).toEqual({ removed: true });
    expect(existsSync(row.worktreePath as string)).toBe(false);
    expect((threads.get(row.id) as ThreadRow).worktreePath).toBeNull();
    // The branch is kept: removing the folder is not discarding the work.
    expect(git(project, 'branch', '--list', 'pi-kit/clean').trim()).toContain('pi-kit/clean');
  });

  it('asks before it removes a worktree with uncommitted changes, and removes it with force', async () => {
    const row = await newThread('34343434-aaaa', 'Dirty');
    writeFileSync(join(row.worktreePath as string, 'wip.ts'), 'wip\n');
    await expect(service.remove(row, { force: false })).rejects.toThrow(/1 uncommitted change/);
    expect(existsSync(row.worktreePath as string)).toBe(true);
    await service.remove(row, { force: true });
    expect(existsSync(row.worktreePath as string)).toBe(false);
  });

  it('forgets a worktree whose folder is already gone', async () => {
    const row = await newThread('56565656-aaaa', 'Gone');
    rmSync(row.worktreePath as string, { recursive: true, force: true });
    expect(await service.remove(row, { force: false })).toEqual({ removed: true });
    expect((threads.get(row.id) as ThreadRow).worktreePath).toBeNull();
  });
});
