import { TestBed } from '@angular/core/testing';
import { browserAction, browserState, provideMockApi } from '@pi-kit/api';
import { emptyBrowserState } from '@pi-kit/protocol';
import { BrowserStore } from './browser.store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('BrowserStore ownership', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('rejects an old chat read and a late mutation after selecting another chat', async () => {
    vi.useFakeTimers();
    const oldRead = deferred<ReturnType<typeof emptyBrowserState>>();
    const oldWrite = deferred<{ state: ReturnType<typeof emptyBrowserState> }>();
    const read = vi.fn((id: string) => (id === 'a' ? oldRead.promise : Promise.resolve(emptyBrowserState(id, true))));
    const write = vi.fn(() => oldWrite.promise);
    TestBed.configureTestingModule({
      providers: [
        BrowserStore,
        ...provideMockApi([
          [browserState, read, (o) => [o.path?.['id']]],
          [browserAction, write, () => []],
        ]),
      ],
    });
    const store = TestBed.inject(BrowserStore);
    store.watch('a', 750);
    const action = store.act({ action: 'navigate', url: 'http://localhost:3000' });
    store.watch('b', 750);
    await vi.advanceTimersByTimeAsync(0);
    oldRead.resolve({ ...emptyBrowserState('a', true), url: 'http://old' });
    oldWrite.resolve({ state: { ...emptyBrowserState('a', true), url: 'http://old' } });
    expect(await action).toBeUndefined();
    expect(store.page()?.threadId).toBe('b');
    expect(store.page()?.url).toBe('');
    expect(store.busy()).toBe(false);
  });

  it('does not let a poll begun before navigation overwrite the confirmed page', async () => {
    vi.useFakeTimers();
    const stale = deferred<ReturnType<typeof emptyBrowserState>>();
    const read = vi.fn(() => stale.promise);
    const write = vi.fn(async () => ({
      state: { ...emptyBrowserState('a', true), open: true, url: 'http://localhost:3000/' },
    }));
    TestBed.configureTestingModule({
      providers: [
        BrowserStore,
        ...provideMockApi([
          [browserState, read, () => []],
          [browserAction, write, () => []],
        ]),
      ],
    });
    const store = TestBed.inject(BrowserStore);
    store.watch('a', 750);
    await store.act({ action: 'navigate', url: 'http://localhost:3000' });
    stale.resolve(emptyBrowserState('a', true));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.page()?.url).toBe('http://localhost:3000/');
    expect(store.page()?.open).toBe(true);
    const before = read.mock.calls.length;
    TestBed.resetTestingModule();
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(before);
  });
  it('shows the picker as active immediately and preserves Stop while its start request is pending', async () => {
    const started = deferred<{ state: ReturnType<typeof emptyBrowserState> }>();
    const state = { ...emptyBrowserState('a', true), open: true, documentId: 'doc' };
    const write = vi.fn((action) =>
      action.enabled ? started.promise : Promise.resolve({ state: { ...state, inspecting: false } }),
    );
    TestBed.configureTestingModule({
      providers: [
        BrowserStore,
        ...provideMockApi([
          [browserState, async () => state, () => []],
          [browserAction, write, (o) => [o.body]],
        ]),
      ],
    });
    const store = TestBed.inject(BrowserStore);
    store.watch('a', 750);
    await vi.waitFor(() => expect(store.page()?.open).toBe(true));
    const start = store.act({ action: 'inspect', enabled: true });
    expect(store.page()?.inspecting).toBe(true);
    expect(store.busy()).toBe(true);
    const stop = store.act({ action: 'inspect', enabled: false });
    expect(write).toHaveBeenCalledTimes(1);
    started.resolve({ state: { ...state, inspecting: true } });
    await Promise.all([start, stop]);
    expect(write.mock.calls.map(([action]) => action.enabled)).toEqual([true, false]);
    expect(store.page()?.inspecting).toBe(false);
    expect(store.busy()).toBe(false);
  });

  it('discards a queued inspection stop when its chat changes', async () => {
    const started = deferred<{ state: ReturnType<typeof emptyBrowserState> }>();
    const write = vi.fn(() => started.promise);
    TestBed.configureTestingModule({
      providers: [
        BrowserStore,
        ...provideMockApi([
          [browserState, async (id: string) => emptyBrowserState(id, true), (o) => [o.path?.['id']]],
          [browserAction, write, () => []],
        ]),
      ],
    });
    const store = TestBed.inject(BrowserStore);
    store.watch('a', 750);
    const start = store.act({ action: 'inspect', enabled: true });
    const stop = store.act({ action: 'inspect', enabled: false });
    store.watch('b', 750);
    started.resolve({ state: { ...emptyBrowserState('a', true), inspecting: true } });
    await Promise.all([start, stop]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(store.threadId()).toBe('b');
    expect(store.page()?.inspecting).not.toBe(true);
  });

  it('restores the inspection button if native inspection fails to start', async () => {
    const state = { ...emptyBrowserState('a', true), open: true, inspecting: false };
    TestBed.configureTestingModule({
      providers: [
        BrowserStore,
        ...provideMockApi([
          [browserState, async () => state, () => []],
          [
            browserAction,
            async () => {
              throw new Error('Picker unavailable');
            },
            () => [],
          ],
        ]),
      ],
    });
    const store = TestBed.inject(BrowserStore);
    store.watch('a', 750);
    await vi.waitFor(() => expect(store.page()?.open).toBe(true));
    await store.act({ action: 'inspect', enabled: true });
    expect(store.page()?.inspecting).toBe(false);
    expect(store.error()).toContain('Picker unavailable');
    expect(store.busy()).toBe(false);
  });
});
