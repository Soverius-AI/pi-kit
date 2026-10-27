import { LocalRuntimeStore } from '@pi-kit/settings/data';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideMockApi, usageGet } from '@pi-kit/api';
import type { ProviderInfo, SettingsModel } from '@pi-kit/protocol';
import { ToastStore } from '@pi-kit/data-access';
import { ProviderCardsStore, SecretsStore, SettingsStore } from '@pi-kit/settings/api';
import { ProvidersSection } from './providers-section';

const NOW = Date.now();
const provider = (over: Partial<ProviderInfo> & { id: string }): ProviderInfo => ({
  name: over.id,
  methods: ['api_key'],
  configured: false,
  stored: false,
  ...over,
});
const providers: ProviderInfo[] = [
  provider({
    id: 'anthropic',
    name: 'Anthropic',
    methods: ['api_key', 'oauth'],
    subscription: true,
    configured: true,
    stored: true,
    storedType: 'oauth',
    credential: { type: 'oauth', store: 'auth.json', addedAt: NOW - 3 * 86_400_000 },
    usage: { windows: [{ name: '5-hour window', used: 38, resets: '14:30' }] },
  }),
  provider({
    id: 'openrouter',
    name: 'OpenRouter',
    configured: true,
    stored: true,
    storedType: 'api_key',
    credential: { type: 'api_key', store: 'keychain', lastFour: 'a1b2', addedAt: NOW },
  }),
  provider({ id: 'llama-swap', name: 'llama-swap', methods: [], configured: true, source: 'models_json_key' }),
  provider({ id: 'google', name: 'Google', configured: true, source: 'environment', label: 'GEMINI_API_KEY' }),
  provider({ id: 'mistral', name: 'Mistral' }),
];
const models: SettingsModel[] = ['a', 'b'].map((id) => ({
  provider: 'anthropic',
  id,
  name: id,
  reasoning: false,
  available: true,
}));

/** The add-provider wizard reads the managed llama-swap from the runtime store; these tests keep it stopped and silent. */
const runtimeStub = {
  managed: () => undefined,
  submitting: () => false,
  observe: () => () => undefined,
  start: async () => undefined,
};

describe('ProvidersSection', () => {
  const overview = signal<{ providers: ProviderInfo[]; models: SettingsModel[] } | undefined>({ providers, models });
  const store = {
    overview,
    settings: signal({ agentDir: '/agent' }),
    error: signal(''),
    logout: vi.fn(),
    removeProvider: vi.fn(async () => true),
    openKeyWorkflow: vi.fn(),
    flow: signal(undefined),
    keyWorkflow: signal(undefined),
    shows: () => true,
    cancelLogin: vi.fn(),
    closeKeyWorkflow: vi.fn(),
    dismissFlow: vi.fn(),
    login: vi.fn(),
    patch: vi.fn(),
  };
  const cards = {
    servers: signal([{ kind: 'llama-swap', baseUrl: 'http://localhost:8080/v1' }]),
    local: signal({ phase: 'idle' }),
    localUrl: signal(''),
    detecting: signal(false),
    detect: vi.fn(async () => undefined),
    resetLocal: vi.fn(),
  };
  const secrets = {
    status: signal({ available: true, label: 'macOS Keychain', movable: [] as string[] }),
    loadStatus: vi.fn(async () => undefined),
    moved: signal(undefined),
    moving: signal(false),
  };
  const toasts = { show: vi.fn() };
  const balances: Record<string, unknown> = {};
  const usage = vi.fn(async (id: string, refresh: unknown) => {
    void refresh;
    return balances[id] ?? providers.find((p) => p.id === id)?.usage ?? null;
  });

  const render = () => {
    const fixture = TestBed.createComponent(ProvidersSection);
    fixture.detectChanges();
    return fixture;
  };
  const el = (f: { nativeElement: unknown }): HTMLElement => f.nativeElement as HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    overview.set({ providers, models });
    for (const key of Object.keys(balances)) delete balances[key];
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: ProviderCardsStore, useValue: cards },
        { provide: SecretsStore, useValue: secrets },
        { provide: LocalRuntimeStore, useValue: runtimeStub },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi([[usageGet, usage, (o) => [o.path?.['id'], o.query?.['refresh']]]]),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('fetches Radius credit and reconciles a top-up when the window regains focus', async () => {
    overview.set({
      providers: [provider({ id: 'radius', configured: true, stored: true, storedType: 'oauth' })],
      models: [],
    });
    balances['radius'] = { windows: [], credit: '$3.00' };
    const f = render();
    f.autoDetectChanges();
    await f.whenStable();
    await vi.waitFor(() => {
      f.detectChanges();
      expect(el(f).querySelector('[data-provider=radius]')?.textContent).toContain('$3.00');
    });
    balances['radius'] = { windows: [], credit: '$23.00' };
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(async () => {
      await f.whenStable();
      expect(el(f).querySelector('[data-provider=radius]')?.textContent).toContain('$23.00');
    });
    expect(usage).toHaveBeenLastCalledWith('radius', '1');
  });

  it('polls credits while mounted and stops when the Providers page is destroyed', async () => {
    overview.set({ providers: [provider({ id: 'radius', configured: true, stored: true })], models: [] });
    balances['radius'] = { windows: [], credit: '$3.00' };
    const f = render();
    f.autoDetectChanges();
    f.componentRef.setInput('usageRefreshMs', 20);
    await f.whenStable();
    balances['radius'] = { windows: [], credit: '$2.00' };
    await vi.waitFor(async () => {
      await f.whenStable();
      expect(el(f).querySelector('[data-provider=radius]')?.textContent).toContain('$2.00');
    });
    f.destroy();
    const calls = usage.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(usage).toHaveBeenCalledTimes(calls);
  });

  it('lists only what is signed in, as rows with a chip, the model count and the credential line', () => {
    const f = render();
    const rows = Array.from(
      el(f).querySelectorAll('[data-testid=section-providers] section[aria-label=Providers] .pk-item'),
    );
    expect(rows.map((r) => r.getAttribute('data-provider'))).toEqual(['anthropic', 'openrouter', 'llama-swap']);
    const openrouter = el(f).querySelector('[data-provider=openrouter]') as HTMLElement;
    expect(openrouter.querySelector('.chip')?.textContent).toBe('API key');
    expect(openrouter.querySelector<HTMLImageElement>('.tile img')?.getAttribute('src')).toBe(
      '/provider-logos/openrouter.svg',
    );
    expect(openrouter.querySelector('[data-testid=credential-line]')?.textContent).toBe(
      'key ending in a1b2 · keychain (macOS Keychain) · added today',
    );
    expect(el(f).querySelector('[data-provider=anthropic] .cnt')?.textContent).toBe('2 models');
    expect(el(f).querySelector('[data-provider=llama-swap] [data-testid=credential-line]')?.textContent).toContain(
      'http://localhost:8080/v1',
    );
    // a provider that is not signed in is not on the page; it is in the wizard
    expect(el(f).querySelector('[data-provider=mistral]')).toBeNull();
  });

  it('puts model-specific llama-swap connections in one collapsed llama.cpp provider group', () => {
    const local = [
      provider({ id: 'ds4', name: 'DeepSeek (llama-swap)', configured: true, source: 'models_json_key', methods: [] }),
      provider({ id: 'glm', name: 'GLM (llama-swap)', configured: true, source: 'models_json_key', methods: [] }),
    ];
    overview.set({
      providers: local,
      models: local.map((connection) => ({
        provider: connection.id,
        id: 'shared-model',
        name: 'Shared',
        available: true,
        reasoning: false,
      })),
    });
    const f = render(),
      group = el(f).querySelector<HTMLDetailsElement>('[data-provider-group="llama.cpp"]');
    expect(group?.open).toBe(false);
    expect(group?.querySelector('summary')?.textContent?.replace(/\s+/g, ' ')).toMatch(/2 models.*2 connections/);
    expect(group?.querySelector<HTMLImageElement>('.llama-mark img')?.getAttribute('src')).toBe(
      '/provider-logos/llama-cpp.svg',
    );
    expect(el(f).querySelector('section[aria-label=Providers] header p')?.textContent).toContain('1 provider.');
    expect([...group!.querySelectorAll('[data-provider]')].map((row) => row.getAttribute('data-provider'))).toEqual([
      'ds4',
      'glm',
    ]);
    expect(group?.querySelector('[data-provider=ds4] .tile img')?.getAttribute('src')).toBe(
      '/provider-logos/deepseek.svg',
    );
    expect(group?.querySelector('[data-provider=glm] .tile img')?.getAttribute('src')).toBe('/provider-logos/zai.svg');
    expect(group?.querySelector('[data-provider=ds4] .nm')?.textContent).toContain('· llama-swap');
    expect(group?.querySelector('[aria-label="Edit DeepSeek (llama-swap)"]')).toBeTruthy();
    expect(group?.querySelector('[aria-label="Test the connection to GLM (llama-swap)"]')).toBeTruthy();
  });

  it('uses a generic tile for unknown local endpoints rather than guessing a brand', () => {
    overview.set({
      providers: [
        provider({
          id: 'custom-engine',
          name: 'My server (llama-swap)',
          configured: true,
          source: 'models_json_key',
          methods: [],
        }),
      ],
      models: [],
    });
    const f = render();
    const tile = el(f).querySelector('[data-provider=custom-engine] .tile');
    expect(tile?.textContent).toBe('MS');
    expect(tile?.querySelector('img')).toBeNull();
  });

  it('recognizes branded account provider IDs without guessing from arbitrary names', () => {
    overview.set({
      providers: [
        provider({ id: 'openai', name: 'OpenAI', configured: true, stored: true, storedType: 'api_key' }),
        provider({ id: 'github-copilot', name: 'GitHub Copilot', configured: true, stored: true, storedType: 'oauth' }),
      ],
      models: [],
    });
    const f = render();
    expect(el(f).querySelector('[data-provider=openai] .tile img')?.getAttribute('src')).toBe(
      '/provider-logos/openai.svg',
    );
    expect(el(f).querySelector('[data-provider=github-copilot] .tile img')?.getAttribute('src')).toBe(
      '/provider-logos/githubcopilot.svg',
    );
  });

  it('shows a usage bar when the provider reports usage, and none otherwise', () => {
    const f = render();
    expect(el(f).querySelector('[data-provider=anthropic] pk-quota')?.getAttribute('aria-label')).toBe(
      '5-hour window 38 %, resets 14:30',
    );
    expect(el(f).querySelector('[data-provider=openrouter] pk-quota')).toBeNull();
  });

  it('every icon-only button has a name and a tooltip, and the actions do what they say', () => {
    const f = render();
    const buttons = Array.from(el(f).querySelectorAll<HTMLButtonElement>('.pk-item .act button.btn-square'));
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Sign out of Anthropic',
      'Change the key for OpenRouter',
      'Remove the key for OpenRouter',
      'Test the connection to llama-swap',
      'Edit llama-swap',
      'Remove llama-swap',
    ]);
    el(f).querySelector<HTMLButtonElement>('[aria-label="Sign out of Anthropic"]')?.click();
    expect(store.logout).toHaveBeenCalledWith('anthropic');
    el(f).querySelector<HTMLButtonElement>('[aria-label="Change the key for OpenRouter"]')?.click();
    expect(store.openKeyWorkflow).toHaveBeenCalledWith('openrouter');
    el(f).querySelector<HTMLButtonElement>('[aria-label="Remove the key for OpenRouter"]')?.click();
    expect(store.logout).toHaveBeenCalledWith('openrouter');
  });

  it('requires confirmation to remove LiteLLM; cancel does nothing and failures keep the confirmation', async () => {
    overview.set({
      providers: [provider({ id: 'litellm', name: 'LiteLLM', configured: true, source: 'models_json_key' })],
      models: [],
    });
    const f = render();
    const click = (selector: string) => {
      el(f).querySelector<HTMLButtonElement>(selector)!.click();
      f.detectChanges();
    };
    click('[aria-label="Remove LiteLLM"]');
    const modal = el(f).querySelector('[data-testid=remove-provider-confirm]')!;
    expect(modal.textContent).toContain('Remove LiteLLM?');
    expect(modal.getAttribute('role')).toBe('alertdialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(store.removeProvider).not.toHaveBeenCalled();
    const cancel = [...el(f).querySelectorAll<HTMLButtonElement>('[data-testid=remove-provider-confirm] button')].find(
      (b) => b.textContent?.trim() === 'Cancel',
    )!;
    cancel.click();
    f.detectChanges();
    expect(el(f).querySelector('[data-testid=remove-provider-confirm]')).toBeNull();
    expect(store.removeProvider).not.toHaveBeenCalled();
    click('[aria-label="Remove LiteLLM"]');
    el(f)
      .querySelector('[data-testid=remove-provider-confirm]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    f.detectChanges();
    expect(el(f).querySelector('[data-testid=remove-provider-confirm]')).toBeNull();
    expect(store.removeProvider).not.toHaveBeenCalled();
    click('[aria-label="Remove LiteLLM"]');
    store.removeProvider.mockResolvedValueOnce(false);
    click('[data-testid=remove-provider-yes]');
    await f.whenStable();
    f.detectChanges();
    expect(el(f).querySelector('[data-testid=remove-provider-confirm]')).not.toBeNull();
    click('[data-testid=remove-provider-yes]');
    await f.whenStable();
    f.detectChanges();
    expect(store.removeProvider).toHaveBeenLastCalledWith('litellm');
    expect(el(f).querySelector('[data-testid=remove-provider-confirm]')).toBeNull();
  });

  it('"Test the connection" looks at the machine again and says whether the server answers', async () => {
    const f = render();
    el(f).querySelector<HTMLButtonElement>('[aria-label="Test the connection to llama-swap"]')?.click();
    await f.whenStable();
    expect(cards.detect).toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledWith('success', 'llama-swap answers at http://localhost:8080/v1.');
  });

  it('lists the keys from the environment on their own, read only, with "Add a key instead"', () => {
    const f = render();
    const group = el(f).querySelector('[data-testid=environment-keys]') as HTMLElement;
    expect(group.textContent).toContain('Keys from the environment');
    expect(group.querySelector('.pk-item .chip.off')?.textContent).toContain('GEMINI_API_KEY');
    expect(group.querySelector('[data-testid=add-key-instead-google]')?.textContent?.trim()).toBe('Add a key instead');
  });

  it('has no "Add a provider" group on the page: the "+" in the header is the way in', () => {
    const f = render();
    expect(el(f).querySelector('pk-get-model')).toBeNull();
    expect(el(f).querySelector('[data-setting=provider-cards]')).toBeNull();
    const add = el(f).querySelector('[data-testid=add-provider]') as HTMLElement;
    expect(add.classList.contains('btn-primary') && add.classList.contains('btn-square')).toBe(true);
    expect(add.getAttribute('aria-label')).toBe('Add a provider');
  });

  it('the "+" opens the wizard, and "Add a key instead" opens it on that provider', async () => {
    const f = render();
    el(f).querySelector<HTMLButtonElement>('[data-testid=add-provider]')?.click();
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
    expect(el(f).querySelector('pk-add-provider-wizard [data-wstep=how]')).not.toBeNull();
  });

  it('an empty list is an invitation with the same "+"', () => {
    overview.set({ providers: [providers[4]], models: [] });
    const f = render();
    expect(el(f).querySelector('[data-testid=providers-empty]')?.textContent).toContain(
      'No providers yet. Add one to get models.',
    );
  });
});
