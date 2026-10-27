import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideMockApi,
  setupDetect,
  setupReady,
  setupSaveLocal,
  setupScratch,
  setupState,
  setupTestLocal,
} from '@pi-kit/api';
import { UiStore } from '@pi-kit/data-access';
import type { SettingsOverview, SetupInfo } from '@pi-kit/protocol';
import { SettingsStore } from '@pi-kit/settings/api';
import { ThreadsStore } from '@pi-kit/threads/api';
import { OnboardingStore } from './onboarding.store';

const info = (over: Partial<SetupInfo> = {}): SetupInfo => ({
  os: { platform: 'darwin', arch: 'arm64', release: '25' },
  pi: { version: '1.3.0', source: 'bundled' },
  pathPi: { found: false },
  agentDir: {
    path: '/home/a/.pi/agent',
    exists: false,
    auth: [],
    hasModelsJson: false,
    hasSettings: false,
    sessionCount: 0,
  },
  providers: [],
  localServers: [
    {
      kind: 'llama-swap',
      name: 'llama-swap or llama.cpp',
      baseUrl: 'http://127.0.0.1:8080/v1',
      models: ['gemma', 'llama'],
    },
  ],
  needsSetup: true,
  existingSetupWorks: false,
  autoOpenOff: false,
  ...over,
});

const model = (provider: string, id: string, reasoning = false) => ({
  provider,
  id,
  name: id,
  reasoning,
  available: true,
  contextWindow: 100_000,
});

describe('OnboardingStore', () => {
  let overview: ReturnType<typeof signal<SettingsOverview | undefined>>;
  const api = {
    detect: vi.fn(async () => info()),
    setState: vi.fn(async (state: string) => ({ state, at: 1 })),
    testLocal: vi.fn(async (baseUrl: string) => ({
      ok: true,
      kind: 'llama-swap' as const,
      baseUrl,
      models: ['gemma', 'llama'],
    })),
    saveLocal: vi.fn(async (provider: string, _url: string, models: string[]) => ({
      provider,
      models: models.length,
      path: '/m.json',
    })),
    scratch: vi.fn(async () => ({ path: '/data/scratch/try-1' })),
    ready: vi.fn(async (provider: string, modelId: string) => ({
      ok: true,
      model: `${provider}/${modelId}`,
      message: 'ok',
      ms: 400,
    })),
  };
  const settings = {
    overview: undefined as unknown as typeof overview,
    settings: undefined as unknown as ReturnType<typeof signal<SettingsOverview['settings'] | undefined>>,
    load: vi.fn(async () => undefined),
    patch: vi.fn(async () => undefined),
    setScope: vi.fn(async () => undefined),
    login: vi.fn(async () => undefined),
    openKeyWorkflow: vi.fn(),
  };
  const threads = {
    openWorkspace: vi.fn(async () => undefined),
    create: vi.fn(async (cwd: string) => ({ id: 't-1', cwd })),
    select: vi.fn(),
  };

  const make = () => {
    const store = TestBed.inject(OnboardingStore);
    TestBed.tick();
    return store;
  };

  beforeEach(() => {
    overview = signal<SettingsOverview | undefined>({
      settings: {},
      providers: [],
      models: [],
      keybindings: [],
      piVersion: '1.3.0',
    } as unknown as SettingsOverview);
    settings.overview = overview;
    settings.settings = signal<SettingsOverview['settings'] | undefined>({
      defaultProvider: null,
      defaultModel: null,
      defaultThinkingLevel: null,
      autoCompaction: true,
      enabledModels: null,
    } as never);
    for (const fn of [
      ...Object.values(api),
      settings.load,
      settings.patch,
      settings.setScope,
      settings.login,
      settings.openKeyWorkflow,
      threads.openWorkspace,
      threads.create,
      threads.select,
    ])
      (fn as ReturnType<typeof vi.fn>).mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsStore, useValue: settings },
        { provide: ThreadsStore, useValue: threads },
        ...provideMockApi([
          [setupDetect, api.detect, (o) => [o.signal]],
          [setupState, api.setState, (o) => [o.body?.['state']]],
          [setupTestLocal, api.testLocal, (o) => [o.body?.['baseUrl']]],
          [setupSaveLocal, api.saveLocal, (o) => [o.body?.['provider'], o.body?.['baseUrl'], o.body?.['models']]],
          [setupScratch, api.scratch, () => []],
          [setupReady, api.ready, (o) => [o.body?.['provider'], o.body?.['modelId']]],
        ]),
      ],
    });
  });

  it('starts from the Welcome card with fresh facts when the switch turns on', async () => {
    const store = make();
    expect(store.open()).toBe(false);
    TestBed.inject(UiStore).openOnboarding();
    TestBed.tick();
    await vi.waitFor(() => expect(store.info()).toBeDefined());
    expect(store.open()).toBe(true);
    expect(store.step()).toBe('welcome');
    expect(api.detect).toHaveBeenCalledOnce();
    expect(settings.load).toHaveBeenCalledOnce();
    expect(store.servers()).toHaveLength(1);
    // The address field starts with the first server found.
    expect(store.localUrl()).toBe('http://127.0.0.1:8080/v1');
  });

  it('goes through the five steps and back, with the rail showing done, now and to do', () => {
    const store = make();
    expect(store.steps().map((s) => s.state)).toEqual(['now', 'todo', 'todo', 'todo', 'todo']);
    store.next();
    store.next();
    expect(store.step()).toBe('defaults');
    expect(store.steps().map((s) => s.state)).toEqual(['done', 'done', 'now', 'todo', 'todo']);
    expect(store.stepNumber()).toBe(3);
    store.back();
    expect(store.step()).toBe('model');
    store.go('folder');
    store.next();
    expect(store.step()).toBe('prompt');
    store.next();
    expect(store.step()).toBe('prompt');
  });

  it('docks the last step into the real chat page: it is a strip, not a card, and only while the flow is open', () => {
    const store = make();
    const ui = TestBed.inject(UiStore);
    store.go('prompt');
    expect(store.docked()).toBe(false);
    ui.openOnboarding();
    expect(store.docked()).toBe(true);
  });

  it('skipping and finishing close the flow and record which it was', async () => {
    const store = make();
    const ui = TestBed.inject(UiStore);
    ui.openOnboarding();
    await store.skip();
    expect(ui.onboarding()).toBe(false);
    expect(api.setState).toHaveBeenLastCalledWith('skipped');
    ui.openOnboarding();
    store.useExisting();
    expect(ui.onboarding()).toBe(true);
    expect(store.step()).toBe('defaults');
    await store.finish();
    expect(ui.onboarding()).toBe(false);
    expect(api.setState).toHaveBeenLastCalledWith('completed');
  });

  it('adds a detected local server under the name of its product, with every model it lists, and reads pi’s models again', async () => {
    const store = make();
    await store.detect();
    await store.saveLocal('http://127.0.0.1:8080/v1');
    expect(api.saveLocal).toHaveBeenCalledWith('llama-swap', 'http://127.0.0.1:8080/v1', ['gemma', 'llama']);
    expect(store.local().saved).toEqual({ provider: 'llama-swap', models: 2 });
    expect(settings.load).toHaveBeenCalled();
  });

  it('says so when a server lists no model, and writes nothing', async () => {
    api.testLocal.mockResolvedValueOnce({ ok: true, kind: 'openai', baseUrl: 'http://box:9/v1', models: [] } as never);
    const store = make();
    await store.saveLocal('http://box:9/v1');
    expect(api.saveLocal).not.toHaveBeenCalled();
    expect(store.local().error).toMatch(/lists no model/);
  });

  it('tests an address and keeps the answer, or the reason it did not answer', async () => {
    const store = make();
    store.setLocalUrl('127.0.0.1:8080');
    await store.testLocal();
    expect(api.testLocal).toHaveBeenCalledWith('127.0.0.1:8080');
    expect(store.local().result?.models).toEqual(['gemma', 'llama']);
    api.testLocal.mockResolvedValueOnce({
      ok: false,
      baseUrl: 'http://127.0.0.1:9/v1',
      models: [],
      error: 'Nothing is listening there.',
    } as never);
    store.setLocalUrl('127.0.0.1:9');
    await store.testLocal();
    expect(store.local().error).toBe('Nothing is listening there.');
  });

  it('picks a default model when pi has none, never when it has one, and splits provider and id at the first slash', async () => {
    const store = make();
    overview.set({
      settings: {},
      providers: [],
      models: [model('openrouter', 'anthropic/claude-5'), model('llama-swap', 'gemma')],
      keybindings: [],
      piVersion: '1',
    } as unknown as SettingsOverview);
    await store.prepareDefaults();
    expect(settings.patch).toHaveBeenCalledWith({
      defaultModel: { provider: 'openrouter', modelId: 'anthropic/claude-5' },
    });
    settings.patch.mockClear();
    settings.settings.set({
      defaultProvider: 'llama-swap',
      defaultModel: 'gemma',
      defaultThinkingLevel: 'off',
      autoCompaction: true,
      enabledModels: null,
    } as never);
    await store.prepareDefaults();
    expect(settings.patch).not.toHaveBeenCalled();
    await store.chooseModel('openrouter/anthropic/claude-5');
    expect(settings.patch).toHaveBeenCalledWith({
      defaultModel: { provider: 'openrouter', modelId: 'anthropic/claude-5' },
    });
  });

  it('offers the effort levels of a model that thinks and only "off" for one that does not', () => {
    const store = make();
    overview.set({
      settings: {},
      providers: [],
      models: [model('p', 'plain'), model('p', 'thinker', true)],
      keybindings: [],
      piVersion: '1',
    } as unknown as SettingsOverview);
    settings.settings.set({
      defaultProvider: 'p',
      defaultModel: 'plain',
      defaultThinkingLevel: 'off',
      autoCompaction: true,
      enabledModels: null,
    } as never);
    expect(store.defaults().levels).toEqual(['off']);
    expect(store.defaults().reasoning).toBe(false);
    settings.settings.set({
      defaultProvider: 'p',
      defaultModel: 'thinker',
      defaultThinkingLevel: 'high',
      autoCompaction: true,
      enabledModels: null,
    } as never);
    expect(store.defaults().levels).toContain('high');
    expect(store.defaults().effort).toBe('high');
  });

  it('scopes models for the ⌘⇧M cycle one at a time, and none checked clears the scope', async () => {
    const store = make();
    settings.settings.set({
      defaultProvider: null,
      defaultModel: null,
      defaultThinkingLevel: null,
      autoCompaction: true,
      enabledModels: ['p/a'],
    } as never);
    await store.togglePinned('p/b', true);
    expect(settings.setScope).toHaveBeenLastCalledWith(['p/a', 'p/b']);
    await store.togglePinned('p/a', false);
    expect(settings.setScope).toHaveBeenLastCalledWith([]);
  });

  it('opens the scratch folder as a project and remembers that it is one', async () => {
    const store = make();
    await store.useScratch();
    expect(threads.openWorkspace).toHaveBeenCalledWith('/data/scratch/try-1');
    expect(store.folder()).toMatchObject({ opened: '/data/scratch/try-1', scratch: true });
    expect(store.prompts()[0]).toMatch(/Fibonacci/);
  });

  it('reports a folder that cannot be opened and stays on the card', async () => {
    threads.openWorkspace.mockRejectedValueOnce(new Error('There is no folder /nope'));
    const store = make();
    store.setFolderPath('/nope');
    await store.openFolder();
    expect(store.folder()).toMatchObject({ phase: 'idle', error: 'There is no folder /nope' });
    expect(store.folder().opened).toBeUndefined();
  });

  it('enters the last step by opening a thread in the folder and asking pi once through the default model', async () => {
    const store = make();
    overview.set({
      settings: {},
      providers: [],
      models: [model('llama-swap', 'gemma')],
      keybindings: [],
      piVersion: '1',
    } as unknown as SettingsOverview);
    settings.settings.set({
      defaultProvider: 'llama-swap',
      defaultModel: 'gemma',
      defaultThinkingLevel: 'off',
      autoCompaction: true,
      enabledModels: null,
    } as never);
    store.setFolderPath('/p');
    await store.openFolder();
    await store.enterPrompt();
    expect(threads.create).toHaveBeenCalledWith('/p');
    expect(threads.select).toHaveBeenCalledWith('t-1');
    expect(api.ready).toHaveBeenCalledWith('llama-swap', 'gemma');
    expect(store.ready()).toEqual({
      phase: 'done',
      result: { ok: true, model: 'llama-swap/gemma', message: 'ok', ms: 400 },
    });
  });

  it('shows why pi is not ready, and the check can run again', async () => {
    api.ready.mockResolvedValueOnce({ ok: false, model: 'p/m', message: '401: User not found.', ms: 90 });
    const store = make();
    settings.settings.set({
      defaultProvider: 'p',
      defaultModel: 'm',
      defaultThinkingLevel: 'off',
      autoCompaction: true,
      enabledModels: null,
    } as never);
    overview.set({
      settings: {},
      providers: [],
      models: [model('p', 'm')],
      keybindings: [],
      piVersion: '1',
    } as unknown as SettingsOverview);
    await store.checkReady();
    expect(store.ready()).toMatchObject({ phase: 'done', result: { ok: false, message: '401: User not found.' } });
    await store.checkReady();
    expect(store.ready()).toMatchObject({ phase: 'done', result: { ok: true } });
  });

  it('puts a suggested prompt into the real composer and focuses it', () => {
    const store = make();
    const ui = TestBed.inject(UiStore);
    store.usePrompt('Explain this project.');
    expect(ui.composerText()?.text).toBe('Explain this project.');
    expect(ui.composerFocus()).toBe(1);
  });

  it('forwards the provider cards to Settings’ own sign-in and key workflow', async () => {
    const store = make();
    await store.signInRadius();
    expect(settings.login).toHaveBeenCalledWith('radius', 'oauth');
    store.setSubscription('openai');
    await store.signInSubscription();
    expect(settings.login).toHaveBeenLastCalledWith('openai', 'oauth');
    store.addKey();
    expect(settings.openKeyWorkflow).toHaveBeenCalledOnce();
  });
});
