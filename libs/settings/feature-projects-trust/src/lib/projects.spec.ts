import { english } from '@pi-kit/i18n/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ProjectGit, SetupScript, TrustState, Workspace, WorktreeSettings } from '@pi-kit/protocol';
import { ScoreStore, ThreadsStore } from '@pi-kit/threads/api';
import { ProjectPageStore, SettingsStore } from '@pi-kit/settings/data';
import { settingsCatalog } from '@pi-kit/ui';
import { type OpenWorktreeRow, baseOptions } from '@pi-kit/settings/util';
import { ProjectPage } from './project-page';
import { ProjectsSection } from './projects-section';

const settings = (over: Partial<WorktreeSettings> = {}): WorktreeSettings => ({
  root: null,
  base: null,
  setup: null,
  defaultRoot: '/home/me/.pi-kit/worktrees',
  git: true,
  start: 'worktree',
  allowBranchSwitch: true,
  carryChanges: 'ask',
  branchMode: 'named',
  branchPrefix: 'pi-kit/',
  removeFolder: 'ask',
  setupScripts: [
    { id: 'node', name: 'Node', command: 'npm ci', copy: ['.env.local'] },
    { id: 'full', name: 'Full', command: 'npm ci && npx playwright install chromium' },
  ],
  ...over,
});
const workspace = (cwd: string, over: Partial<Workspace> = {}): Workspace => ({
  cwd,
  name: cwd.split('/').pop() as string,
  lastOpenedAt: 0,
  threadCount: 3,
  collapsed: false,
  hidden: false,
  attendant: true,
  agents: false,
  branch: 'main',
  worktree: settings(),
  ...over,
});
const trust = (cwd: string, over: Partial<TrustState> = {}): TrustState => ({
  cwd,
  hasResources: true,
  status: 'trusted',
  source: 'saved',
  resources: [
    { kind: 'skill', path: '.pi/skills/a/SKILL.md' },
    { kind: 'extension', path: '.pi/extensions/x.ts' },
  ],
  ...over,
});

const KIT = '/home/me/pi-kit';
const SPEC = '/home/me/form-api-spec';
const NOTES = '/home/me/notes';
const PROJECT_IDS = settingsCatalog(english)
  .filter((e) => e.section === 'projects')
  .map((e) => e.id);

describe('Settings › Projects', () => {
  const project = signal<string | undefined>(undefined);
  const searching = signal(false);
  const workspaces = signal<Workspace[]>([]);
  const folders = signal<Record<string, TrustState>>({});
  const store = {
    project,
    searching,
    workspaces,
    folders,
    settings: signal({ defaultProjectTrust: 'ask' }),
    matches: signal(new Set(PROJECT_IDS)),
    shows: (...ids: string[]) => ids.some((id) => store.matches().has(id)),
    patch: vi.fn(),
    save: vi.fn(async (work: () => Promise<unknown>) => work()),
    openProject: vi.fn((cwd: string) => project.set(cwd)),
    closeProject: vi.fn(() => project.set(undefined)),
    reviewFolder: vi.fn(async () => undefined),
  };
  const threads = {
    threads: signal([
      { id: 't1', cwd: KIT, worktree: { path: '/w/1', branch: 'a', base: 'main', exists: true } },
      { id: 't2', cwd: KIT, worktree: { path: '/w/2', branch: 'b', base: 'main', exists: true } },
    ]),
    moveProject: vi.fn(async () => undefined),
    openWorkspace: vi.fn(async () => undefined),
  };
  const score = { overview: signal(undefined), loadOverview: vi.fn(async () => undefined) };

  // The page store as the components see it.
  const scripts = signal<SetupScript[]>([]);
  const rows = signal<OpenWorktreeRow[]>([]);
  const editing = signal<{ id: string | null; name: string; command: string; copy: string } | undefined>(undefined);
  const confirming = signal<unknown>(undefined);
  const trustState = signal<TrustState | undefined>(undefined);
  const git: Pick<ProjectGit, 'branches' | 'remoteBranches'> = {
    branches: [
      { name: 'main', current: true, heldBy: null },
      { name: 'develop', current: false, heldBy: null },
    ],
    remoteBranches: ['origin/main'],
  };
  const page = {
    defaults: signal({ root: null, defaultRoot: '/home/me/.pi-kit/worktrees', start: 'worktree' }),
    loadDefaults: vi.fn(async () => undefined),
    saveDefaults: vi.fn(),
    workspace: signal<Workspace | undefined>(undefined),
    worktree: signal<WorktreeSettings | undefined>(undefined),
    trust: trustState,
    scripts,
    rows,
    baseOptions: signal(baseOptions(english, git, null)),
    worktreesLoading: signal(false),
    editing,
    editError: signal<string | undefined>(undefined),
    confirming,
    save: vi.fn(async () => undefined),
    setShown: vi.fn(),
    setTrusted: vi.fn(),
    addScript: vi.fn(() => editing.set({ id: null, name: '', command: '', copy: '' })),
    editScript: vi.fn(),
    cancelScript: vi.fn(() => editing.set(undefined)),
    setDraft: vi.fn(),
    saveScript: vi.fn(async () => true),
    makeDefaultScript: vi.fn(),
    removeScript: vi.fn(),
    handoff: vi.fn(),
    mergeBack: vi.fn(),
    askRemove: vi.fn(),
    removeFolder: vi.fn(),
    cancelConfirm: vi.fn(),
    askForget: vi.fn(),
    forget: vi.fn(),
  };

  const el = (f: { nativeElement: unknown }): HTMLElement => f.nativeElement as HTMLElement;
  const click = (root: HTMLElement, selector: string): void => (root.querySelector(selector) as HTMLElement).click();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    project.set(undefined);
    searching.set(false);
    store.matches.set(new Set(PROJECT_IDS));
    workspaces.set([
      workspace(KIT, { threadCount: 31 }),
      workspace(SPEC, { branch: 'master', hidden: true, worktree: settings({ start: 'ask', setupScripts: [] }) }),
      workspace(NOTES, { branch: null, worktree: settings({ git: false }) }),
    ]);
    folders.set({
      [KIT]: trust(KIT),
      [SPEC]: trust(SPEC, { status: 'ask' }),
      [NOTES]: trust(NOTES, { hasResources: false, resources: [] }),
    });
    scripts.set(settings().setupScripts);
    rows.set([]);
    editing.set(undefined);
    confirming.set(undefined);
    trustState.set(trust(KIT));
    page.workspace.set(workspace(KIT));
    page.worktree.set(settings());
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: ProjectPageStore, useValue: page },
        { provide: ThreadsStore, useValue: threads },
        { provide: ScoreStore, useValue: score },
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  describe('the list', () => {
    const render = () => {
      const f = TestBed.createComponent(ProjectsSection);
      f.detectChanges();
      return f;
    };

    it('has a row for every project with its trust chip, branch, path, counts and where a thread starts', () => {
      const f = render();
      const items = Array.from(el(f).querySelectorAll('[data-testid=projects-list] .pk-item'));
      expect(items.map((i) => i.getAttribute('data-project'))).toEqual(['pi-kit', 'form-api-spec', 'notes']);
      const kit = el(f).querySelector('[data-testid=project-pi-kit]') as HTMLElement;
      expect(Array.from(kit.querySelectorAll('.nm .chip')).map((c) => c.textContent?.trim())).toEqual([
        'trusted',
        'main',
      ]);
      expect(kit.querySelector('.ds')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        '~/pi-kit· 31 threads· 2 worktrees· starts in a worktree· setup Node',
      );
      const spec = el(f).querySelector('[data-testid=project-form-api-spec]') as HTMLElement;
      expect(Array.from(spec.querySelectorAll('.nm .chip')).map((c) => c.textContent?.trim())).toEqual([
        'waiting',
        'master',
        'hidden',
      ]);
      expect(spec.classList.contains('off')).toBe(true);
      expect(
        Array.from(
          (el(f).querySelector('[data-testid=project-notes]') as HTMLElement).querySelectorAll('.nm .chip'),
        ).map((c) => c.textContent?.trim()),
      ).toEqual(['nothing to trust', 'not git']);
    });

    it('opens a project’s page from its row, and from the chevron by keyboard', () => {
      const f = render();
      click(el(f), '[data-testid=project-pi-kit]');
      expect(store.openProject).toHaveBeenCalledWith(KIT);
      store.openProject.mockClear();
      click(el(f), '[data-testid=open-project-notes]');
      expect(store.openProject).toHaveBeenCalledWith(NOTES);
    });

    it('shows the page instead of the list while one is open', () => {
      const f = render();
      project.set(KIT);
      f.detectChanges();
      expect(el(f).querySelector('[data-testid=projects-list]')).toBeNull();
      expect(el(f).querySelector('pk-project-page')).not.toBeNull();
      // a search shows the matching settings (the list) over the page
      searching.set(true);
      f.detectChanges();
      expect(el(f).querySelector('pk-project-page')).toBeNull();
    });

    it('moves a project when a row is dropped on another, and one place with Alt+arrow', () => {
      const f = render();
      const row = (name: string) => el(f).querySelector(`[data-testid=project-${name}]`) as HTMLElement;
      row('notes').dispatchEvent(new Event('dragstart', { bubbles: true }));
      const over = new Event('dragover', { bubbles: true, cancelable: true });
      row('pi-kit').dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      row('pi-kit').dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      expect(threads.moveProject).toHaveBeenCalledWith(NOTES, KIT);
      threads.moveProject.mockClear();
      const key = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true });
      (el(f).querySelector('[data-testid=open-project-form-api-spec]') as HTMLElement).dispatchEvent(key);
      expect(threads.moveProject).toHaveBeenCalledWith(SPEC, KIT);
      // the first project cannot go up
      threads.moveProject.mockClear();
      (el(f).querySelector('[data-testid=open-project-pi-kit]') as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }),
      );
      expect(threads.moveProject).not.toHaveBeenCalled();
    });

    it('adds a folder: the picker of the desktop app when there is one, else the path is typed', async () => {
      const f = render();
      click(el(f), '[data-testid=add-project]');
      f.detectChanges();
      const input = el(f).querySelector('[data-testid=add-project-path]') as HTMLInputElement;
      expect(input).not.toBeNull();
      input.value = '/home/me/new';
      input.dispatchEvent(new Event('input'));
      f.detectChanges();
      click(el(f), '[data-testid=add-project-submit]');
      await vi.runAllTimersAsync();
      expect(threads.openWorkspace).toHaveBeenCalledWith('/home/me/new');
      f.detectChanges();
      expect(el(f).querySelector('[data-testid=add-project-form]')).toBeNull();

      (window as unknown as { piKit: unknown }).piKit = { showOpenDialog: vi.fn(async () => '/picked') };
      click(el(f), '[data-testid=add-project]');
      await vi.runAllTimersAsync();
      expect(threads.openWorkspace).toHaveBeenLastCalledWith('/picked');
      delete (window as unknown as { piKit?: unknown }).piKit;
    });

    it('has the defaults for every project in the control column, and saves a change', () => {
      const f = render();
      const group = el(f).querySelector('[data-testid=project-defaults]') as HTMLElement;
      expect(Array.from(group.querySelectorAll('.row > .ctl')).every((c) => c.classList.contains('ctl-w'))).toBe(true);
      const start = group.querySelector('[data-testid=default-start]') as HTMLSelectElement;
      expect(start.value).toBe('worktree');
      start.value = 'ask';
      start.dispatchEvent(new Event('change'));
      expect(page.saveDefaults).toHaveBeenCalledWith({ start: 'ask' });
      const root = group.querySelector('[data-testid=default-worktree-root]') as HTMLInputElement;
      root.value = '/srv/wt';
      root.dispatchEvent(new Event('change'));
      expect(page.saveDefaults).toHaveBeenCalledWith({ root: '/srv/wt' });
      const trustSelect = group.querySelector('[data-testid=default-trust]') as HTMLSelectElement;
      trustSelect.value = 'never';
      trustSelect.dispatchEvent(new Event('change'));
      expect(store.patch).toHaveBeenCalledWith({ defaultProjectTrust: 'never' });
    });

    it('tells a search that found only a project’s own settings to open a project', () => {
      store.matches.set(new Set(['project-carry']));
      searching.set(true);
      const f = render();
      expect(el(f).querySelector('[data-testid=projects-list] header p')?.textContent).toContain('on a project’s page');
      expect(el(f).querySelector('[data-testid=project-defaults]')).toBeNull();
    });
  });

  describe('a project’s page', () => {
    const render = () => {
      project.set(KIT);
      const f = TestBed.createComponent(ProjectPage);
      f.detectChanges();
      return f;
    };

    it('has the groups of the mockup, every row in the control column, and no control with a width of its own', () => {
      rows.set([]);
      const f = render();
      expect(Array.from(el(f).querySelectorAll('section.pk-group')).map((s) => s.getAttribute('aria-label'))).toEqual([
        'Trust',
        'New threads',
        'Worktrees',
        'Setup scripts',
        'Open worktrees',
        'Sidebar',
      ]);
      expect(el(f).querySelector('.pk-path button')?.textContent?.trim()).toBe('Projects');
      expect(el(f).querySelector('.pk-path [aria-current=page]')?.textContent).toBe('pi-kit');
      const rowsOfGroups = Array.from(el(f).querySelectorAll('.pk-group .row'));
      expect(rowsOfGroups.length).toBeGreaterThan(8);
      for (const row of rowsOfGroups)
        expect(row.querySelector(':scope > .ctl.ctl-w'), row.textContent ?? '').not.toBeNull();
      expect(
        el(f).querySelector('[class*="w-36"], [class*="w-44"], [class*="w-56"], [class*="w-64"], [class*="w-72"]'),
      ).toBeNull();
    });

    it('Trust: the switch trusts and remembers, Review resources opens the existing dialog, a folder with nothing to trust has neither', () => {
      const f = render();
      expect(el(f).querySelector('[data-testid=project-trust-hint]')?.textContent).toBe(
        '2 resources: 1 skill, 1 extension. Saved answer.',
      );
      const toggle = el(f).querySelector('[data-testid=project-trusted]') as HTMLInputElement;
      expect(toggle.checked).toBe(true);
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      expect(page.setTrusted).toHaveBeenCalledWith(false);
      click(el(f), '[data-testid=project-review]');
      expect(store.reviewFolder).toHaveBeenCalledWith(KIT);

      trustState.set(trust(KIT, { hasResources: false, resources: [] }));
      f.detectChanges();
      expect(el(f).querySelector('[data-testid=project-review]')).toBeNull();
      expect((el(f).querySelector('[data-testid=project-trusted]') as HTMLInputElement).disabled).toBe(true);
    });

    it('New threads and Worktrees: each control saves its own field', () => {
      const f = render();
      expect((el(f).querySelector('[data-testid=project-start-worktree]') as HTMLInputElement).checked).toBe(true);
      const radio = el(f).querySelector('[data-testid=project-start-ask]') as HTMLInputElement;
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
      expect(page.save).toHaveBeenLastCalledWith({ start: 'ask' });

      const toggle = el(f).querySelector('[data-testid=project-switch]') as HTMLInputElement;
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      expect(page.save).toHaveBeenLastCalledWith({ allowBranchSwitch: false });

      const base = el(f).querySelector('[data-testid=project-base]') as HTMLSelectElement;
      expect(Array.from(base.options).map((o) => o.textContent?.trim())).toEqual([
        'the checked-out branch',
        'main',
        'develop',
        'origin/main (fetch first)',
      ]);
      base.value = 'develop';
      base.dispatchEvent(new Event('change'));
      expect(page.save).toHaveBeenLastCalledWith({ base: 'develop' });
      base.value = '';
      base.dispatchEvent(new Event('change'));
      expect(page.save).toHaveBeenLastCalledWith({ base: null });

      for (const [id, field, value] of [
        ['project-carry', 'carryChanges', 'always'],
        ['project-remove', 'removeFolder', 'after-7-days'],
        ['project-branch', 'branchMode', 'detached'],
      ] as const) {
        const select = el(f).querySelector(`[data-testid=${id}]`) as HTMLSelectElement;
        select.value = value;
        select.dispatchEvent(new Event('change'));
        expect(page.save).toHaveBeenLastCalledWith({ [field]: value });
      }
      const prefix = el(f).querySelector('[data-testid=project-prefix]') as HTMLInputElement;
      expect(prefix.value).toBe('pi-kit/');
      prefix.value = 'feat/';
      prefix.dispatchEvent(new Event('change'));
      expect(page.save).toHaveBeenLastCalledWith({ branchPrefix: 'feat/' });
      const root = el(f).querySelector('[data-testid=project-root]') as HTMLInputElement;
      expect(root.placeholder).toBe('~/.pi-kit/worktrees');
    });

    it('a detached worktree has no prefix to type', () => {
      page.worktree.set(settings({ branchMode: 'detached' }));
      page.workspace.set(workspace(KIT, { worktree: settings({ branchMode: 'detached' }) }));
      const f = render();
      expect(el(f).querySelector('[data-testid=project-prefix]')).toBeNull();
    });

    it('a folder that is not a repository has Trust and Sidebar, and a line that says why the rest is missing', () => {
      page.workspace.set(workspace(NOTES, { branch: null, worktree: settings({ git: false }) }));
      const f = render();
      expect(Array.from(el(f).querySelectorAll('section.pk-group')).map((s) => s.getAttribute('aria-label'))).toEqual([
        'Trust',
        'New threads and worktrees',
        'Sidebar',
      ]);
    });

    it('Back slides the page out and closes it; with reduced motion at once', () => {
      const f = render();
      click(el(f), '[data-testid=project-back]');
      f.detectChanges();
      expect(el(f).querySelector('.pk-detail')?.classList.contains('leaving')).toBe(true);
      expect(store.closeProject).not.toHaveBeenCalled();
      vi.advanceTimersByTime(200);
      expect(store.closeProject).toHaveBeenCalledTimes(1);

      const reduced = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
      store.closeProject.mockClear();
      click(el(f), '[data-testid=project-back]');
      expect(store.closeProject).toHaveBeenCalledTimes(1);
      reduced.mockRestore();
    });

    it('Sidebar: the switch shows or hides, and Forget asks first', () => {
      const f = render();
      const shown = el(f).querySelector('[data-testid=project-shown]') as HTMLInputElement;
      shown.checked = false;
      shown.dispatchEvent(new Event('change'));
      expect(page.setShown).toHaveBeenCalledWith(false);
      click(el(f), '[data-testid=forget-project]');
      expect(page.askForget).toHaveBeenCalled();
      confirming.set({ kind: 'forget' });
      f.detectChanges();
      expect(el(f).querySelector('[data-testid=forget-project]')).toBeNull();
      click(el(f), '[data-testid=forget-confirm]');
      expect(page.forget).toHaveBeenCalled();
    });

    describe('the setup scripts', () => {
      it('lists them with the first as the default, the suggested one marked, and an action per row', () => {
        page.worktree.set(settings({ setupSuggested: true }));
        const f = render();
        const items = Array.from(el(f).querySelectorAll('[data-testid=project-scripts] .pk-item'));
        expect(items.map((i) => i.querySelector('.nm')?.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
          'Node defaultsuggested',
          'Full',
        ]);
        expect(items[0]?.querySelector('.ds')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
          'npm ci· copies .env.local',
        );
        expect(items[0]?.querySelector('[data-testid=script-default-node]')).toBeNull();
        click(el(f), '[data-testid=script-default-full]');
        expect(page.makeDefaultScript).toHaveBeenCalledWith('full');
        click(el(f), '[data-testid=script-edit-full]');
        expect(page.editScript).toHaveBeenCalledWith('full');
        click(el(f), '[data-testid=script-remove-node]');
        expect(page.removeScript).toHaveBeenCalledWith('node');
      });

      it('opens the form under the row being edited, and a new one under the list', () => {
        const f = render();
        editing.set({ id: 'full', name: 'Full', command: 'make full', copy: '' });
        f.detectChanges();
        const forms = el(f).querySelectorAll('[data-testid=script-form]');
        expect(forms).toHaveLength(1);
        expect(forms[0]?.closest('.pk-item')?.getAttribute('data-testid')).toBe('script-full');
        expect((el(f).querySelector('[data-testid=script-name]') as HTMLInputElement).value).toBe('Full');

        editing.set({ id: null, name: '', command: '', copy: '' });
        f.detectChanges();
        expect(el(f).querySelectorAll('[data-testid=script-form]')).toHaveLength(1);
        expect(el(f).querySelector('[data-testid=script-form]')?.closest('.pk-item')).toBeNull();
        expect(el(f).querySelector('[data-testid=script-save]')?.textContent?.trim()).toBe('Add script');
      });

      it('types into the draft, saves with the button or Enter, and cancels with Escape', () => {
        const f = render();
        click(el(f), '[data-testid=add-script]');
        f.detectChanges();
        const name = el(f).querySelector('[data-testid=script-name]') as HTMLInputElement;
        name.value = 'Docs';
        name.dispatchEvent(new Event('input'));
        expect(page.setDraft).toHaveBeenLastCalledWith({ name: 'Docs' });
        const copy = el(f).querySelector('[data-testid=script-copy]') as HTMLTextAreaElement;
        copy.value = '.env\nconfig.json';
        copy.dispatchEvent(new Event('input'));
        expect(page.setDraft).toHaveBeenLastCalledWith({ copy: '.env\nconfig.json' });
        (el(f).querySelector('[data-testid=script-form]') as HTMLFormElement).dispatchEvent(
          new Event('submit', { cancelable: true }),
        );
        expect(page.saveScript).toHaveBeenCalled();
        (el(f).querySelector('[data-testid=script-form]') as HTMLFormElement).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        expect(page.cancelScript).toHaveBeenCalled();
      });

      it('says what is wrong with a draft, and invites the first script when there is none', () => {
        page.scripts.set([]);
        const f = render();
        expect(el(f).querySelector('[data-testid=scripts-empty]')).not.toBeNull();
        page.editError.set('Give the script a name.');
        editing.set({ id: null, name: '', command: '', copy: '' });
        f.detectChanges();
        expect(el(f).querySelector('[data-testid=scripts-empty]')).toBeNull();
        expect(el(f).querySelector('[data-testid=script-error]')?.textContent).toBe('Give the script a name.');
        page.editError.set(undefined);
      });
    });

    describe('the open worktrees', () => {
      const row = (over: Partial<OpenWorktreeRow> = {}): OpenWorktreeRow => ({
        threadId: 't1',
        branch: 'pi-kit/settings-ux',
        detached: false,
        title: 'Settings v2 proposal',
        state: { text: 'idle', tone: 'off' },
        ahead: 14,
        base: 'main',
        path: '/home/me/.pi-kit/worktrees/pi-kit/settings-ux',
        archived: false,
        busy: false,
        merged: false,
        ...over,
      });

      it('has a row per worktree with the branch, state, thread, commits ahead and the three actions', () => {
        rows.set([
          row(),
          row({
            threadId: 't2',
            branch: 'detached',
            detached: true,
            title: 'Loose idea',
            ahead: null,
            state: { text: 'running', tone: 'ok' },
            busy: true,
          }),
        ]);
        const f = render();
        const items = Array.from(el(f).querySelectorAll('[data-testid=project-open-worktrees] .pk-item'));
        expect(items).toHaveLength(2);
        expect(items[0]?.querySelector('[data-testid=worktree-branch]')?.textContent).toBe('pi-kit/settings-ux');
        expect(items[0]?.querySelector('[data-testid=worktree-state]')?.textContent).toBe('idle');
        expect(items[0]?.querySelector('[data-testid=worktree-thread]')?.textContent).toBe(
          'Thread “Settings v2 proposal”',
        );
        expect(items[0]?.querySelector('[data-testid=worktree-ahead]')?.textContent).toContain(
          '14 commits ahead of main',
        );
        expect(items[1]?.querySelector('[data-testid=worktree-ahead]')).toBeNull();
        // a thread that runs cannot have its folder moved or removed
        expect((el(f).querySelector('[data-testid=handoff-t2]') as HTMLButtonElement).disabled).toBe(true);
        expect((el(f).querySelector('[data-testid=handoff-t1]') as HTMLButtonElement).disabled).toBe(false);
      });

      it('Hand off to local and Merge back open the thread’s dialogs; Remove folder asks first', () => {
        rows.set([row()]);
        const f = render();
        click(el(f), '[data-testid=handoff-t1]');
        expect(page.handoff).toHaveBeenCalledWith('t1');
        click(el(f), '[data-testid=merge-t1]');
        expect(page.mergeBack).toHaveBeenCalledWith('t1');
        click(el(f), '[data-testid=remove-folder-t1]');
        expect(page.askRemove).toHaveBeenCalledWith('t1');
        confirming.set({ kind: 'remove', threadId: 't1', force: false });
        f.detectChanges();
        expect(el(f).querySelector('[data-testid=remove-confirm]')?.textContent).toContain(
          'The thread carries on in the project folder',
        );
        click(el(f), '[data-testid=remove-confirm-yes]');
        expect(page.removeFolder).toHaveBeenCalled();
        confirming.set({
          kind: 'remove',
          threadId: 't1',
          force: true,
          message: 'The worktree has 2 uncommitted changes.',
        });
        f.detectChanges();
        expect(el(f).querySelector('[data-testid=remove-confirm]')?.textContent).toContain('2 uncommitted changes');
        expect(el(f).querySelector('[data-testid=remove-confirm-yes]')?.textContent?.trim()).toBe('Remove anyway');
      });

      it('says there is none when the project has no worktree', () => {
        const f = render();
        expect(el(f).querySelector('[data-testid=worktrees-empty]')?.textContent).toContain('No open worktrees');
      });
    });
  });
});
