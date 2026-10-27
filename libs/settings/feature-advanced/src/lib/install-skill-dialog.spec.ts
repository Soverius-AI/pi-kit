import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import type { SkillDetail, SkillSearchResponse, SkillSearchResult } from '@pi-kit/protocol';
import { PackagesStore, SettingsStore } from '@pi-kit/settings/api';
import { InstallSkillDialog } from './install-skill-dialog';
import { DialogStore } from '@pi-kit/data-access';

const skill: SkillSearchResult = {
  id: 'org/repo/test',
  name: 'test',
  source: 'org/repo',
  installs: 1234,
  url: 'https://skills.sh/org/repo/test',
};
const detail: SkillDetail = {
  source: 'org/repo',
  name: 'test',
  description: 'Build accessible components with typed inputs and signals.',
  license: 'MIT',
  compatibility: 'Requires Node.js',
  author: 'Example team',
  path: 'skills/test',
  commit: 'a'.repeat(40),
  files: 4,
  bytes: 2048,
  scripts: ['scripts/check.mjs'],
  content: '---\nname: test\ndescription: Real upstream description\n---\n# Instructions\nRead before use.',
  warnings: [],
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 330));

describe('InstallSkillDialog', () => {
  const store = {
    cwd: () => '/project' as string | undefined,
    searchSkills: vi.fn(async (_q: string, _signal?: AbortSignal): Promise<SkillSearchResponse> => ({
      results: [skill],
    })),
    skillDetail: vi.fn(async (_source: string, _name: string, _signal?: AbortSignal): Promise<SkillDetail> => detail),
    installSkill: vi.fn(async (_body: unknown): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })),
  };
  const settings = { settings: () => ({ agentDir: '/agent' }), resources: signal({ projectSkipped: false }) };
  const open = () => {
    const f = TestBed.createComponent(InstallSkillDialog);
    f.detectChanges();
    return f;
  };
  beforeEach(() => {
    vi.clearAllMocks();
    settings.resources.set({ projectSkipped: false });
    store.searchSkills.mockImplementation(async () => ({ results: [skill] }));
    store.skillDetail.mockImplementation(async () => detail);
    store.installSkill.mockResolvedValue({ ok: true });
    TestBed.configureTestingModule({
      providers: [
        { provide: PackagesStore, useValue: store },
        { provide: SettingsStore, useValue: settings },
      ],
    });
  });

  it('browses structured results, then shows real metadata and installs the previewed revision', async () => {
    const f = open();
    expect(f.nativeElement.textContent).toContain('Search queries are shared with');
    expect(f.nativeElement.querySelector('a').href).toBe('https://skills.sh/');
    f.componentInstance.search('a');
    f.detectChanges();
    await pause();
    expect(store.searchSkills).not.toHaveBeenCalled();
    f.componentInstance.search('angular');
    f.detectChanges();
    expect(store.searchSkills).not.toHaveBeenCalled();
    await pause();
    f.detectChanges();
    const row = f.nativeElement.querySelector('[data-testid=skill-result-test]');
    expect(row.textContent).toContain('org/repo');
    expect(row.textContent).toContain('1,234 installs');
    expect(f.nativeElement.textContent).not.toContain('Enter at least 2 characters');
    row.click();
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expect(store.skillDetail).toHaveBeenCalledWith('org/repo', 'test', expect.any(AbortSignal));
    expect(f.nativeElement.querySelector('[data-testid=skill-description]').textContent).toBe(detail.description);
    expect(f.nativeElement.textContent).toContain('MIT');
    expect(f.nativeElement.textContent).toContain('Example team');
    expect(f.nativeElement.textContent).toContain('4 files');
    expect(f.nativeElement.textContent).toContain('2.0 KB');
    expect(f.nativeElement.textContent).toContain('/agent/skills/test/');
    expect(f.nativeElement.querySelector('pre').textContent).toBe(detail.content);
    expect(store.installSkill).not.toHaveBeenCalled();
    const closed = vi.spyOn(TestBed.inject(DialogStore), 'close');
    f.componentInstance.scope.set('project');
    f.detectChanges();
    expect(f.nativeElement.textContent).toContain('/project/.pi/skills/test/');
    f.nativeElement.querySelector('[data-testid=install-skill-confirm]').click();
    await f.whenStable();
    expect(store.installSkill).toHaveBeenCalledWith({
      source: 'org/repo',
      name: 'test',
      scope: 'project',
      commit: detail.commit,
    });
    expect(closed).toHaveBeenCalledOnce();
  });

  it('keeps a valid destination choice but falls back to user scope when project trust is lost', () => {
    const f = open();
    expect(f.componentInstance.scope()).toBe('user');
    f.componentInstance.scope.set('project');
    f.detectChanges();
    expect(f.componentInstance.scope()).toBe('project');
    settings.resources.set({ projectSkipped: true });
    f.detectChanges();
    expect(f.componentInstance.scope()).toBe('user');
    settings.resources.set({ projectSkipped: false });
    f.detectChanges();
    expect(f.componentInstance.scope()).toBe('user');
  });

  it('aborts stale searches and ignores their late responses', async () => {
    let resolve!: (value: SkillSearchResponse) => void;
    store.searchSkills.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const f = open();
    f.componentInstance.search('old');
    f.detectChanges();
    await pause();
    const signal = store.searchSkills.mock.calls[0][1];
    f.componentInstance.search('new');
    f.detectChanges();
    expect(signal?.aborted).toBe(true);
    await pause();
    resolve({ results: [] });
    await Promise.resolve();
    f.detectChanges();
    expect(f.componentInstance.results()).toEqual([skill]);
  });

  it('debounces input and cancels pending searches when destroyed', async () => {
    const f = open();
    f.componentInstance.search('first');
    f.componentInstance.search('second');
    await pause();
    expect(store.searchSkills).toHaveBeenCalledOnce();
    expect(store.searchSkills.mock.calls[0][0]).toBe('second');
    const signal = store.searchSkills.mock.calls[0][1];
    f.componentInstance.search('third');
    expect(signal?.aborted).toBe(true);
    f.destroy();
    await pause();
    expect(store.searchSkills).toHaveBeenCalledOnce();
  });

  it('aborts previews on destruction and ignores late responses', async () => {
    let resolve!: (value: SkillDetail) => void;
    store.skillDetail.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const f = open();
    const dialog = f.componentInstance;
    dialog.select(skill);
    const signal = store.skillDetail.mock.calls[0][2];
    f.destroy();
    resolve(detail);
    await Promise.resolve();
    expect(signal?.aborted).toBe(true);
    expect(dialog.info()).toBeUndefined();
  });

  it('reuses a successful preview when selecting the same skill again', async () => {
    const f = open();
    f.componentInstance.select(skill);
    await f.whenStable();
    f.componentInstance.back();
    expect(f.componentInstance.info()).toBeUndefined();
    f.componentInstance.select(skill);
    expect(f.componentInstance.info()).toEqual(detail);
    expect(f.componentInstance.loading()).toBe(false);
    expect(store.skillDetail).toHaveBeenCalledOnce();
  });

  it('blocks installation while a preview fails and supports retry', async () => {
    store.skillDetail.mockRejectedValueOnce(new Error('Repository unavailable'));
    const f = open();
    f.componentInstance.select(skill);
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expect(f.nativeElement.querySelector('[role=alert]').textContent).toContain('Repository unavailable');
    expect(f.nativeElement.querySelector('[data-testid=install-skill-confirm]').disabled).toBe(true);
    await f.componentInstance.install();
    expect(store.installSkill).not.toHaveBeenCalled();
    f.componentInstance.retryPreview();
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expect(f.nativeElement.querySelector('[data-testid=skill-description]').textContent).toBe(detail.description);
    expect(f.nativeElement.querySelector('[data-testid=install-skill-confirm]').disabled).toBe(false);
  });

  it('ignores late preview responses and preserves the search list when going back', async () => {
    let resolve!: (value: SkillDetail) => void;
    store.skillDetail.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const f = open();
    f.componentInstance.results.set([skill]);
    f.componentInstance.select(skill);
    f.detectChanges();
    const signal = store.skillDetail.mock.calls[0][2];
    f.componentInstance.back();
    f.detectChanges();
    resolve(detail);
    await Promise.resolve();
    await Promise.resolve();
    f.detectChanges();
    expect(signal?.aborted).toBe(true);
    expect(f.componentInstance.info()).toBeUndefined();
    expect(f.componentInstance.results()).toEqual([skill]);
    expect(f.componentInstance.selected()).toBeUndefined();
  });

  it('keeps failed installation open, shows an alert, and allows cancellation', async () => {
    store.installSkill.mockResolvedValueOnce({ ok: false, error: 'Already installed' });
    const f = open();
    const closed = vi.spyOn(TestBed.inject(DialogStore), 'close');
    f.componentInstance.select(skill);
    f.detectChanges();
    await f.whenStable();
    await f.componentInstance.install();
    f.detectChanges();
    expect(f.nativeElement.querySelector('[role=alert]').textContent).toContain('Already installed');
    expect(closed).not.toHaveBeenCalled();
    f.componentInstance.close();
    expect(closed).toHaveBeenCalledOnce();
    expect(store.installSkill).toHaveBeenCalledOnce();
  });

  it('distinguishes catalog errors from an empty result', async () => {
    store.searchSkills.mockResolvedValueOnce({ results: [], error: 'Catalog unavailable' });
    const f = open();
    f.componentInstance.search('test');
    f.detectChanges();
    await pause();
    f.detectChanges();
    expect(f.nativeElement.querySelector('[role=alert]').textContent).toContain('Catalog unavailable');
    expect(f.nativeElement.textContent).not.toContain('No skills found');
  });
});
