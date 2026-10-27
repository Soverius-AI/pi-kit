import { LocalRuntimeStore } from '@pi-kit/settings/data';
import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import type { ProviderInfo, SettingsModel } from '@pi-kit/protocol';
import { LiteLlmStore, ProviderCardsStore, SecretsStore, SettingsStore } from '@pi-kit/settings/api';
import { LiteLlmConnectionPanel } from './litellm-connection';
import { AddProviderWizard } from './add-provider-wizard';

const provider = (over: Partial<ProviderInfo> & { id: string }): ProviderInfo => ({
  name: over.id,
  methods: ['api_key'],
  configured: false,
  stored: false,
  ...over,
});
const providers: ProviderInfo[] = [
  provider({ id: 'anthropic', name: 'Anthropic', methods: ['api_key', 'oauth'], subscription: true }),
  provider({
    id: 'openai',
    name: 'OpenAI',
    methods: ['api_key', 'oauth'],
    subscription: true,
    configured: true,
    stored: true,
    storedType: 'oauth',
  }),
  provider({ id: 'radius', name: 'Radius', methods: ['oauth'], subscription: true }),
  provider({ id: 'openrouter', name: 'OpenRouter' }),
];
const models: SettingsModel[] = [
  { provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Sonnet', reasoning: true, available: true },
  { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Haiku', reasoning: false, available: true },
  { provider: 'radius', id: 'radius-auto', name: 'Auto', reasoning: false, available: true },
];

/** The add-provider wizard reads the managed llama-swap from the runtime store; these tests keep it stopped and silent. */
const runtimeStub = {
  managed: () => undefined,
  submitting: () => false,
  observe: () => () => undefined,
  start: async () => undefined,
};

describe('AddProviderWizard', () => {
  const flow = signal<{ status: string } | undefined>(undefined);
  const keyWorkflow = signal<{ step: number; embedded?: boolean } | undefined>(undefined);
  const settings = signal<{ defaultModel: string | null }>({ defaultModel: 'gemma' });
  const store = {
    overview: signal({ providers, models }),
    settings,
    flow,
    keyWorkflow,
    // As the real store does: a sign-in has its flow at once, the key workflow its state, and cancelling or closing takes them away.
    login: vi.fn(async () => {
      flow.set({ status: 'running' });
    }),
    openKeyWorkflow: vi.fn((_provider?: string, embedded?: boolean) =>
      keyWorkflow.set({ step: 2, ...(embedded ? { embedded } : {}) }),
    ),
    cancelLogin: vi.fn(() => flow.set(undefined)),
    closeKeyWorkflow: vi.fn(() => keyWorkflow.set(undefined)),
    dismissFlow: vi.fn(() => flow.set(undefined)),
    patch: vi.fn(async () => undefined),
    load: vi.fn(async () => undefined),
  };
  const cards = {
    servers: signal<{ kind: string; baseUrl: string }[]>([]),
    local: signal<{ phase: string; saved?: { provider: string; models: number }; result?: unknown; error?: string }>({
      phase: 'idle',
    }),
    localUrl: signal(''),
    detecting: signal(false),
    detect: vi.fn(async () => undefined),
    resetLocal: vi.fn(),
    setLocalUrl: vi.fn(),
    testLocal: vi.fn(),
    saveLocal: vi.fn(),
  };
  const secrets = {
    status: signal({ available: true, label: 'macOS Keychain' }),
    loadStatus: vi.fn(async () => undefined),
  };

  const open = (
    entry: { method?: 'radius' | 'subscription' | 'api_key' | 'local' | 'litellm'; provider?: string } = {},
  ) => {
    const fixture = TestBed.createComponent(AddProviderWizard);
    fixture.componentRef.setInput('entry', entry);
    fixture.detectChanges();
    return fixture;
  };
  const root = (f: { nativeElement: unknown }): HTMLElement => f.nativeElement as HTMLElement;
  const q = (f: { nativeElement: unknown }, selector: string): HTMLElement | null =>
    root(f).querySelector<HTMLElement>(selector);
  const click = (f: ReturnType<typeof open>, selector: string): void => {
    q(f, selector)?.click();
    f.detectChanges();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    flow.set(undefined);
    keyWorkflow.set(undefined);
    settings.set({ defaultModel: 'gemma' });
    cards.servers.set([]);
    cards.local.set({ phase: 'idle' });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: LiteLlmStore,
          useValue: {
            load: async () => ({
              baseUrl: 'http://localhost:4000/v1',
              hasApiKey: false,
              configured: false,
              models: [],
            }),
          },
        },
        { provide: SettingsStore, useValue: store },
        { provide: ProviderCardsStore, useValue: cards },
        { provide: SecretsStore, useValue: secrets },
        { provide: LocalRuntimeStore, useValue: runtimeStub },
      ],
    });
  });

  it('starts with the provider connection choices to sign in, Radius outlined as the recommendation, and nothing chosen', () => {
    const f = open();
    expect(q(f, '[data-wstep=how]')).not.toBeNull();
    const ways = Array.from(root(f).querySelectorAll('.pk-choices button'));
    expect(ways.map((b) => b.getAttribute('data-testid'))).toEqual([
      'choice-radius',
      'choice-subscription',
      'choice-api_key',
      'choice-local',
      'choice-litellm',
    ]);
    expect(q(f, '[data-testid=choice-radius]')?.classList.contains('rec')).toBe(true);
    expect(q(f, '[data-testid=choice-radius]')?.textContent).toContain('recommended by pi');
    expect(q(f, '[data-testid=wizard-continue]')?.hasAttribute('disabled')).toBe(true);
    expect(root(f).querySelectorAll('.dots i.on')).toHaveLength(1);
    expect(root(f).querySelector('.foot .hint')?.textContent).toBe('Step 1 of 4, next: choose the provider');
  });

  it('completes LiteLLM setup only after saving, without an inference-success claim', async () => {
    const f = open({ method: 'litellm' });
    await f.whenStable();
    f.detectChanges();
    expect(q(f, '[data-testid=litellm-panel]')).not.toBeNull();
    expect(q(f, '[data-testid=wizard-continue]')).toBeNull();
    const panel = f.debugElement.query(By.directive(LiteLlmConnectionPanel))
      .componentInstance as LiteLlmConnectionPanel;
    panel.saved.emit();
    f.detectChanges();
    expect(q(f, '[data-testid=litellm-panel]')).toBeNull();
    expect(q(f, '[data-testid=provider-result]')?.textContent).toContain('Connection saved');
    expect(root(f).textContent).not.toContain('One request succeeded');
  });

  it('a subscription: lists the providers that offer one (not Radius), searches, signs in and ends with what was saved', async () => {
    const f = open();
    click(f, '[data-testid=choice-subscription]');
    expect(q(f, '[data-wstep=which]')).not.toBeNull();
    expect(Array.from(root(f).querySelectorAll('.pick button')).map((b) => b.getAttribute('data-provider'))).toEqual([
      'anthropic',
      'openai',
    ]);
    expect(q(f, '[data-provider=openai] .chip')?.textContent).toBe('signed in');
    const search = q(f, '[data-testid=which-search]') as HTMLInputElement;
    search.value = 'anth';
    search.dispatchEvent(new Event('input'));
    f.detectChanges();
    expect(root(f).querySelectorAll('.pick button')).toHaveLength(1);
    expect(q(f, '[data-testid=wizard-continue]')?.hasAttribute('disabled')).toBe(true);
    click(f, '[data-provider=anthropic]');
    expect(q(f, '[data-provider=anthropic]')?.getAttribute('aria-pressed')).toBe('true');
    expect(q(f, '[data-testid=wizard-continue]')?.textContent?.trim()).toBe('Sign in');
    click(f, '[data-testid=wizard-continue]');
    expect(store.login).toHaveBeenCalledWith('anthropic', 'oauth');
    expect(q(f, '[data-wstep=sign-in]')).not.toBeNull();
    // pi finishes the sign-in: the wizard moves on by itself
    flow.set({ status: 'done' });
    f.detectChanges();
    TestBed.tick();
    f.detectChanges();
    expect(store.dismissFlow).toHaveBeenCalled();
    expect(q(f, '[data-wstep=done]')).not.toBeNull();
    expect(q(f, '[data-testid=provider-result]')?.textContent).toContain('2 models');
    expect(q(f, '[data-testid=provider-result]')?.textContent).toContain('claude-sonnet-5-5, claude-haiku-5-5');
    // pi already has a default model: the switch starts off and stays the person's
    const toggle = q(f, '[data-testid=make-default] input') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    let closed = 0;
    f.componentInstance.closed.subscribe(() => closed++);
    click(f, '[data-testid=provider-done]');
    await f.whenStable();
    expect(store.patch).not.toHaveBeenCalled();
    expect(closed).toBe(1);
  });

  it('"Make … the default" sets pi’s default model, and starts on when pi has none', async () => {
    settings.set({ defaultModel: null });
    const f = open({ method: 'subscription', provider: 'anthropic' });
    click(f, '[data-testid=wizard-continue]');
    flow.set({ status: 'done' });
    f.detectChanges();
    TestBed.tick();
    f.detectChanges();
    const toggle = q(f, '[data-testid=make-default] input') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(q(f, '[data-testid=make-default]')?.textContent).toContain('claude-sonnet-5-5');
    click(f, '[data-testid=provider-done]');
    await f.whenStable();
    expect(store.patch).toHaveBeenCalledWith({ defaultModel: { provider: 'anthropic', modelId: 'claude-sonnet-5-5' } });
  });

  it('Radius goes straight to its sign-in, and a cancelled sign-in goes back to the list', () => {
    const f = open();
    click(f, '[data-testid=choice-radius]');
    expect(store.login).toHaveBeenCalledWith('radius', 'oauth');
    expect(q(f, '[data-wstep=sign-in]')).not.toBeNull();
    // the flow is cancelled in its own box
    flow.set(undefined);
    f.detectChanges();
    TestBed.tick();
    f.detectChanges();
    expect(q(f, '[data-wstep=how]')).not.toBeNull();
  });

  it('an API key hands the provider to the existing key workflow, embedded in this window', () => {
    const f = open();
    click(f, '[data-testid=choice-api_key]');
    click(f, '[data-provider=openrouter]');
    click(f, '[data-testid=wizard-continue]');
    expect(store.openKeyWorkflow).toHaveBeenCalledWith('openrouter', true);
    expect(root(f).querySelector('pk-key-workflow')).not.toBeNull();
    expect(store.login).not.toHaveBeenCalled();
  });

  it('opened from "Add a key instead" it starts at the list with the provider picked', () => {
    const f = open({ method: 'api_key', provider: 'openrouter' });
    expect(q(f, '[data-wstep=which]')).not.toBeNull();
    expect(q(f, '[data-provider=openrouter]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('a local model: detects the machine, offers what it found, and ends when the server is saved', () => {
    cards.servers.set([{ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }]);
    const f = open();
    click(f, '[data-testid=choice-local]');
    expect(cards.detect).toHaveBeenCalled();
    expect(q(f, '[data-testid=local-panel]')?.textContent).toContain('Found one server');
    click(f, '[data-testid=use-local]');
    expect(cards.saveLocal).toHaveBeenCalledWith('http://127.0.0.1:11434/v1');
    cards.local.set({ phase: 'idle', saved: { provider: 'ollama', models: 3 } });
    f.detectChanges();
    TestBed.tick();
    f.detectChanges();
    expect(q(f, '[data-wstep=done]')?.textContent).toContain('ollama is added');
    expect(q(f, '[data-testid=provider-result]')?.textContent).toContain('3 models');
  });

  it('Back slides the other way, and leaving the sign-in ends it', () => {
    const f = open();
    click(f, '[data-testid=choice-subscription]');
    click(f, '[data-provider=anthropic]');
    click(f, '[data-testid=wizard-continue]');
    click(f, '[data-testid=wizard-back]');
    expect(store.cancelLogin).toHaveBeenCalled();
    expect(q(f, '[data-wstep=which]')?.classList.contains('back')).toBe(true);
    click(f, '[data-testid=wizard-back]');
    expect(q(f, '[data-wstep=how]')?.classList.contains('back')).toBe(true);
  });

  it('Escape closes it and ends whatever was started', () => {
    const f = open();
    let closed = 0;
    f.componentInstance.closed.subscribe(() => closed++);
    q(f, '.win')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toBe(1);
    expect(store.cancelLogin).toHaveBeenCalled();
    expect(store.closeKeyWorkflow).toHaveBeenCalled();
  });
});
