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
import * as wtGit from './worktree-git';

// The Where row of the new-thread page against real git repositories in temporary folders: the branch rules of a Local thread, a new worktree
// (named, detached, typed, carrying changes, from a remote branch, with a setup script), a hand off in both directions, a branch for a detached worktree.

let base: string;
let project: string;
let db: DatabaseService;
let meta: MetaRepository;
let threads: ThreadsRepository;
let service: WorktreeService;
let terminals: { start: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
let sessions: { has: () => boolean; isStreaming: () => boolean; dispose: ReturnType<typeof vi.fn> };
const oldRoot = process.env['PI_KIT_WORKTREE_ROOT'];
const oldGh = process.env['PI_KIT_GH'];

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
const write = (cwd: string, file: string, text: string): void => {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), text);
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-where-')));
  project = join(base, 'proj');
  mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  write(project, 'a.txt', 'one\n');
  write(project, 'b.txt', 'bee\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'first');
  process.env['PI_KIT_WORKTREE_ROOT'] = join(base, 'worktrees');
  process.env['PI_KIT_GH'] = 'none';
  db = new DatabaseService({ dataDir: join(base, 'data') });
  meta = new MetaRepository(db);
  meta.touchWorkspace(project);
  threads = new ThreadsRepository(db);
  terminals = { start: vi.fn(), write: vi.fn(), kill: vi.fn() };
  sessions = { has: () => false, isStreaming: () => false, dispose: vi.fn() };
  const trust = { useWorktrees: vi.fn() } as unknown as TrustService;
  const status = { touch: vi.fn(), listChanged: vi.fn() } as unknown as ThreadStatusService;
  const outcomes = { recordMerged: vi.fn(), recordPullRequest: vi.fn() } as unknown as OutcomesService;
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

/** A thread in a worktree, made as `ThreadsService.create` makes it. */
async function worktreeThread(id: string, request: Parameters<WorktreeService['create']>[1]['request'] = {}, title?: string): Promise<ThreadRow> {
  const facts = await service.create(project, { threadId: id, ...(title ? { title } : {}), request });
  threads.insertDraft({ id, sessionPath: join(base, `${id}.jsonl`), cwd: facts.path, ...(title ? { title } : {}), worktree: facts });
  return threads.get(id) as ThreadRow;
}

/** A thread in the project folder. */
function localThread(id: string, title?: string): ThreadRow {
  threads.insertDraft({ id, sessionPath: join(base, `${id}.jsonl`), cwd: project, ...(title ? { title } : {}) });
  return threads.get(id) as ThreadRow;
}

describe('the folder as the Where row shows it', () => {
  it('lists the branches, the current one, the changed files and who holds a branch', async () => {
    git(project, 'branch', 'develop');
    const held = await worktreeThread('11111111-aaaa', {}, 'Settings ux');
    write(project, 'new.txt', 'x\n');
    write(project, 'a.txt', 'changed\n');
    const state = await service.projectGit(project);
    expect(state).toMatchObject({ git: true, branch: 'main', dirty: 2, hasRemote: false, remoteBranches: [] });
    const byName = Object.fromEntries(state.branches.map((b) => [b.name, b]));
    expect(byName['main']).toMatchObject({ current: true, heldBy: null });
    expect(byName['develop']).toMatchObject({ current: false, heldBy: null });
    expect(byName['pi-kit/settings-ux']?.heldBy).toEqual({ path: held.worktreePath, thread: 'Settings ux' });
  });

  it('says so for a folder that is not a repository', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(await service.projectGit(plain)).toMatchObject({ git: false, branch: null, branches: [], dirty: 0 });
  });

  it('knows a detached HEAD', async () => {
    git(project, 'checkout', '-q', '--detach');
    const state = await service.projectGit(project);
    expect(state.branch).toBeNull();
    expect(state.head).toMatch(/^[0-9a-f]{7}$/);
  });
});

describe('Local on another branch', () => {
  it('switches the checkout when the tree is clean, and does nothing for the branch that is checked out', async () => {
    git(project, 'branch', 'develop');
    expect(await service.switchLocal(project, { branch: 'main' })).toBe('main');
    expect(await service.switchLocal(project, {})).toBe('main');
    expect(await service.switchLocal(project, { branch: 'develop' })).toBe('develop');
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('develop');
  });

  it('refuses a dirty tree and says how many files to stash or commit; untracked files count', async () => {
    git(project, 'branch', 'develop');
    write(project, 'a.txt', 'dirty\n');
    write(project, 'untracked.txt', 'u\n');
    await expect(service.switchLocal(project, { branch: 'develop' })).rejects.toThrow(/2 uncommitted files\. Stash or commit them, then switch to develop/);
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    // One file reads in the singular.
    git(project, 'checkout', '-q', '--', 'a.txt');
    await expect(service.switchLocal(project, { branch: 'develop' })).rejects.toThrow(/1 uncommitted file\. Stash or commit it/);
  });

  it('refuses a branch a worktree holds, naming the folder', async () => {
    const held = await worktreeThread('22222222-aaaa', {}, 'Holder');
    await expect(service.switchLocal(project, { branch: 'pi-kit/holder' })).rejects.toThrow(new RegExp(`pi-kit/holder is checked out in the worktree at ${held.worktreePath}`));
  });

  it('refuses a branch that does not exist, a bad name, and a project that turned switching off', async () => {
    await expect(service.switchLocal(project, { branch: 'nope' })).rejects.toThrow(/no branch nope/);
    await expect(service.switchLocal(project, { branch: 'bad..name', create: true })).rejects.toThrow(/not a branch name/);
    meta.setWorktreeSettings(project, { allowSwitch: false });
    git(project, 'branch', 'develop');
    await expect(service.switchLocal(project, { branch: 'develop' })).rejects.toThrow(/turned off for this project/);
    // Staying where it is needs no permission.
    expect(await service.switchLocal(project, { branch: 'main' })).toBe('main');
  });

  it('makes a new branch from the checked-out one, and not over an existing name', async () => {
    write(project, 'later.txt', 'l\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'later');
    const tip = git(project, 'rev-parse', 'HEAD').trim();
    expect(await service.switchLocal(project, { branch: 'feature/x', create: true })).toBe('feature/x');
    expect(git(project, 'rev-parse', 'HEAD').trim()).toBe(tip);
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x');
    await expect(service.switchLocal(project, { branch: 'main', create: true })).rejects.toThrow(/exists already/);
  });

  it('takes the uncommitted changes along to a new branch (switching to another branch is what needs them out of the way)', async () => {
    write(project, 'a.txt', 'one\nwip\n');
    write(project, 'untracked.txt', 'u\n');
    expect(await service.switchLocal(project, { branch: 'feature/with-changes', create: true })).toBe('feature/with-changes');
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('one\nwip\n');
    expect(existsSync(join(project, 'untracked.txt'))).toBe(true);
  });

  it('types a Local thread\'s setup script into the folder\'s own terminal, and nothing for none', () => {
    meta.setWorktreeSettings(project, { scripts: [{ id: 'node', name: 'Node', command: 'npm ci', copy: ['.env.local'] }] });
    service.runLocalSetup(project, null);
    service.runLocalSetup(project, undefined);
    expect(terminals.write).not.toHaveBeenCalled();
    service.runLocalSetup(project, 'node');
    expect(terminals.start).toHaveBeenCalledWith(project, expect.any(Number), expect.any(Number));
    expect(terminals.write).toHaveBeenCalledWith(project, 'npm ci\r');
    expect(() => service.runLocalSetup(project, 'gone')).toThrow(/no setup script/);
  });

  it('refuses while a merge waits in the folder', async () => {
    git(project, 'branch', 'develop');
    write(project, 'a.txt', 'x\n');
    git(project, 'commit', '-q', '-am', 'main side');
    git(project, 'checkout', '-q', 'develop');
    write(project, 'a.txt', 'y\n');
    git(project, 'commit', '-q', '-am', 'develop side');
    try {
      git(project, 'merge', 'main');
    } catch {
      // the conflict is what this test needs
    }
    await expect(service.switchLocal(project, { branch: 'main' })).rejects.toThrow(/merge or rebase is waiting/);
  });
});

describe('a new worktree from the Where row', () => {
  it('is named <prefix><name> from the first message, and the project prefix applies', async () => {
    const plain = await service.create(project, { threadId: 'aaaaaaaa-1', request: { name: 'Fix the cramped row' } });
    expect(plain.branch).toBe('pi-kit/fix-the-cramped-row');
    expect(plain.path).toBe(join(base, 'worktrees', 'proj', 'fix-the-cramped-row'));
    meta.setWorktreeSettings(project, { branchPrefix: 'wolf/' });
    const prefixed = await service.create(project, { threadId: 'aaaaaaaa-2', request: { name: 'Fix the cramped row' } });
    expect(prefixed.branch).toBe('wolf/fix-the-cramped-row-2');
    expect(prefixed.path).toBe(join(base, 'worktrees', 'proj', 'fix-the-cramped-row-2'));
  });

  it('can be detached: no branch, the base commit checked out, still merging back into the base', async () => {
    const facts = await service.create(project, { threadId: 'bbbbbbbb-1', request: { branch: null, name: 'Try an idea' } });
    expect(facts.branch).toBeNull();
    expect(facts.base).toBe('main');
    expect(git(facts.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD');
    expect(git(facts.path, 'rev-parse', 'HEAD').trim()).toBe(git(project, 'rev-parse', 'HEAD').trim());
    expect(git(project, 'branch', '--list').trim()).toBe('* main');
  });

  it('is detached when the project says branches are detached and the request says nothing', async () => {
    meta.setWorktreeSettings(project, { branchMode: 'detached' });
    expect((await service.create(project, { threadId: 'bbbbbbbb-2', request: {} })).branch).toBeNull();
    expect((await service.create(project, { threadId: 'bbbbbbbb-3', request: { branch: 'typed/one' } })).branch).toBe('typed/one');
  });

  it('uses a typed branch exactly, and refuses one that exists or is not a name', async () => {
    const facts = await service.create(project, { threadId: 'cccccccc-1', request: { branch: 'feature/Map Rows'.replace(' ', '-') } });
    expect(facts.branch).toBe('feature/Map-Rows');
    expect(facts.path.endsWith('feature-map-rows')).toBe(true);
    await expect(service.create(project, { threadId: 'cccccccc-2', request: { branch: 'main' } })).rejects.toThrow(/exists already/);
    await expect(service.create(project, { threadId: 'cccccccc-3', request: { branch: 'a..b' } })).rejects.toThrow(/not a branch name/);
  });

  it('carries the folder\'s uncommitted changes, tracked, staged and untracked, and leaves the folder as it was', async () => {
    write(project, 'a.txt', 'one\ntwo\n');
    write(project, 'staged.txt', 's\n');
    git(project, 'add', 'staged.txt');
    write(project, 'dir/untracked.txt', 'u\n');
    writeFileSync(join(project, '.gitignore'), 'ignored.log\n');
    write(project, 'ignored.log', 'noise\n');
    const before = git(project, 'status', '--porcelain=v1', '--untracked-files=all');
    const facts = await service.create(project, { threadId: 'dddddddd-1', request: { carryChanges: true } });
    expect(readFileSync(join(facts.path, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(join(facts.path, 'staged.txt'), 'utf8')).toBe('s\n');
    expect(readFileSync(join(facts.path, 'dir', 'untracked.txt'), 'utf8')).toBe('u\n');
    expect(existsSync(join(facts.path, 'ignored.log'))).toBe(false);
    // In the worktree they are uncommitted changes, not a commit.
    expect(git(facts.path, 'rev-parse', 'HEAD').trim()).toBe(git(project, 'rev-parse', 'HEAD').trim());
    expect(git(facts.path, 'status', '--porcelain=v1').trim().split('\n')).toHaveLength(4);
    // The folder's status, index and files are exactly what they were.
    expect(git(project, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(before);
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  it('carries binary files, and nothing when there are no changes', async () => {
    writeFileSync(join(project, 'blob.bin'), Buffer.from([0, 1, 2, 255, 0, 7]));
    const facts = await service.create(project, { threadId: 'eeeeeeee-1', request: { carryChanges: true } });
    expect([...readFileSync(join(facts.path, 'blob.bin'))]).toEqual([0, 1, 2, 255, 0, 7]);
    rmSync(join(project, 'blob.bin'));
    const clean = await service.create(project, { threadId: 'eeeeeeee-2', request: { carryChanges: true } });
    expect(git(clean.path, 'status', '--porcelain=v1').trim()).toBe('');
  });

  it('follows the project\'s carry rule: always carries, never does not', async () => {
    write(project, 'a.txt', 'changed\n');
    meta.setWorktreeSettings(project, { carry: 'always' });
    const always = await service.create(project, { threadId: 'ffffffff-1', request: {} });
    expect(readFileSync(join(always.path, 'a.txt'), 'utf8')).toBe('changed\n');
    meta.setWorktreeSettings(project, { carry: 'never' });
    const never = await service.create(project, { threadId: 'ffffffff-2', request: { carryChanges: true } });
    expect(readFileSync(join(never.path, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('removes the worktree again when the changes do not apply on the chosen base', async () => {
    git(project, 'branch', 'old');
    git(project, 'checkout', '-q', 'old');
    write(project, 'a.txt', 'other\n');
    git(project, 'commit', '-q', '-am', 'old moves');
    git(project, 'checkout', '-q', 'main');
    write(project, 'a.txt', 'one\nnew line\n');
    git(project, 'commit', '-q', '-am', 'main moves');
    write(project, 'a.txt', 'one\nnew line\nuncommitted\n');
    await expect(service.create(project, { threadId: 'abababab-1', request: { base: 'old', carryChanges: true } })).rejects.toThrow(/do not apply on old/);
    expect(git(project, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(git(project, 'branch', '--list', 'pi-kit/*').trim()).toBe('');
  });

  it('cuts from origin/<branch> after a fetch, and merges back into the local branch of that name', async () => {
    const remote = join(base, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    git(project, 'remote', 'add', 'origin', remote);
    git(project, 'push', '-q', 'origin', 'main');
    // Somebody else pushes a commit; the folder has not fetched it yet.
    const other = join(base, 'other');
    execFileSync('git', ['clone', '-q', remote, other]);
    write(other, 'remote.txt', 'r\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'remote commit');
    git(other, 'push', '-q', 'origin', 'main');
    const facts = await service.create(project, { threadId: '12121212-1', request: { base: 'origin/main' } });
    expect(facts.base).toBe('main');
    expect(readFileSync(join(facts.path, 'remote.txt'), 'utf8')).toBe('r\n');
    expect((await service.projectGit(project)).remoteBranches).toContain('origin/main');
  });

  it('copies a script\'s files and types its command; the first script is the default, null is none, a bad id is refused', async () => {
    write(project, '.env.local', 'SECRET=1\n');
    meta.setWorktreeSettings(project, {
      scripts: [
        { id: 'node', name: 'Node', command: 'npm ci', copy: ['.env.local'] },
        { id: 'docs', name: 'Docs', command: 'make docs' },
      ],
    });
    const first = await service.create(project, { threadId: '34343434-1', request: {} });
    expect(readFileSync(join(first.path, '.env.local'), 'utf8')).toBe('SECRET=1\n');
    expect(terminals.write).toHaveBeenLastCalledWith(first.path, 'npm ci\r');
    const docs = await service.create(project, { threadId: '34343434-2', request: { setup: 'docs' } });
    expect(terminals.write).toHaveBeenLastCalledWith(docs.path, 'make docs\r');
    expect(existsSync(join(docs.path, '.env.local'))).toBe(false);
    terminals.write.mockClear();
    await service.create(project, { threadId: '34343434-3', request: { setup: null } });
    expect(terminals.write).not.toHaveBeenCalled();
    await expect(service.create(project, { threadId: '34343434-4', request: { setup: 'gone' } })).rejects.toThrow(/no setup script/);
  });

  it('suggests the script of the lockfile when nothing is configured, and the single setup command wins', () => {
    writeFileSync(join(project, 'pnpm-lock.yaml'), '');
    expect(service.settingsOf(project).setupScripts).toEqual([{ id: 'pnpm', name: 'pnpm', command: 'pnpm install --frozen-lockfile' }]);
    expect(service.settingsOf(project).setup).toBeNull();
    meta.setWorktreeSettings(project, { setup: 'make setup' });
    expect(service.settingsOf(project)).toMatchObject({ setup: 'make setup', setupScripts: [{ id: 'setup', name: 'Setup', command: 'make setup' }] });
    // Blank removes it, and "none" stays none: the lockfile is not suggested again.
    meta.setWorktreeSettings(project, { setup: '' });
    expect(service.settingsOf(project)).toMatchObject({ setup: null, setupScripts: [] });
  });

  it('says the script is only suggested until a list is saved', () => {
    writeFileSync(join(project, 'pnpm-lock.yaml'), '');
    expect(service.settingsOf(project).setupSuggested).toBe(true);
    meta.setWorktreeSettings(project, { scripts: [{ id: 'pnpm', name: 'pnpm', command: 'pnpm install --frozen-lockfile' }] });
    expect(service.settingsOf(project).setupSuggested).toBeUndefined();
    meta.setWorktreeSettings(project, { scripts: [] });
    expect(service.settingsOf(project)).toMatchObject({ setupScripts: [] });
    expect(service.settingsOf(project).setupSuggested).toBeUndefined();
  });

  it('uses the defaults for every project where a project has no folder or start of its own, and a project overrides them', async () => {
    expect(service.defaults()).toEqual({ root: null, defaultRoot: join(base, 'worktrees'), start: 'local' });
    expect(service.patchDefaults({ root: join(base, 'all-worktrees'), start: 'worktree' })).toMatchObject({ root: join(base, 'all-worktrees'), start: 'worktree' });
    expect(service.settingsOf(project)).toMatchObject({ start: 'worktree', root: null, defaultRoot: join(base, 'all-worktrees') });
    const facts = await service.create(project, { threadId: 'dd-1', request: {} });
    expect(facts.path.startsWith(join(base, 'all-worktrees'))).toBe(true);
    meta.setWorktreeSettings(project, { start: 'ask', root: join(base, 'mine') });
    expect(service.settingsOf(project)).toMatchObject({ start: 'ask', root: join(base, 'mine') });
    // blank puts the default back; a patch of one field leaves the other
    expect(service.patchDefaults({ root: '  ' })).toMatchObject({ root: null, start: 'worktree' });
  });

  it('has the defaults until a project says otherwise', () => {
    expect(service.settingsOf(project)).toMatchObject({ start: 'local', allowBranchSwitch: true, carryChanges: 'ask', branchMode: 'named', branchPrefix: 'pi-kit/', removeFolder: 'ask' });
    meta.setWorktreeSettings(project, { start: 'worktree', carry: 'never', branchPrefix: 'feat/', remove: 'after-7-days', branchMode: 'detached', allowSwitch: false });
    expect(service.settingsOf(project)).toMatchObject({ start: 'worktree', allowBranchSwitch: false, carryChanges: 'never', branchMode: 'detached', branchPrefix: 'feat/', removeFolder: 'after-7-days' });
  });
});

describe('hand off to local', () => {
  it('moves the branch and the uncommitted changes into the folder and removes the worktree', async () => {
    const row = await worktreeThread('56565656-1', { name: 'Hand me off' }, 'Hand me off');
    const path = row.worktreePath as string;
    write(path, 'committed.txt', 'c\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'in the worktree');
    write(path, 'a.txt', 'one\nedited\n');
    write(path, 'fresh.txt', 'f\n');
    const result = await service.handoff(row, { to: 'local', remove: true });
    expect(result).toMatchObject({ to: 'local', path: project, branch: 'pi-kit/hand-me-off', moved: 2, removed: true });
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('pi-kit/hand-me-off');
    expect(readFileSync(join(project, 'committed.txt'), 'utf8')).toBe('c\n');
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('one\nedited\n');
    expect(readFileSync(join(project, 'fresh.txt'), 'utf8')).toBe('f\n');
    // Uncommitted in the folder, as they were in the worktree.
    expect(git(project, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean).sort()).toEqual([' M a.txt', '?? fresh.txt']);
    expect(existsSync(path)).toBe(false);
    expect(terminals.kill).toHaveBeenCalledWith(path);
    expect(sessions.dispose).toHaveBeenCalledWith(row.id);
    const after = threads.get(row.id) as ThreadRow;
    expect(after).toMatchObject({ worktreePath: null, branch: null, baseBranch: null, cwd: project });
  });

  it('keeps the worktree folder when it is not asked to remove it, detached from the branch the folder took', async () => {
    const row = await worktreeThread('56565656-2', {}, 'Keep folder');
    const path = row.worktreePath as string;
    write(path, 'a.txt', 'edited\n');
    const result = await service.handoff(row, { to: 'local' });
    expect(result.removed).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('pi-kit/keep-folder');
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD');
  });

  it('follows the project\'s rule: now removes without being asked', async () => {
    meta.setWorktreeSettings(project, { remove: 'now' });
    const row = await worktreeThread('56565656-3', {}, 'Rule now');
    expect((await service.handoff(row, { to: 'local' })).removed).toBe(true);
  });

  it('hands a detached worktree to a folder that stays on its branch when the commit is the same', async () => {
    const row = await worktreeThread('78787878-1', { branch: null, name: 'Detached' }, 'Detached');
    const path = row.worktreePath as string;
    write(path, 'idea.txt', 'i\n');
    const result = await service.handoff(row, { to: 'local', remove: true });
    expect(result).toMatchObject({ branch: null, moved: 1, removed: true });
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(readFileSync(join(project, 'idea.txt'), 'utf8')).toBe('i\n');
  });

  it('refuses a folder with uncommitted files, with the sentence that says what to do, and changes nothing', async () => {
    const row = await worktreeThread('90909090-1', {}, 'Blocked');
    write(row.worktreePath as string, 'a.txt', 'worktree edit\n');
    write(project, 'b.txt', 'folder edit\n');
    write(project, 'extra.txt', 'x\n');
    await expect(service.handoff(row, { to: 'local', remove: true })).rejects.toThrow(/The folder has 2 uncommitted files\. Commit or stash them, then hand off\./);
    expect(existsSync(row.worktreePath as string)).toBe(true);
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(readFileSync(join(row.worktreePath as string, 'a.txt'), 'utf8')).toBe('worktree edit\n');
    expect((threads.get(row.id) as ThreadRow).worktreePath).toBe(row.worktreePath);
  });

  it('refuses while a run holds the thread, a merge waits in the worktree, or the thread has no worktree', async () => {
    const row = await worktreeThread('90909090-2', {}, 'Busy');
    sessions.has = () => true;
    sessions.isStreaming = () => true;
    await expect(service.handoff(row, { to: 'local' })).rejects.toThrow(/Stop the run/);
    sessions.has = () => false;
    await expect(service.handoff(localThread('90909090-3'), { to: 'local' })).rejects.toThrow(/already/);
  });

  it('puts everything back when the changes cannot be applied in the folder', async () => {
    const row = await worktreeThread('90909090-4', {}, 'Rollback');
    const path = row.worktreePath as string;
    write(path, 'new.txt', 'from the worktree\n');
    const apply = vi.spyOn(wtGit, 'applyPatch').mockRejectedValueOnce(new Error('patch does not apply'));
    await expect(service.handoff(row, { to: 'local', remove: true })).rejects.toThrow(/could not move the worktree's work into the folder: patch does not apply/);
    apply.mockRestore();
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('pi-kit/rollback');
    expect(readFileSync(join(path, 'new.txt'), 'utf8')).toBe('from the worktree\n');
    expect((threads.get(row.id) as ThreadRow).worktreePath).toBe(path);
  });

  it('sweeps a folder that was left for a week once it is due, and only when it is clean', async () => {
    meta.setWorktreeSettings(project, { remove: 'after-7-days' });
    const row = await worktreeThread('a1a1a1a1-1', {}, 'Later');
    const path = row.worktreePath as string;
    await service.handoff(row, { to: 'local' });
    expect(existsSync(path)).toBe(true);
    expect(await service.sweep(Date.now() + 6 * 86_400_000)).toEqual([]);
    write(path, 'dirty.txt', 'd\n');
    expect(await service.sweep(Date.now() + 8 * 86_400_000)).toEqual([]);
    expect(existsSync(path)).toBe(true);
    rmSync(join(path, 'dirty.txt'));
    expect(await service.sweep(Date.now() + 10 * 86_400_000)).toEqual([path]);
    expect(existsSync(path)).toBe(false);
  });
});

describe('move into a worktree', () => {
  it('makes a worktree from the folder\'s branch and moves the uncommitted changes out of the folder, keeping a copy in the stash', async () => {
    git(project, 'checkout', '-q', '-b', 'develop');
    const row = localThread('b2b2b2b2-1', 'Move me');
    write(project, 'a.txt', 'one\nwip\n');
    write(project, 'wip.txt', 'w\n');
    const result = await service.handoff(row, { to: 'worktree' });
    expect(result).toMatchObject({ to: 'worktree', branch: 'pi-kit/move-me', moved: 2, removed: false });
    const after = threads.get(row.id) as ThreadRow;
    expect(after).toMatchObject({ worktreePath: result.path, branch: 'pi-kit/move-me', baseBranch: 'develop', cwd: project });
    expect(readFileSync(join(result.path, 'a.txt'), 'utf8')).toBe('one\nwip\n');
    expect(readFileSync(join(result.path, 'wip.txt'), 'utf8')).toBe('w\n');
    expect(git(project, 'status', '--porcelain=v1', '--untracked-files=all').trim()).toBe('');
    expect(git(project, 'stash', 'list')).toContain('pi-kit: moved to pi-kit/move-me');
    expect(sessions.dispose).toHaveBeenCalledWith(row.id);
  });

  it('can leave the changes where they are, and can make the worktree detached', async () => {
    const row = localThread('b2b2b2b2-2', 'Stay put');
    write(project, 'a.txt', 'wip\n');
    const result = await service.handoff(row, { to: 'worktree', carryChanges: false, branch: null });
    expect(result).toMatchObject({ branch: null, moved: 0 });
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('wip\n');
    expect(readFileSync(join(result.path, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('refuses a thread that is in a worktree already', async () => {
    const row = await worktreeThread('b2b2b2b2-3', {}, 'Already');
    await expect(service.handoff(row, { to: 'worktree' })).rejects.toThrow(/already/);
  });

  it('round trips: out to a worktree and back, the changes where they started', async () => {
    const row = localThread('b2b2b2b2-4', 'Round trip');
    write(project, 'a.txt', 'one\nwip\n');
    await service.handoff(row, { to: 'worktree' });
    const inTree = threads.get(row.id) as ThreadRow;
    const back = await service.handoff(inTree, { to: 'local', remove: true });
    expect(back.moved).toBe(1);
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('one\nwip\n');
    expect(git(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('pi-kit/round-trip');
  });
});

describe('a branch for a detached worktree', () => {
  it('gives it the name and records it; refuses a worktree that has one, a taken name and a bad one', async () => {
    const row = await worktreeThread('c3c3c3c3-1', { branch: null, name: 'Detached' }, 'Detached');
    await expect(service.createBranch(row, 'a..b')).rejects.toThrow(/not a branch name/);
    await expect(service.createBranch(row, 'main')).rejects.toThrow(/exists already/);
    expect(await service.createBranch(row, 'pi-kit/now-named')).toEqual({ branch: 'pi-kit/now-named' });
    expect(git(row.worktreePath as string, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('pi-kit/now-named');
    const after = threads.get(row.id) as ThreadRow;
    expect(after.branch).toBe('pi-kit/now-named');
    expect(service.describe(after)).toMatchObject({ branch: 'pi-kit/now-named' });
    await expect(service.createBranch(after, 'other')).rejects.toThrow(/has a branch already/);
  });

  it('describes a detached worktree without a branch', async () => {
    const row = await worktreeThread('c3c3c3c3-2', { branch: null }, 'Loose');
    expect(service.describe(row)).toEqual({ path: row.worktreePath, branch: null, base: 'main', exists: true, detached: true });
  });
});

describe('merge back from a detached worktree', () => {
  it('merges its HEAD into the base, and refuses a pull request', async () => {
    const row = await worktreeThread('d4d4d4d4-1', { branch: null, name: 'Loose idea' }, 'Loose idea');
    const path = row.worktreePath as string;
    write(path, 'idea.txt', 'i\n');
    await expect(service.merge(row, { mode: 'pr', remove: false })).rejects.toThrow(/needs a branch/);
    const result = await service.merge(row, { mode: 'merge', message: 'Add the idea', remove: true });
    expect(result).toMatchObject({ status: 'merged', removed: true });
    expect(git(project, 'log', '-1', '--format=%s').trim()).toMatch(/^Merge [0-9a-f]{7,} into main/);
    expect(readFileSync(join(project, 'idea.txt'), 'utf8')).toBe('i\n');
    expect(existsSync(path)).toBe(false);
  });
});
