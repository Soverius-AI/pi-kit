import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@pi-kit/i18n';
import {
  appSettingsSetSetting,
  appSettingsSettings,
  provideMockApi,
  sessionOpenInEditor,
  worktreeRemove,
  worktreeState,
} from '@pi-kit/api';
import { HealthStore, SIDEBAR_WIDTH, ThemeStore, ToastStore, UiStore, ViewPrefs } from '@pi-kit/data-access';
import type { ThreadSummary, Workspace } from '@pi-kit/protocol';
import { ConnectorsStore } from '@pi-kit/settings/api';
import { idleState, thread } from '@pi-kit/testing';
import {
  ChangedCountStore,
  LearnStore,
  NewThreadStore,
  OutcomeMenuStore,
  ThreadShell,
  ThreadsStore,
  WorktreeReview,
  WorktreeStore,
  type Project,
} from '@pi-kit/threads/data';
import { countStates, strongestKind, worstContext } from '@pi-kit/threads/util';
import { UpdateStore } from '@pi-kit/update/api';
import { ThreadSidebar } from './thread-sidebar';

const workspace = (cwd: string, over: Partial<Workspace> = {}): Workspace =>
  ({
    cwd,
    name: cwd.slice(1),
    lastOpenedAt: 1,
    threadCount: 0,
    collapsed: false,
    hidden: false,
    attendant: true,
    agents: false,
    branch: 'main',
    ...over,
  }) as Workspace;

const project = (ws: Workspace, threads: ThreadSummary[], selectedId?: string): Project => ({
  workspace: ws,
  threads,
  counts: countStates(threads),
  strongest: strongestKind(threads, selectedId),
  context: worstContext(threads),
});

describe('ThreadSidebar', () => {
  const opened = vi.fn();
  const shell = {
    openWaiting: vi.fn(),
    acceptSuggestion: vi.fn(async () => undefined),
    dismissSuggestion: vi.fn(async () => undefined),
    answerWaiting: vi.fn(async () => undefined),
  };
  let projects: ReturnType<typeof signal<Project[]>>;
  let selectedId: ReturnType<typeof signal<string | undefined>>;
  const store = {
    visibleProjects: () => projects().filter((p) => !p.workspace.hidden),
    hiddenProjects: () => projects().filter((p) => p.workspace.hidden),
    workspaces: () => projects().map((p) => p.workspace),
    workspace: () => projects()[0]?.workspace.cwd,
    workspaceName: () => projects()[0]?.workspace.name,
    cwd: () => projects()[0]?.workspace.cwd,
    folder: () => projects()[0]?.workspace.cwd,
    selected: () =>
      projects()
        .flatMap((p) => p.threads)
        .find((t) => t.id === selectedId()),
    selectedId: () => selectedId(),
    showArchived: () => false,
    error: () => undefined,
    create: vi.fn(async () => undefined),
    setCollapsed: vi.fn(async () => undefined),
    setHidden: vi.fn(async () => undefined),
    stepProject: vi.fn(async () => undefined),
    moveProject: vi.fn(async () => undefined),
    setAttendant: vi.fn(async () => undefined),
    toggleArchived: vi.fn(async () => undefined),
    setArchived: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    setPinned: vi.fn(async () => undefined),
    jumpToProject: vi.fn(),
    selectWorkspace: vi.fn(async () => undefined),
  };
  const review = { setSource: vi.fn(), open: vi.fn(), refresh: vi.fn(async () => undefined) };
  const changed = { count: signal(0) };
  const workspaceApi = { openInEditor: vi.fn(async () => ({ opened: true })) };
  const toasts = { show: vi.fn() };
  const threadsApi = {
    worktree: vi.fn(async () => ({ dirty: 0 })),
    removeWorktree: vi.fn(async () => ({ removed: true })),
  };
  const worktrees = { openDialog: vi.fn(async () => undefined) };
  const newThread = { preset: vi.fn(async () => undefined) };
  const outcomeMenu = { openFor: vi.fn() };
  const learn = { read: vi.fn(async () => undefined), learnFrom: vi.fn(async () => undefined) };

  const render = () => {
    const fixture = TestBed.createComponent(ThreadSidebar);
    fixture.componentInstance.opened.subscribe(opened);
    fixture.detectChanges();
    return fixture;
  };
  const el = (fixture: ReturnType<typeof render>): HTMLElement => fixture.nativeElement as HTMLElement;
  /** Lets the promises of a click settle, then draws what they changed. */
  const flush = async (fixture: ReturnType<typeof render>): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  };

  const uiSettings = { all: vi.fn(async () => ({})), set: vi.fn(async () => undefined) };

  beforeEach(() => {
    localStorage.clear();
    opened.mockClear();
    vi.clearAllMocks();
    selectedId = signal<string | undefined>('t1');
    projects = signal<Project[]>([]);
    changed.count.set(0);
    document.documentElement.removeAttribute('data-sidebar');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: store },
        { provide: ThreadShell, useValue: shell },
        { provide: HealthStore, useValue: { state: signal('ok') } },
        {
          provide: ConnectorsStore,
          useValue: { needsAttention: () => false, attention: () => undefined, label: () => 'No MCP servers' },
        },
        { provide: UpdateStore, useValue: { attention: () => false } },
        { provide: ThemeStore, useValue: { theme: () => 'pi-dark', isDark: () => true, toggle: vi.fn() } },
        { provide: WorktreeStore, useValue: worktrees },
        { provide: NewThreadStore, useValue: newThread },
        { provide: OutcomeMenuStore, useValue: outcomeMenu },
        { provide: LearnStore, useValue: learn },
        { provide: WorktreeReview, useValue: review },
        { provide: ChangedCountStore, useValue: changed },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi([
          [worktreeState, threadsApi.worktree, (o) => [o.path?.['id']]],
          [worktreeRemove, threadsApi.removeWorktree, (o) => [o.path?.['id'], o.body?.['force']]],
          [appSettingsSettings, uiSettings.all, () => []],
          [appSettingsSetSetting, uiSettings.set, (o) => [o.path?.['key'], o.body?.['value']]],
          [sessionOpenInEditor, workspaceApi.openInEditor, (o) => [o.path?.['id'], o.body?.['path']]],
        ]),
      ],
    });
  });

  const two = () => {
    const a = [
      thread('t1', { title: 'First thread', state: idleState({ context: 96 }) }),
      thread('t2', {
        title: 'Second thread',
        state: idleState({
          activity: 'waiting',
          question: 'Proceed with the test?',
          suggestions: [{ id: 5, kind: 'answer', target: 'd1', text: 'Allow' }],
        }),
      }),
    ];
    const b = [thread('t3', { title: 'Elsewhere', cwd: '/b', state: idleState({ activity: 'running' }) })];
    projects.set([
      project(workspace('/a', { branch: 'feature/x' }), a, 't1'),
      project(workspace('/b', { collapsed: true }), b, 't1'),
    ]);
  };

  it('draws every project as a group with its name and branch, the open one expanded and the folded one without its threads', () => {
    two();
    const fixture = render();
    const groups = el(fixture).querySelectorAll('.pk-project');
    expect(Array.from(groups).map((g) => g.getAttribute('data-project'))).toEqual(['a', 'b']);
    expect(groups[0].querySelector('[data-testid=project-branch]')?.textContent?.trim()).toBe('feature/x');
    expect(groups[0].querySelectorAll('.pk-thread')).toHaveLength(2);
    expect(groups[1].getAttribute('data-collapsed')).toBe('true');
    expect(groups[1].querySelectorAll('.pk-thread')).toHaveLength(0);
    // the folded project still says what its threads are doing
    expect(groups[1].querySelector('[data-testid=count-running]')?.textContent?.trim()).toBe('1 running');
  });

  it('a row shows the context ring from 70 %, the waiting question as a pill and the attendant’s suggestion as a chip', () => {
    two();
    const fixture = render();
    const rows = el(fixture).querySelectorAll('.pk-thread');
    expect(rows[0].querySelector('[data-testid=thread-gauge]')?.getAttribute('data-level')).toBe('err');
    expect(rows[0].querySelector('[data-testid=thread-gauge]')?.textContent).toContain('96 % context');
    expect(rows[1].querySelector('[data-testid=waiting-badge]')?.textContent?.trim()).toBe('Proceed with the test?');
    expect(rows[1].querySelector('[data-testid=suggestion-chip]')?.textContent?.trim()).toBe('Allow, suggested');
    expect(el(fixture).querySelector('[data-testid=count-waiting]')?.textContent?.trim()).toBe('1');
  });

  it('clicking a waiting pill or count opens the approval; clicking a chip accepts; clicking a row opens the thread', () => {
    two();
    const fixture = render();
    (el(fixture).querySelector('[data-testid=waiting-badge]') as HTMLElement).click();
    expect(shell.openWaiting).toHaveBeenCalledWith('t2');
    expect(opened).toHaveBeenLastCalledWith('t2');
    (el(fixture).querySelector('[data-testid=suggestion-chip]') as HTMLElement).click();
    expect(shell.acceptSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't2' }),
      expect.objectContaining({ id: 5, text: 'Allow' }),
    );
    (el(fixture).querySelectorAll('.pk-thread')[0] as HTMLElement).click();
    expect(opened).toHaveBeenLastCalledWith('t1');
    // the pill is not a click on the row: the thread opened once for the pill
    expect(opened.mock.calls.filter(([id]) => id === 't2')).toHaveLength(2);
  });

  describe('skills learned from threads', () => {
    const drafted = (state: 'pending' | 'discarded' | 'approved' = 'pending') =>
      thread('l1', {
        title: 'Learned thread',
        messageCount: 6,
        state: idleState({
          suggestions:
            state === 'pending'
              ? [
                  {
                    id: 9,
                    kind: 'learn',
                    target: 'd1',
                    text: 'add-a-migration',
                    reason: 'The attendant drafted a skill from this thread.',
                  },
                ]
              : [],
          draft: { id: 'd1', name: 'add-a-migration', state, madeBy: 'attendant' },
        }),
      });

    it('shows the attendant’s learn suggestion as a chip, and clicking it opens the thread and the review, not the shell’s accept', () => {
      projects.set([project(workspace('/a'), [drafted(), thread('p1', { title: 'Plain' })], 'p1')]);
      const fixture = render();
      const chip = el(fixture).querySelector('[data-testid=learn-chip]') as HTMLElement;
      expect(chip.textContent?.trim()).toBe('Skill “add-a-migration”, drafted');
      expect(chip.getAttribute('title')).toContain('Click to read it.');
      expect(el(fixture).querySelectorAll('[data-testid=learn-chip]')).toHaveLength(1);
      chip.click();
      expect(opened).toHaveBeenLastCalledWith('l1');
      expect(learn.read).toHaveBeenCalledWith('l1');
      expect(shell.acceptSuggestion).not.toHaveBeenCalled();
    });

    it('the thread menu offers to learn a skill, read the draft, or reopen it, and nothing once it is learned', () => {
      projects.set([
        project(
          workspace('/a'),
          [
            thread('p1', { title: 'Plain', messageCount: 4 }),
            drafted('pending'),
            { ...drafted('discarded'), id: 'l2' } as ThreadSummary,
            { ...drafted('approved'), id: 'l3' } as ThreadSummary,
            thread('e1', { title: 'Empty', messageCount: 0 }),
          ],
          'p1',
        ),
      ]);
      const fixture = render();
      const label = (row: Element) => row.querySelector('[data-testid=menu-learn]')?.textContent?.trim();
      const rows = el(fixture).querySelectorAll('.pk-thread');
      expect(rows[0].querySelector('[data-testid=menu-learn]')?.textContent?.trim()).toBe(
        'Learn a skill from this thread',
      );
      expect(label(rows[1])).toBe('Read the skill draft');
      expect(label(rows[2])).toBe('Reopen the skill draft');
      expect(label(rows[3])).toBeUndefined();
      expect((rows[4].querySelector('[data-testid=menu-learn]') as HTMLButtonElement).disabled).toBe(true);
    });

    it('choosing it opens the thread and asks the store', () => {
      projects.set([project(workspace('/a'), [thread('p1', { title: 'Plain', messageCount: 4 })], 'p1')]);
      const fixture = render();
      (el(fixture).querySelector('[data-testid=menu-learn]') as HTMLElement).click();
      expect(opened).toHaveBeenLastCalledWith('p1');
      expect(learn.learnFrom).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
    });
  });

  it('a row with an outcome shows its badge after the state, with the tooltip; pressing it opens the menu and not the thread', () => {
    const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    const ago = Date.now() - 2 * 3_600_000 - 5 * 60_000;
    projects.set([
      project(
        workspace('/a'),
        [
          thread('t1', {
            title: 'Merged one',
            worktree: { path: '/wt', branch: 'pi-kit/x', base: 'main', exists: false },
            state: idleState({ outcome: { kind: 'merged', head: HEAD, at: ago } }),
          }),
          thread('t2', {
            title: 'Committed one',
            state: idleState({
              unread: true,
              lastRun: 'finished',
              outcome: { kind: 'committed', head: HEAD, at: ago },
            }),
          }),
          thread('t3', {
            title: 'PR one',
            state: idleState({ outcome: { kind: 'pr', head: HEAD, at: ago, url: 'https://example.test/pr/1' } }),
          }),
          thread('t4', { title: 'Plain one' }),
        ],
        't1',
      ),
    ]);
    const fixture = render();
    const rows = el(fixture).querySelectorAll('.pk-thread');
    const kinds = Array.from(rows).map(
      (r) => r.querySelector('[data-testid=outcome-badge]')?.getAttribute('data-kind') ?? null,
    );
    expect(kinds).toEqual(['merged', 'committed', 'pr', null]);
    expect(rows[0].querySelector('[data-testid=outcome-badge]')?.getAttribute('title')).toBe(
      'Merged into main as a1b2c3d, 2 h ago',
    );
    expect(rows[1].querySelector('[data-testid=outcome-badge]')?.getAttribute('title')).toBe(
      'Committed as a1b2c3d, 2 h ago',
    );
    expect(rows[2].querySelector('[data-testid=outcome-badge]')?.getAttribute('title')).toBe(
      'Pull request opened for a1b2c3d, 2 h ago',
    );
    // After the state glyph and before the time.
    const order = Array.from(
      rows[1].querySelectorAll('[data-testid=thread-state], [data-testid=outcome-badge], .when'),
    ).map((c) => c.getAttribute('data-testid') ?? 'when');
    expect(order).toEqual(['thread-state', 'outcome-badge', 'when']);

    (rows[2].querySelector('[data-testid=outcome-badge]') as HTMLElement).click();
    expect(outcomeMenu.openFor).toHaveBeenCalledWith('t3', expect.any(Number), expect.any(Number));
    expect(opened).not.toHaveBeenCalled();
  });

  it('a click on a project header folds or unfolds it; the menu hides, moves and opts the attendant out', () => {
    two();
    const fixture = render();
    (el(fixture).querySelector('.pk-project-head') as HTMLElement).click();
    expect(store.setCollapsed).toHaveBeenCalledWith('/a', true);
    const items = Array.from(
      el(fixture).querySelectorAll<HTMLButtonElement>('details[data-project-menu="/a"] li button'),
    );
    const click = (label: string) => items.find((b) => b.textContent?.trim() === label)?.click();
    click('Hide project');
    expect(store.setHidden).toHaveBeenCalledWith('/a', true);
    click('Move down');
    expect(store.stepProject).toHaveBeenCalledWith('/a', 1);
    click('Turn the attendant off here');
    expect(store.setAttendant).toHaveBeenCalledWith('/a', false);
  });

  it('no row says "stop": the tests and the screenshots find the composer’s Stop button by a substring of its name, and a row is a button too', () => {
    const states = [
      idleState({ lastRun: 'aborted' }),
      idleState({ lastRun: 'error', unread: true }),
      idleState({ activity: 'running', context: 95 }),
      idleState({ cli: true }),
    ];
    projects.set([
      project(
        workspace('/a'),
        states.map((state, i) => thread(`s${i}`, { title: `Thread ${i}`, state })),
      ),
    ]);
    const fixture = render();
    for (const row of Array.from(el(fixture).querySelectorAll('.pk-thread'))) {
      const labels = Array.from(row.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label'));
      expect(`${row.textContent} ${labels.join(' ')}`.toLowerCase()).not.toContain('stop');
    }
  });

  it('a search shows the projects that have a match, open, and hides the others', () => {
    two();
    const fixture = render();
    const input = el(fixture).querySelector<HTMLInputElement>('input[type=search]') as HTMLInputElement;
    input.value = 'elsewhere';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const groups = el(fixture).querySelectorAll('.pk-project');
    expect(Array.from(groups).map((g) => g.getAttribute('data-project'))).toEqual(['b']);
    expect(groups[0].querySelectorAll('.pk-thread')).toHaveLength(1);
  });

  it('hidden projects are not drawn and are listed in the filter menu, with sections only past eight threads', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      thread(`m${i}`, { title: `Thread ${i}`, updatedAt: Date.now() - i * 1000 }),
    );
    projects.set([project(workspace('/a'), many), project(workspace('/h', { hidden: true }), [])]);
    const fixture = render();
    expect(Array.from(el(fixture).querySelectorAll('.pk-project')).map((g) => g.getAttribute('data-project'))).toEqual([
      'a',
    ]);
    expect(el(fixture).querySelectorAll('.pk-section').length).toBeGreaterThan(0);
    expect(el(fixture).querySelector('details[data-project-menu]')).not.toBeNull();
    expect(el(fixture).textContent).toContain('Hidden projects');
    // eight or fewer: no section headers
    projects.set([project(workspace('/a'), many.slice(0, 8))]);
    fixture.detectChanges();
    expect(el(fixture).querySelectorAll('.pk-section')).toHaveLength(0);
  });
  describe('worktrees', () => {
    const wtThread = () =>
      thread('w1', {
        title: 'In a worktree',
        worktree: { path: '/wt/a/w1', branch: 'pi-kit/w1', base: 'main', exists: true } as ThreadSummary['worktree'],
      });

    it('a row shows the worktree badge while the worktree exists, and not once it was removed', () => {
      const gone = thread('w2', {
        title: 'Merged',
        worktree: { path: '/wt/a/w2', branch: 'pi-kit/w2', base: 'main', exists: false } as ThreadSummary['worktree'],
      });
      projects.set([project(workspace('/a'), [wtThread(), gone, thread('p1', { title: 'Plain' })], 'w1')]);
      const fixture = render();
      const rows = el(fixture).querySelectorAll('.pk-thread');
      // A small icon with a tooltip, not a word: the name is its label.
      expect(rows[0].querySelector('[data-testid=worktree-badge]')?.textContent?.trim()).toBe('');
      expect(rows[0].querySelector('[data-testid=worktree-badge]')?.getAttribute('aria-label')).toContain('pi-kit/w1');
      expect(rows[1].querySelector('[data-testid=worktree-badge]')).toBeNull();
      expect(rows[2].querySelector('[data-testid=worktree-badge]')).toBeNull();
    });

    it('the thread menu offers Sync with base and Merge back only for a thread whose worktree exists', async () => {
      selectedId.set('w1');
      projects.set([project(workspace('/a'), [wtThread(), thread('p1', { title: 'Plain' })], 'w1')]);
      const fixture = render();
      const rows = el(fixture).querySelectorAll('.pk-thread');
      expect(rows[0].querySelector('[data-testid=menu-sync]')?.textContent?.trim()).toBe('Sync with main…');
      expect(rows[1].querySelector('[data-testid=menu-sync]')).toBeNull();
      (rows[0].querySelector('[data-testid=menu-merge-back]') as HTMLElement).click();
      await flush(fixture);
      // The thread is the open one already: the dialog opens for it at once.
      expect(worktrees.openDialog).toHaveBeenCalledWith('w1', 'merge');
    });

    const settings = (git: boolean) => ({
      root: null,
      base: null,
      setup: null,
      defaultRoot: '/w',
      git,
      start: 'local' as const,
      allowBranchSwitch: true,
      carryChanges: 'ask' as const,
      branchMode: 'named' as const,
      branchPrefix: 'pi-kit/',
      removeFolder: 'ask' as const,
      setupScripts: [],
    });

    it('the + has a menu with the choice: in this folder, or in a new worktree (disabled for a folder that is not a repository); both open the new-thread page with the row showing the choice', async () => {
      store.create.mockResolvedValue(thread('n1') as never);
      projects.set([project(workspace('/a', { worktree: settings(true) }), [thread('p1')], 'p1')]);
      let fixture = render();
      const worktree = el(fixture).querySelector('[data-testid=new-in-worktree]') as HTMLButtonElement;
      expect(worktree.disabled).toBe(false);
      expect(worktree.textContent).toContain('cut from main');
      expect(worktree.textContent).toContain('⌘⇧N');
      (el(fixture).querySelector('[data-testid=new-in-folder]') as HTMLElement).click();
      await flush(fixture);
      // Nothing is made in git by the menu: a plain empty thread, whose row shows the mode.
      expect(store.create).toHaveBeenLastCalledWith('/a');
      expect(newThread.preset).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'n1' }), 'local');
      worktree.click();
      await flush(fixture);
      expect(store.create).toHaveBeenLastCalledWith('/a');
      expect(newThread.preset).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'n1' }), 'worktree');
      expect(opened).toHaveBeenLastCalledWith('n1');
      projects.set([project(workspace('/a', { worktree: settings(false) }), [thread('p1')], 'p1')]);
      fixture = render();
      expect((el(fixture).querySelector('[data-testid=new-in-worktree]') as HTMLButtonElement).disabled).toBe(true);
    });

    it('the + itself opens the page with the project’s default, without choosing a mode', async () => {
      store.create.mockResolvedValue(thread('n2') as never);
      projects.set([project(workspace('/a', { worktree: settings(true) }), [thread('p1')], 'p1')]);
      const fixture = render();
      (el(fixture).querySelector('[data-testid=new-thread]') as HTMLElement).click();
      await flush(fixture);
      expect(newThread.preset).not.toHaveBeenCalled();
      expect(opened).toHaveBeenLastCalledWith('n2');
    });

    it('the thread menu offers Hand off to local, Move into a worktree and Create branch here, each off with its reason when it does not apply', () => {
      const detached = thread('d1', {
        title: 'No branch',
        messageCount: 2,
        worktree: { path: '/wt/d1', branch: null, base: 'main', exists: true, detached: true },
      });
      const named = wtThread();
      const plain = thread('l1', { title: 'Local', messageCount: 4, cwd: '/a' });
      const fresh = thread('f1', { title: 'Fresh', messageCount: 0, cwd: '/a' });
      projects.set([project(workspace('/a', { worktree: settings(true) }), [detached, named, plain, fresh], 'l1')]);
      const rows = el(render()).querySelectorAll('.pk-thread');
      const entry = (row: number, id: string) => rows[row].querySelector(`[data-testid=${id}]`) as HTMLButtonElement;
      // The detached worktree: hand off and a branch, not a move.
      expect(entry(0, 'menu-handoff').disabled).toBe(false);
      expect(entry(0, 'menu-branch').disabled).toBe(false);
      expect(entry(0, 'menu-move').disabled).toBe(true);
      expect(entry(0, 'menu-move').title).toContain('worktree already');
      // A worktree that has its branch: no branch to create.
      expect(entry(1, 'menu-branch').disabled).toBe(true);
      expect(entry(1, 'menu-branch').title).toContain('branch already');
      // A Local thread with messages moves; it cannot be handed off.
      expect(entry(2, 'menu-move').disabled).toBe(false);
      expect(entry(2, 'menu-handoff').disabled).toBe(true);
      expect(entry(2, 'menu-handoff').title).toContain('in a worktree');
      // A thread without messages is placed by the row instead.
      expect(entry(3, 'menu-move').disabled).toBe(true);
      expect(entry(3, 'menu-move').title).toContain('Worktree in the row');
    });

    it('Hand off to local and Move into a worktree open the dialog for the thread', async () => {
      selectedId.set('w1');
      projects.set([
        project(
          workspace('/a', { worktree: settings(true) }),
          [wtThread(), thread('l1', { messageCount: 3, cwd: '/a' })],
          'w1',
        ),
      ]);
      const fixture = render();
      const rows = el(fixture).querySelectorAll('.pk-thread');
      (rows[0].querySelector('[data-testid=menu-handoff]') as HTMLElement).click();
      await flush(fixture);
      expect(worktrees.openDialog).toHaveBeenLastCalledWith('w1', 'handoff');
    });

    it('archiving a thread that has a worktree asks what happens to it; removing a dirty one forces it, after the question', async () => {
      selectedId.set('w1');
      threadsApi.worktree.mockResolvedValueOnce({ dirty: 3 });
      projects.set([project(workspace('/a'), [wtThread()], 'w1')]);
      const fixture = render();
      const archive = Array.from(el(fixture).querySelectorAll<HTMLButtonElement>('.pk-thread li button')).find(
        (b) => b.textContent?.trim() === 'Archive',
      );
      archive?.click();
      await flush(fixture);
      fixture.detectChanges();
      expect(store.setArchived).not.toHaveBeenCalled();
      const dialog = el(fixture).querySelector('[data-testid=archive-dialog]') as HTMLElement;
      expect(dialog.textContent).toContain('3 uncommitted changes');
      (dialog.querySelector('[data-testid=remove-worktree]') as HTMLElement).click();
      (dialog.querySelector('[data-testid=confirm-archive]') as HTMLElement).click();
      await flush(fixture);
      expect(threadsApi.removeWorktree).toHaveBeenCalledWith('w1', true);
      expect(store.setArchived).toHaveBeenCalledWith('w1', true, undefined);
    });

    it('archiving keeps the worktree by default, and a thread without one archives at once', async () => {
      projects.set([project(workspace('/a'), [wtThread(), thread('p1', { title: 'Plain' })], 'w1')]);
      const fixture = render();
      const archives = Array.from(el(fixture).querySelectorAll<HTMLButtonElement>('.pk-thread li button')).filter(
        (b) => b.textContent?.trim() === 'Archive',
      );
      archives[1].click();
      await flush(fixture);
      expect(store.setArchived).toHaveBeenCalledWith('p1', true);
      archives[0].click();
      await flush(fixture);
      fixture.detectChanges();
      (el(fixture).querySelector('[data-testid=confirm-archive]') as HTMLElement).click();
      await flush(fixture);
      expect(store.setArchived).toHaveBeenLastCalledWith('w1', true, undefined);
      expect(threadsApi.removeWorktree).not.toHaveBeenCalled();
    });

    it('deleting offers to remove the worktree too: clean goes with remove, dirty with force', async () => {
      threadsApi.worktree.mockResolvedValueOnce({ dirty: 1 });
      projects.set([project(workspace('/a'), [wtThread()], 'w1')]);
      const fixture = render();
      (
        Array.from(el(fixture).querySelectorAll<HTMLButtonElement>('.pk-thread li button')).find(
          (b) => b.textContent?.trim() === 'Delete',
        ) as HTMLElement
      ).click();
      await flush(fixture);
      fixture.detectChanges();
      (el(fixture).querySelector('[data-testid=remove-worktree]') as HTMLElement).click();
      (el(fixture).querySelector('[data-testid=confirm-delete]') as HTMLElement).click();
      await flush(fixture);
      expect(store.remove).toHaveBeenCalledWith('w1', 'force');
    });
  });

  describe('three lines, the status in words, the actions', () => {
    const rowFor = (title: string, over: Partial<ThreadSummary> = {}) => {
      projects.set([project(workspace('/a'), [thread('x1', { title, ...over })], 'x1')]);
      const fixture = render();
      return { fixture, row: el(fixture).querySelector('.pk-thread') as HTMLElement };
    };

    it('a row is the title, a summary line and a status line; the attendant’s summary wins, else the last answer’s first line, else the count', () => {
      let { row } = rowFor('With a summary', {
        lastLine: 'The last answer',
        messageCount: 4,
        state: idleState({ summary: 'Writing the wizard' }),
      });
      expect(row.querySelector('.title')?.textContent?.trim()).toBe('With a summary');
      expect(row.querySelector('[data-testid=thread-meta]')?.textContent?.trim()).toBe('Writing the wizard');
      ({ row } = rowFor('With a last line', { lastLine: 'The last answer', messageCount: 4 }));
      expect(row.querySelector('[data-testid=thread-meta]')?.textContent?.trim()).toBe('The last answer');
      ({ row } = rowFor('Counted', { messageCount: 3 }));
      expect(row.querySelector('[data-testid=thread-meta]')?.textContent?.trim()).toBe('3 messages');
      ({ row } = rowFor('Empty', { messageCount: 0 }));
      expect(row.querySelector('[data-testid=thread-meta]')?.textContent?.trim()).toBe('No messages yet');
    });

    it('the status line says the state in words and colour', () => {
      const status = (state: ReturnType<typeof idleState>, selected = false) => {
        selectedId.set(selected ? 'x1' : 'other');
        const { row } = rowFor('S', { state });
        const line = row.querySelector('[data-testid=thread-status]') as HTMLElement;
        return {
          kind: line.getAttribute('data-kind'),
          text: line.querySelector('.lbl')?.textContent?.trim(),
          tone: line.querySelector('.st')?.getAttribute('data-tone'),
        };
      };
      expect(status(idleState({ activity: 'running' }))).toEqual({ kind: 'running', text: 'Running', tone: 'run' });
      expect(status(idleState({ activity: 'waiting', question: 'Ok?' }))).toEqual({
        kind: 'waiting',
        text: 'Waiting for you',
        tone: 'wait',
      });
      expect(status(idleState({ lastRun: 'finished', unread: true, unseen: true }))).toEqual({
        kind: 'unread',
        text: 'Done, unread',
        tone: 'plain',
      });
      expect(status(idleState({ lastRun: 'aborted' }))).toEqual({ kind: 'aborted', text: 'Aborted', tone: 'muted' });
      expect(status(idleState({ lastRun: 'error' }))).toEqual({
        kind: 'error',
        text: 'The last run failed',
        tone: 'err',
      });
      expect(status(idleState({ context: 73 }))).toEqual({ kind: 'context', text: '73 % context', tone: 'warn' });
      expect(status(idleState({}))).toEqual({ kind: 'idle', text: 'Idle', tone: 'muted' });
      // The open thread has no news.
      expect(status(idleState({ lastRun: 'finished', unread: true }), true).kind).toBe('idle');
    });

    it('the worktree, outcome and cli marks sit after the state; the learn and label chips after them, then the time', () => {
      const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
      const { row } = rowFor('Marks', {
        worktree: { path: '/wt', branch: 'pi-kit/x', base: 'main', exists: true },
        state: idleState({
          cli: true,
          outcome: { kind: 'merged', head: HEAD, at: Date.now() },
          suggestions: [{ id: 3, kind: 'label', target: 'e1', text: 'Fork point' }],
        }),
      });
      const order = Array.from(row.querySelectorAll('.f [data-testid], .f .when')).map(
        (e) => e.getAttribute('data-testid') ?? 'when',
      );
      expect(order.slice(0, 7)).toEqual([
        'worktree-badge',
        'outcome-badge',
        'thread-state',
        'suggestion-chip',
        'when',
        'thread-pin',
        'thread-archive',
      ]);
      expect(row.querySelector('[data-testid=thread-state]')?.getAttribute('data-kind')).toBe('cli');
    });

    it.each([0, 35, 73])('shows %s%% context inside the running ring without a duplicate gauge', (context) => {
      const { row } = rowFor('Running', { state: idleState({ activity: 'running', context }) });
      const state = row.querySelector('[data-testid=thread-state]');
      expect(state?.getAttribute('data-kind')).toBe('running');
      expect(state?.getAttribute('aria-label')).toBe(`Running, context ${context}% full`);
      expect(state?.querySelector('.context')?.getAttribute('stroke-dasharray')).toBe(
        `${(2 * Math.PI * 6 * context) / 100} ${2 * Math.PI * 6}`,
      );
      expect(state?.querySelector('.runner')).not.toBeNull();
      expect(row.querySelector('.lbl')?.textContent).toContain(`${context}%`);
      expect(row.querySelector('[data-testid=thread-gauge]')).toBeNull();
    });

    it('⋯ is always there; pin and archive are buttons of the row: pin pins, archive asks like the menu (a worktree) or archives', async () => {
      const { fixture, row } = rowFor('Pin me');
      expect(row.querySelector('summary[aria-label="Thread actions"]')).not.toBeNull();
      (row.querySelector('[data-testid=thread-pin]') as HTMLElement).click();
      await flush(fixture);
      expect(store.setPinned).toHaveBeenCalledWith('x1', true);
      (row.querySelector('[data-testid=thread-archive]') as HTMLElement).click();
      await flush(fixture);
      expect(store.setArchived).toHaveBeenCalledWith('x1', true);
      expect(opened).not.toHaveBeenCalled();
    });
  });

  describe('a project band', () => {
    it('has a tile with the first letter and a colour from the name, the name, the branch and the counts', () => {
      two();
      const fixture = render();
      const heads = el(fixture).querySelectorAll('.pk-project-head');
      const tile = heads[0].querySelector('.pk-ptile') as HTMLElement;
      expect(tile.textContent?.trim()).toBe('A');
      expect(['primary', 'info', 'success', 'secondary', 'neutral']).toContain(tile.getAttribute('data-hue'));
      expect(heads[0].querySelector('.name')?.textContent?.trim()).toBe('a');
      // The same name has the same colour in the quick actions and the rail.
      expect(el(fixture).querySelector('.pk-quick .pk-ptile')?.getAttribute('data-hue')).toBe(
        tile.getAttribute('data-hue'),
      );
    });

    it('a folded band keeps mini tags "N running" / "N waiting" and no branch', () => {
      const running = [
        thread('r1', { cwd: '/b', state: idleState({ activity: 'running' }) }),
        thread('r2', { cwd: '/b', state: idleState({ activity: 'running' }) }),
      ];
      const waiting = [thread('w1', { cwd: '/b', state: idleState({ activity: 'waiting', question: 'Ok?' }) })];
      projects.set([
        project(workspace('/a'), [thread('t1')], 't1'),
        project(workspace('/b', { collapsed: true, branch: 'docs' }), [...running, ...waiting]),
      ]);
      const fixture = render();
      const band = el(fixture).querySelectorAll('.pk-project-head')[1];
      expect(band.querySelector('[data-testid=count-running]')?.textContent?.trim()).toBe('2 running');
      expect(band.querySelector('[data-testid=count-waiting]')?.textContent?.trim()).toBe('1 waiting');
      expect(band.querySelector('[data-testid=project-branch]')).toBeNull();
      (band.querySelector('[data-testid=count-waiting]') as HTMLElement).click();
      expect(shell.openWaiting).toHaveBeenCalledWith('w1');
    });

    it('"Add a project…" is a ghost row at the bottom of the list', () => {
      two();
      const fixture = render();
      const list = el(fixture).querySelector('[data-testid=projects]') as HTMLElement;
      expect(list.lastElementChild?.getAttribute('data-testid')).toBe('add-project');
      expect(list.lastElementChild?.textContent).toContain('Add a project…');
    });
  });

  describe('Needs you', () => {
    const waits = (
      id: string,
      cwd: string,
      updatedAt: number,
      dialog: ThreadSummary['state']['dialog'],
      suggestions: ThreadSummary['state']['suggestions'] = [],
    ) =>
      thread(id, {
        title: `Thread ${id}`,
        cwd,
        updatedAt,
        state: idleState({ activity: 'waiting', question: `Question of ${id}?`, dialog, suggestions }),
      });

    it('is absent when nothing waits', () => {
      projects.set([project(workspace('/a'), [thread('t1')], 't1')]);
      expect(el(render()).querySelector('[data-testid=needs-you]')).toBeNull();
    });

    it('lists the waiting threads of every project, newest first, with the project and the question', () => {
      projects.set([
        project(workspace('/a'), [waits('w1', '/a', 100, { id: 'd1', method: 'confirm' }), thread('t0')], 't0'),
        project(workspace('/b'), [waits('w2', '/b', 300, { id: 'd2', method: 'select', options: ['Vitest', 'Jest'] })]),
      ]);
      const fixture = render();
      const items = el(fixture).querySelectorAll('[data-testid=needs-item]');
      expect(Array.from(items).map((i) => i.getAttribute('data-thread'))).toEqual(['w2', 'w1']);
      expect(items[0].querySelector('.p')?.textContent?.trim()).toBe('b');
      expect(items[0].querySelector('[data-testid=needs-question]')?.textContent?.trim()).toBe('Question of w2?');
      expect(
        Array.from(items[0].querySelectorAll('[data-testid=needs-answer]')).map((c) => c.textContent?.trim()),
      ).toEqual(['Vitest', 'Jest']);
      expect(
        Array.from(items[1].querySelectorAll('[data-testid=needs-answer]')).map((c) => c.textContent?.trim()),
      ).toEqual(['Allow', 'Deny']);
      expect(el(fixture).querySelector('[data-testid=needs-count]')?.textContent?.trim()).toBe('2 threads');
    });

    it('keeps every waiting thread actionable, including questions older than the fifth', async () => {
      const many = Array.from({ length: 7 }, (_, i) => waits(`w${i}`, '/a', i, { id: `d${i}`, method: 'confirm' }));
      projects.set([project(workspace('/a'), many)]);
      const fixture = render();
      expect(
        Array.from(el(fixture).querySelectorAll('[data-testid=needs-item]')).map((item) =>
          item.getAttribute('data-thread'),
        ),
      ).toEqual(['w6', 'w5', 'w4', 'w3', 'w2', 'w1', 'w0']);
      (
        el(fixture).querySelector(
          '[data-testid=needs-item][data-thread=w0] [data-testid=needs-answer]',
        ) as HTMLButtonElement
      ).click();
      await flush(fixture);
      expect(shell.answerWaiting).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'w0' }),
        'd0',
        { confirmed: true },
        undefined,
      );
      expect(opened).not.toHaveBeenCalled();
    });

    it('raises a clickable desktop notification for a new question and reveals its row when the thread was not selected', async () => {
      vi.useFakeTimers();
      const originalScroll = HTMLElement.prototype.scrollIntoView;
      const scroll = vi.fn();
      const notifications: FakeNotification[] = [];
      class FakeNotification {
        onclick: (() => void) | null = null;
        readonly close = vi.fn();
        constructor(
          readonly title: string,
          readonly options?: NotificationOptions,
        ) {
          notifications.push(this);
        }
      }
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
      vi.stubGlobal('Notification', FakeNotification);
      const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
      (window as unknown as { piKit?: object }).piKit = {};
      try {
        projects.set([
          project(workspace('/a'), [thread('t1'), waits('w1', '/a', 100, { id: 'd1', method: 'confirm' })], 't1'),
        ]);
        const fixture = render();
        expect(notifications).toHaveLength(1);
        expect(notifications[0].title).toBe('Needs you · Thread w1');
        expect(notifications[0].options?.body).toBe('Question of w1?\na');

        notifications[0].onclick?.();
        await vi.advanceTimersByTimeAsync(0);
        expect(shell.openWaiting).toHaveBeenCalledWith('w1');
        expect(opened).toHaveBeenLastCalledWith('w1');
        expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
        fixture.destroy();
      } finally {
        delete (window as unknown as { piKit?: object }).piKit;
        vi.unstubAllGlobals();
        focus.mockRestore();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          value: originalScroll,
        });
        vi.useRealTimers();
      }
    });

    it('publishes active threads to the system tray and opens the thread chosen there', () => {
      const setTrayThreads = vi.fn(async () => undefined);
      const stop = vi.fn();
      let openFromTray: ((threadId: string) => void) | undefined;
      (window as unknown as { piKit?: object }).piKit = {
        setTrayThreads,
        onTrayOpenThread: (callback: (threadId: string) => void) => {
          openFromTray = callback;
          return stop;
        },
      };
      try {
        selectedId.set('r1');
        projects.set([
          project(workspace('/a'), [thread('r1', { state: idleState({ activity: 'running' }) })], 'r1'),
          project(workspace('/b'), [waits('w1', '/b', 100, { id: 'd1', method: 'confirm' })]),
        ]);
        const fixture = render();
        const rows = [
          { id: 'r1', title: 'r1', project: 'a', state: 'running' },
          { id: 'w1', title: 'Thread w1', project: 'b', state: 'waiting' },
        ];
        expect(setTrayThreads).toHaveBeenLastCalledWith(
          rows,
          expect.objectContaining({ quit: 'Quit', needsYou: 'Needs you' }),
        );
        TestBed.inject(TranslocoService).setActiveLang('de');
        fixture.detectChanges();
        expect(setTrayThreads).toHaveBeenLastCalledWith(
          rows,
          expect.objectContaining({ quit: 'Beenden', needsYou: 'Braucht dich', runningThreads: 'Aktive Chats' }),
        );

        openFromTray?.('r1');
        expect(opened).toHaveBeenLastCalledWith('r1');
        fixture.destroy();
        expect(stop).toHaveBeenCalledTimes(1);
      } finally {
        TestBed.inject(TranslocoService).setActiveLang('en');
        delete (window as unknown as { piKit?: object }).piKit;
      }
    });

    it('a chip answers the dialog without opening the thread; the suggested one is marked accepted through the same call', async () => {
      const suggestion = { id: 5, kind: 'answer' as const, target: 'd1', text: 'Allow' };
      projects.set([project(workspace('/a'), [waits('w1', '/a', 100, { id: 'd1', method: 'confirm' }, [suggestion])])]);
      const fixture = render();
      const chips = Array.from(el(fixture).querySelectorAll<HTMLElement>('[data-testid=needs-answer]'));
      expect(chips[0].getAttribute('data-suggested')).toBe('true');
      chips[1].click();
      await flush(fixture);
      expect(shell.answerWaiting).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'w1' }),
        'd1',
        { confirmed: false },
        undefined,
      );
      chips[0].click();
      await flush(fixture);
      expect(shell.answerWaiting).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'w1' }),
        'd1',
        { confirmed: true },
        suggestion,
      );
      expect(opened).not.toHaveBeenCalled();
    });

    it('"Open" opens the thread at its question, and the title opens the thread', () => {
      projects.set([project(workspace('/a'), [waits('w1', '/a', 100, null)])]);
      const fixture = render();
      const chips = el(fixture).querySelectorAll<HTMLElement>('[data-testid=needs-answer]');
      expect(Array.from(chips).map((c) => c.textContent?.trim())).toEqual(['Open']);
      chips[0].click();
      expect(shell.openWaiting).toHaveBeenCalledWith('w1');
      expect(opened).toHaveBeenLastCalledWith('w1');
      (el(fixture).querySelector('[data-testid=needs-open]') as HTMLElement).click();
      expect(opened).toHaveBeenLastCalledWith('w1');
      expect(shell.answerWaiting).not.toHaveBeenCalled();
    });
  });

  describe('quick actions for the current project', () => {
    const settings = {
      root: null,
      base: null,
      setup: null,
      defaultRoot: '/w',
      git: true,
      start: 'local' as const,
      allowBranchSwitch: true,
      carryChanges: 'ask' as const,
      branchMode: 'named' as const,
      branchPrefix: 'pi-kit/',
      removeFolder: 'ask' as const,
      setupScripts: [],
    };
    const quick = (fixture: ReturnType<typeof render>, id: string) =>
      el(fixture).querySelector(`[data-testid=quick-${id}]`) as HTMLElement;

    it('shows the project (tile, name, branch) and the five buttons, none of them behind a hover', () => {
      projects.set([project(workspace('/a', { branch: 'feature/x', worktree: settings }), [thread('p1')], 'p1')]);
      const fixture = render();
      const strip = el(fixture).querySelector('[data-testid=quick-actions]') as HTMLElement;
      expect(strip.querySelector('.nm')?.textContent?.trim()).toBe('a');
      expect(strip.querySelector('.br')?.textContent?.trim()).toBe('feature/x');
      for (const id of ['worktree', 'terminal', 'editor', 'changes', 'settings'])
        expect(quick(fixture, id)).not.toBeNull();
    });

    it('the switcher lists the projects and opens the one chosen like ⌘1…9 does', () => {
      two();
      const fixture = render();
      const choices = Array.from(el(fixture).querySelectorAll<HTMLElement>('[data-testid=quick-switch-menu] button'));
      expect(choices.map((b) => b.getAttribute('data-project'))).toEqual(['a', 'b']);
      choices[1].click();
      expect(store.jumpToProject).toHaveBeenCalledWith(1);
    });

    it('the worktree button makes a worktree thread in the project (off for a folder that is not a repository)', async () => {
      store.create.mockResolvedValue(thread('n1') as never);
      projects.set([project(workspace('/a', { worktree: settings }), [thread('p1')], 'p1')]);
      let fixture = render();
      quick(fixture, 'worktree').click();
      await flush(fixture);
      expect(store.create).toHaveBeenLastCalledWith('/a');
      expect(newThread.preset).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'n1' }), 'worktree');
      store.create.mockClear();
      projects.set([project(workspace('/a', { worktree: { ...settings, git: false } }), [thread('p1')], 'p1')]);
      fixture = render();
      expect(quick(fixture, 'worktree').getAttribute('aria-disabled')).toBe('true');
      quick(fixture, 'worktree').click();
      await flush(fixture);
      expect(store.create).not.toHaveBeenCalled();
    });

    it('the terminal opens the Terminal panel; the changes button opens the Changes panel on the working tree and shows the count', async () => {
      selectedId.set('p1');
      projects.set([project(workspace('/a'), [thread('p1')], 'p1')]);
      changed.count.set(3);
      const fixture = render();
      expect(el(fixture).querySelector('[data-testid=quick-changes-count]')?.textContent?.trim()).toBe('3');
      const bus = TestBed.inject(UiStore);
      quick(fixture, 'terminal').click();
      await flush(fixture);
      expect(bus.panel()).toBe('terminal');
      quick(fixture, 'changes').click();
      await flush(fixture);
      expect(review.setSource).toHaveBeenCalledWith('worktree');
      expect(bus.panel()).toBe('changes');
    });

    it('the changes badge is absent at 0', () => {
      projects.set([project(workspace('/a'), [thread('p1')], 'p1')]);
      expect(el(render()).querySelector('[data-testid=quick-changes-count]')).toBeNull();
    });

    it('project settings opens Settings › Projects with the project’s folder', () => {
      projects.set([project(workspace('/a'), [thread('p1')], 'p1')]);
      const fixture = render();
      quick(fixture, 'settings').click();
      expect(TestBed.inject(UiStore).settings()).toEqual({ tab: 'projects', project: '/a' });
    });

    it('open in editor says "Desktop only" in a browser and does nothing; the desktop app opens the folder', async () => {
      projects.set([project(workspace('/a'), [thread('p1')], 'p1')]);
      let fixture = render();
      expect(quick(fixture, 'editor').getAttribute('aria-disabled')).toBe('true');
      quick(fixture, 'editor').click();
      await flush(fixture);
      expect(workspaceApi.openInEditor).not.toHaveBeenCalled();
      (window as unknown as { piKit?: object }).piKit = {};
      try {
        fixture = render();
        expect(quick(fixture, 'editor').getAttribute('aria-disabled')).toBe('false');
        quick(fixture, 'editor').click();
        await flush(fixture);
        expect(workspaceApi.openInEditor).toHaveBeenCalledWith('/a', '.');
      } finally {
        delete (window as unknown as { piKit?: object }).piKit;
      }
    });
  });

  describe('the rail', () => {
    it('has the "+", a tile per visible project with a dot while one runs or waits, the needs-you count and the expand button', () => {
      const waiting = thread('w1', {
        cwd: '/b',
        state: idleState({ activity: 'waiting', question: 'Ok?', dialog: { id: 'd1', method: 'confirm' } }),
      });
      projects.set([
        project(workspace('/a'), [thread('r1', { state: idleState({ activity: 'running' }) })], 'r1'),
        project(workspace('/b'), [waiting]),
        project(workspace('/c'), [thread('i1', { cwd: '/c' })]),
        project(workspace('/h', { hidden: true }), []),
      ]);
      const fixture = render();
      const tiles = Array.from(el(fixture).querySelectorAll('[data-testid=rail-project]'));
      expect(tiles.map((t) => t.getAttribute('data-project'))).toEqual(['a', 'b', 'c']);
      expect(tiles.map((t) => t.querySelector('[data-testid=rail-dot]')?.getAttribute('data-kind') ?? null)).toEqual([
        'run',
        'wait',
        null,
      ]);
      expect(el(fixture).querySelector('[data-testid=rail-needs]')?.textContent?.trim()).toBe('1');
      expect(el(fixture).querySelector('[data-testid=rail-new]')).not.toBeNull();
      expect(el(fixture).querySelector('[data-testid=rail-expand]')).not.toBeNull();
    });

    it('the needs-you tile is absent when nothing waits; a project tile opens the sidebar on that project (unfolded), the expand button just opens it', async () => {
      two();
      document.documentElement.dataset['sidebar'] = 'collapsed';
      const fixture = render();
      const prefs = TestBed.inject(ViewPrefs);
      await prefs.set('sidebarCollapsed', true);
      expect(el(fixture).querySelector('[data-testid=rail-needs]')?.textContent?.trim()).toBe('1');
      (el(fixture).querySelectorAll('[data-testid=rail-project]')[1] as HTMLElement).click();
      await flush(fixture);
      expect(store.setCollapsed).toHaveBeenCalledWith('/b', false);
      expect(prefs.sidebarCollapsed()).toBe(false);
      await prefs.set('sidebarCollapsed', true);
      (el(fixture).querySelector('[data-testid=rail-expand]') as HTMLElement).click();
      await flush(fixture);
      expect(prefs.sidebarCollapsed()).toBe(false);
    });
  });

  it('the right edge resizes the sidebar: a drag saves once at the end, arrows step, a double-click resets', async () => {
    const fixture = render();
    const prefs = TestBed.inject(ViewPrefs);
    const edge = el(fixture).querySelector<HTMLElement>('[data-testid=sidebar-resize]') as HTMLElement;
    edge.dispatchEvent(new MouseEvent('pointerdown', { clientX: 280, button: 0, bubbles: true }));
    edge.dispatchEvent(new MouseEvent('pointermove', { clientX: 340, bubbles: true }));
    fixture.detectChanges();
    expect(prefs.sidebarWidth()).toBe(340);
    expect(edge.getAttribute('aria-valuenow')).toBe('340');
    expect(uiSettings.set).not.toHaveBeenCalled();
    edge.dispatchEvent(new MouseEvent('pointerup', { clientX: 340, bubbles: true }));
    expect(uiSettings.set).toHaveBeenCalledExactlyOnceWith('sidebarWidth', 340);

    edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(prefs.sidebarWidth()).toBe(324);
    edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(prefs.sidebarWidth()).toBe(SIDEBAR_WIDTH.max);
    edge.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(prefs.sidebarWidth()).toBe(SIDEBAR_WIDTH.default);
  });
});
