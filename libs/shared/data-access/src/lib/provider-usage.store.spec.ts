import { TestBed } from '@angular/core/testing';
import { provideMockApi, usageGet } from '@pi-kit/api';
import { ProviderUsageStore } from './provider-usage.store';

function setup(answers: Record<string, unknown>) {
  const asked: string[] = [];
  const api = {
    providerUsage: vi.fn(async (id: string, refresh: boolean) => {
      void refresh;
      asked.push(id);
      const answer = answers[id];
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      ...provideMockApi([[usageGet, api.providerUsage, (o) => [o.path?.['id'], o.query?.['refresh'] === '1']]]),
    ],
  });
  return { store: TestBed.inject(ProviderUsageStore), asked, api };
}

describe('ProviderUsageStore', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the answers per provider, null for a provider with no source', async () => {
    const { store } = setup({ anthropic: { windows: [{ name: '5 h', used: 38 }] }, radius: null });
    await store.refresh(['anthropic', 'radius']);
    expect(store.usage()['anthropic']?.windows[0].used).toBe(38);
    expect(store.usage()['radius']).toBeNull();
    expect('google' in store.usage()).toBe(false);
  });

  it('does not ask again while the answer is fresh, and does once it is not', async () => {
    vi.useFakeTimers();
    const { store, asked } = setup({ anthropic: { windows: [] } });
    await store.refresh(['anthropic']);
    await store.refresh(['anthropic']);
    expect(asked).toEqual(['anthropic']);
    vi.advanceTimersByTime(31_000);
    await store.refresh(['anthropic']);
    expect(asked).toEqual(['anthropic', 'anthropic']);
    await store.refresh(['anthropic'], true);
    expect(asked).toHaveLength(3);
  });

  it('shares one request between callers that ask at the same time', async () => {
    const { store, asked } = setup({ anthropic: { windows: [] } });
    await Promise.all([store.refresh(['anthropic']), store.refresh(['anthropic'])]);
    expect(asked).toHaveLength(1);
  });

  it('sends force refresh to the generated API and awaits the shared pending balance', async () => {
    const { store, api } = setup({ radius: { windows: [], credit: '$10.00' } });
    await store.refresh(['radius']);
    let complete!: (value: { windows: []; credit: string }) => void;
    api.providerUsage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const first = store.refresh(['radius', 'radius'], true);
    let finished = false;
    const second = store.refresh(['radius']).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(api.providerUsage).toHaveBeenLastCalledWith('radius', true);
    complete({ windows: [], credit: '$7.00' });
    await Promise.all([first, second]);
    expect(store.usage()['radius']?.credit).toBe('$7.00');
    expect(api.providerUsage).toHaveBeenCalledTimes(2);
  });

  it('shows nothing for a provider that fails', async () => {
    const { store } = setup({ anthropic: new Error('down') });
    await store.refresh(['anthropic']);
    expect(store.usage()['anthropic']).toBeNull();
  });

  it('puts the answers on ProviderInfo.usage and leaves providers not asked alone', async () => {
    const { store } = setup({ openrouter: { windows: [], credit: '$41.20' } });
    await store.refresh(['openrouter']);
    const out = store.withUsage([{ id: 'openrouter' }, { id: 'google' }]);
    expect(out[0]).toEqual({ id: 'openrouter', usage: { windows: [], credit: '$41.20' } });
    expect('usage' in out[1]).toBe(false);
  });
});
