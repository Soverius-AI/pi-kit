import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatStore } from '@pi-kit/chat/api';
import { DialogStore, UiStore } from '@pi-kit/data-access';
import type { PackageItem, ResourceItem, ResourcesOverview } from '@pi-kit/protocol';
import { PackagesStore, SettingsStore } from '@pi-kit/settings/api';
import { LearnStore, LearnedStore } from '@pi-kit/threads/api';
import { ExtensionsSection } from './extensions-section';
import { InstallSkillDialog } from './install-skill-dialog';
import { DeleteSkillDialog } from './delete-skill-dialog';

const brings = (extensions = 0, skills = 0, prompts = 0, themes = 0) => ({
  extensions,
  skills,
  prompts,
  themes,
  names: { extensions: [], skills: [], prompts: [], themes: [] },
});
const pkg = (over: Partial<PackageItem> & { name: string }): PackageItem => ({
  id: `user:npm:${over.name}`,
  source: `npm:${over.name}`,
  scope: 'user',
  origin: 'npm',
  enabled: true,
  installed: true,
  brings: brings(1),
  ...over,
});
const res = (over: Partial<ResourceItem> & { name: string; type: ResourceItem['type'] }): ResourceItem => ({
  key: `${over.type}:user:${over.name}`,
  path: `/u/${over.name}`,
  enabled: true,
  scope: 'user',
  origin: 'top-level',
  source: 'local',
  label: 'User (~/.pi/agent)',
  ...over,
});

describe('Extensions and Skills sections', () => {
  const resources = signal<ResourcesOverview | undefined>(undefined);
  const settings = {
    shows: () => true,
    search: () => '',
    resources,
    resourcesBusy: signal<string[]>([]),
    reloading: () => false,
    canReload: () => true,
    reload: vi.fn(),
    toggleResource: vi.fn(),
    settings: signal<{ enableSkillCommands: boolean; agentDir?: string } | undefined>(undefined),
    matches: () => new Set(['skill-commands']),
    patch: vi.fn(),
    markReload: vi.fn(),
  };
  const items = signal<PackageItem[]>([]);
  const overview = signal<{ packages: PackageItem[]; errors: string[] } | undefined>(undefined);
  const pkgs = {
    overview,
    packages: computed(() => items()),
    loading: signal(false),
    checking: signal(false),
    busy: signal(new Set<string>()),
    wizard: signal(false),
    error: signal<string | undefined>(undefined),
    cwd: () => '/proj' as string | undefined,
    load: vi.fn(async () => undefined),
    checkForUpdates: vi.fn(),
    openWizard: vi.fn(),
    closeWizard: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    setEnabled: vi.fn(),
    skillFile: vi.fn(() => new Promise(() => undefined)),
    search: vi.fn(async () => ({ results: [], total: 0 })),
    detail: vi.fn(),
    install: vi.fn(),
  };
  const chat = { threadId: () => 't1' as string | undefined, addChip: vi.fn() };
  const ui = { closeSettings: vi.fn(), focusComposer: vi.fn() };

  const render = (section: 'extensions' | 'skills' = 'extensions') => {
    const fixture = TestBed.createComponent(ExtensionsSection);
    fixture.componentRef.setInput('section', section);
    fixture.detectChanges();
    return fixture;
  };
  const el = (f: { nativeElement: unknown }): HTMLElement => f.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(f: { nativeElement: unknown }, selector: string): T | null =>
    el(f).querySelector<T>(selector);

  beforeEach(() => {
    vi.clearAllMocks();
    settings.settings.set(undefined);
    items.set([
      pkg({
        name: 'pi-subagents',
        version: '0.4.0',
        brings: brings(2, 3),
        installedAt: Date.UTC(2026, 9, 3, 12),
        outdated: { current: '0.4.0', latest: '0.5.0' },
      }),
      pkg({
        name: 'git-guard',
        id: 'user:git:github.com/x/git-guard',
        source: 'git:github.com/x/git-guard',
        origin: 'git',
        enabled: false,
      }),
      pkg({
        name: '@pi-kit/learn',
        id: 'user:../pi-kit-learn',
        source: '../pi-kit-learn',
        origin: 'bundled',
        path: '/app/packages/pi-kit-learn',
        version: '0.1.0',
      }),
    ]);
    overview.set({ packages: items(), errors: [] });
    resources.set({
      items: [
        res({
          name: 'angular-developer',
          type: 'skills',
          description: 'Angular 22 signals',
          path: '/u/skills/angular-developer/SKILL.md',
        }),
        res({ name: 'pk-beta', type: 'skills', scope: 'project', label: 'Project (.pi/)', enabled: false }),
        res({
          name: 'split-task',
          type: 'skills',
          origin: 'package',
          source: 'npm:pi-subagents',
          label: 'npm:pi-subagents',
        }),
        res({
          name: 'subagents',
          type: 'extensions',
          origin: 'package',
          source: 'npm:pi-subagents',
          label: 'npm:pi-subagents',
        }),
        res({ name: 'worktree-guard', type: 'extensions', description: undefined }),
        res({ name: 'review', type: 'prompts' }),
        res({ name: 'builtin-x', type: 'extensions', origin: 'builtin', source: 'builtin' }),
      ],
      projectSkipped: false,
      errors: [],
    });
    pkgs.wizard.set(false);
    pkgs.busy.set(new Set());
    pkgs.skillFile.mockReset();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsStore, useValue: settings },
        { provide: PackagesStore, useValue: pkgs },
        { provide: ChatStore, useValue: chat },
        { provide: UiStore, useValue: ui },
        // 10d's learned-skill component under each skill row: its stores are stubbed so no thread shell is needed here.
        {
          provide: LearnedStore,
          useValue: {
            live: () => [],
            retired: () => [],
            busy: signal({}),
            errors: signal({}),
            load: async () => undefined,
            reverify: async () => undefined,
            retire: async () => true,
            restore: async () => true,
            stopVerify: async () => undefined,
          },
        },
        { provide: LearnStore, useValue: { edit: async () => undefined } },
      ],
    });
  });

  it('links the active tab to the section while preserving manual selection within a section', () => {
    settings.settings.set({ enableSkillCommands: true });
    const f = render('skills');
    const active = () => q(f, '[role=tab][aria-selected=true]')?.textContent?.trim();
    expect(active()).toBe('Library');
    Array.from(el(f).querySelectorAll<HTMLButtonElement>('[role=tab]'))
      .find((b) => b.textContent?.trim() === 'Commands')
      ?.click();
    f.detectChanges();
    expect(active()).toBe('Commands');
    f.detectChanges();
    expect(active()).toBe('Commands');
    f.componentRef.setInput('section', 'extensions');
    f.detectChanges();
    expect(active()).toBe('Packages');
    f.componentRef.setInput('section', 'skills');
    f.detectChanges();
    expect(active()).toBe('Library');
    expect(pkgs.load).not.toHaveBeenCalled();
  });

  it('renders packages and extension files without owning package loading', () => {
    const f = render();
    expect(Array.from(el(f).querySelectorAll('.pk-group > header h4')).map((h) => h.textContent)).toEqual([
      'Packages',
      'Your extensions and prompts',
    ]);
    expect(pkgs.load).not.toHaveBeenCalled();
    expect(q(f, '[data-testid=skills-group]')).toBeNull();
    expect(q(f, 'pk-learned-retired')).toBeNull();
  });

  it('keeps skill controls and retired skills on Skills without package or extension groups', () => {
    const f = render('skills');
    expect(q(f, '[data-testid=section-skills]')).not.toBeNull();
    expect(q(f, '[data-testid=skills-group]')).not.toBeNull();
    expect(q(f, 'pk-learned-retired')).not.toBeNull();
    expect(q(f, '[data-testid=packages-group]')).toBeNull();
    expect(q(f, '[data-testid=files-group]')).toBeNull();
    expect(pkgs.load).not.toHaveBeenCalled();
  });

  it('saves skill slash commands from Skills, and keeps the control out of Extensions', () => {
    settings.settings.set({ enableSkillCommands: false });
    const skills = render('skills');
    const toggle = q<HTMLInputElement>(skills, '[aria-labelledby=lbl-skill-commands]') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(settings.patch).toHaveBeenCalledWith({ enableSkillCommands: true }, 'skills');
    skills.destroy();
    const extensions = render();
    expect(q(extensions, '[aria-labelledby=lbl-skill-commands]')).toBeNull();
  });

  it('a package row says on/off, where it is from, what it brings and when it was installed, with the outdated chip and Update', () => {
    const f = render();
    const row = q(f, '[data-testid=package-pi-subagents]') as HTMLElement;
    expect(row.querySelector('.nm')?.textContent).toContain('pi-subagents');
    expect(row.querySelector('.nm .chip.ok')?.textContent).toBe('on');
    expect(row.querySelector('.ds')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '2 extensions, 3 skills · npm:pi-subagents · installed Oct 3',
    );
    expect(q(f, '[data-testid=outdated-pi-subagents]')?.textContent).toBe('0.4.0 → 0.5.0');
    q(f, '[data-testid=update-pi-subagents]')?.click();
    expect(pkgs.update).toHaveBeenCalledWith('user:npm:pi-subagents');
    expect(q(f, '[data-testid=update-git-guard]')).toBeNull();
  });

  it('an off package is dimmed and says off; the bundled one says so and is not described by a path', () => {
    const f = render();
    const off = q(f, '[data-testid=package-git-guard]') as HTMLElement;
    expect(off.classList.contains('off')).toBe(true);
    expect(off.querySelector('.nm .chip.off')?.textContent).toBe('off');
    const bundled = q(f, '[data-testid="package-@pi-kit/learn"]') as HTMLElement;
    expect(bundled.querySelector('.nm')?.textContent).toContain('bundled');
    expect(bundled.querySelector('.ds')?.textContent).toContain('ships with pi-kit');
  });

  it('the switch turns a package on or off', () => {
    const f = render();
    const toggle = q<HTMLInputElement>(f, '[data-testid=package-toggle-git-guard]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(pkgs.setEnabled).toHaveBeenCalledWith('user:git:github.com/x/git-guard', true);
  });

  it('More has Update (when behind) and Remove…, and Remove asks first', () => {
    const f = render();
    q(f, '[data-testid=package-more-pi-subagents]')?.click();
    f.detectChanges();
    const labels = Array.from(el(f).querySelectorAll('pk-context-menu [role=menuitem]')).map((i) =>
      i.textContent?.trim(),
    );
    expect(labels).toEqual(['Update', 'Remove…']);
    (el(f).querySelectorAll('pk-context-menu [role=menuitem]')[1] as HTMLElement).click();
    f.detectChanges();
    expect(q(f, '[data-testid=remove-confirm-pi-subagents]')?.textContent).toContain('Remove pi-subagents?');
    expect(pkgs.remove).not.toHaveBeenCalled();
    q(f, '[data-testid=remove-yes-pi-subagents]')?.click();
    expect(pkgs.remove).toHaveBeenCalledWith('user:npm:pi-subagents');
    q(f, '[data-testid=package-more-git-guard]')?.click();
    f.detectChanges();
    expect(
      Array.from(el(f).querySelectorAll('pk-context-menu [role=menuitem]')).map((i) => i.textContent?.trim()),
    ).toEqual(['Remove…']);
  });

  it('what a package brings can be shown and switched one by one', () => {
    const f = render();
    expect(q(f, '[data-testid=contents-pi-subagents]')).toBeNull();
    q(f, '[data-testid=toggle-contents-pi-subagents]')?.click();
    f.detectChanges();
    const rows = Array.from(el(f).querySelectorAll('[data-testid=contents-pi-subagents] [data-testid^=resource-]')).map(
      (r) => r.getAttribute('data-testid'),
    );
    expect(rows).toEqual(['resource-skills-split-task', 'resource-extensions-subagents']);
    const toggle = q<HTMLInputElement>(f, '[data-testid=resource-extensions-subagents] input') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(settings.toggleResource).toHaveBeenCalledWith('extensions:user:subagents', false);
  });

  it('the header has Check for updates and the "+" that opens the wizard', () => {
    const f = render();
    q(f, '[data-testid=check-updates]')?.click();
    expect(pkgs.checkForUpdates).toHaveBeenCalled();
    q(f, '[data-testid=add-package]')?.click();
    expect(pkgs.openWizard).toHaveBeenCalled();
    expect(q(f, '[data-testid=add-package]')?.getAttribute('aria-label')).toBe('Add a package');
  });

  it('an empty list invites with the same "+"', () => {
    items.set([]);
    const f = render();
    expect(q(f, '[data-testid=packages-empty]')?.textContent).toContain('No packages yet');
    (q(f, '[data-testid=packages-empty] button') as HTMLElement).click();
    expect(pkgs.openWizard).toHaveBeenCalled();
  });

  it('Your skills lists the user’s and the project’s skills (not a package’s), with Add to composer and the switch, but no manual editor', () => {
    const f = render('skills');
    const rows = Array.from(el(f).querySelectorAll('[data-testid=skills-group] .pk-item')).map((r) =>
      r.getAttribute('data-testid'),
    );
    expect(rows).toEqual(['resource-skills-angular-developer', 'resource-skills-pk-beta']);
    const row = q(f, '[data-testid=resource-skills-angular-developer]') as HTMLElement;
    expect(row.querySelector('.nm .chip')?.textContent).toBe('user');
    expect(row.querySelector('.ds')?.textContent).toContain('/skill:angular-developer');
    (row.querySelector('[data-testid=add-to-composer]') as HTMLElement).click();
    expect(chat.addChip).toHaveBeenCalledWith({ kind: 'skill', name: 'angular-developer', scope: 'user' });
    expect(ui.closeSettings).toHaveBeenCalled();
    expect(ui.focusComposer).toHaveBeenCalled();
    expect(q(f, '[data-testid^=edit-skill-]')).toBeNull();
    const toggle = row.querySelector<HTMLInputElement>('input') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(settings.toggleResource).toHaveBeenCalledWith('skills:user:angular-developer', false);
    expect(
      (q(f, '[data-testid=resource-skills-pk-beta] [data-testid=add-to-composer]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(q(f, '[data-testid=skills-group] header .chip.off')?.textContent).toBe('1 of 2 on');
  });

  it('has no manual skill creation or editing controls', () => {
    const f = render('skills');
    expect(q(f, '[data-testid=new-skill]')).toBeNull();
    expect(q(f, '[data-testid=new-skill-form]')).toBeNull();
    expect(q(f, '[data-testid^=edit-skill-]')).toBeNull();
    expect(q(f, 'pk-file-editor-dialog')).toBeNull();
  });

  it('Your extensions and prompts: the top-level files and the built-in ones, which cannot be turned off', () => {
    const f = render();
    const rows = Array.from(el(f).querySelectorAll('[data-testid=files-group] .pk-item')).map((r) =>
      r.getAttribute('data-testid'),
    );
    expect(rows).toEqual([
      'resource-extensions-worktree-guard',
      'resource-prompts-review',
      'resource-extensions-builtin-x',
    ]);
    expect((q(f, '[data-testid=resource-extensions-builtin-x] input') as HTMLInputElement).disabled).toBe(true);
    const toggle = q<HTMLInputElement>(f, '[data-testid=resource-extensions-worktree-guard] input') as HTMLInputElement;
    expect(toggle.getAttribute('aria-label')).toBe('Turn off worktree-guard');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(settings.toggleResource).toHaveBeenCalledWith('extensions:user:worktree-guard', false);
  });

  it('every icon-only button has a name', () => {
    const f = render();
    for (const b of Array.from(el(f).querySelectorAll<HTMLButtonElement>('button.btn-square')))
      expect(b.getAttribute('aria-label'), b.outerHTML).toBeTruthy();
  });

  it('the package wizard stays on Extensions and neither section mounts a skill editor', async () => {
    const f = render();
    pkgs.wizard.set(true);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expect(el(f).querySelector('pk-add-package-wizard')).not.toBeNull();
    expect(el(f).querySelector('pk-file-editor-dialog')).toBeNull();
    f.destroy();
    const skills = render('skills');
    await skills.whenStable();
    skills.detectChanges();
    expect(el(skills).querySelector('pk-add-package-wizard')).toBeNull();
    expect(el(skills).querySelector('pk-file-editor-dialog')).toBeNull();
  });
  it('offers skill install on Skills only', () => {
    const skills = render('skills');
    expect(q(skills, '[data-testid=install-skill]')).toBeTruthy();
    skills.destroy();
    const extensions = render('extensions');
    expect(q(extensions, '[data-testid=install-skill]')).toBeNull();
  });

  it('opens install in the shared dialog store with a live busy guard, without mounting a local dialog', () => {
    const f = render('skills');
    const dialogs = TestBed.inject(DialogStore);
    q(f, '[data-testid=install-skill]')?.click();
    f.detectChanges();
    const state = dialogs.current();
    expect(state).toMatchObject({ kind: 'component', component: InstallSkillDialog });
    expect(q(f, 'pk-install-skill-dialog')).toBeNull();
    expect(q(f, '[role=dialog]')).toBeNull();
    if (state?.kind !== 'component') throw new Error('Expected component dialog');
    expect(state.canClose?.()).toBe(true);
    pkgs.busy.set(new Set(['skill:+']));
    expect(state.canClose?.()).toBe(false);
    dialogs.close();
    expect(dialogs.current()).toBe(state);
    pkgs.busy.set(new Set());
    dialogs.close();
    expect(dialogs.current()).toBeUndefined();
  });

  it('captures mtime before opening shared deletion confirmation with the skill and a live path guard', async () => {
    settings.settings.set({ enableSkillCommands: true, agentDir: '/u' });
    pkgs.skillFile.mockResolvedValue({ mtime: 41 });
    const f = render('skills');
    const dialogs = TestBed.inject(DialogStore);
    const button = q(f, '[data-testid=delete-skill-angular-developer]');
    expect(button?.querySelector('pk-icon')?.getAttribute('name')).toBe('trash');
    expect(button?.textContent?.trim()).toBe('');
    expect(button?.getAttribute('aria-label')).toBe('Delete angular-developer');
    button?.click();
    expect(dialogs.current()).toBeUndefined();
    await f.whenStable();
    f.detectChanges();
    expect(pkgs.skillFile).toHaveBeenCalledExactlyOnceWith('/u/skills/angular-developer/SKILL.md');
    const state = dialogs.current();
    expect(state).toMatchObject({
      kind: 'component',
      component: DeleteSkillDialog,
      inputs: { skill: resources()?.items[0], mtime: 41 },
    });
    expect(q(f, 'pk-delete-skill-dialog')).toBeNull();
    expect(q(f, '[role=dialog]')).toBeNull();
    if (state?.kind !== 'component') throw new Error('Expected component dialog');
    expect(state.canClose?.()).toBe(true);
    pkgs.busy.set(new Set(['skill:+']));
    expect(state.canClose?.()).toBe(true);
    pkgs.busy.set(new Set(['/u/skills/angular-developer/SKILL.md']));
    expect(state.canClose?.()).toBe(false);
    dialogs.close();
    expect(dialogs.current()).toBe(state);
    pkgs.busy.set(new Set());
    dialogs.close();
    expect(dialogs.current()).toBeUndefined();
  });

  it('blocks duplicate preflight reads and shows progress until confirmation can open', async () => {
    settings.settings.set({ enableSkillCommands: true, agentDir: '/u' });
    let finish!: (file: { mtime: number }) => void;
    pkgs.skillFile.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const f = render('skills');
    const button = q<HTMLButtonElement>(f, '[data-testid=delete-skill-angular-developer]');
    button?.click();
    button?.click();
    f.detectChanges();
    expect(pkgs.skillFile).toHaveBeenCalledOnce();
    expect(button?.disabled).toBe(true);
    expect(q(f, '[data-testid=skills-group] [role=status]')).not.toBeNull();
    expect(TestBed.inject(DialogStore).current()).toBeUndefined();
    finish({ mtime: 42 });
    await f.whenStable();
    f.detectChanges();
    expect(button?.disabled).toBe(false);
    expect(q(f, '[data-testid=skills-group] [role=status]')).toBeNull();
    expect(TestBed.inject(DialogStore).current()).toMatchObject({ kind: 'component', inputs: { mtime: 42 } });
  });

  it('reports a preflight failure without opening a dialog and permits retry', async () => {
    settings.settings.set({ enableSkillCommands: true, agentDir: '/u' });
    pkgs.skillFile.mockRejectedValueOnce(new Error('Cannot read skill')).mockResolvedValueOnce({ mtime: 43 });
    const f = render('skills');
    const button = q<HTMLButtonElement>(f, '[data-testid=delete-skill-angular-developer]');
    button?.click();
    await f.whenStable();
    f.detectChanges();
    expect(q(f, '[data-testid=skills-group] [role=alert]')?.textContent).toContain('Cannot read skill');
    expect(TestBed.inject(DialogStore).current()).toBeUndefined();
    expect(button?.disabled).toBe(false);
    button?.click();
    await f.whenStable();
    f.detectChanges();
    expect(q(f, '[data-testid=skills-group] [role=alert]')).toBeNull();
    expect(TestBed.inject(DialogStore).current()).toMatchObject({ kind: 'component', inputs: { mtime: 43 } });
  });

  it('does not open confirmation when a preflight read completes after section destruction', async () => {
    settings.settings.set({ enableSkillCommands: true, agentDir: '/u' });
    let finish!: (file: { mtime: number }) => void;
    pkgs.skillFile.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const f = render('skills');
    const dialogs = TestBed.inject(DialogStore);
    q(f, '[data-testid=delete-skill-angular-developer]')?.click();
    f.destroy();
    finish({ mtime: 44 });
    await Promise.resolve();
    expect(dialogs.current()).toBeUndefined();
  });

  it('hides Delete for protected skills but not a same-name manual skill in another scope', () => {
    settings.settings.set({ enableSkillCommands: true, agentDir: '/u' });
    resources.set({
      items: [
        res({ name: 'custom', type: 'skills', path: '/custom/skills/custom/SKILL.md' }),
        res({ name: 'builtin', type: 'skills', origin: 'builtin', path: '/u/skills/builtin/SKILL.md' }),
        res({ name: 'package', type: 'skills', origin: 'package', path: '/u/skills/package/SKILL.md' }),
        res({ name: 'learned', type: 'skills', path: '/u/skills/learned/SKILL.md' }),
        res({
          name: 'learned',
          key: 'skills:project:learned',
          type: 'skills',
          scope: 'project',
          path: '/proj/.pi/skills/learned/SKILL.md',
        }),
      ],
      errors: [],
      projectSkipped: false,
    });
    const learned = TestBed.inject(LearnedStore);
    vi.spyOn(learned, 'live').mockReturnValue([
      {
        id: 'id',
        name: 'learned',
        path: '\\u\\skills\\learned\\SKILL.md',
        scope: 'user',
        retiredAt: null,
        missing: false,
        learnedFrom: { threadId: 't1', title: 'Test', base: null, head: null },
        verification: null,
        uses: 0,
        mergedAfterUse: 0,
        threads: 0,
        lastUsedAt: null,
        flag: null,
      },
    ] as ReturnType<typeof learned.live>);
    const f = render('skills');
    const buttons = el(f).querySelectorAll('[data-testid^=delete-skill-]');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.closest('[role=listitem]')?.textContent).toContain('project');
  });
});
