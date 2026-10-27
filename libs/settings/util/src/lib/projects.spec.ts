import { english } from '@pi-kit/i18n/testing';
import type {
  ProjectGit,
  SetupScript,
  ThreadSummary,
  TrustState,
  Workspace,
  WorktreeSettings,
  WorktreeStatus,
} from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import {
  aheadText,
  baseOptions,
  dirtyPatch,
  draftOf,
  draftProblem,
  dropBefore,
  neighbour,
  newDraft,
  openWorktreeRows,
  parseCopy,
  projectCountText,
  projectRows,
  resourceSummary,
  scriptId,
  tildePath,
  trustChip,
  withDefault,
  withScript,
  withoutScript,
  worktreeCounts,
  worktreeState,
} from './projects';

const settings = (over: Partial<WorktreeSettings> = {}): WorktreeSettings => ({
  root: null,
  base: null,
  setup: null,
  defaultRoot: '/home/me/.pi-kit/worktrees',
  git: true,
  start: 'local',
  allowBranchSwitch: true,
  carryChanges: 'ask',
  branchMode: 'named',
  branchPrefix: 'pi-kit/',
  removeFolder: 'ask',
  setupScripts: [],
  ...over,
});

const workspace = (over: Partial<Workspace> & { cwd: string }): Workspace => ({
  name: over.cwd.split('/').pop() ?? over.cwd,
  lastOpenedAt: 0,
  threadCount: 0,
  collapsed: false,
  hidden: false,
  attendant: true,
  agents: false,
  branch: 'main',
  worktree: settings(),
  ...over,
});

const trust = (over: Partial<TrustState> = {}): TrustState => ({
  cwd: '/p',
  hasResources: true,
  status: 'trusted',
  source: 'saved',
  resources: [{ kind: 'skill', path: '.pi/skills/a/SKILL.md' }],
  ...over,
});

const thread = (over: Partial<ThreadSummary> & { id: string }): ThreadSummary =>
  ({
    cwd: '/home/me/pi-kit',
    title: null,
    preview: null,
    pinned: false,
    archived: false,
    state: { activity: 'idle', outcome: null },
    ...over,
  }) as ThreadSummary;

describe('the trust chip', () => {
  it('says trusted, not trusted, waiting, or nothing to trust, and nothing while the state is unknown', () => {
    expect(trustChip(english, trust())).toEqual({ text: 'trusted', tone: 'ok' });
    expect(trustChip(english, trust({ status: 'untrusted' }))).toEqual({ text: 'not trusted', tone: 'err' });
    expect(trustChip(english, trust({ status: 'ask' }))).toEqual({ text: 'waiting', tone: 'warn' });
    expect(trustChip(english, trust({ hasResources: false, status: 'ask', resources: [] }))).toEqual({
      text: 'nothing to trust',
      tone: 'off',
    });
    expect(trustChip(english, undefined)).toBeUndefined();
  });

  it('counts what a folder would load, an MCP file by its servers', () => {
    expect(
      resourceSummary(english, {
        resources: [
          { kind: 'skill', path: 'a' },
          { kind: 'skill', path: 'b' },
          { kind: 'extension', path: 'c' },
          { kind: 'mcp', path: '.pi/mcp.json', servers: 1 },
        ],
      }),
    ).toBe('2 skills, 1 extension, 1 MCP server');
    expect(resourceSummary(english, { resources: [{ kind: 'mcp', path: '.pi/mcp.json', servers: 3 }] })).toBe(
      '3 MCP servers',
    );
  });
});

describe('the rows of the list', () => {
  const projects = [
    workspace({
      cwd: '/home/me/pi-kit',
      threadCount: 31,
      worktree: settings({ start: 'worktree', setupScripts: [{ id: 'node', name: 'Node', command: 'npm ci' }] }),
    }),
    workspace({
      cwd: '/home/me/form-api-spec',
      threadCount: 1,
      branch: 'master',
      hidden: true,
      worktree: settings({ start: 'ask' }),
    }),
    workspace({ cwd: '/home/me/notes', threadCount: 3, branch: null, worktree: settings({ git: false }) }),
  ];
  const folders = {
    '/home/me/pi-kit': trust(),
    '/home/me/form-api-spec': trust({
      status: 'ask',
      resources: [
        { kind: 'skill', path: 'a' },
        { kind: 'skill', path: 'b' },
      ],
    }),
    '/home/me/notes': trust({ hasResources: false, resources: [] }),
  };
  const rows = projectRows(
    english,
    projects,
    folders,
    worktreeCounts([
      thread({ id: 'a', cwd: '/home/me/pi-kit', worktree: { path: '/w/a', branch: 'x', base: 'main', exists: true } }),
      thread({ id: 'b', cwd: '/home/me/pi-kit', worktree: { path: '/w/b', branch: 'y', base: 'main', exists: true } }),
      thread({ id: 'c', cwd: '/home/me/pi-kit', worktree: { path: '/w/c', branch: 'z', base: 'main', exists: false } }),
    ]),
  );

  it('keep the order of the sidebar and tell each project apart: chips, path, counts, where a thread starts, the setup script', () => {
    expect(rows.map((r) => r.name)).toEqual(['pi-kit', 'form-api-spec', 'notes']);
    expect(rows[0]).toMatchObject({
      trust: { text: 'trusted' },
      branch: 'main',
      git: true,
      hidden: false,
      path: '~/pi-kit',
    });
    expect(rows[0]?.facts).toEqual(['31 threads', '2 worktrees', 'starts in a worktree', 'setup Node']);
    expect(rows[1]?.facts).toEqual([
      '1 thread',
      'no worktrees',
      'asks where to start',
      '2 project resources not loaded',
    ]);
    expect(rows[1]).toMatchObject({ hidden: true, trust: { text: 'waiting' } });
  });

  it('show a folder that is not a repository by its threads alone', () => {
    expect(rows[2]).toMatchObject({ git: false, branch: null, trust: { text: 'nothing to trust' } });
    expect(rows[2]?.facts).toEqual(['3 threads']);
  });

  it('count the projects for the nav', () => {
    expect(projectCountText(projects)).toBe('3');
    expect(projectCountText([])).toBeUndefined();
  });

  it('write the home folder as a tilde', () => {
    expect(tildePath('/Users/me/Development/pi-kit')).toBe('~/Development/pi-kit');
    expect(tildePath('/home/me/x')).toBe('~/x');
    expect(tildePath('/srv/data')).toBe('/srv/data');
  });
});

describe('ordering the projects', () => {
  const order = ['a', 'b', 'c', 'd'];

  it('drops a project before the one it lands on when it comes from below, after it when it comes from above', () => {
    expect(dropBefore(order, 'd', 'b')).toEqual({ before: 'b' });
    expect(dropBefore(order, 'a', 'c')).toEqual({ before: 'd' });
    expect(dropBefore(order, 'a', 'd')).toEqual({ before: undefined });
    expect(dropBefore(order, 'b', 'b')).toBeNull();
    expect(dropBefore(order, 'zzz', 'b')).toBeNull();
  });

  it('moves one place up or down, and not past the ends', () => {
    expect(neighbour(order, 'c', -1)).toEqual({ before: 'b' });
    expect(neighbour(order, 'b', 1)).toEqual({ before: 'd' });
    expect(neighbour(order, 'c', 1)).toEqual({ before: undefined });
    expect(neighbour(order, 'a', -1)).toBeNull();
    expect(neighbour(order, 'd', 1)).toBeNull();
  });
});

describe('the Cut from options', () => {
  const git: Pick<ProjectGit, 'branches' | 'remoteBranches'> = {
    branches: [
      { name: 'main', current: true, heldBy: null },
      { name: 'develop', current: false, heldBy: null },
    ],
    remoteBranches: ['origin/main'],
  };

  it('offer the checked-out branch first, every local branch, and the remote ones with the fetch', () => {
    expect(baseOptions(english, git, null)).toEqual([
      { value: '', label: 'the checked-out branch' },
      { value: 'main', label: 'main' },
      { value: 'develop', label: 'develop' },
      { value: 'origin/main', label: 'origin/main (fetch first)' },
    ]);
  });

  it('keep a saved base that is gone selectable and say so; with no repository there is only the checked-out branch', () => {
    expect(baseOptions(english, git, 'old-branch').at(-1)).toEqual({
      value: 'old-branch',
      label: 'old-branch (not found)',
    });
    expect(baseOptions(english, undefined, null)).toEqual([{ value: '', label: 'the checked-out branch' }]);
  });
});

describe('the dirty save', () => {
  const current = settings({
    branchPrefix: 'pi-kit/',
    root: null,
    setupScripts: [{ id: 'a', name: 'A', command: 'x' }],
  });

  it('sends only what differs, and a blank text equals the default', () => {
    expect(dirtyPatch(current, { branchPrefix: 'pi-kit/', root: '', base: null })).toEqual({});
    expect(dirtyPatch(current, { branchPrefix: 'feat/', root: '  ', start: 'local' })).toEqual({
      branchPrefix: 'feat/',
    });
    expect(dirtyPatch(current, { root: '/srv/wt' })).toEqual({ root: '/srv/wt' });
  });

  it('compares a list of scripts by value', () => {
    expect(dirtyPatch(current, { setupScripts: [{ id: 'a', name: 'A', command: 'x' }] })).toEqual({});
    expect(dirtyPatch(current, { setupScripts: [{ id: 'a', name: 'A', command: 'y' }] })).toEqual({
      setupScripts: [{ id: 'a', name: 'A', command: 'y' }],
    });
    expect(dirtyPatch(current, { setupScripts: [] })).toEqual({ setupScripts: [] });
  });

  it('sends everything while the project is not known yet', () => {
    expect(dirtyPatch(undefined, { start: 'ask' })).toEqual({ start: 'ask' });
  });
});

describe('the open worktrees', () => {
  const wt = (over: Partial<NonNullable<ThreadSummary['worktree']>> = {}): ThreadSummary['worktree'] => ({
    path: '/w/one',
    branch: 'pi-kit/one',
    base: 'main',
    exists: true,
    ...over,
  });
  const status = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
    path: '/w/one',
    exists: true,
    branch: 'pi-kit/one',
    base: 'main',
    ahead: 14,
    behind: 0,
    dirty: 0,
    conflicts: [],
    operation: null,
    baseCheckedOut: true,
    projectDirty: 0,
    remote: false,
    gh: false,
    sharedWith: 0,
    removeFolder: 'ask',
    ...over,
  });

  const threads = [
    thread({
      id: '1',
      title: 'Settings v2 proposal',
      worktree: wt(),
      state: { activity: 'running', outcome: null } as ThreadSummary['state'],
    }),
    thread({
      id: '2',
      title: null,
      preview: 'Fix the cramped row',
      worktree: wt({ path: '/w/two', branch: null, detached: true }),
    }),
    thread({
      id: '3',
      title: 'Merged long ago',
      worktree: wt({ path: '/w/three' }),
      state: { activity: 'idle', outcome: { kind: 'merged', head: 'a', at: 1 } } as ThreadSummary['state'],
    }),
    thread({ id: '4', title: 'Gone', worktree: wt({ exists: false }) }),
    thread({ id: '5', title: 'Other project', cwd: '/elsewhere', worktree: wt() }),
    thread({ id: '6', title: 'Local thread' }),
  ];

  it('are the threads of the project whose folder still exists, with branch, state, title and commits ahead', () => {
    const rows = openWorktreeRows(english, threads, '/home/me/pi-kit', { '1': status(), '3': status({ ahead: 0 }) });
    expect(rows.map((r) => r.threadId)).toEqual(['2', '3', '1']);
    const one = rows.find((r) => r.threadId === '1');
    expect(one).toMatchObject({
      branch: 'pi-kit/one',
      title: 'Settings v2 proposal',
      ahead: 14,
      base: 'main',
      busy: true,
      state: { text: 'running', tone: 'ok' },
    });
    expect(rows.find((r) => r.threadId === '2')).toMatchObject({
      branch: 'detached',
      detached: true,
      title: 'Fix the cramped row',
      ahead: null,
      busy: false,
    });
    expect(rows.find((r) => r.threadId === '3')).toMatchObject({ merged: true, state: { text: 'merged' } });
  });

  it('say how far ahead a worktree is, or that the folder can go', () => {
    expect(aheadText(english, { ahead: 14, base: 'main', merged: false })).toBe('14 commits ahead of main');
    expect(aheadText(english, { ahead: 1, base: null, merged: false })).toBe('1 commit ahead');
    expect(aheadText(english, { ahead: 0, base: 'main', merged: false })).toBe('up to date with main');
    expect(aheadText(english, { ahead: null, base: 'main', merged: false })).toBeUndefined();
    expect(aheadText(english, { ahead: 3, base: 'main', merged: true })).toBe('merged: the folder can go');
  });

  it('say waiting, a pull request and archived where they apply', () => {
    expect(
      worktreeState(english, {
        archived: false,
        state: { activity: 'waiting', outcome: null } as ThreadSummary['state'],
      }),
    ).toEqual({ text: 'waiting', tone: 'warn' });
    expect(
      worktreeState(english, {
        archived: false,
        state: { activity: 'idle', outcome: { kind: 'pr', head: 'a', at: 1 } } as ThreadSummary['state'],
      }),
    ).toEqual({ text: 'pull request', tone: 'info' });
    expect(
      worktreeState(english, { archived: true, state: { activity: 'idle', outcome: null } as ThreadSummary['state'] }),
    ).toEqual({ text: 'archived', tone: 'off' });
  });
});

describe('the setup script editor', () => {
  const list: SetupScript[] = [
    { id: 'node', name: 'Node', command: 'npm ci', copy: ['.env.local'] },
    { id: 'full', name: 'Full', command: 'npm ci && npx playwright install chromium' },
  ];

  it('reads the files to copy one per line (a comma also parts them), without blanks or repeats', () => {
    expect(parseCopy('.env.local\n  config/dev.json , .env.local\n\n')).toEqual(['.env.local', 'config/dev.json']);
    expect(parseCopy('')).toEqual([]);
  });

  it('opens a script as text, and a new one empty', () => {
    expect(draftOf(list[0] as SetupScript)).toEqual({
      id: 'node',
      name: 'Node',
      command: 'npm ci',
      copy: '.env.local',
    });
    expect(newDraft()).toEqual({ id: null, name: '', command: '', copy: '' });
  });

  it('asks for a name and something to do, and keeps copied files inside the project', () => {
    expect(draftProblem(english, newDraft())).toBe('Give the script a name.');
    expect(draftProblem(english, { ...newDraft(), name: 'X' })).toBe('Add a command, or files to copy, or both.');
    expect(draftProblem(english, { ...newDraft(), name: 'X', command: 'make' })).toBeUndefined();
    expect(draftProblem(english, { ...newDraft(), name: 'X', copy: '.env' })).toBeUndefined();
    expect(draftProblem(english, { ...newDraft(), name: 'X', copy: '../secrets' })).toContain('not inside the project');
    expect(draftProblem(english, { ...newDraft(), name: 'X', copy: '/etc/passwd' })).toContain(
      'not inside the project',
    );
  });

  it('makes a free id from the name', () => {
    expect(scriptId('Node & Co', ['x'])).toBe('node-co');
    expect(scriptId('Node', ['node', 'node-2'])).toBe('node-3');
    expect(scriptId('???', [])).toBe('script');
  });

  it('adds a new script last, replaces an edited one in place, and trims what was typed', () => {
    const added = withScript(list, { id: null, name: '  Docs ', command: ' make docs ', copy: '' });
    expect(added.map((s) => s.id)).toEqual(['node', 'full', 'docs']);
    expect(added[2]).toEqual({ id: 'docs', name: 'Docs', command: 'make docs' });
    const edited = withScript(list, { id: 'full', name: 'Full e2e', command: 'make e2e', copy: '.env.local\n.env' });
    expect(edited.map((s) => s.name)).toEqual(['Node', 'Full e2e']);
    expect(edited[1]?.copy).toEqual(['.env.local', '.env']);
  });

  it('makes one the default by moving it first, and removes one', () => {
    expect(withDefault(list, 'full').map((s) => s.id)).toEqual(['full', 'node']);
    expect(withDefault(list, 'nope')).toEqual(list);
    expect(withoutScript(list, 'node').map((s) => s.id)).toEqual(['full']);
    expect(withoutScript(withoutScript(list, 'node'), 'full')).toEqual([]);
  });
});
