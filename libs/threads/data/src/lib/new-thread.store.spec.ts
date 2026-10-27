import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideMockApi, threadsPlace, workspacesGit } from '@pi-kit/api';
import type { ProjectGit, ThreadSummary, Workspace, WorktreeSettings } from '@pi-kit/protocol';
import { thread as fakeThread } from '@pi-kit/testing';
import { NewThreadStore, isNewThread } from './new-thread.store';

import { ThreadsStore } from './threads.store';

const git = (over: Partial<ProjectGit> = {}): ProjectGit => ({
  git: true,
  branch: 'main',
  head: null,
  dirty: 0,
  branches: [
    { name: 'main', current: true, heldBy: null },
    { name: 'develop', current: false, heldBy: null },
  ],
  remoteBranches: ['origin/main'],
  hasRemote: true,
  ...over,
});

const settings = (over: Partial<WorktreeSettings> = {}): WorktreeSettings => ({
  root: null,
  base: null,
  setup: null,
  defaultRoot: '/w',
  git: true,
  start: 'local',
  allowBranchSwitch: true,
  carryChanges: 'ask',
  branchMode: 'named',
  branchPrefix: 'pi-kit/',
  removeFolder: 'ask',
  setupScripts: [
    { id: 'node', name: 'Node', command: 'npm ci' },
    { id: 'docs', name: 'Docs', command: 'make docs' },
  ],
  ...over,
});

const fresh = (over: Partial<ThreadSummary> = {}): ThreadSummary =>
  fakeThread('n1', { cwd: '/p', messageCount: 0, origin: 'app', ...over });

describe('isNewThread', () => {
  it('is a thread the app made that has no message and is not in a worktree', () => {
    expect(isNewThread(fresh())).toBe(true);
    expect(isNewThread(fresh({ messageCount: 2 }))).toBe(false);
    expect(isNewThread(fresh({ origin: 'cli' }))).toBe(false);
    expect(isNewThread(fresh({ worktree: { path: '/wt', branch: 'b', base: 'main', exists: true } }))).toBe(false);
    expect(isNewThread(fresh({ worktree: { path: '/wt', branch: 'b', base: 'main', exists: false } }))).toBe(true);
    expect(isNewThread(undefined)).toBe(false);
  });
});

describe('NewThreadStore', () => {
  let selected: ReturnType<typeof signal<ThreadSummary | undefined>>;
  let workspaces: ReturnType<typeof signal<Workspace[]>>;
  const api = {
    projectGit: vi.fn(async () => git()),
    place: vi.fn(async () => undefined),
  };
  const threads = {
    selected: () => selected(),
    threads: () => (selected() ? [selected() as ThreadSummary] : []),
    workspaces: () => workspaces(),
    refresh: vi.fn(async () => undefined),
    setWorktreeSettings: vi.fn(async () => undefined),
  };

  const workspace = (worktree: WorktreeSettings): Workspace => ({
    cwd: '/p',
    name: 'p',
    lastOpenedAt: 1,
    threadCount: 0,
    collapsed: false,
    hidden: false,
    attendant: true,
    agents: false,
    branch: 'main',
    worktree,
  });

  beforeEach(() => {
    selected = signal<ThreadSummary | undefined>(fresh());
    workspaces = signal<Workspace[]>([workspace(settings())]);
    for (const fn of [...Object.values(api), threads.refresh, threads.setWorktreeSettings]) fn.mockClear();
    api.projectGit.mockResolvedValue(git());
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        ...provideMockApi([
          [workspacesGit, api.projectGit, (o) => [o.path?.['id']]],
          [threadsPlace, api.place, (o) => [o.path?.['id'], o.body]],
        ]),
      ],
    });
  });

  const make = () => TestBed.inject(NewThreadStore);

  it("starts the plan of a new thread from the project's defaults, after reading its folder", async () => {
    workspaces.set([workspace(settings({ start: 'worktree', branchMode: 'detached' }))]);
    const store = make();
    await store.ensure(fresh());
    expect(api.projectGit).toHaveBeenCalledWith('/p');
    expect(store.plan()).toMatchObject({ mode: 'worktree', naming: 'detached', remember: false });
    expect(store.projectGit()?.branch).toBe('main');
    expect(store.workspace()?.name).toBe('p');
  });

  it('has no plan for a thread that has begun', async () => {
    const store = make();
    await store.ensure(fresh());
    selected.set(fresh({ messageCount: 1 }));
    expect(store.thread()).toBeUndefined();
    expect(store.plan()).toBeUndefined();
  });

  it("the chevron menu's choice shows in the row: Worktree on a repository, never on a folder that is not one", async () => {
    const store = make();
    await store.preset(fresh(), 'worktree');
    expect(store.plan()?.mode).toBe('worktree');
    store.forget('n1');
    api.projectGit.mockResolvedValue(git({ git: false, branches: [], branch: null }));
    await store.preset(fresh(), 'worktree');
    expect(store.plan()?.mode).toBe('local');
  });

  it('a second look at the page keeps what was chosen', async () => {
    const store = make();
    await store.ensure(fresh());
    store.setMode('n1', 'worktree');
    store.patch('n1', { naming: 'typed', typed: 'feature/x' });
    await store.ensure(fresh());
    expect(store.plan()).toMatchObject({ mode: 'worktree', naming: 'typed', typed: 'feature/x' });
  });

  it('applies nothing for Local on the branch that is checked out: no request, the plan is gone', async () => {
    const store = make();
    await store.ensure(fresh());
    await store.apply('n1', 'hello');
    expect(api.place).not.toHaveBeenCalled();
    expect(store.plan()).toBeUndefined();
    expect(threads.refresh).toHaveBeenCalled();
  });

  it('places the thread on another branch with one request', async () => {
    const store = make();
    await store.ensure(fresh());
    store.pickLocalBranch('n1', 'develop');
    await store.apply('n1', 'hello');
    expect(api.place).toHaveBeenCalledWith('n1', { local: { branch: 'develop' } });
  });

  it('places the thread in a worktree named from the message, with the base, carried changes and script the row shows', async () => {
    api.projectGit.mockResolvedValue(git({ dirty: 2 }));
    const store = make();
    await store.ensure(fresh(), 'worktree');
    store.patch('n1', { from: 'origin/main', carry: true, setup: 'docs' });
    await store.apply('n1', 'Fix the cramped row');
    expect(api.place).toHaveBeenCalledWith('n1', {
      worktree: { base: 'origin/main', carryChanges: true, setup: 'docs', name: 'Fix the cramped row' },
    });
  });

  it('keeps the plan and says why when the backend refuses', async () => {
    api.place.mockRejectedValueOnce(
      new Error('The folder has 2 uncommitted files. Stash or commit them, then switch to develop.'),
    );
    const store = make();
    await store.ensure(fresh());
    store.pickLocalBranch('n1', 'develop');
    await expect(store.apply('n1', 'x')).rejects.toThrow(/2 uncommitted files/);
    expect(store.plan()).toMatchObject({ localBranch: 'develop' });
    expect(store.error()).toMatch(/2 uncommitted files/);
    expect(store.applying()).toBe(false);
  });

  it('will not send while the project asks and nothing was chosen, or a typed name is empty', async () => {
    workspaces.set([workspace(settings({ start: 'ask' }))]);
    const store = make();
    await store.ensure(fresh());
    await expect(store.apply('n1', 'x')).rejects.toThrow(/Choose where/);
    store.setMode('n1', 'worktree');
    store.patch('n1', { naming: 'typed', typed: '  ' });
    await expect(store.apply('n1', 'x')).rejects.toThrow(/Type a branch name/);
    expect(api.place).not.toHaveBeenCalled();
  });

  describe('Remember', () => {
    it("keeps Worktree, detached, always-carry, the base and the chosen script as the project's defaults", async () => {
      api.projectGit.mockResolvedValue(git({ dirty: 1 }));
      const store = make();
      await store.ensure(fresh(), 'worktree');
      store.patch('n1', { remember: true, naming: 'detached', carry: true, from: 'develop', setup: 'docs' });
      await store.apply('n1', 'go');
      expect(threads.setWorktreeSettings).toHaveBeenCalledWith('/p', {
        start: 'worktree',
        branchMode: 'detached',
        carryChanges: 'always',
        base: 'develop',
        setupScripts: [
          { id: 'docs', name: 'Docs', command: 'make docs' },
          { id: 'node', name: 'Node', command: 'npm ci' },
        ],
      });
    });

    it('keeps Local, and leaves the rest alone', async () => {
      const store = make();
      await store.ensure(fresh());
      store.patch('n1', { remember: true, localBranch: 'develop' });
      await store.apply('n1', 'go');
      expect(threads.setWorktreeSettings).toHaveBeenCalledWith('/p', { start: 'local' });
    });

    it('does not turn an unchecked "carry" into a rule, and takes "always" back to ask when it was unchecked', async () => {
      api.projectGit.mockResolvedValue(git({ dirty: 3 }));
      const store = make();
      await store.ensure(fresh(), 'worktree');
      store.patch('n1', { remember: true, carry: false });
      await store.apply('n1', 'go');
      expect(threads.setWorktreeSettings).toHaveBeenLastCalledWith('/p', { start: 'worktree', branchMode: 'named' });
      workspaces.set([workspace(settings({ carryChanges: 'always' }))]);
      store.forget('n1');
      await store.ensure(fresh(), 'worktree');
      store.patch('n1', { remember: true, carry: false });
      await store.apply('n1', 'go');
      expect(threads.setWorktreeSettings).toHaveBeenLastCalledWith('/p', {
        start: 'worktree',
        branchMode: 'named',
        carryChanges: 'ask',
      });
    });
  });
});
