import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatStore } from '@pi-kit/chat/api';
import { UiStore } from '@pi-kit/data-access';
import type { PackageItem, ResourceItem, ResourcesOverview } from '@pi-kit/protocol';
import { PackagesStore, SettingsStore } from '@pi-kit/settings/api';
import { LearnStore, LearnedStore } from '@pi-kit/threads/api';
import { ExtensionsSection } from './extensions-section';

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
    settings: signal<{ enableSkillCommands: boolean } | undefined>(undefined),
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
    skillEditor: signal<{ path: string; created?: boolean } | undefined>(undefined),
    error: signal<string | undefined>(undefined),
    cwd: () => '/proj' as string | undefined,
    load: vi.fn(async () => undefined),
    checkForUpdates: vi.fn(),
    openWizard: vi.fn(),
    closeWizard: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    setEnabled: vi.fn(),
    newSkill: vi.fn(async () => ({ ok: true })),
    openSkillEditor: vi.fn(),
    closeSkillEditor: vi.fn(),
    skillFile: vi.fn(() => new Promise(() => undefined)),
    saveSkill: vi.fn(),
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
    pkgs.skillEditor.set(undefined);
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

  it('keeps packages and extension files on Extensions and asks for packages when it shows', () => {
    const f = render();
    expect(Array.from(el(f).querySelectorAll('.pk-group > header h4')).map((h) => h.textContent)).toEqual([
      'Packages',
      'Your extensions and prompts',
    ]);
    expect(pkgs.load).toHaveBeenCalled();
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

  it('Your skills lists the user’s and the project’s skills (not a package’s), with Add to composer, Edit and the switch', () => {
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
    (row.querySelector('[data-testid=edit-skill-angular-developer]') as HTMLElement).click();
    expect(pkgs.openSkillEditor).toHaveBeenCalledWith('/u/skills/angular-developer/SKILL.md');
    expect(
      (q(f, '[data-testid=resource-skills-pk-beta] [data-testid=add-to-composer]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(q(f, '[data-testid=skills-group] header .chip.off')?.textContent).toBe('1 of 2 on');
  });

  it('"+" on Your skills asks for a name and a scope, refuses a bad name, and creates the folder', async () => {
    const f = render('skills');
    q(f, '[data-testid=new-skill]')?.click();
    f.detectChanges();
    const name = q<HTMLInputElement>(f, '[data-testid=new-skill-name]') as HTMLInputElement;
    name.value = 'Bad Name';
    name.dispatchEvent(new Event('input'));
    q(f, '[data-testid=new-skill-create]')?.click();
    f.detectChanges();
    expect(q(f, '[data-testid=new-skill-error]')?.textContent).toMatch(/lowercase/);
    expect(pkgs.newSkill).not.toHaveBeenCalled();
    name.value = 'add-a-migration';
    name.dispatchEvent(new Event('input'));
    const scope = q<HTMLSelectElement>(f, '[data-testid=new-skill-scope]') as HTMLSelectElement;
    scope.value = 'project';
    scope.dispatchEvent(new Event('change'));
    q(f, '[data-testid=new-skill-create]')?.click();
    await f.whenStable();
    f.detectChanges();
    expect(pkgs.newSkill).toHaveBeenCalledWith({ name: 'add-a-migration', scope: 'project' });
    expect(q(f, '[data-testid=new-skill-form]')).toBeNull();
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

  it('the package wizard stays on Extensions and the skill editor stays on Skills', async () => {
    const f = render();
    pkgs.wizard.set(true);
    pkgs.skillEditor.set({ path: '/u/skills/x/SKILL.md', created: true });
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
    expect(el(skills).querySelector('pk-file-editor-dialog')).not.toBeNull();
  });
});
