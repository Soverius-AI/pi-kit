import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideMockApi, threadsGetProtection, threadsSetProtection, WORKBENCH } from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { ThreadProtection } from '@pi-kit/protocol';
import { ChatStore } from './chat.store';
import { ThreadProtectionStore } from './thread-protection.store';

class Protection {
  static of(over: Partial<ThreadProtection> = {}): ThreadProtection {
    return {
      mode: 'bypass',
      state: 'bypass',
      generation: 0,
      experimentalWindowsAccepted: false,
      platform: 'darwin',
      reason: null,
      ...over,
    };
  }
}

class Deferred<T> {
  resolve!: (value: T) => void;
  reject!: (reason: Error) => void;
  readonly promise = new Promise<T>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
}

describe('ThreadProtectionStore', () => {
  const threadId = signal<string | undefined>('a');
  const running = signal(false);
  const waitingForAnswer = signal(false);
  const get = vi.fn<(id: string) => Promise<ThreadProtection>>();
  const put = vi.fn<(id: string, body: unknown) => Promise<ThreadProtection>>();
  const toasts = { show: vi.fn() };
  const sandboxed = Protection.of({ mode: 'sandboxed', state: 'active', generation: 1 });

  beforeEach(() => {
    threadId.set('a');
    running.set(false);
    waitingForAnswer.set(false);
    get.mockReset().mockResolvedValue(Protection.of());
    put.mockReset().mockResolvedValue(sandboxed);
    toasts.show.mockReset();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ChatStore, useValue: { threadId, running, waitingForAnswer } },
        { provide: ToastStore, useValue: toasts },
        ...provideMockApi([
          [threadsGetProtection, get, (o) => [o.path?.['id']]],
          [threadsSetProtection, put, (o) => [o.path?.['id'], o.body]],
        ]),
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  async function ready() {
    const store = TestBed.inject(ThreadProtectionStore);
    TestBed.tick();
    await vi.waitFor(() => expect(store.loading()).toBe(false));
    return store;
  }

  it('loads the current thread and only allows changes once its protection is known', async () => {
    const store = TestBed.inject(ThreadProtectionStore);
    TestBed.tick();
    expect(store.loading()).toBe(true);
    expect(store.canOpen()).toBe(false);
    expect(store.canChange()).toBe(false);
    await vi.waitFor(() => expect(store.protection()?.state).toBe('bypass'));
    expect(get).toHaveBeenCalledWith('a');
    expect(store.canChange()).toBe(true);
    running.set(true);
    expect(store.canChange()).toBe(false);
    expect(store.canOpen()).toBe(true);
  });

  it('applies responses only for the current thread and never below the held generation', async () => {
    const stale = new Deferred<ThreadProtection>();
    get.mockReturnValueOnce(stale.promise);
    const store = TestBed.inject(ThreadProtectionStore);
    TestBed.tick();
    threadId.set('b');
    TestBed.tick();
    await vi.waitFor(() => expect(store.protection()).toBeDefined());
    stale.resolve(sandboxed);
    await stale.promise;
    expect(store.mode()).toBe('bypass');

    await store.change({ mode: 'sandboxed' }, 'b');
    expect(put).toHaveBeenCalledWith('b', { mode: 'sandboxed' });
    expect(store.protection()?.generation).toBe(1);
    get.mockResolvedValueOnce(Protection.of({ generation: 0 }));
    store.retry();
    await vi.waitFor(() => expect(store.loading()).toBe(false));
    expect(store.mode()).toBe('sandboxed');
  });

  it('lets only the newest read of a thread land, so a poll answered late cannot undo a Refresh', async () => {
    vi.useFakeTimers();
    get.mockResolvedValueOnce(sandboxed);
    const store = await ready();
    const unavailable = Protection.of({ ...sandboxed, state: 'unavailable', reason: 'worker exited' });
    for (const settle of [
      (poll: Deferred<ThreadProtection>) => poll.resolve(sandboxed),
      (poll: Deferred<ThreadProtection>) => poll.reject(new Error('backend offline')),
    ]) {
      const poll = new Deferred<ThreadProtection>();
      get.mockReturnValueOnce(poll.promise).mockResolvedValueOnce(unavailable);
      await vi.advanceTimersByTimeAsync(5_000);
      store.retry();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.protection()?.state).toBe('unavailable');
      settle(poll);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.protection()?.state).toBe('unavailable');
      expect(store.error()).toBeUndefined();
    }
  });

  it('clears an earlier read error once a change succeeds', async () => {
    const store = await ready();
    get.mockRejectedValueOnce(new Error('backend offline'));
    store.retry();
    await vi.waitFor(() => expect(store.error()).toBe('backend offline'));
    await store.change({ mode: 'sandboxed' }, 'a');
    expect(store.mode()).toBe('sandboxed');
    expect(store.error()).toBeUndefined();
  });

  it('applies a PUT response when its thread is current again, and drops it while another thread is shown', async () => {
    const store = await ready();
    const saving = new Deferred<ThreadProtection>();
    put.mockReturnValueOnce(saving.promise);
    const save = store.change({ mode: 'sandboxed' }, 'a');
    expect(store.pending()).toBe(true);
    threadId.set('b');
    expect(store.pending()).toBe(false);
    threadId.set('a');
    TestBed.tick();
    expect(store.pending()).toBe(true);
    saving.resolve(sandboxed);
    await save;
    expect(store.mode()).toBe('sandboxed');
  });

  it('toasts write failures and keeps the authoritative protection, without reporting a read error', async () => {
    get.mockResolvedValueOnce(sandboxed);
    const store = await ready();
    put.mockRejectedValueOnce(new Error('Stop this thread’s background agents'));
    await store.change({ mode: 'bypass', confirmBypass: true }, 'a');
    expect(toasts.show).toHaveBeenCalledWith(
      'error',
      'Protection was not changed: Stop this thread’s background agents',
    );
    expect(store.error()).toBeUndefined();
    expect(store.mode()).toBe('sandboxed');
    expect(store.pending()).toBe(false);
  });

  it('runs the Linux setup in the desktop app, then starts the sandbox again, and toasts a failed setup', async () => {
    const setUpLinuxSandbox = vi.fn(async () => undefined);
    window.piKit = { setUpLinuxSandbox } as never;
    try {
      get.mockResolvedValueOnce(Protection.of({ mode: 'sandboxed', state: 'setup-required', platform: 'linux' }));
      const store = await ready();
      expect(store.canSetUpLinux).toBe(true);
      await store.setUpLinux('a');
      expect(setUpLinuxSandbox).toHaveBeenCalledOnce();
      expect(put).toHaveBeenCalledWith('a', { mode: 'sandboxed' });
      expect(store.protection()?.state).toBe('active');
      setUpLinuxSandbox.mockRejectedValueOnce(new Error('The setup was cancelled.'));
      await store.setUpLinux('a');
      expect(put).toHaveBeenCalledOnce();
      expect(toasts.show).toHaveBeenCalledWith('error', 'The Linux sandbox was not set up: The setup was cancelled.');
    } finally {
      delete window.piKit;
    }
  });

  it('surfaces a change dropped because the thread moved or became busy', async () => {
    const store = await ready();
    await store.change({ mode: 'sandboxed' }, 'other');
    running.set(true);
    await store.change({ mode: 'sandboxed' }, 'a');
    expect(put).not.toHaveBeenCalled();
    expect(toasts.show).toHaveBeenCalledTimes(2);
    expect(toasts.show).toHaveBeenCalledWith('warning', expect.stringContaining('the thread changed or became busy'));
  });

  it('keeps a read error openable so Refresh can recover it', async () => {
    get.mockRejectedValueOnce(new Error('offline'));
    const store = await ready();
    expect(store.error()).toContain('offline');
    expect(store.protection()).toBeUndefined();
    expect(store.canOpen()).toBe(true);
    expect(store.canChange()).toBe(false);
    store.retry();
    await vi.waitFor(() => expect(store.protection()?.state).toBe('bypass'));
    expect(store.error()).toBeUndefined();
  });

  it('never allows changing a remote owner', async () => {
    TestBed.overrideProvider(WORKBENCH, { useValue: { remote: true } });
    const store = await ready();
    expect(store.canChange()).toBe(false);
  });

  it('polls every 5 s without overlapping reads, picks up a mode enabled elsewhere on a Bypass thread, and stops on destroy', async () => {
    vi.useFakeTimers();
    get.mockResolvedValue(sandboxed);
    const store = await ready();
    TestBed.tick();
    const polling = new Deferred<ThreadProtection>();
    get.mockReturnValueOnce(polling.promise);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(get).toHaveBeenCalledTimes(2);
    expect(store.loading()).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(get).toHaveBeenCalledTimes(2);
    polling.resolve(Protection.of({ mode: 'sandboxed', state: 'unavailable', generation: 1, reason: 'worker exited' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.protection()?.reason).toBe('worker exited');

    get.mockResolvedValue(Protection.of());
    threadId.set('b');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    expect(store.mode()).toBe('bypass');
    const calls = get.mock.calls.length;
    get.mockResolvedValueOnce(Protection.of({ mode: 'sandboxed', state: 'active', generation: 1 }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(get).toHaveBeenCalledTimes(calls + 1);
    expect(store.mode()).toBe('sandboxed');

    TestBed.resetTestingModule();
    const destroyed = get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(get).toHaveBeenCalledTimes(destroyed);
    expect(vi.getTimerCount()).toBe(0);
  });
});
