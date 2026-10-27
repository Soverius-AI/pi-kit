import { TestBed } from '@angular/core/testing';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { computed } from '@angular/core';
import { withLatestRequest, withPolling } from './index';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('async store features', () => {
  const Store = signalStore(
    withState({ values: {} as Record<string, string>, errors: [] as string[], completions: 0 }),
    withLatestRequest(),
    withPolling(),
    withComputed((s) => ({
      pending: computed(() => Object.values(s._requestStates()).filter((r) => r.status === 'loading').length),
    })),
    withMethods((s) => ({
      load(key: string, work: (signal: AbortSignal) => Promise<string>, signal?: AbortSignal) {
        return s._request(key, work, {
          signal,
          next: (value) => patchState(s, (state) => ({ values: { ...state.values, [key]: value } })),
          error: (error) => patchState(s, (state) => ({ errors: [...state.errors, String(error)] })),
          settled: () => patchState(s, (state) => ({ completions: state.completions + 1 })),
        });
      },
      poll: (work: (signal: AbortSignal) => Promise<void>) => s._startPolling('test', { intervalMs: 100, run: work }),
      stop: () => s._stopPolling('test'),
    })),
  );
  const make = () => TestBed.configureTestingModule({ providers: [Store] }).inject(Store);

  it('supersedes reads by key without accepting stale data, errors or completion', async () => {
    const store = make();
    const first = deferred<string>();
    const second = deferred<string>();
    let signal!: AbortSignal;
    const old = store.load('a', (abort) => {
      signal = abort;
      return first.promise;
    });
    const current = store.load('a', () => second.promise);
    expect(signal.aborted).toBe(true);
    first.reject(new Error('old failure'));
    await old;
    expect(store.errors()).toEqual([]);
    expect(store.completions()).toBe(0);
    expect(store.pending()).toBe(1);
    second.resolve('new');
    await current;
    expect(store.values()).toEqual({ a: 'new' });
    expect(store.pending()).toBe(0);
    expect(store.completions()).toBe(1);
  });

  it('keeps different resources independent and discards a late success', async () => {
    const store = make();
    const first = deferred<string>();
    const old = store.load('a', () => first.promise);
    await Promise.all([store.load('a', async () => 'latest'), store.load('b', async () => 'other')]);
    first.resolve('stale');
    await old;
    expect(store.values()).toEqual({ a: 'latest', b: 'other' });
  });

  it('cancels on parent abort and store destruction, even if the transport ignores abort', async () => {
    const store = make();
    const parent = new AbortController();
    const first = deferred<string>();
    const pending = store.load('a', () => first.promise, parent.signal);
    parent.abort();
    first.resolve('ignored');
    await pending;
    expect(store.values()).toEqual({});
    const second = deferred<string>();
    let signal!: AbortSignal;
    const destroyed = store.load('b', (abort) => {
      signal = abort;
      return second.promise;
    });
    TestBed.resetTestingModule();
    expect(signal.aborted).toBe(true);
    second.resolve('ignored');
    await destroyed;
    expect(store.values()).toEqual({});
  });

  it('waits for a poll to finish and stops its in-flight read and timer', async () => {
    vi.useFakeTimers();
    try {
      const store = make();
      const first = deferred<void>();
      let signal!: AbortSignal;
      const read = vi.fn((abort: AbortSignal) => {
        signal = abort;
        return first.promise;
      });
      store.poll(read);
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(1);
      first.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(read).toHaveBeenCalledTimes(2);
      store.stop();
      expect(signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
