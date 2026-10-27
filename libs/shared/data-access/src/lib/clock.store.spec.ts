import { TestBed } from '@angular/core/testing';
import { ClockStore } from './clock.store';

describe('ClockStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
  });
  afterEach(() => vi.useRealTimers());

  it('ticks once a second', () => {
    const clock = TestBed.inject(ClockStore);
    const start = clock.now();
    vi.advanceTimersByTime(3000);
    expect(clock.now() - start).toBeGreaterThanOrEqual(3000);
  });

  it('stops when the store is destroyed', () => {
    const clock = TestBed.inject(ClockStore);
    TestBed.resetTestingModule();
    const stopped = clock.now();
    vi.advanceTimersByTime(5000);
    expect(clock.now()).toBe(stopped);
  });
});
