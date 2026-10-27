import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SettingsStore } from '@pi-kit/settings/data';
import { UpdateStore } from '@pi-kit/update/api';
import { ModelsSection } from './models-section';

const ids = ['default-model', 'default-effort', 'pinned-models', 'price-table', 'pi-update'];
const facts = () => ({
  settings: {
    defaultProvider: 'fixture',
    defaultModel: 'alpha',
    defaultThinkingLevel: 'low',
    enabledModels: ['fixture/alpha', 'fixture/beta'],
  },
  providers: [
    { id: 'fixture', name: 'Fixture' },
    { id: 'other', name: 'Other provider' },
  ],
  models: [
    { provider: 'fixture', id: 'alpha', name: 'Alpha', available: true, reasoning: true, contextWindow: 8192 },
    { provider: 'fixture', id: 'beta', name: 'Beta', available: true, reasoning: false, costInput: 0, costOutput: 0 },
    { provider: 'other', id: 'remote', name: 'Remote', available: false, reasoning: true, costInput: 3, costOutput: 9 },
  ],
  piVersion: '1.0',
});

describe('chat model settings', () => {
  const overview = signal(facts()),
    matches = signal(new Set(ids));
  const patch = vi.fn(),
    scope = vi.fn(),
    select = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    overview.set(facts());
    matches.set(new Set(ids));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: SettingsStore,
          useValue: {
            overview,
            settings: () => overview().settings,
            error: signal(undefined),
            matches,
            shows: (...keys: string[]) => keys.some((key) => matches().has(key)),
            patch,
            setScope: scope,
            select,
          },
        },
        {
          provide: UpdateStore,
          useValue: {
            pi: signal({ state: 'current' }),
            models: signal({ updatedAt: Date.now() }),
            resolution: signal({ version: '1.0' }),
            running: signal(false),
            update: vi.fn(),
          },
        },
      ],
    });
  });
  const open = () => {
    const fixture = TestBed.createComponent(ModelsSection);
    fixture.detectChanges();
    return fixture;
  };
  const root = (fixture: ReturnType<typeof open>): HTMLElement => fixture.nativeElement;
  const tab = (fixture: ReturnType<typeof open>, name: string) => {
    const button = [...root(fixture).querySelectorAll<HTMLButtonElement>('[role=tab]')].find((button) =>
      button.textContent?.trim().startsWith(name),
    );
    expect(button).toBeTruthy();
    button!.click();
    fixture.detectChanges();
  };

  it('opens chat defaults and gives each purpose its own tab without ineffective provider preferences', () => {
    const fixture = open(),
      element = root(fixture);
    expect([...element.querySelectorAll('[role=tab]')].map((item) => item.textContent?.trim())).toEqual([
      'Chat defaults',
      'Pinned models 2',
      'Catalog 3',
    ]);
    const panels = element.querySelectorAll<HTMLElement>('[role=tabpanel]');
    expect(panels[0].hidden).toBe(false);
    expect(panels[1].hidden).toBe(true);
    expect(panels[2].hidden).toBe(true);
    expect(panels[0].textContent).toContain('Applies when you create a chat');
    expect(element.querySelector('[data-testid^=provider-default-]')).toBeNull();
    const chooser = element.querySelector<HTMLSelectElement>('[data-testid=default-model]')!;
    expect([...chooser.options].map((item) => item.value)).toEqual(['fixture|alpha', 'fixture|beta']);
    chooser.value = 'fixture|beta';
    chooser.dispatchEvent(new Event('change'));
    expect(patch).toHaveBeenCalledWith({ defaultModel: { provider: 'fixture', modelId: 'beta' } });
    const effort = element.querySelector<HTMLSelectElement>('[data-testid=default-effort]')!;
    effort.value = 'high';
    effort.dispatchEvent(new Event('change'));
    expect(patch).toHaveBeenCalledWith({ defaultThinkingLevel: 'high' });
  });

  it('preserves pinned-model ordering and distinguishes unknown prices from free models', () => {
    const fixture = open(),
      element = root(fixture);
    tab(fixture, 'Pinned models');
    element.querySelector<HTMLButtonElement>('[aria-label="Move fixture/alpha down"]')!.click();
    expect(scope).toHaveBeenCalledWith(['fixture/beta', 'fixture/alpha']);
    tab(fixture, 'Catalog');
    const rows = element.querySelectorAll('[data-testid=price-table] tbody tr');
    expect(rows[0].textContent).toContain('—');
    expect(rows[0].textContent).not.toContain('Free');
    expect(rows[1].textContent).toContain('Free');
  });

  it('filters the bounded catalog by model and provider and keeps search results reachable', () => {
    const fixture = open(),
      element = root(fixture);
    tab(fixture, 'Catalog');
    const filter = element.querySelector<HTMLInputElement>('[aria-label="Filter model catalog"]')!;
    filter.value = 'beta';
    filter.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(element.querySelectorAll('[data-testid=price-table] tbody tr')).toHaveLength(1);
    expect(element.querySelector('[data-testid=price-table]')?.textContent).toContain('fixture/beta');
    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    const provider = element.querySelector<HTMLSelectElement>('[aria-label="Filter by provider"]')!;
    provider.value = 'other';
    provider.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(element.querySelectorAll('[data-testid=price-table] tbody tr')).toHaveLength(1);
    expect(element.querySelector('[data-testid=price-table]')?.textContent).toContain('other/remote');
    matches.set(new Set(['pinned-models']));
    fixture.detectChanges();
    expect([...element.querySelectorAll<HTMLElement>('[role=tabpanel]')].filter((panel) => !panel.hidden)).toHaveLength(
      1,
    );
    expect(element.querySelector<HTMLElement>('[role=tabpanel]')?.textContent).toContain('Pinned models');
  });

  it('offers one llama.cpp group while saving the original connection of a selected default', () => {
    overview.set({
      ...facts(),
      providers: [
        { id: 'ds4', name: 'DeepSeek (llama-swap)' },
        { id: 'glm', name: 'GLM (llama-swap)' },
      ],
      models: [
        { provider: 'ds4', id: 'shared', name: 'DeepSeek', available: true, reasoning: true, contextWindow: 8192 },
        { provider: 'glm', id: 'shared', name: 'GLM', available: true, reasoning: true, contextWindow: 8192 },
      ],
    });
    const fixture = open(),
      element = root(fixture);
    const defaults = element.querySelector<HTMLSelectElement>('[data-testid=default-model]')!;
    expect(defaults.querySelectorAll('optgroup')).toHaveLength(1);
    expect(defaults.querySelector('optgroup')?.label).toBe('llama.cpp');
    defaults.value = 'glm|shared';
    defaults.dispatchEvent(new Event('change'));
    expect(patch).toHaveBeenCalledWith({ defaultModel: { provider: 'glm', modelId: 'shared' } });
    tab(fixture, 'Catalog');
    const filter = element.querySelector<HTMLSelectElement>('[aria-label="Filter by provider"]')!;
    expect([...filter.options].map((option) => option.textContent?.trim())).toEqual(['All providers', 'llama.cpp']);
    filter.value = 'llama.cpp';
    filter.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(element.querySelectorAll('[data-testid=price-table] tbody tr')).toHaveLength(2);
  });
});
