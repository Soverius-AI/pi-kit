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
  settingsKeybindings,
  settingsProviders,
  settingsTrustList,
  settingsTrustState,
} from '@pi-kit/api';
import { ChatStore, VoiceStore } from '@pi-kit/chat/api';
import { ToastStore, UiStore } from '@pi-kit/data-access';
import type { ProviderInfo, SettingsOverview } from '@pi-kit/protocol';
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
    keybindings: vi.fn(async () => []),
    providers: vi.fn(async (): Promise<ProviderInfo[]> => overview().providers),
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
          [settingsKeybindings, api.keybindings, () => []],
          [settingsProviders, api.providers, () => []],
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
    expect(api.providers).toHaveBeenCalled();
    expect(api.resources).toHaveBeenCalled();
    expect(api.keybindings).toHaveBeenCalled();
    expect(api.overview).not.toHaveBeenCalled();
    settings.setSearch('x');
    ui.closeSettings();
    TestBed.tick();
    expect(settings.search()).toBe('');
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
    let finish!: (value: ProviderInfo[]) => void;
    api.providers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    ui.openSettings('providers', 'anthropic');
    TestBed.tick();
    ui.closeSettings();
    TestBed.tick();
    finish(overview().providers);
    await vi.advanceTimersByTimeAsync(0);
    expect(signIn).not.toHaveBeenCalled();
    expect(settings.flow()).toBeUndefined();
  });

  it('regression: a provider change resolves only after every open section read its slice again', async () => {
    const settings = make();
    let finish!: () => void;
    const refresh = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const leave = settings.onProvidersChanged(refresh);
    let done = false;
    const changed = settings.providersChanged().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(api.providers).toHaveBeenCalled();
    expect(done).toBe(false);
    finish();
    await changed;
    expect(done).toBe(true);
    leave();
    await settings.providersChanged();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
