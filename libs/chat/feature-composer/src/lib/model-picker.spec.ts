import { InteractivityChecker } from '@angular/cdk/a11y';
import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatStore } from '@pi-kit/chat/data';
import { ProviderUsageStore, UiStore } from '@pi-kit/data-access';
import type { ModelInfo, ThinkingLevel } from '@pi-kit/protocol';
import { ModelPicker } from './model-picker';
import { ComposerField } from './composer-field';

@Component({
  selector: 'pk-effort-focus-test',
  imports: [ComposerField, ModelPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<pk-composer-field /><button data-testid="other-control">Another control</button><pk-model-picker />',
})
class EffortFocusHost {}

describe('ModelPicker effort slider', () => {
  const current = signal({ provider: 'test', id: 'reasoner' });
  const levels = signal<readonly ThinkingLevel[]>(['off', 'low', 'high']);
  const effort = signal<ThinkingLevel>('low');
  const request = signal<{ menu: 'model' | 'effort'; n: number } | undefined>(undefined);
  const info = computed<ModelInfo>(() => ({
    ...current(),
    name: current().id,
    reasoning: levels().length > 1,
    levels: [...levels()],
    contextWindow: 1000,
  }));
  const session = {
    draft: signal(''),
    followUp: signal(undefined),
    caretRequest: signal<{ pos: number; n: number } | undefined>(undefined),
    menuOpen: () => false,
    menuSelected: () => undefined,
    placeholder: () => 'Message pi',
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    handleKey: vi.fn(),
    threadId: () => 't1',
    model: current,
    modelInfo: info,
    levels,
    effort,
    canThink: computed(() => levels().some((level) => level !== 'off')),
    stats: computed(() => ({ model: current(), thinkingLevel: effort() })),
    modelList: computed(() => ({ models: [info()] })),
    modelProviders: () => [],
    pinned: () => [],
    modelError: () => undefined,
    running: () => false,
    loadModels: vi.fn(),
    chooseModel: vi.fn(),
    togglePinnedModel: vi.fn(),
    setEffort: vi.fn<(level: ThinkingLevel) => Promise<boolean>>(async () => true),
  };

  beforeEach(() => {
    TestBed.resetTestingModule();
    current.set({ provider: 'test', id: 'reasoner' });
    levels.set(['off', 'low', 'high']);
    effort.set('low');
    request.set(undefined);
    session.draft.set('');
    session.caretRequest.set(undefined);
    session.setEffort.mockReset().mockResolvedValue(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatStore, useValue: session },
        {
          provide: UiStore,
          useValue: { chipMenu: request, composerFocus: signal(0), focusComposer: vi.fn(), openSettings: vi.fn() },
        },
        { provide: ProviderUsageStore, useValue: { usage: () => ({}), refresh: vi.fn() } },
      ],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function draw(placement: 'composer' | 'header' = 'composer', opened = true) {
    const fixture = TestBed.createComponent(ModelPicker);
    fixture.componentRef.setInput('placement', placement);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const range = () => document.querySelector<HTMLInputElement>(`[data-testid="${placement}-effort-slider"]`)!;
    const show = async () => {
      root.querySelector<HTMLButtonElement>(`[data-testid="${placement}-effort-control"]`)!.click();
      await fixture.whenStable();
      return range();
    };
    if (opened) await show();
    const preview = async (index: number) => {
      range().value = String(index);
      range().dispatchEvent(new Event('input', { bubbles: true }));
      await fixture.whenStable();
    };
    const commit = async () => {
      range().dispatchEvent(new Event('change', { bubbles: true }));
      await fixture.whenStable();
    };
    return {
      fixture,
      root,
      get slider() {
        return range();
      },
      show,
      preview,
      commit,
    };
  }

  it('previews supported steps in its own popover and saves on release without opening model selection', async () => {
    const { fixture, root, slider, preview, commit } = await draw();
    expect(slider.max).toBe('2');
    expect(slider.value).toBe('1');
    await preview(0);
    await preview(2);
    current.set({ provider: 'test', id: 'reasoner' });
    await fixture.whenStable();
    expect(document.querySelector('[data-testid="effort-popover"]')).not.toBeNull();
    expect(slider.getAttribute('aria-valuetext')).toBe('high');
    expect(root.querySelector('pk-flask')?.getAttribute('data-level')).toBe('high');
    expect(session.setEffort).not.toHaveBeenCalled();
    await commit();
    expect(session.setEffort).toHaveBeenCalledExactlyOnceWith('high');
    expect(root.querySelector('[data-testid="model-picker"]')).toBeNull();
  });

  it('updates the steps when the model changes, including models without off and models that cannot think', async () => {
    const { fixture, preview, show } = await draw();
    await preview(2);
    current.set({ provider: 'test', id: 'always-thinking' });
    levels.set(['low', 'high', 'max']);
    effort.set('low');
    await fixture.whenStable();
    expect(document.querySelector('[data-testid="effort-popover"]')).toBeNull();
    let slider = await show();
    expect(slider.value).toBe('0');
    expect(slider.getAttribute('aria-valuetext')).toBe('low');
    await preview(2);
    expect(slider.getAttribute('aria-valuetext')).toBe('max');
    current.set({ provider: 'test', id: 'plain' });
    levels.set(['off']);
    effort.set('off');
    await fixture.whenStable();
    expect(document.querySelector('[data-testid="effort-popover"]')).toBeNull();
    slider = await show();
    expect(slider.disabled).toBe(true);
    expect(slider.max).toBe('0');
    expect(slider.getAttribute('aria-valuetext')).toBe('off');
    expect(document.querySelector('pk-effort-panel')?.textContent).toContain('plain does not think');
  });

  it('restores the confirmed effort if saving fails', async () => {
    session.setEffort.mockResolvedValueOnce(false);
    const { slider, preview, commit } = await draw();
    await preview(2);
    await commit();
    expect(slider.getAttribute('aria-valuetext')).toBe('low');
    expect(slider.value).toBe('1');
  });

  it('does not let a failed request reset a newer preview', async () => {
    let finish!: (saved: boolean) => void;
    session.setEffort.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { fixture, slider, preview, commit } = await draw();
    await preview(2);
    await commit();
    await preview(0);
    finish(false);
    await fixture.whenStable();
    expect(slider.getAttribute('aria-valuetext')).toBe('off');
  });

  it('focuses the slider for /thinking without opening model selection', async () => {
    const drawn = await draw('composer', false);
    const { fixture, root } = drawn;
    // jsdom has no layout; retain CDK's real focusability/disabled checks and provide only visibility.
    vi.spyOn(TestBed.inject(InteractivityChecker), 'isVisible').mockImplementation(
      (element) =>
        element.isConnected &&
        getComputedStyle(element).visibility === 'visible' &&
        getComputedStyle(element).display !== 'none',
    );
    expect(root.querySelector('input[type="range"]')).toBeNull();
    request.set({ menu: 'effort', n: 1 });
    await fixture.whenStable();
    expect(document.activeElement).toBe(drawn.slider);
    expect(root.querySelector('[data-testid="model-picker"]')).toBeNull();
  });

  it('also exposes the current model slider in the header', async () => {
    const { slider, preview, commit } = await draw('header');
    expect(slider.getAttribute('aria-valuetext')).toBe('low');
    await preview(0);
    await commit();
    expect(session.setEffort).toHaveBeenCalledExactlyOnceWith('off');
  });

  it('keeps the slider out of the toolbar and Escape cancels an uncommitted preview', async () => {
    const drawn = await draw('composer', false);
    expect(document.querySelector('input[type="range"]')).toBeNull();
    const slider = await drawn.show();
    await drawn.preview(2);
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await drawn.fixture.whenStable();
    expect(document.querySelector('[data-testid="effort-popover"]')).toBeNull();
    expect(drawn.root.querySelector('pk-flask')?.getAttribute('data-level')).toBe('low');
    expect(session.setEffort).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(drawn.root.querySelector('[data-testid="composer-effort-control"]'));
  });

  it('does not let a delayed caret request steal focus from a newer user choice', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {
          /* This test drives focus, not layout. */
        }
        disconnect() {
          /* No native observer in jsdom. */
        }
      },
    );
    const fixture = TestBed.createComponent(EffortFocusHost);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    (fixture.nativeElement as HTMLElement).querySelector('textarea')!.focus();
    session.caretRequest.set({ pos: 0, n: 1 });
    fixture.detectChanges();
    const other = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '[data-testid="other-control"]',
    )!;
    other.focus();
    await vi.runOnlyPendingTimersAsync();
    await fixture.whenStable();
    expect(document.activeElement).toBe(other);
  });
});
