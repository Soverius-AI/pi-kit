import { TestBed } from '@angular/core/testing';
import { THREAD_CACHE_IDLE_MS, ThreadReplayCacheStore } from './thread-replay-cache.store';

describe('ThreadReplayCacheStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });
  const entry = () => ({
    cursor: 'generation:1',
    messages: [{ id: 'u1', role: 'user' as const, content: 'hello' }],
    state: {},
    interrupts: [],
  });

  it('retains visited threads without a thread-count limit', () => {
    const cache = TestBed.inject(ThreadReplayCacheStore);
    for (let i = 0; i < 60; i++) {
      cache.activate(`t${i}`);
      cache.record(`t${i}`, entry());
    }
    expect(Object.keys(cache.entries())).toHaveLength(60);
    cache.activate('t0');
    expect(cache.entries()['t0'].messages[0].content).toBe('hello');
  });

  it('expires inactive threads after fifteen minutes while preserving the selected thread', () => {
    const cache = TestBed.inject(ThreadReplayCacheStore);
    cache.activate('old');
    cache.record('old', entry());
    cache.activate('active');
    cache.record('active', entry());
    vi.advanceTimersByTime(THREAD_CACHE_IDLE_MS);
    expect(Object.keys(cache.entries())).toEqual(['active']);
    cache.activate('old');
    expect(cache.entries()['old']).toBeUndefined();
  });

  it('evicts only inactive threads under memory pressure', () => {
    const cache = TestBed.inject(ThreadReplayCacheStore);
    cache.activate('old');
    cache.record('old', entry());
    cache.activate('active');
    cache.record('active', entry());
    window.dispatchEvent(new Event('memorypressure'));
    expect(Object.keys(cache.entries())).toEqual(['active']);
    cache.record('old', entry()); // A late event from a detached connection cannot repopulate it.
    expect(cache.entries()['old']).toBeUndefined();
  });

  it('checks Chromium heap pressure without evicting the selected thread', () => {
    const previous = Object.getOwnPropertyDescriptor(performance, 'memory');
    try {
      Object.defineProperty(performance, 'memory', {
        configurable: true,
        value: { usedJSHeapSize: 90, jsHeapSizeLimit: 100 },
      });
      const cache = TestBed.inject(ThreadReplayCacheStore);
      cache.activate('old');
      cache.record('old', entry());
      cache.activate('active');
      cache.record('active', entry());
      vi.advanceTimersByTime(30_000);
      expect(Object.keys(cache.entries())).toEqual(['active']);
    } finally {
      if (previous) Object.defineProperty(performance, 'memory', previous);
      else Reflect.deleteProperty(performance, 'memory');
    }
  });
});
