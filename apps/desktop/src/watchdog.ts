/**
 * The backend watchdog's state machine. It knows nothing about Electron or child processes: the host
 * launches and kills the backend, supplies timers and a clock, and hears about every change of state, so the whole
 * thing runs under a fake clock in the unit tests.
 *
 *   starting --healthy--> running --exit / unhealthy--> restarting --after backoff--> starting ...
 *                                                           |
 *                                       too many failures in a row --> failed --retry()--> starting
 *   any state --stop()--> stopped
 *
 * Failures count in a row: a backend that stayed up for `stableAfterMs` has earned a clean slate, so one crash a day
 * restarts after `baseDelayMs`, while a crash loop backs off (base, 2x, 4x ... up to `maxDelayMs`) and, after
 * `maxFailures` in a row, stops with `failed` instead of burning CPU.
 */

export interface BackendHandle {
  /** Settles when the process has ended, for whatever reason. */
  exited: Promise<{ code: number | null; signal?: string | null }>;
  kill(): void;
}

export interface WatchdogHost {
  /** Starts the backend and resolves when it answers its health check; rejects (after cleaning up) when it cannot. */
  launch(): Promise<BackendHandle>;
  /** `true` when the running backend answered its health check. */
  ping(): Promise<boolean>;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  schedule(fn: () => void, ms: number): () => void;
  now(): number;
  /** Called on every change of state. */
  report(status: WatchdogStatus): void;
}

export interface WatchdogOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Consecutive failures after which the watchdog gives up. */
  maxFailures: number;
  /** A backend that ran this long before it died does not count towards `maxFailures`. */
  stableAfterMs: number;
  /** How often a running backend is pinged; 0 turns the ping off. */
  pingIntervalMs: number;
  /** Consecutive missed pings after which a process that is alive but not answering is killed (and so restarted). */
  pingFailuresToKill: number;
}

export const DEFAULT_WATCHDOG_OPTIONS: WatchdogOptions = {
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  maxFailures: 5,
  stableAfterMs: 30_000,
  pingIntervalMs: 5_000,
  pingFailuresToKill: 3,
};

export type WatchdogState = 'starting' | 'running' | 'restarting' | 'failed' | 'stopped';

export interface WatchdogStatus {
  state: WatchdogState;
  /** How many times the backend came back after a failure since the app started. */
  restarts: number;
  /** For `restarting`: which consecutive failure this is and how long until the next attempt. */
  attempt?: number;
  delayMs?: number;
  /** Why the last run ended (`restarting`, `failed`). */
  reason?: string;
}

/**
 * The state machine itself, driven by a `WatchdogHost`: `start()` launches the backend and pings it while it runs, an exit or missed
 * pings restart it after a backoff, too many failures in a row end in `failed` until `retry()`, and `stop()` kills it for good.
 * Each launch gets a generation number so a late answer from an older one is ignored.
 */
export class BackendWatchdog {
  private state: WatchdogState = 'stopped';
  private restarts = 0;
  private failures = 0;
  private startedAt: number | undefined;
  private handle: BackendHandle | undefined;
  private cancelTimer: (() => void) | undefined;
  private cancelPing: (() => void) | undefined;
  private missedPings = 0;
  /** A failure happened since the last time the backend was up; the next `running` then counts as a restart. */
  private sawFailure = false;
  /** Bumped by every launch so a late answer from an older one is ignored. */
  private generation = 0;

  constructor(
    private readonly host: WatchdogHost,
    private readonly options: WatchdogOptions = DEFAULT_WATCHDOG_OPTIONS,
  ) {}

  get status(): WatchdogStatus {
    return { state: this.state, restarts: this.restarts };
  }

  start(): void {
    if (this.state !== 'stopped') return;
    this.begin();
  }

  /** Gives up for good: no more restarts, the running backend is killed. */
  stop(): void {
    this.state = 'stopped';
    this.generation += 1;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.cancelPing?.();
    this.cancelPing = undefined;
    const handle = this.handle;
    this.handle = undefined;
    handle?.kill();
    this.emit();
  }

  /** From `failed`: try again with a clean slate. */
  retry(): void {
    if (this.state !== 'failed') return;
    this.failures = 0;
    this.begin();
  }

  private begin(): void {
    this.state = 'starting';
    this.emit();
    const generation = ++this.generation;
    this.host.launch().then(
      (handle) => {
        if (generation !== this.generation) {
          handle.kill(); // stop() was called while the backend was starting
          return;
        }
        this.handle = handle;
        this.startedAt = this.host.now();
        this.missedPings = 0;
        if (this.sawFailure) this.restarts += 1;
        this.sawFailure = false;
        this.state = 'running';
        this.emit();
        this.armPing(generation);
        void handle.exited.then((info) => this.ended(generation, `the backend exited (${describe(info)})`));
      },
      (error: unknown) => {
        if (generation === this.generation) this.ended(generation, `the backend did not start (${error instanceof Error ? error.message : String(error)})`);
      },
    );
  }

  private ended(generation: number, reason: string): void {
    if (generation !== this.generation || this.state === 'stopped') return;
    this.generation += 1;
    this.cancelPing?.();
    this.cancelPing = undefined;
    this.handle = undefined;
    const uptime = this.startedAt === undefined ? 0 : this.host.now() - this.startedAt;
    this.startedAt = undefined;
    if (uptime >= this.options.stableAfterMs) this.failures = 0;
    this.failures += 1;
    this.sawFailure = true;
    if (this.failures > this.options.maxFailures) {
      this.state = 'failed';
      this.emit({ reason });
      return;
    }
    const delayMs = Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** (this.failures - 1));
    this.state = 'restarting';
    this.emit({ reason, attempt: this.failures, delayMs });
    this.cancelTimer = this.host.schedule(() => {
      this.cancelTimer = undefined;
      if (this.state === 'restarting') this.begin();
    }, delayMs);
  }

  private armPing(generation: number): void {
    if (this.options.pingIntervalMs <= 0) return;
    this.cancelPing = this.host.schedule(() => {
      if (generation !== this.generation || this.state !== 'running') return;
      void this.host.ping().then(
        (ok) => this.pinged(generation, ok),
        () => this.pinged(generation, false),
      );
    }, this.options.pingIntervalMs);
  }

  private pinged(generation: number, ok: boolean): void {
    if (generation !== this.generation || this.state !== 'running') return;
    this.missedPings = ok ? 0 : this.missedPings + 1;
    if (this.missedPings >= this.options.pingFailuresToKill) {
      // Alive but not answering: kill it; the exit takes the normal path.
      this.handle?.kill();
      return;
    }
    this.armPing(generation);
  }

  private emit(extra: Partial<WatchdogStatus> = {}): void {
    this.host.report({ state: this.state, restarts: this.restarts, ...extra });
  }
}

function describe(info: { code: number | null; signal?: string | null }): string {
  return info.signal ? `signal ${info.signal}` : `code ${info.code}`;
}
