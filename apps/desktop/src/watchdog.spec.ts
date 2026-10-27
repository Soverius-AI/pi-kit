import { describe, expect, it } from 'vitest';
import { BackendWatchdog, type BackendHandle, DEFAULT_WATCHDOG_OPTIONS, type WatchdogHost, type WatchdogOptions, type WatchdogStatus } from './watchdog';

/** A fake host: a manual clock and timer queue, and backends the test can kill or hang. */
class FakeHost implements WatchdogHost {
  clock = 0;
  statuses: WatchdogStatus[] = [];
  launches = 0;
  /** Set to make the next launches fail with this message. */
  failLaunch: string | undefined;
  pingAnswer = true;
  pings = 0;
  current: { handle: BackendHandle; die(code?: number | null, signal?: string): void; killed: boolean } | undefined;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private nextId = 0;

  launch(): Promise<BackendHandle> {
    this.launches += 1;
    if (this.failLaunch) return Promise.reject(new Error(this.failLaunch));
    let resolveExit!: (info: { code: number | null; signal?: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal?: string | null }>((resolve) => (resolveExit = resolve));
    const entry = {
      killed: false,
      die: (code: number | null = 1, signal?: string) => resolveExit({ code, signal }),
      handle: undefined as unknown as BackendHandle,
    };
    entry.handle = {
      exited,
      kill: () => {
        entry.killed = true;
        resolveExit({ code: null, signal: 'SIGTERM' });
      },
    };
    this.current = entry;
    return Promise.resolve(entry.handle);
  }

  async ping(): Promise<boolean> {
    this.pings += 1;
    return this.pingAnswer;
  }

  schedule(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.push({ at: this.clock + ms, fn, id });
    return () => (this.timers = this.timers.filter((t) => t.id !== id));
  }

  now(): number {
    return this.clock;
  }

  report(status: WatchdogStatus): void {
    this.statuses.push(status);
  }

  /** Moves the clock, firing timers in order, and lets promises settle after each one. */
  async advance(ms: number): Promise<void> {
    const end = this.clock + ms;
    for (;;) {
      const next = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.clock = next.at;
      next.fn();
      await settle();
    }
    this.clock = end;
    await settle();
  }

  get states(): string[] {
    return this.statuses.map((s) => s.state);
  }
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

const options = (patch: Partial<WatchdogOptions> = {}): WatchdogOptions => ({ ...DEFAULT_WATCHDOG_OPTIONS, pingIntervalMs: 0, ...patch });

async function started(host: FakeHost, patch: Partial<WatchdogOptions> = {}): Promise<BackendWatchdog> {
  const dog = new BackendWatchdog(host, options(patch));
  dog.start();
  await settle();
  return dog;
}

describe('BackendWatchdog', () => {
  it('goes starting -> running when the backend comes up', async () => {
    const host = new FakeHost();
    const dog = await started(host);
    expect(host.states).toEqual(['starting', 'running']);
    expect(dog.status).toEqual({ state: 'running', restarts: 0 });
  });

  it('restarts a crashed backend after the base delay and counts the restart', async () => {
    const host = new FakeHost();
    const dog = await started(host);
    host.current?.die(null, 'SIGKILL');
    await settle();
    expect(host.statuses.at(-1)).toMatchObject({ state: 'restarting', attempt: 1, delayMs: 500, reason: 'the backend exited (signal SIGKILL)' });
    await host.advance(499);
    expect(host.launches).toBe(1);
    await host.advance(1);
    expect(host.launches).toBe(2);
    expect(host.statuses.at(-1)).toEqual({ state: 'running', restarts: 1 });
    expect(dog.status.restarts).toBe(1);
  });

  it('backs off exponentially in a crash loop, up to the maximum', async () => {
    const host = new FakeHost();
    await started(host, { baseDelayMs: 100, maxDelayMs: 350, maxFailures: 10 });
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      host.current?.die(1);
      await settle();
      const status = host.statuses.at(-1);
      delays.push(status?.delayMs ?? -1);
      await host.advance(status?.delayMs ?? 0);
    }
    expect(delays).toEqual([100, 200, 350, 350, 350]);
  });

  it('a backend that stayed up long enough resets the failure count', async () => {
    const host = new FakeHost();
    await started(host, { baseDelayMs: 100, stableAfterMs: 1000, maxFailures: 3 });
    for (let i = 0; i < 3; i++) {
      host.current?.die(1);
      await settle();
      await host.advance(host.statuses.at(-1)?.delayMs ?? 0);
    }
    expect(host.statuses.filter((s) => s.state === 'restarting').map((s) => s.attempt)).toEqual([1, 2, 3]);
    await host.advance(1000); // stable now
    host.current?.die(1);
    await settle();
    expect(host.statuses.at(-1)).toMatchObject({ state: 'restarting', attempt: 1, delayMs: 100 });
  });

  it('gives up after too many failures in a row, and retry() starts again from a clean slate', async () => {
    const host = new FakeHost();
    const dog = await started(host, { baseDelayMs: 10, maxFailures: 2 });
    host.current?.die(1);
    await settle();
    await host.advance(10);
    host.current?.die(1);
    await settle();
    await host.advance(20);
    host.current?.die(1);
    await settle();
    expect(host.statuses.at(-1)).toMatchObject({ state: 'failed', reason: 'the backend exited (code 1)' });
    const launches = host.launches;
    await host.advance(60_000);
    expect(host.launches).toBe(launches); // no further attempt on its own
    dog.retry();
    await settle();
    expect(dog.status.state).toBe('running');
    host.current?.die(1);
    await settle();
    expect(host.statuses.at(-1)).toMatchObject({ state: 'restarting', attempt: 1 });
  });

  it('treats a backend that never becomes healthy like a crash', async () => {
    const host = new FakeHost();
    host.failLaunch = 'did not become healthy within 30s';
    const dog = new BackendWatchdog(host, options({ baseDelayMs: 50, maxFailures: 2 }));
    dog.start();
    await settle();
    expect(host.statuses.at(-1)).toMatchObject({ state: 'restarting', attempt: 1, reason: 'the backend did not start (did not become healthy within 30s)' });
    await host.advance(50);
    await host.advance(100);
    expect(host.statuses.at(-1)?.state).toBe('failed');
    expect(host.launches).toBe(3);
    host.failLaunch = undefined;
    dog.retry();
    await settle();
    expect(dog.status).toEqual({ state: 'running', restarts: 1 });
  });

  it('stop() kills the backend and nothing restarts afterwards', async () => {
    const host = new FakeHost();
    const dog = await started(host);
    const backend = host.current;
    dog.stop();
    await settle();
    expect(backend?.killed).toBe(true);
    expect(dog.status.state).toBe('stopped');
    await host.advance(60_000);
    expect(host.launches).toBe(1);
  });

  it('stop() while a restart is pending cancels it', async () => {
    const host = new FakeHost();
    const dog = await started(host);
    host.current?.die(1);
    await settle();
    dog.stop();
    await host.advance(60_000);
    expect(host.launches).toBe(1);
    expect(dog.status.state).toBe('stopped');
  });

  it('kills a backend that is alive but stops answering, then restarts it', async () => {
    const host = new FakeHost();
    await started(host, { pingIntervalMs: 1000, pingFailuresToKill: 3, baseDelayMs: 10 });
    const first = host.current;
    host.pingAnswer = false;
    await host.advance(2999);
    expect(first?.killed).toBe(false);
    await host.advance(1);
    expect(first?.killed).toBe(true);
    await host.advance(10);
    expect(host.launches).toBe(2);
    expect(host.statuses.at(-1)?.state).toBe('running');
  });

  it('one answered ping clears the missed ones', async () => {
    const host = new FakeHost();
    await started(host, { pingIntervalMs: 1000, pingFailuresToKill: 3 });
    host.pingAnswer = false;
    await host.advance(2000);
    host.pingAnswer = true;
    await host.advance(1000);
    host.pingAnswer = false;
    await host.advance(2000);
    expect(host.current?.killed).toBe(false);
  });

  it('ignores the exit of a backend that was already replaced', async () => {
    const host = new FakeHost();
    await started(host, { baseDelayMs: 10 });
    const old = host.current;
    old?.die(1);
    await settle();
    await host.advance(10);
    expect(host.launches).toBe(2);
    old?.die(2); // a second exit report for the first process
    await settle();
    expect(host.statuses.at(-1)?.state).toBe('running');
  });
});
