import { TestBed } from '@angular/core/testing';
import {
  provideMockApi,
  settingsDiagnose,
  settingsOverview,
  settingsRevokeTrust,
  settingsTrustList,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import { AdvancedSettingsStore } from './advanced-settings.store';
import { SettingsStore } from './settings.store';

describe('AdvancedSettingsStore', () => {
  const entries = [
    { path: '/a', trusted: true },
    { path: '/b', trusted: false },
  ];
  const api = {
    diagnose: vi.fn(async () => ({ app: { version: '1' } })),
    trustList: vi.fn(async () => ({ file: '/agent/trust.json', entries })),
    revoke: vi.fn(async (path: string) => ({
      file: '/agent/trust.json',
      entries: entries.filter((entry) => entry.path !== path),
      running: 1,
    })),
    overview: vi.fn(),
  };
  const dialog = {
    save: vi.fn(<T>(work: () => Promise<T>) => work().catch(() => undefined)),
    loadFolders: vi.fn(async () => undefined),
  };
  const toasts = { show: vi.fn() };

  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of [...Object.values(api), ...Object.values(dialog), toasts.show]) fn.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        AdvancedSettingsStore,
        { provide: SettingsStore, useValue: dialog },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi([
          [settingsDiagnose, api.diagnose, () => []],
          [settingsTrustList, api.trustList, () => []],
          [settingsRevokeTrust, api.revoke, (o) => [o.body?.['path']]],
          [settingsOverview, api.overview, () => []],
        ]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('reads its own diagnostics and trust list, never the bundled settings overview', async () => {
    const store = TestBed.inject(AdvancedSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.diagnostics()).toEqual({ app: { version: '1' } });
    expect(store.trustList()?.entries).toEqual(entries);
    expect(api.overview).not.toHaveBeenCalled();
  });

  it('forgetting an answer updates the list, says a run keeps its answer, and refreshes the projects’ trust', async () => {
    const store = TestBed.inject(AdvancedSettingsStore);
    await vi.advanceTimersByTimeAsync(0);
    await store.revokeTrust('/a');
    expect(api.revoke).toHaveBeenCalledWith('/a');
    expect(store.trustList()?.entries).toEqual([{ path: '/b', trusted: false }]);
    expect(toasts.show).toHaveBeenCalledWith('info', expect.any(String));
    expect(dialog.loadFolders).toHaveBeenCalledTimes(1);
  });
});
