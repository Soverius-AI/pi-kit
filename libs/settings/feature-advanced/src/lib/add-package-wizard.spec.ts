import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { PackageDetail, PackageSearchResponse, PackageSearchResult } from '@pi-kit/protocol';
import { PackagesStore } from '@pi-kit/settings/api';
import { AddPackageWizard } from './add-package-wizard';

const result = (over: Partial<PackageSearchResult> & { name: string }): PackageSearchResult => ({
  source: `npm:${over.name}`,
  version: '1.0.0',
  contains: ['extensions'],
  exact: true,
  ...over,
});
const SEARCH: PackageSearchResponse = {
  total: 6,
  results: [
    result({
      name: 'pi-subagents',
      description: 'Run pi in sub-threads.',
      downloads: 12034,
      license: 'MIT',
      brings: { extensions: 2, skills: 3, prompts: 0, themes: 0 },
      contains: ['extensions', 'skills'],
      installed: true,
    }),
    result({ name: 'skills-devops', description: 'Terraform skills.', contains: ['skills'], exact: false }),
    result({ name: '@pi-kit/learn', source: '/app/packages/pi-kit-learn', bundled: true }),
  ],
};
const DETAIL: PackageDetail = {
  source: 'npm:pi-subagents',
  origin: 'npm',
  name: 'pi-subagents',
  version: '0.5.0',
  author: 'nicolo',
  repository: 'https://github.com/nicolo/pi-subagents',
  license: 'MIT',
  brings: {
    extensions: 2,
    skills: 3,
    prompts: 0,
    themes: 0,
    names: {
      extensions: ['subagents', 'budget'],
      skills: ['parallel-research', 'split-task', 'merge-results'],
      prompts: [],
      themes: [],
    },
  },
  readme: 'Sub-agents let a thread delegate a bounded task.',
  notes: [],
  command: 'pi install npm:pi-subagents',
  installed: false,
};

describe('AddPackageWizard', () => {
  const busy = signal(new Set<string>());
  const store = {
    busy,
    search: vi.fn(async (_q: string, _kind: string): Promise<PackageSearchResponse> => SEARCH),
    detail: vi.fn(async (_source: string): Promise<PackageDetail> => DETAIL),
    install: vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true })),
    closeWizard: vi.fn(),
  };

  const settle = async (f: { whenStable(): Promise<unknown>; detectChanges(): void }): Promise<void> => {
    await f.whenStable();
    await new Promise((r) => setTimeout(r));
    f.detectChanges();
  };
  const open = async () => {
    const fixture = TestBed.createComponent(AddPackageWizard);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  };
  const root = (f: { nativeElement: unknown }): HTMLElement => f.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(f: { nativeElement: unknown }, selector: string): T | null =>
    root(f).querySelector<T>(selector);
  const type = (f: Awaited<ReturnType<typeof open>>, selector: string, value: string): void => {
    const input = q<HTMLInputElement>(f, selector) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    f.detectChanges();
  };
  const click = (f: Awaited<ReturnType<typeof open>>, selector: string): void => {
    q(f, selector)?.click();
    f.detectChanges();
  };
  const tab = (f: Awaited<ReturnType<typeof open>>, id: string): void => {
    const radio = q<HTMLInputElement>(f, `[data-testid=tab-${id}]`) as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    f.detectChanges();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    busy.set(new Set());
    store.search.mockImplementation(async () => SEARCH);
    store.detail.mockImplementation(async (source: string) => ({ ...DETAIL, source }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: PackagesStore, useValue: store }] });
  });

  it('opens on Browse with the three tabs and the first search, and says how many results', async () => {
    const f = await open();
    expect(Array.from(root(f).querySelectorAll('.pk-seg input')).map((i) => i.getAttribute('aria-label'))).toEqual([
      'Browse',
      'From git',
      'From a folder',
    ]);
    expect(store.search).toHaveBeenCalledWith('', 'all');
    expect(
      Array.from(root(f).querySelectorAll('.pk-choices button')).map((b) => b.getAttribute('data-testid')),
    ).toEqual(['result-pi-subagents', 'result-skills-devops', 'result-@pi-kit/learn']);
    expect(q(f, '[data-testid=browse-hint]')?.textContent).toBe(
      'pi packages on npm (keyword pi-package) and the pi-kit list. 3 results of 6.',
    );
    expect(root(f).querySelectorAll('.dots i.on')).toHaveLength(1);
    expect(q(f, '.foot .hint')?.textContent).toBe('Step 1 of 2, next: what it adds');
    expect(q<HTMLButtonElement>(f, '[data-testid=package-primary]')?.disabled).toBe(true);
  });

  it('a result says what it contains, how much it is used and whether it is installed', async () => {
    const f = await open();
    const row = q(f, '[data-testid=result-pi-subagents]') as HTMLElement;
    expect(row.querySelector('.t')?.textContent).toContain('installed');
    expect(row.querySelector('.d')?.textContent).toContain('2 extensions, 3 skills · 12k downloads');
    expect(q(f, '[data-testid=result-skills-devops] .chip.off')?.textContent).toBe('skills only');
    expect(q(f, '[data-testid="result-@pi-kit/learn"] .chip.off')?.textContent).toBe('ships with pi-kit');
  });

  it('typing searches after a pause, and the kind filter at once; the newest answer wins', async () => {
    vi.useFakeTimers();
    try {
      const f = TestBed.createComponent(AddPackageWizard);
      f.detectChanges();
      await vi.advanceTimersByTimeAsync(0);
      store.search.mockClear();
      type(f as never, '[data-testid=package-search]', 'sub');
      type(f as never, '[data-testid=package-search]', 'subag');
      expect(store.search).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(350);
      expect(store.search).toHaveBeenCalledTimes(1);
      expect(store.search).toHaveBeenCalledWith('subag', 'all');
      const kind = q<HTMLSelectElement>(f, '[data-testid=package-kind]') as HTMLSelectElement;
      kind.value = 'skills';
      kind.dispatchEvent(new Event('change'));
      expect(store.search).toHaveBeenLastCalledWith('subag', 'skills');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a registry that does not answer says why, and the pi-kit packages are still there', async () => {
    store.search.mockImplementationOnce(async () => ({
      results: [SEARCH.results[2]],
      total: 1,
      error: 'The registry did not answer in time. The packages that ship with pi-kit are listed below.',
    }));
    const f = await open();
    expect(q(f, '[data-testid=search-error]')?.textContent).toContain('did not answer in time');
    expect(root(f).querySelectorAll('.pk-choices button')).toHaveLength(1);
    store.search.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    type(f, '[data-testid=package-search]', 'x');
    await new Promise((r) => setTimeout(r, 400));
    f.detectChanges();
    expect(q(f, '[data-testid=search-error]')?.textContent).toContain('boom');
  });

  it('picking a result goes to step 2: what it adds, the README as text, the exact command', async () => {
    const f = await open();
    click(f, '[data-testid=result-pi-subagents]');
    await settle(f);
    expect(store.detail).toHaveBeenCalledWith('npm:pi-subagents');
    expect(q(f, '[data-wstep=confirm]')).not.toBeNull();
    expect(q(f, '[data-testid=detail-title]')?.textContent).toContain('pi-subagents');
    expect(q(f, '[data-testid=detail-title]')?.textContent).toContain('0.5.0');
    const adds = Array.from(
      root(f).querySelectorAll('[data-testid=package-adds] dt, [data-testid=package-adds] dd'),
    ).map((e) => e.textContent?.trim());
    expect(adds.slice(0, 4)).toEqual([
      'Extensions',
      'subagents, budget',
      'Skills',
      'parallel-research, split-task, merge-results',
    ]);
    expect(adds).not.toContain('Prompts');
    expect(q(f, '[data-testid=package-command]')?.textContent).toBe('pi install npm:pi-subagents');
    expect(q(f, '[data-testid=package-readme]')?.textContent).toContain('Sub-agents let a thread');
    expect(q(f, '[data-testid=package-readme]')?.getAttribute('style')).toContain('max-height: 160px');
    expect(root(f).querySelectorAll('.dots i.on')).toHaveLength(2);
    expect(q(f, '[data-testid=package-primary]')?.textContent?.trim()).toBe('Install');
    expect(q<HTMLInputElement>(f, '[data-testid=every-project]')?.checked).toBe(true);
  });

  it('Install sends the source and the scope, and the wizard closes when it went through', async () => {
    const f = await open();
    let closed = 0;
    f.componentInstance.closed.subscribe(() => closed++);
    click(f, '[data-testid=result-skills-devops]');
    await settle(f);
    click(f, '[data-testid=package-primary]');
    await settle(f);
    expect(store.install).toHaveBeenCalledWith({ source: 'npm:skills-devops', scope: 'user' });
    expect(closed).toBe(1);
  });

  it('“Enable for every project” off installs for this project only and the command says so', async () => {
    const f = await open();
    click(f, '[data-testid=result-skills-devops]');
    await settle(f);
    const toggle = q<HTMLInputElement>(f, '[data-testid=every-project]') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(q(f, '[data-testid=package-command]')?.textContent).toBe('pi install -l npm:skills-devops');
    click(f, '[data-testid=package-primary]');
    await settle(f);
    expect(store.install).toHaveBeenCalledWith({ source: 'npm:skills-devops', scope: 'project' });
  });

  it('an install that pi refuses stays on step 2 with pi-kit’s sentence', async () => {
    store.install.mockResolvedValueOnce({ ok: false, error: 'pi could not install npm:pi-subagents: 404 Not Found' });
    const f = await open();
    click(f, '[data-testid=result-pi-subagents]');
    await settle(f);
    click(f, '[data-testid=package-primary]');
    await settle(f);
    expect(q(f, '[data-testid=install-error]')?.textContent).toContain('404 Not Found');
    expect(q(f, '[data-wstep=confirm]')).not.toBeNull();
  });

  it('a package that is installed already cannot be installed again', async () => {
    store.detail.mockResolvedValueOnce({ ...DETAIL, installed: true });
    const f = await open();
    click(f, '[data-testid=result-pi-subagents]');
    await settle(f);
    expect(q<HTMLButtonElement>(f, '[data-testid=package-primary]')?.disabled).toBe(true);
    expect(root(f).textContent).toContain('installed already');
    // the button that had the focus is disabled now; the focus is still in the dialog, so Escape closes this wizard and not the Settings window behind it
    await settle(f);
    expect(q(f, '.win')?.contains(document.activeElement)).toBe(true);
  });

  it('Back returns to the results, sliding the other way', async () => {
    const f = await open();
    click(f, '[data-testid=result-pi-subagents]');
    await settle(f);
    click(f, '[data-testid=wizard-back]');
    expect(q(f, '[data-wstep=pick]')?.classList.contains('back')).toBe(true);
    expect(root(f).querySelectorAll('.pk-choices button')).toHaveLength(3);
  });

  it('From git takes an address; the second step is about it, and it is installed as typed', async () => {
    store.detail.mockImplementationOnce(async () => ({
      ...DETAIL,
      source: 'git:github.com/x/git-guard',
      origin: 'git',
      name: 'git-guard',
      brings: undefined,
      readme: undefined,
      notes: ['What a repository adds is known once pi has cloned it.'],
      command: 'pi install git:github.com/x/git-guard',
    }));
    const f = await open();
    tab(f, 'git');
    expect(q<HTMLButtonElement>(f, '[data-testid=package-primary]')?.disabled).toBe(true);
    type(f, '[data-testid=package-git]', 'github.com/x/git-guard');
    expect(q<HTMLButtonElement>(f, '[data-testid=package-primary]')?.disabled).toBe(false);
    expect(q(f, '[data-testid=package-primary]')?.textContent?.trim()).toBe('Continue');
    click(f, '[data-testid=package-primary]');
    await settle(f);
    expect(store.detail).toHaveBeenCalledWith('git:github.com/x/git-guard');
    expect(q(f, '[data-testid=package-adds]')?.textContent).toContain('Known after the install.');
    expect(root(f).textContent).toContain('known once pi has cloned it');
    click(f, '[data-testid=package-primary]');
    await settle(f);
    expect(store.install).toHaveBeenCalledWith({ source: 'git:github.com/x/git-guard', scope: 'user' });
  });

  it('From a folder takes a path; the answer for a folder that is no package is shown on step 2', async () => {
    store.detail.mockRejectedValueOnce(
      new Error(
        '/tmp/nothing is not a pi package: it has no package.json and no extensions, skills, prompts or themes folder.',
      ),
    );
    const f = await open();
    tab(f, 'folder');
    type(f, '[data-testid=package-folder]', '/tmp/nothing');
    click(f, '[data-testid=package-primary]');
    await settle(f);
    expect(store.detail).toHaveBeenCalledWith('/tmp/nothing');
    expect(q(f, '[data-testid=detail-error]')?.textContent).toContain('not a pi package');
    expect(q<HTMLButtonElement>(f, '[data-testid=package-primary]')?.disabled).toBe(true);
  });

  it('Escape closes, and the tabs cannot change under an install', async () => {
    const f = await open();
    let closed = 0;
    f.componentInstance.closed.subscribe(() => closed++);
    q(f, '.win')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toBe(1);
    expect(store.closeWizard).toHaveBeenCalled();
    click(f, '[data-testid=result-pi-subagents]');
    await settle(f);
    expect(q<HTMLInputElement>(f, '[data-testid=tab-git]')?.disabled).toBe(true);
  });
});
