import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideMockApi,
  settingsDecide,
  threadsList,
  workspacesDefaults,
  workspacesGit,
  workspacesPatchDefaults,
  worktreeRemove,
  worktreeState,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type {
  ProjectGit,
  ThreadSummary,
  TrustState,
  Workspace,
  WorktreeSettings,
  WorktreeStatus,
} from '@pi-kit/protocol';
import { ThreadsStore, WorktreeStore } from '@pi-kit/threads/api';
import { ProjectPageStore } from './project-page.store';
import { SettingsStore } from './settings.store';

const CWD = '/home/me/pi-kit';

const worktreeSettings = (over: Partial<WorktreeSettings> = {}): WorktreeSettings => ({
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
  setupScripts: [{ id: 'pnpm', name: 'pnpm', command: 'pnpm install --frozen-lockfile' }],
  setupSuggested: true,
  ...over,
});

const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  cwd: CWD,
  name: 'pi-kit',
  lastOpenedAt: 0,
  threadCount: 2,
  collapsed: false,
  hidden: false,
  attendant: true,
  agents: false,
  branch: 'main',
  worktree: worktreeSettings(),
  ...over,
});
const thread = (id: string, over: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({
    id,
    cwd: CWD,
    title: `Thread ${id}`,
    preview: null,
    pinned: false,
    archived: false,
    state: { activity: 'idle', outcome: null },
    worktree: { path: `/w/${id}`, branch: `pi-kit/${id}`, base: 'main', exists: true },
    ...over,
  }) as ThreadSummary;
const status = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  path: '/w',
  exists: true,
  branch: 'b',
  base: 'main',
  ahead: 2,
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
const git: ProjectGit = {
  git: true,
  branch: 'main',
  head: 'abc',
  dirty: 0,
  branches: [{ name: 'main', current: true, heldBy: null }],
  remoteBranches: [],
  hasRemote: false,
};

describe('ProjectPageStore', () => {
  const project = signal<string | undefined>(undefined);
  const folders = signal<Record<string, TrustState>>({});
  const workspaces = signal<Workspace[]>([]);
  const settings = {
    project,
    folders,
    section: signal('projects'),
    save: vi.fn(async (work: () => Promise<unknown>) => work()),
    loadFolders: vi.fn(async () => undefined),
    closeProject: vi.fn(() => project.set(undefined)),
  };
  const threads = {
    workspaces,
    threads: signal<ThreadSummary[]>([]),
    setWorktreeSettings: vi.fn(async () => undefined),
    setHidden: vi.fn(async () => undefined),
    forgetWorkspace: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  };
  const api = {
    projectGit: vi.fn(async () => git),
    list: vi.fn(async () => [] as ThreadSummary[]),
    worktree: vi.fn(async () => status()),
    removeWorktree: vi.fn(async () => ({ removed: true })),
    worktreeDefaults: vi.fn(async () => ({ root: null, defaultRoot: '/home/me/.pi-kit/worktrees', start: 'local' })),
    patchWorktreeDefaults: vi.fn(async (patch: Record<string, unknown>) => ({
      root: null,
      defaultRoot: '/home/me/.pi-kit/worktrees',
      start: 'local',
      ...patch,
    })),
  };
  const workspaceApi = {
    decideTrust: vi.fn(async () => ({
      cwd: CWD,
      hasResources: true,
      status: 'trusted',
      source: 'saved',
      resources: [],
      reopened: 0,
      running: 0,
    })),
  };
  const worktreeStore = { open: signal(false), openDialog: vi.fn(async () => undefined) };
  const toasts = { show: vi.fn() };

  const make = (): ProjectPageStore => {
    const store = TestBed.inject(ProjectPageStore);
    TestBed.tick();
    return store;
  };
  const open = async (store: ProjectPageStore, cwd = CWD): Promise<void> => {
    project.set(cwd);
    TestBed.tick();
    await vi.waitFor(() => expect(store.worktreesLoading()).toBe(false));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    project.set(undefined);
    folders.set({});
    workspaces.set([workspace()]);
    threads.threads.set([]);
    api.list.mockImplementation(async () => [
      thread('a'),
      thread('b', { archived: true }),
      thread('gone', { worktree: { path: '/w/gone', branch: null, base: 'main', exists: false } }),
      thread('other', { cwd: '/elsewhere' }),
    ]);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsStore, useValue: settings },
        { provide: ThreadsStore, useValue: threads },
        { provide: WorktreeStore, useValue: worktreeStore },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi([
          [workspacesGit, api.projectGit, (o) => [o.path?.['id']]],
          [threadsList, api.list, (o) => [o.query?.['workspace'], o.query?.['archived'] === '1', o.signal]],
          [worktreeState, api.worktree, (o) => [o.path?.['id']]],
          [worktreeRemove, api.removeWorktree, (o) => [o.path?.['id'], o.body?.['force']]],
          [workspacesDefaults, api.worktreeDefaults, () => []],
          [workspacesPatchDefaults, api.patchWorktreeDefaults, (o) => [o.body]],
          [settingsDecide, workspaceApi.decideTrust, (o) => [o.path?.['id'], o.body?.['decision']]],
        ]),
      ],
    });
  });

  describe('opening a project and going back', () => {
    it('reads the branches and the worktrees of the project that opens, with the commits ahead of each', async () => {
      const store = make();
      expect(store.cwd()).toBeUndefined();
      await open(store);
      expect(api.projectGit).toHaveBeenCalledWith(CWD);
      expect(api.list).toHaveBeenCalledWith(CWD, true, undefined);
      expect(api.worktree).toHaveBeenCalledTimes(2);
      expect(store.rows().map((r) => [r.threadId, r.ahead, r.archived])).toEqual([
        ['a', 2, false],
        ['b', 2, true],
      ]);
      expect(settings.loadFolders).toHaveBeenCalled();
      expect(store.baseOptions().map((o) => o.value)).toEqual(['', 'main']);
      expect(store.worktree()?.setupSuggested).toBe(true);
    });

    it('lets go of what it read when Back closes the page, and reads again for the next project', async () => {
      const store = make();
      await open(store);
      project.set(undefined);
      TestBed.tick();
      expect(store.rows()).toEqual([]);
      expect(store.git()).toBeUndefined();
      expect(store.loadedFor()).toBeUndefined();
      workspaces.set([
        workspace(),
        workspace({ cwd: '/home/me/notes', name: 'notes', worktree: worktreeSettings({ git: false }) }),
      ]);
      await open(store, '/home/me/notes');
      expect(api.projectGit).toHaveBeenLastCalledWith('/home/me/notes');
      expect(store.workspace()?.name).toBe('notes');
    });

    it('does not show the worktrees of a project that was left before its answer came', async () => {
      let release: (threads: ThreadSummary[]) => void = () => undefined;
      api.list.mockImplementationOnce(() => new Promise<ThreadSummary[]>((resolve) => (release = resolve)));
      const store = make();
      project.set(CWD);
      TestBed.tick();
      await vi.waitFor(() => expect(store.git()).toBeDefined());
      project.set(undefined);
      TestBed.tick();
      release([thread('late')]);
      await new Promise((r) => setTimeout(r));
      expect(store.rows()).toEqual([]);
    });
  });

  describe('saving a change (dirty save)', () => {
    it('sends only the fields that differ, and nothing at all for a blur on an unchanged field', async () => {
      const store = make();
      await open(store);
      await store.save({ branchPrefix: 'pi-kit/', root: '', start: 'local' });
      expect(threads.setWorktreeSettings).not.toHaveBeenCalled();
      expect(settings.save).not.toHaveBeenCalled();
      await store.save({ branchPrefix: 'feat/', start: 'local', carryChanges: 'always' });
      expect(threads.setWorktreeSettings).toHaveBeenCalledWith(CWD, { branchPrefix: 'feat/', carryChanges: 'always' });
      expect(settings.save).toHaveBeenCalledTimes(1);
    });

    it('shows the project as hidden or shown through the sidebar flag, and not when it already is', async () => {
      const store = make();
      await open(store);
      await store.setShown(true);
      expect(threads.setHidden).not.toHaveBeenCalled();
      await store.setShown(false);
      expect(threads.setHidden).toHaveBeenCalledWith(CWD, true);
    });

    it('trusts and remembers on the switch, never trusts when it goes off, and warns about a run in the folder', async () => {
      const store = make();
      await open(store);
      await store.setTrusted(true);
      expect(workspaceApi.decideTrust).toHaveBeenLastCalledWith(CWD, 'remember');
      workspaceApi.decideTrust.mockResolvedValueOnce({
        cwd: CWD,
        hasResources: true,
        status: 'untrusted',
        source: 'saved',
        resources: [],
        reopened: 0,
        running: 1,
      });
      await store.setTrusted(false);
      expect(workspaceApi.decideTrust).toHaveBeenLastCalledWith(CWD, 'never');
      expect(toasts.show).toHaveBeenCalledWith('info', expect.stringContaining('A run is going'));
      expect(settings.loadFolders).toHaveBeenCalledTimes(3);
    });
  });

  describe('the setup scripts', () => {
    it('adds a script to the list and saves the list whole, which ends the suggestion', async () => {
      const store = make();
      await open(store);
      store.addScript();
      expect(store.editing()).toMatchObject({ id: null, name: '' });
      expect(await store.saveScript()).toBe(false);
      expect(store.editError()).toBe('Give the script a name.');
      store.setDraft({ name: 'Docs', command: 'make docs', copy: '.env.local' });
      expect(store.editError()).toBeUndefined();
      expect(await store.saveScript()).toBe(true);
      expect(threads.setWorktreeSettings).toHaveBeenCalledWith(CWD, {
        setupScripts: [
          { id: 'pnpm', name: 'pnpm', command: 'pnpm install --frozen-lockfile' },
          { id: 'docs', name: 'Docs', command: 'make docs', copy: ['.env.local'] },
        ],
      });
      expect(store.editing()).toBeUndefined();
    });

    it('edits a script in place, cancels without a request, makes one the default and removes one', async () => {
      workspaces.set([
        workspace({
          worktree: worktreeSettings({
            setupSuggested: undefined,
            setupScripts: [
              { id: 'node', name: 'Node', command: 'npm ci' },
              { id: 'full', name: 'Full', command: 'make full' },
            ],
          }),
        }),
      ]);
      const store = make();
      await open(store);
      store.editScript('full');
      expect(store.editing()).toEqual({ id: 'full', name: 'Full', command: 'make full', copy: '' });
      store.setDraft({ command: 'make e2e' });
      store.cancelScript();
      expect(store.editing()).toBeUndefined();
      expect(threads.setWorktreeSettings).not.toHaveBeenCalled();
      store.editScript('full');
      store.setDraft({ command: 'make e2e' });
      await store.saveScript();
      expect(threads.setWorktreeSettings).toHaveBeenLastCalledWith(CWD, {
        setupScripts: [
          { id: 'node', name: 'Node', command: 'npm ci' },
          { id: 'full', name: 'Full', command: 'make e2e' },
        ],
      });
      await store.makeDefaultScript('full');
      expect(threads.setWorktreeSettings).toHaveBeenLastCalledWith(CWD, {
        setupScripts: [
          { id: 'full', name: 'Full', command: 'make full' },
          { id: 'node', name: 'Node', command: 'npm ci' },
        ],
      });
      await store.removeScript('node');
      expect(threads.setWorktreeSettings).toHaveBeenLastCalledWith(CWD, {
        setupScripts: [{ id: 'full', name: 'Full', command: 'make full' }],
      });
    });
  });

  describe('the open worktrees', () => {
    it('opens the thread menu’s dialogs from a row', async () => {
      const store = make();
      store.handoff('a');
      store.mergeBack('b');
      expect(worktreeStore.openDialog).toHaveBeenNthCalledWith(1, 'a', 'handoff');
      expect(worktreeStore.openDialog).toHaveBeenNthCalledWith(2, 'b', 'merge');
    });

    it('reads the rows again when a dialog closes', async () => {
      const store = make();
      await open(store);
      api.list.mockClear();
      worktreeStore.open.set(true);
      TestBed.tick();
      worktreeStore.open.set(false);
      TestBed.tick();
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    });

    it('asks before it removes a folder, then removes it and reads the rows again', async () => {
      const store = make();
      await open(store);
      store.askRemove('a');
      expect(store.confirming()).toEqual({ kind: 'remove', threadId: 'a', force: false });
      await store.removeFolder();
      expect(api.removeWorktree).toHaveBeenCalledWith('a', false);
      expect(store.confirming()).toBeUndefined();
      expect(threads.refresh).toHaveBeenCalled();
    });

    it('says why a removal was refused and offers to remove anyway', async () => {
      api.removeWorktree.mockRejectedValueOnce(new Error('The worktree has 2 uncommitted changes.'));
      const store = make();
      await open(store);
      store.askRemove('a');
      await store.removeFolder();
      expect(store.confirming()).toEqual({
        kind: 'remove',
        threadId: 'a',
        force: true,
        message: 'The worktree has 2 uncommitted changes.',
      });
      await store.removeFolder();
      expect(api.removeWorktree).toHaveBeenLastCalledWith('a', true);
      expect(store.confirming()).toBeUndefined();
    });
  });

  describe('forgetting the project', () => {
    it('asks first, forgets, and goes back to the list', async () => {
      const store = make();
      await open(store);
      store.askForget();
      expect(store.confirming()).toEqual({ kind: 'forget' });
      store.cancelConfirm();
      expect(store.confirming()).toBeUndefined();
      expect(threads.forgetWorkspace).not.toHaveBeenCalled();
      store.askForget();
      await store.forget();
      expect(threads.forgetWorkspace).toHaveBeenCalledWith(CWD);
      expect(settings.closeProject).toHaveBeenCalled();
      expect(project()).toBeUndefined();
    });

    it('stays on the page when the project could not be forgotten', async () => {
      settings.save.mockImplementationOnce(async () => undefined);
      const store = make();
      await open(store);
      await store.forget();
      expect(settings.closeProject).not.toHaveBeenCalled();
      expect(project()).toBe(CWD);
    });
  });

  describe('the defaults for every project', () => {
    it('reads them, saves a change and tells the projects, and sends nothing for what is already so', async () => {
      const store = make();
      await store.loadDefaults();
      expect(store.defaults()).toMatchObject({ start: 'local', root: null });
      await store.saveDefaults({ start: 'local', root: '' });
      expect(api.patchWorktreeDefaults).not.toHaveBeenCalled();
      await store.saveDefaults({ start: 'worktree' });
      expect(api.patchWorktreeDefaults).toHaveBeenCalledWith({ start: 'worktree' });
      expect(store.defaults()?.start).toBe('worktree');
      expect(threads.refresh).toHaveBeenCalled();
    });
  });
});
