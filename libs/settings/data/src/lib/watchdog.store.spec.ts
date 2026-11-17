import { TestBed } from '@angular/core/testing';
import { provideMockApi, settingsWatchdog, settingsSetWatchdog } from '@pi-kit/api';
import { WatchdogStore } from './watchdog.store';

describe('WatchdogStore', () => {
  const get = vi.fn();
  const set = vi.fn();
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ enabled: false, supported: true });
    set.mockReset();
    TestBed.configureTestingModule({
      providers: provideMockApi([
        [settingsWatchdog, get, () => []],
        [settingsSetWatchdog, set, (options) => [options.body]],
      ]),
    });
  });
  it('loads and persists using the generated owner API', async () => {
    const store = TestBed.inject(WatchdogStore);
    await store.load();
    expect(store.status()).toEqual({ enabled: false, supported: true });
    set.mockResolvedValue({ enabled: true, supported: true });
    await store.setEnabled(true);
    expect(set).toHaveBeenCalledWith({ enabled: true });
    expect(store.status()?.enabled).toBe(true);
    expect(store.busy()).toBe(false);
  });
  it('keeps the saved value and resets busy after a failed change, then clears the error on retry', async () => {
    const store = TestBed.inject(WatchdogStore);
    await store.load();
    set.mockRejectedValue(new Error('cannot persist'));
    await store.setEnabled(true);
    expect(store.status()?.enabled).toBe(false);
    expect(store.busy()).toBe(false);
    expect(store.error()).toContain('cannot persist');
    set.mockResolvedValue({ enabled: true, supported: true });
    await store.setEnabled(true);
    expect(store.error()).toBeUndefined();
    expect(store.status()?.enabled).toBe(true);
  });
});
