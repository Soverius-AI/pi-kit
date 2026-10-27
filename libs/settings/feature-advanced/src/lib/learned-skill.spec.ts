import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiStore } from '@pi-kit/data-access';
import type { LearnedSkill } from '@pi-kit/protocol';
import { SettingsStore } from '@pi-kit/settings/data';
import { LearnStore, LearnedStore } from '@pi-kit/threads/api';
import { PkLearnedRetired, PkLearnedSkill } from './learned-skill';

const HOUR = 3_600_000;
const skill = (over: Partial<LearnedSkill> = {}): LearnedSkill => ({
  id: 'd1',
  name: 'add-notes',
  scope: 'project',
  path: '/p/.pi/skills/add-notes/SKILL.md',
  retiredAt: null,
  missing: false,
  learnedFrom: { threadId: 't1', title: 'Add six notes', base: null, head: null },
  verification: { state: 'done', result: 'pass', at: Date.now() - 30 * HOUR, stale: false },
  uses: 4,
  mergedAfterUse: 3,
  threads: 3,
  lastUsedAt: Date.now() - 2 * HOUR,
  flag: null,
  ...over,
});

describe('the record of a learned skill in Settings', () => {
  const skills = signal<LearnedSkill[]>([]);
  const busy = signal<Record<string, string>>({});
  const errors = signal<Record<string, string>>({});
  const store = {
    live: () => skills().filter((s) => s.retiredAt === null),
    retired: () => skills().filter((s) => s.retiredAt !== null),
    busy,
    errors,
    load: vi.fn(async () => undefined),
    reverify: vi.fn(async () => undefined),
    retire: vi.fn(async () => true),
    restore: vi.fn(async () => true),
    stopVerify: vi.fn(async () => undefined),
  };
  const learn = { edit: vi.fn(async () => undefined) };
  const settings = { loadResources: vi.fn(async () => undefined) };
  const ui = { closeSettings: vi.fn() };

  const el = (f: { nativeElement: unknown }): HTMLElement => f.nativeElement as HTMLElement;
  const q = <T extends HTMLElement>(f: { nativeElement: unknown }, id: string): T | null =>
    el(f).querySelector<T>(`[data-testid=${id}]`);
  const render = (name = 'add-notes', path = '/p/.pi/skills/add-notes/SKILL.md') => {
    const fixture = TestBed.createComponent(PkLearnedSkill);
    fixture.componentRef.setInput('name', name);
    fixture.componentRef.setInput('path', path);
    fixture.detectChanges();
    return fixture;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    skills.set([skill()]);
    busy.set({});
    errors.set({});
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: LearnedStore, useValue: store },
        { provide: LearnStore, useValue: learn },
        { provide: SettingsStore, useValue: settings },
        { provide: UiStore, useValue: ui },
      ],
    });
  });

  it('says where the skill was learned from, how it was verified, how often it was used and how many threads merged, and when it was last used', () => {
    const f = render();
    expect(q(f, 'learned-record')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Learned from Add six notes · verified ' +
        new Date(skills()[0].verification?.at ?? 0).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
        ', pass · used 4 times, merged after 3 · last used 2 h ago',
    );
    expect(q(f, 'learned-flag')).toBeNull();
    expect(store.load).toHaveBeenCalled();
  });

  it('draws nothing for a skill that was not learned, for a retired one, and before the record is read', () => {
    expect(q(render('mine', '/p/.pi/skills/mine/SKILL.md'), 'learned-skill')).toBeNull();
    skills.set([skill({ retiredAt: 5 })]);
    expect(q(render(), 'learned-skill')).toBeNull();
    skills.set([]);
    expect(q(render(), 'learned-skill')).toBeNull();
  });

  it('matches a row by the skill’s name and its place (skills/<name>/SKILL.md), wherever the skills folder is', () => {
    expect(
      q(render('add-notes', '/home/.pi/agent/git/acme/skills/add-notes/SKILL.md'), 'learned-skill'),
    ).not.toBeNull();
    expect(q(render('add-notes', '/home/.pi/agent/git/acme/other/add-notes.md'), 'learned-skill')).toBeNull();
  });

  it('shows the warning line when the skill is flagged', () => {
    skills.set([
      skill({
        flag: { reason: 'no-outcomes', text: 'Its last three threads ended without a commit, merge or pull request.' },
      }),
    ]);
    const f = render();
    expect(q(f, 'learned-flag')?.textContent).toContain(
      'Its last three threads ended without a commit, merge or pull request.',
    );
    expect(q(f, 'learned-skill')?.getAttribute('data-flagged')).toBe('no-outcomes');
  });

  it('Re-verify and Edit and Retire are the three actions; Re-verify starts the replay', () => {
    const f = render();
    expect(['learned-reverify', 'learned-edit', 'learned-retire'].map((id) => q(f, id)?.textContent?.trim())).toEqual([
      'Re-verify',
      'Edit',
      'Retire',
    ]);
    q(f, 'learned-reverify')?.click();
    expect(store.reverify).toHaveBeenCalledWith(skills()[0]);
  });

  it('Edit closes Settings and opens the review dialog on the skill', () => {
    const f = render();
    q(f, 'learned-edit')?.click();
    expect(ui.closeSettings).toHaveBeenCalled();
    expect(learn.edit).toHaveBeenCalledWith(skills()[0]);
  });

  it('Retire asks first, says what happens, and does nothing until it is confirmed; Cancel leaves the skill alone', async () => {
    const f = render();
    q(f, 'learned-retire')?.click();
    f.detectChanges();
    expect(q(f, 'learned-confirm')?.textContent).toContain('Retire add-notes? pi stops loading it.');
    expect(q(f, 'learned-confirm')?.textContent).toContain('.pi/skills/.retired/add-notes/');
    expect(store.retire).not.toHaveBeenCalled();
    q(f, 'learned-retire-cancel')?.click();
    f.detectChanges();
    expect(q(f, 'learned-confirm')).toBeNull();
    q(f, 'learned-retire')?.click();
    f.detectChanges();
    q(f, 'learned-retire-confirm')?.click();
    await f.whenStable();
    expect(store.retire).toHaveBeenCalledWith(skills()[0]);
    expect(settings.loadResources).toHaveBeenCalled();
  });

  it('a user skill is retired into pi’s own folder, and the words say so', () => {
    skills.set([skill({ scope: 'user' })]);
    const f = render();
    q(f, 'learned-retire')?.click();
    f.detectChanges();
    expect(q(f, 'learned-confirm')?.textContent).toContain('skills/.retired/add-notes/ in pi’s folder');
  });

  it('while it is verified the row shows the phase and Stop, and the actions that would collide are off', () => {
    skills.set([skill({ verification: { state: 'running', phase: 'run', stale: false } })]);
    const f = render();
    expect(q(f, 'learned-running')?.textContent).toContain('The thread is running with the skill pinned…');
    expect(q<HTMLButtonElement>(f, 'learned-reverify')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(f, 'learned-edit')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(f, 'learned-retire')?.disabled).toBe(true);
    q(f, 'learned-stop')?.click();
    expect(store.stopVerify).toHaveBeenCalledWith(skills()[0]);
  });

  it('shows a refusal under the row, and a skill file that is gone', () => {
    errors.set({ d1: 'This skill is being verified.' });
    skills.set([skill({ missing: true })]);
    const f = render();
    expect(q(f, 'learned-error')?.textContent).toContain('being verified');
    expect(q(f, 'learned-missing')?.textContent).toContain('/p/.pi/skills/add-notes/SKILL.md');
    expect(q<HTMLButtonElement>(f, 'learned-reverify')?.disabled).toBe(true);
    expect(q<HTMLButtonElement>(f, 'learned-retire')?.disabled).toBe(true);
  });
});

describe('the retired list in Settings', () => {
  const skills = signal<LearnedSkill[]>([]);
  const store = {
    retired: () => skills().filter((s) => s.retiredAt !== null),
    busy: signal<Record<string, string>>({}),
    errors: signal<Record<string, string>>({}),
    load: vi.fn(async () => undefined),
    restore: vi.fn(async () => true),
  };
  const settings = { loadResources: vi.fn(async () => undefined) };
  const render = () => {
    const fixture = TestBed.createComponent(PkLearnedRetired);
    fixture.detectChanges();
    return fixture;
  };
  const q = <T extends HTMLElement>(f: { nativeElement: unknown }, id: string): T | null =>
    (f.nativeElement as HTMLElement).querySelector<T>(`[data-testid=${id}]`);

  beforeEach(() => {
    vi.clearAllMocks();
    skills.set([skill({ id: 'd2', name: 'old-skill', retiredAt: Date.now() - 3 * 86_400_000 })]);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: LearnedStore, useValue: store },
        { provide: SettingsStore, useValue: settings },
      ],
    });
  });

  it('draws nothing while no skill is retired', () => {
    skills.set([skill()]);
    expect(q(render(), 'retired-group')).toBeNull();
  });

  it('is collapsed, with the count; opening it lists the retired skills with when they were retired', () => {
    const f = render();
    expect(q(f, 'retired-count')?.textContent?.trim()).toBe('1');
    expect(q(f, 'retired-toggle')?.getAttribute('aria-expanded')).toBe('false');
    expect(q(f, 'retired-old-skill')).toBeNull();
    q(f, 'retired-toggle')?.click();
    f.detectChanges();
    expect(q(f, 'retired-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(q(f, 'retired-old-skill')?.textContent).toContain('retired 3 d ago');
    expect(q(f, 'retired-old-skill')?.textContent).toContain('Learned from Add six notes');
  });

  it('Restore brings the skill back and reads pi’s list again', async () => {
    const f = render();
    q(f, 'retired-toggle')?.click();
    f.detectChanges();
    q(f, 'learned-restore')?.click();
    await f.whenStable();
    expect(store.restore).toHaveBeenCalledWith(skills()[0]);
    expect(settings.loadResources).toHaveBeenCalled();
  });
});
