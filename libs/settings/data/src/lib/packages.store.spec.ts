import { TestBed } from '@angular/core/testing';
import {
  packagesDetail,
  packagesEnabled,
  packagesInstall,
  packagesList,
  packagesOutdated,
  packagesRemove,
  packagesSearch,
  packagesUpdate,
  provideMockApi,
  skillsCreate,
  skillsRead,
  skillsSave,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { PackageActionResult, PackageItem, PackagesOverview } from '@pi-kit/protocol';
import { fakeThreads, thread } from '@pi-kit/testing';
import { ThreadsStore } from '@pi-kit/threads/api';

import { PackagesStore } from './packages.store';
import { SettingsStore } from './settings.store';

const brings = {
  extensions: 1,
  skills: 0,
  prompts: 0,
  themes: 0,
  names: { extensions: ['a'], skills: [], prompts: [], themes: [] },
};
const item = (name: string, over: Partial<PackageItem> = {}): PackageItem => ({
  id: `user:npm:${name}`,
  source: `npm:${name}`,
  name,
  scope: 'user',
  origin: 'npm',
  enabled: true,
  installed: true,
  brings,
  ...over,
});
const overview = (...packages: PackageItem[]): PackagesOverview => ({ packages, errors: [] });

describe('PackagesStore', () => {
  let current: PackagesOverview;
  const result = (message: string): PackageActionResult => ({ message, overview: current, reloaded: 1 });
  const api = {
    list: vi.fn(async (_cwd?: string) => current),
    outdated: vi.fn(async (_cwd?: string) => current),
    install: vi.fn(async (_body: unknown, _cwd?: string) => result('Installed x.')),
    update: vi.fn(async (_id: string, _cwd?: string) => result('Updated x.')),
    remove: vi.fn(async (_id: string, _cwd?: string) => result('Removed x.')),
    setEnabled: vi.fn(async (_id: string, _enabled: boolean, _cwd?: string) => current),
    search: vi.fn(async () => ({ results: [], total: 0 })),
    detail: vi.fn(),
    newSkill: vi.fn(async (_body: unknown, _cwd?: string) => ({
      path: '/u/skills/x/SKILL.md',
      text: '---\n',
      mtime: 1,
      name: 'x',
      scope: 'user' as const,
    })),
    skillFile: vi.fn(),
    saveSkill: vi.fn(async (_path: string, _body: { text: string; mtime: number }, _cwd?: string) => ({
      path: '/u/skills/x/SKILL.md',
      text: 't',
      mtime: 2,
      name: 'x',
      scope: 'user' as const,
    })),
  };
  const settings = { loadResources: vi.fn(async () => undefined), markReload: vi.fn() };
  const toasts = { show: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    current = overview(
      item('pi-subagents', { outdated: { current: '0.4.0', latest: '0.5.0' } }),
      item('git-guard', { enabled: false }),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: fakeThreads({ selected: thread('t1', { cwd: '/proj' }) }) },
        { provide: SettingsStore, useValue: settings },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi([
          [packagesList, api.list, (o) => [o.query?.['cwd']]],
          [packagesOutdated, api.outdated, (o) => [o.query?.['cwd']]],
          [packagesInstall, api.install, (o) => [o.body, o.query?.['cwd']]],
          [packagesUpdate, api.update, (o) => [o.path?.['id'], o.query?.['cwd']]],
          [packagesRemove, api.remove, (o) => [o.path?.['id'], o.query?.['cwd']]],
          [packagesEnabled, api.setEnabled, (o) => [o.path?.['id'], o.body?.['enabled'], o.query?.['cwd']]],
          [packagesSearch, api.search, (o) => [o.query?.['q'], o.query?.['kind'], o.query?.['cwd']]],
          [packagesDetail, api.detail, (o) => [o.query?.['source'], o.query?.['cwd']]],
          [skillsCreate, api.newSkill, (o) => [o.body, o.query?.['cwd']]],
          [skillsRead, api.skillFile, (o) => [o.query?.['path'], o.query?.['cwd']]],
          [skillsSave, api.saveSkill, (o) => [o.query?.['path'], o.body, o.query?.['cwd']]],
        ]),
      ],
    });
  });

  it('reads the packages for the open folder, and counts the updates', async () => {
    const store = TestBed.inject(PackagesStore);
    await store.load();
    expect(api.list).toHaveBeenCalledWith('/proj');
    expect(store.packages().map((p) => p.name)).toEqual(['pi-subagents', 'git-guard']);
    expect(store.updates()).toBe(1);
    expect(store.loading()).toBe(false);
    api.list.mockRejectedValueOnce(new Error('pi is not there'));
    await store.load();
    expect(store.error()).toBe('pi is not there');
  });

  it('Check for updates takes the marked list and says so in a toast', async () => {
    const store = TestBed.inject(PackagesStore);
    await store.checkForUpdates();
    expect(api.outdated).toHaveBeenCalledWith('/proj');
    expect(toasts.show).toHaveBeenCalledWith('info', '1 package has an update.', 3500);
    current = overview(item('a'));
    await store.checkForUpdates();
    expect(toasts.show).toHaveBeenLastCalledWith('info', 'Every installed package is current.', 3500);
    api.outdated.mockRejectedValueOnce(new Error('offline'));
    await store.checkForUpdates();
    expect(toasts.show).toHaveBeenLastCalledWith('error', 'Could not check for updates: offline');
    expect(store.checking()).toBe(false);
  });

  it('install marks the wizard busy, closes it, reads the resources again and toasts; a refusal is handed back to the wizard', async () => {
    const store = TestBed.inject(PackagesStore);
    store.openWizard();
    expect(store.wizard()).toBe(true);
    const pending = store.install({ source: 'npm:x' });
    expect(store.busy().has('+')).toBe(true);
    expect(await pending).toEqual({ ok: true });
    expect(api.install).toHaveBeenCalledWith({ source: 'npm:x' }, '/proj');
    expect(store.busy().has('+')).toBe(false);
    expect(store.wizard()).toBe(false);
    expect(settings.loadResources).toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledWith('success', 'Installed x.', 4000);
    store.openWizard();
    api.install.mockRejectedValueOnce(new Error('pi could not install npm:x: 404'));
    expect(await store.install({ source: 'npm:x' })).toEqual({ ok: false, error: 'pi could not install npm:x: 404' });
    expect(store.wizard()).toBe(true);
  });

  it('update and remove take the new list, and say what happened', async () => {
    const store = TestBed.inject(PackagesStore);
    current = overview(item('git-guard'));
    await store.update('user:npm:pi-subagents');
    expect(api.update).toHaveBeenCalledWith('user:npm:pi-subagents', '/proj');
    expect(store.packages().map((p) => p.name)).toEqual(['git-guard']);
    expect(toasts.show).toHaveBeenLastCalledWith('success', 'Updated x.', 4000);
    await store.remove('user:npm:git-guard');
    expect(api.remove).toHaveBeenCalledWith('user:npm:git-guard', '/proj');
    expect(toasts.show).toHaveBeenLastCalledWith('success', 'Removed x.', 4000);
    api.remove.mockRejectedValueOnce(new Error('pi could not remove it'));
    await store.remove('user:npm:git-guard');
    expect(toasts.show).toHaveBeenLastCalledWith('error', 'pi could not remove it');
    expect(store.busy().size).toBe(0);
  });

  it('the switch asks for a reload of the open threads, and re-reads the resources', async () => {
    const store = TestBed.inject(PackagesStore);
    await store.setEnabled('user:npm:git-guard', true);
    expect(api.setEnabled).toHaveBeenCalledWith('user:npm:git-guard', true, '/proj');
    expect(settings.markReload).toHaveBeenCalledWith('extensions and skills');
    expect(settings.loadResources).toHaveBeenCalled();
    api.setEnabled.mockRejectedValueOnce(new Error('could not save'));
    await store.setEnabled('user:npm:git-guard', false);
    expect(toasts.show).toHaveBeenLastCalledWith('error', 'could not save');
  });

  it('a new skill opens the editor on its file and asks for a reload; a bad name is handed back', async () => {
    const store = TestBed.inject(PackagesStore);
    const made = await store.newSkill({ name: 'x', scope: 'user' });
    expect(made.ok).toBe(true);
    expect(api.newSkill).toHaveBeenCalledWith({ name: 'x', scope: 'user' }, '/proj');
    expect(store.skillEditor()).toEqual({ path: '/u/skills/x/SKILL.md', created: true });
    expect(settings.markReload).toHaveBeenCalledWith('extensions and skills');
    store.closeSkillEditor();
    expect(store.skillEditor()).toBeUndefined();
    api.newSkill.mockRejectedValueOnce(new Error('exists already'));
    expect(await store.newSkill({ name: 'x', scope: 'user' })).toEqual({ ok: false, error: 'exists already' });
    store.openSkillEditor('/u/skills/y/SKILL.md');
    expect(store.skillEditor()).toEqual({ path: '/u/skills/y/SKILL.md' });
    await store.saveSkill('/u/skills/y/SKILL.md', { text: 't', mtime: 1 });
    expect(api.saveSkill).toHaveBeenCalledWith('/u/skills/y/SKILL.md', { text: 't', mtime: 1 }, '/proj');
  });
});
