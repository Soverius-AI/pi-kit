import { english } from '@pi-kit/i18n/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  appSettingsSetSetting,
  appSettingsSettings,
  provideMockApi,
  settingsDiagnose,
  settingsListResources,
  settingsOverview,
  settingsPatch,
  settingsSaveKeybindings,
  settingsTrustList,
  settingsTrustState,
} from '@pi-kit/api';
import { ChatStore, VoiceStore } from '@pi-kit/chat/api';
import { ToastStore, UiStore } from '@pi-kit/data-access';
import type { SettingsOverview } from '@pi-kit/protocol';
import { fakeThreads, thread } from '@pi-kit/testing';
import { ThreadsStore, TrustStore } from '@pi-kit/threads/api';
import { ConnectorsStore } from './connectors.store';

import { SettingsStore, sectionOfTab } from './settings.store';

const overview = (): SettingsOverview =>
  ({
    settings: { defaultProvider: 'anthropic', defaultModel: 'opus', enabledModels: null },
    providers: [
      { id: 'anthropic', configured: true },
      { id: 'openai', configured: false },
    ],
    keybindings: [],
  }) as unknown as SettingsOverview;

describe('SettingsStore', () => {
  const api = {
    overview: vi.fn(async (cwd?: string) => {
      void cwd;
      return overview();
    }),
    patch: vi.fn(async (patch: Record<string, unknown>, cwd?: string) => {
      void cwd;
      return { defaultProvider: 'anthropic', defaultModel: 'opus', enabledModels: null, ...patch };
    }),
    resources: vi.fn(async () => ({ items: [{ key: 'a' }], projectSkipped: false, errors: [] })),
    diagnostics: vi.fn(async () => ({})),
    trustList: vi.fn(async () => ({})),
    saveKeybindings: vi.fn(),
  };
  const uiApi = { all: vi.fn(async () => ({})), set: vi.fn(async (key: string, value: unknown) => void [key, value]) };
  let threads: ReturnType<typeof fakeThreads>;

  const make = () => {
    const store = TestBed.inject(SettingsStore);
    TestBed.tick();
    return store;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    for (const fn of [...Object.values(api), uiApi.all, uiApi.set]) (fn as ReturnType<typeof vi.fn>).mockClear();
    threads = fakeThreads({ selected: thread('t1') });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        { provide: TrustStore, useValue: { answered: signal(0), review: vi.fn() } },
        { provide: ChatStore, useValue: { running: signal(false), reconnect: vi.fn() } },
        { provide: VoiceStore, useValue: { set: vi.fn(async () => true) } },
        { provide: ConnectorsStore, useValue: { servers: signal([{ name: 'a' }]) } },
        ...provideMockApi([
          [settingsOverview, api.overview, (o) => [o.query?.['cwd'], o.signal]],
          [settingsPatch, api.patch, (o) => [o.body, o.query?.['cwd']]],
          [settingsListResources, api.resources, (o) => [o.query?.['cwd'], o.signal]],
          [settingsDiagnose, api.diagnostics, () => []],
          [settingsTrustList, api.trustList, () => []],
          [settingsSaveKeybindings, api.saveKeybindings, (o) => [o.body?.['overrides']]],
          [appSettingsSettings, uiApi.all, () => []],
          [appSettingsSetSetting, uiApi.set, (o) => [o.path?.['key'], o.body?.['value']]],
          [settingsTrustState, { trust: vi.fn() }.trust, (o) => [o.path?.['id']]],
        ]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('opens on General, selects a section and clears the search', () => {
    const settings = make();
    expect(settings.section()).toBe('general');
    settings.setSearch('theme');
    expect(settings.searching()).toBe(true);
    settings.select('models');
    expect(settings.section()).toBe('models');
    expect(settings.search()).toBe('');
    expect(settings.visibleSections()).toEqual(['models']);
  });

  it('opens a project’s page over the Projects list and closes it again', () => {
    const settings = make();
    expect(settings.project()).toBeUndefined();
    settings.select('general');
    settings.openProject('/p/pi-kit');
    expect(settings.section()).toBe('projects');
    expect(settings.project()).toBe('/p/pi-kit');
    settings.closeProject();
    expect(settings.project()).toBeUndefined();
    expect(settings.section()).toBe('projects');
    // choosing another section leaves the page; a search shows the sections that match instead (the page is still open behind it)
    settings.openProject('/p/pi-kit');
    settings.select('models');
    expect(settings.project()).toBeUndefined();
    settings.openProject('/p/pi-kit');
    settings.setSearch('theme');
    expect(settings.searching()).toBe(true);
    expect(settings.visibleSections()).not.toContain('projects');
  });

  it('searching shows the sections that have a match', () => {
    const settings = make();
    settings.setSearch('font');
    expect(settings.visibleSections().length).toBeGreaterThan(0);
    expect(settings.matchCounts().size).toBeGreaterThan(0);
    settings.setSearch('zzzzqqqq');
    expect(settings.visibleSections()).toEqual([]);
  });

  it("load reads the overview for the thread's folder; a failure is the error", async () => {
    const settings = make();
    const loading = settings.load();
    expect(settings.loading()).toBe(true);
    await loading;
    expect(api.overview).toHaveBeenCalledWith('/a', expect.any(AbortSignal));
    expect(settings.providersSignedIn()).toBe(1);
    expect(settings.loading()).toBe(false);
    api.overview.mockRejectedValueOnce(new Error('pi is not running'));
    await settings.load();
    expect(settings.error()).toBe('pi is not running');
  });

  it('a pi setting shows at once, is saved, ends in the "Saved" tick and notes a reload when one is needed', async () => {
    const settings = make();
    await settings.load();
    const pending = settings.patch({ enabledModels: ['a/*'] }, 'the model scope');
    expect(settings.settings()?.enabledModels).toEqual(['a/*']);
    expect(settings.saving()).toBe(1);
    await pending;
    expect(api.patch).toHaveBeenCalledWith({ enabledModels: ['a/*'] }, '/a');
    expect(settings.saving()).toBe(0);
    expect(settings.saved()).toBe(true);
    expect(settings.reloadReasons()).toEqual(['the model scope']);
    await vi.advanceTimersByTimeAsync(2600);
    expect(settings.saved()).toBe(false);
  });

  it('a pi setting that cannot be saved is a toast, and the dialog reads pi again', async () => {
    const settings = make();
    await settings.load();
    api.patch.mockRejectedValueOnce(new Error('read-only file'));
    api.overview.mockClear();
    await settings.patch({ enabledModels: ['a/*'] });
    expect(TestBed.inject(ToastStore).items().at(-1)?.text).toBe('pi could not save the setting: read-only file');
    expect(api.overview).toHaveBeenCalledTimes(1);
    expect(settings.saved()).toBe(false);
  });

  it('a pi-kit preference goes to the database; when it refuses, a toast and the saved values are read back', async () => {
    const settings = make();
    await settings.setPref('proseSize', 16);
    expect(uiApi.set).toHaveBeenCalledWith('proseSize', 16);
    expect(settings.saved()).toBe(true);
    uiApi.set.mockRejectedValueOnce(new Error('db'));
    uiApi.all.mockClear();
    await settings.setPref('codeSize', 14);
    expect(TestBed.inject(ToastStore).items().at(-1)?.text).toMatch(/Could not save the setting/);
    expect(uiApi.all).toHaveBeenCalled();
  });

  it('the theme is saved through the theme store', async () => {
    const settings = make();
    await settings.setTheme('pi-light');
    expect(uiApi.set).toHaveBeenCalledWith('theme', 'pi-light');
    expect(settings.saved()).toBe(true);
  });

  it("opening Settings reads pi's settings and resources; closing it clears the search", async () => {
    const settings = make();
    const ui = TestBed.inject(UiStore);
    ui.openSettings('providers');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.section()).toBe('providers');
    expect(api.overview).toHaveBeenCalled();
    expect(api.resources).toHaveBeenCalled();
    settings.setSearch('x');
    ui.closeSettings();
    TestBed.tick();
    expect(settings.search()).toBe('');
  });

  it('exports only the keybindings that differ from the defaults', () => {
    const settings = make();
    const file = JSON.parse(settings.exportKeybindings()) as {
      format: string;
      'pi-kit': Record<string, string>;
      pi: Record<string, string[]>;
    };
    expect(file.format).toBe('pi-kit-keybindings');
    expect(file['pi-kit']).toEqual({});
    expect(file.pi).toEqual({});
  });

  it('maps settings shortcuts to sections and opens MCP servers from the sidebar’s count', () => {
    expect(sectionOfTab(english, 'connectors')).toBe('mcp');
    expect(sectionOfTab(english, 'mcp')).toBe('mcp');
    expect(sectionOfTab(english, 'attendant-activity')).toBe('attendant');
    const settings = make();
    const ui = TestBed.inject(UiStore);
    ui.openMcpPanel();
    TestBed.tick();
    expect(settings.section()).toBe('mcp');
  });

  it('the API-key workflow opens at "where to get a key" for a provider, and embedded when the Add a provider wizard hosts it', () => {
    const settings = make();
    settings.openKeyWorkflow('openrouter');
    expect(settings.keyWorkflow()).toEqual({ step: 2, provider: 'openrouter', phase: 'editing' });
    settings.openKeyWorkflow('openrouter', true);
    expect(settings.keyWorkflow()).toEqual({ step: 2, provider: 'openrouter', embedded: true, phase: 'editing' });
    settings.openKeyWorkflow();
    expect(settings.keyWorkflow()?.step).toBe(1);
    settings.closeKeyWorkflow();
    expect(settings.keyWorkflow()).toBeUndefined();
  });
  it('does not start sign-in after settings closes during its initial read', async () => {
    const settings = make();
    const ui = TestBed.inject(UiStore);
    const signIn = vi.spyOn(settings, 'signInTo');
    let finish!: (value: SettingsOverview) => void;
    api.overview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    ui.openSettings('providers', 'anthropic');
    TestBed.tick();
    ui.closeSettings();
    TestBed.tick();
    finish(overview());
    await vi.advanceTimersByTimeAsync(0);
    expect(signIn).not.toHaveBeenCalled();
    expect(settings.flow()).toBeUndefined();
  });

  it('regression: serializes settings saves and preserves newer optimistic edits', async () => {
    const settings = make();
    await settings.load();
    let finish!: (value: Awaited<ReturnType<typeof api.patch>>) => void;
    api.patch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = settings.patch({ defaultModel: { provider: 'first', modelId: 'old' } });
    api.patch.mockResolvedValueOnce({ defaultProvider: 'second', defaultModel: 'new', enabledModels: null });
    const second = settings.patch({ defaultModel: { provider: 'second', modelId: 'new' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(settings.settings()?.defaultModel).toBe('new');
    finish({ defaultProvider: 'first', defaultModel: 'old', enabledModels: null });
    await first;
    expect(settings.settings()?.defaultModel).toBe('new');
    await second;
    expect(api.patch).toHaveBeenCalledTimes(2);
  });

  it('regression: a save from a previous project cannot overwrite the current overview', async () => {
    const settings = make();
    await settings.load();
    let finish!: (value: Awaited<ReturnType<typeof api.patch>>) => void;
    api.patch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const saving = settings.patch({ defaultModel: { provider: 'first', modelId: 'old' } });
    await vi.advanceTimersByTimeAsync(0);
    threads.open(thread('t2', { cwd: '/b' }));
    await settings.load();
    finish({ defaultProvider: 'first', defaultModel: 'old', enabledModels: null });
    await saving;
    expect(settings.settings()?.defaultModel).toBe('opus');
  });

  it('retains the newest settings when a read started during a save finishes afterward', async () => {
    const settings = make();
    await settings.load();
    let finishRead!: (value: SettingsOverview) => void;
    api.overview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    api.patch.mockResolvedValueOnce({ defaultProvider: 'new', defaultModel: 'new', enabledModels: null });
    const saving = settings.patch({ defaultModel: { provider: 'new', modelId: 'new' } });
    const reading = settings.load();
    await saving;
    finishRead(overview());
    await reading;
    expect(settings.settings()?.defaultModel).toBe('new');
  });

  it('continues the settings queue after failure while retaining the newer optimistic edit', async () => {
    const settings = make();
    await settings.load();
    let fail!: (error: Error) => void;
    api.patch.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    api.patch.mockResolvedValueOnce({ defaultProvider: 'new', defaultModel: 'new', enabledModels: null });
    const first = settings.patch({ defaultModel: { provider: 'old', modelId: 'old' } });
    const second = settings.patch({ defaultModel: { provider: 'new', modelId: 'new' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.settings()?.defaultModel).toBe('new');
    fail(new Error('read-only file'));
    await first;
    expect(settings.settings()?.defaultModel).toBe('new');
    await second;
    expect(settings.settings()?.defaultModel).toBe('new');
    expect(settings.saving()).toBe(0);
  });

  it('keeps a queued settings write bound to the project where it was requested', async () => {
    const settings = make();
    await settings.load();
    let finish!: (value: Awaited<ReturnType<typeof api.patch>>) => void;
    api.patch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = settings.patch({ enabledModels: ['a/*'] });
    await vi.advanceTimersByTimeAsync(0);
    threads.open(thread('t2', { cwd: '/b' }));
    const second = settings.patch({ enabledModels: ['b/*'] });
    threads.open(thread('t3', { cwd: '/c' }));
    finish({ defaultProvider: 'a', defaultModel: 'a', enabledModels: null });
    await Promise.all([first, second]);
    expect(api.patch).toHaveBeenLastCalledWith({ enabledModels: ['b/*'] }, '/b');
  });
});
