import { TestBed } from '@angular/core/testing';
import { LiteLlmStore } from '@pi-kit/settings/api';
import { LiteLlmConnectionPanel } from './litellm-connection';

const connection = {
  baseUrl: 'http://localhost:4000/v1',
  configured: true,
  hasApiKey: true,
  models: [{ id: 'alias', name: 'My model', contextWindow: 64000 }],
};

describe('LiteLLM connection form', () => {
  const store = {
    load: vi.fn(async () => connection),
    discover: vi.fn(async () => connection),
    save: vi.fn(async () => connection),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ providers: [{ provide: LiteLlmStore, useValue: store }] });
  });
  const open = async () => {
    const fixture = TestBed.createComponent(LiteLlmConnectionPanel);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector<HTMLButtonElement>('[data-testid=litellm-save]')?.disabled).toBe(false);
    });
    return { fixture, el };
  };
  it('loads the existing connection without exposing the key, and retains it when saving', async () => {
    const { fixture, el } = await open();
    expect((el.querySelector('#litellm-auth') as HTMLSelectElement).value).toBe('saved');
    expect(el.querySelector('#litellm-key')).toBeNull();
    expect(el.textContent).toContain('My model');
    const saved = vi.fn();
    fixture.componentInstance.saved.subscribe(saved);
    (el.querySelector('[data-testid=litellm-save]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.save).toHaveBeenCalledWith({ baseUrl: connection.baseUrl }, expect.any(AbortSignal));
    expect(saved).toHaveBeenCalledOnce();
  });
  it('supports switching to a keyless proxy and reports discovery errors without advancing', async () => {
    const { fixture, el } = await open();
    const saved = vi.fn();
    fixture.componentInstance.saved.subscribe(saved);
    const auth = el.querySelector('#litellm-auth') as HTMLSelectElement;
    auth.value = 'none';
    auth.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid=litellm-models]')).toBeNull();
    store.discover.mockRejectedValueOnce(new Error('LiteLLM refused this API key.'));
    (el.querySelector('[data-testid=litellm-discover]') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.discover).toHaveBeenCalledWith({ baseUrl: connection.baseUrl, apiKey: '' }, expect.any(AbortSignal));
    expect(el.querySelector('[role=alert]')?.textContent).toContain('refused');
    expect(saved).not.toHaveBeenCalled();
  });
});
