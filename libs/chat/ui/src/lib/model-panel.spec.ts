import { TestBed } from '@angular/core/testing';
import type { ModelInfo, ModelProvider, ModelRef, ProviderUsage } from '@pi-kit/protocol';
import { FlaskIcon } from './flask-icon';
import { ModelPanel } from './model-panel';

const model = (provider: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  provider,
  id,
  name: id,
  contextWindow: 200_000,
  reasoning: false,
  levels: ['off'],
  ...extra,
});
const MODELS: ModelInfo[] = [
  model('anthropic', 'claude-sonnet-5-5', { reasoning: true, levels: ['off', 'low', 'medium', 'high'] }),
  model('anthropic', 'claude-haiku-5-5'),
  model('openrouter', 'gpt-5.2', { costInput: 1.25, costOutput: 10 }),
  model('llama-swap', 'gemma-4-26b', { default: true }),
];
const PROVIDERS: ModelProvider[] = [
  { id: 'anthropic', name: 'Anthropic', kind: 'subscription' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'api-key' },
  { id: 'llama-swap', name: 'llama-swap', kind: 'local', address: 'localhost:8080' },
];

interface Setup {
  pinned?: ModelRef[];
  usage?: Record<string, ProviderUsage | null>;
}

function draw(setup: Setup = {}) {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(ModelPanel);
  const set = (name: string, value: unknown): void => fixture.componentRef.setInput(name, value);
  set('models', MODELS);
  set('providers', PROVIDERS);
  set('pinned', setup.pinned ?? [{ provider: 'llama-swap', id: 'gemma-4-26b' }]);
  set('current', { provider: 'llama-swap', id: 'gemma-4-26b' });
  set('usage', setup.usage ?? {});
  const events = { pick: [] as ModelInfo[], pin: [] as ModelInfo[], dismiss: 0, manage: 0 };
  fixture.componentInstance.pick.subscribe((m) => events.pick.push(m));
  fixture.componentInstance.togglePin.subscribe((m) => events.pin.push(m));
  fixture.componentInstance.dismiss.subscribe(() => (events.dismiss += 1));
  fixture.componentInstance.manage.subscribe(() => (events.manage += 1));
  fixture.detectChanges();
  const root: HTMLElement = fixture.nativeElement;
  const search = root.querySelector<HTMLInputElement>('input[type="search"]') as HTMLInputElement;
  const type = (text: string): void => {
    search.value = text;
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const press = (key: string, init: KeyboardEventInit = {}): void => {
    search.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    fixture.detectChanges();
  };
  const rows = (): string[] =>
    Array.from(root.querySelectorAll('[data-testid="picker-row"]')).map((el) => el.getAttribute('data-model') ?? '');
  const sections = (): string[] =>
    Array.from(root.querySelectorAll('[data-testid="picker-section"]')).map(
      (el) => el.getAttribute('data-section') ?? '',
    );
  return { fixture, root, search, type, press, rows, sections, events };
}

describe('ModelPanel', () => {
  it('lists Pinned first and then a section per provider, with the pinned models taken out of theirs', () => {
    const { sections, rows, root } = draw();
    expect(sections()).toEqual(['pinned', 'provider:anthropic', 'provider:openrouter']);
    expect(rows()).toEqual([
      'llama-swap/gemma-4-26b',
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-haiku-5-5',
      'openrouter/gpt-5.2',
    ]);
    expect(root.querySelector('[data-testid="picker-pinned-count"]')?.textContent?.trim()).toBe('1 of 4');
  });

  it('says how the provider is signed in, the detail line, the badges and the price', () => {
    const { root } = draw();
    const text = root.textContent ?? '';
    expect(text).toContain('subscription');
    expect(text).toContain('API key');
    expect(root.querySelector('[data-model="llama-swap/gemma-4-26b"] .sub')?.textContent).toBe(
      'llama.cpp · 200k context · free',
    );
    expect(root.querySelector('[data-model="anthropic/claude-haiku-5-5"] .sub')?.textContent).toBe(
      '200k context · subscription',
    );
    expect(root.querySelector('[data-model="openrouter/gpt-5.2"] .sub')?.textContent).toBe(
      '200k context · $1.25 in / $10 out per 1M',
    );
    expect(root.querySelector('[data-model="llama-swap/gemma-4-26b"] .badges')?.textContent).toContain('default');
    expect(root.querySelector('[data-model="anthropic/claude-sonnet-5-5"] .badges')?.textContent).toContain('thinks');
  });

  it('shows usage in the heading of a provider that has it, and nothing for one that does not', () => {
    const { root } = draw({
      usage: {
        anthropic: {
          windows: [
            { name: '5 h', used: 38 },
            { name: 'week', used: 12 },
          ],
        },
        openrouter: { windows: [], credit: '$41.20' },
      },
    });
    const anthropic = root.querySelector('[data-section="provider:anthropic"] [data-testid="picker-usage"]');
    expect(Array.from(anthropic?.querySelectorAll('.w') ?? []).map((w) => w.textContent)).toEqual([
      '38 % of 5 h',
      '12 % of week',
    ]);
    expect((anthropic?.querySelector('.bar i') as HTMLElement).style.width).toBe('38%');
    expect(
      root.querySelector('[data-section="provider:openrouter"] [data-testid="picker-usage"]')?.textContent?.trim(),
    ).toBe('credit $41.20');
    const bare = draw();
    expect(bare.root.querySelectorAll('[data-testid="picker-usage"]').length).toBe(0);
  });

  it('shows the address of a local server where the usage would be', () => {
    const { root } = draw({ pinned: [] });
    expect(root.querySelector('[data-section="provider:llama.cpp"]')?.textContent).toContain('localhost:8080');
  });

  it('keeps an empty Pinned section that says what ⌘⇧M does', () => {
    const { root, sections } = draw({ pinned: [] });
    expect(sections()[0]).toBe('pinned');
    expect(root.querySelector('[data-testid="picker-pinned-empty"]')?.textContent).toContain('⌘⇧M cycles all 4 models');
  });

  it('filters by glob and fuzzy, hides sections with no match and counts what is left', () => {
    const { type, sections, rows, root } = draw();
    type('*gpt*');
    expect(sections()).toEqual(['provider:openrouter']);
    expect(rows()).toEqual(['openrouter/gpt-5.2']);
    expect(root.querySelector('[data-testid="picker-count"]')?.textContent?.trim()).toBe('1 model');
    type('zzzz-nothing');
    expect(sections()).toEqual([]);
    expect(root.textContent).toContain('No model matches.');
    expect(root.querySelector('[data-testid="picker-count"]')?.textContent?.trim()).toBe('0 models');
    type('');
    expect(rows()).toHaveLength(4);
    expect(root.querySelector('[data-testid="picker-count"]')?.textContent?.trim()).toBe('4 models');
  });

  it('starts on the current model, moves with the arrows (wrapping) and uses the highlighted one with ⏎', () => {
    const { press, events, root } = draw();
    expect(root.querySelector('.opt.active')?.getAttribute('data-model')).toBe('llama-swap/gemma-4-26b');
    press('ArrowDown');
    expect(root.querySelector('.opt.active')?.getAttribute('data-model')).toBe('anthropic/claude-sonnet-5-5');
    press('ArrowUp');
    press('ArrowUp');
    expect(root.querySelector('.opt.active')?.getAttribute('data-model')).toBe('openrouter/gpt-5.2');
    press('Enter');
    expect(events.pick.map((m) => m.id)).toEqual(['gpt-5.2']);
  });

  it('highlights the first match while searching, and ⇧⏎ toggles its pin instead of using it', () => {
    const { type, press, events, root } = draw();
    type('*haiku*');
    expect(root.querySelector('.opt.active')?.getAttribute('data-model')).toBe('anthropic/claude-haiku-5-5');
    press('Enter', { shiftKey: true });
    expect(events.pin.map((m) => m.id)).toEqual(['claude-haiku-5-5']);
    expect(events.pick).toEqual([]);
  });

  it('clicking a row uses it; clicking its pin toggles the pin and does not use the row', () => {
    const { root, fixture, events } = draw();
    (root.querySelector('[data-model="openrouter/gpt-5.2"]') as HTMLElement).click();
    expect(events.pick.map((m) => m.id)).toEqual(['gpt-5.2']);
    const pin = root.querySelector(
      '[data-model="anthropic/claude-haiku-5-5"] [data-testid="picker-pin"]',
    ) as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    expect(pin.getAttribute('aria-label')).toBe('Pin claude-haiku-5-5');
    pin.click();
    fixture.detectChanges();
    expect(events.pin.map((m) => m.id)).toEqual(['claude-haiku-5-5']);
    expect(events.pick.map((m) => m.id)).toEqual(['gpt-5.2']);
    const pinned = root.querySelector('[data-model="llama-swap/gemma-4-26b"] [data-testid="picker-pin"]');
    expect(pinned?.getAttribute('aria-pressed')).toBe('true');
    expect(pinned?.getAttribute('aria-label')).toBe('Unpin gemma-4-26b');
  });

  it('dismisses on Escape and opens Chat models from the foot; the foot says the change applies to the next message', () => {
    const { root, events, fixture } = draw();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(events.dismiss).toBe(1);
    (root.querySelector('[data-testid="picker-manage"]') as HTMLElement).click();
    expect(events.manage).toBe(1);
    expect(root.querySelector('.foot')?.textContent).toContain('Applies to the next message.');
    fixture.componentRef.setInput('running', true);
    fixture.detectChanges();
    expect(root.querySelector('.foot')?.textContent).toContain('A change applies to the next request.');
  });
});

describe('FlaskIcon', () => {
  it('draws no markup of its own and carries the level for the stylesheet', () => {
    TestBed.resetTestingModule();
    const fixture = TestBed.createComponent(FlaskIcon);
    fixture.componentRef.setInput('level', 'xhigh');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.classList).toContain('pk-flask');
    expect(el.getAttribute('data-level')).toBe('xhigh');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.childElementCount).toBe(0);
  });
});
