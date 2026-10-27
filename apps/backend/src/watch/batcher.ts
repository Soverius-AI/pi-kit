/** What a debounce window collected: the paths that changed, capped, and whether more changed than are listed. */
export interface PathBatch {
  paths: string[];
  overflow: boolean;
}

export interface BatcherOptions {
  /** Quiet time after the last event before the batch goes out (300 ms). */
  quietMs: number;
  /** A window never lasts longer than this, however busy the folder stays, so a build writing for a minute still refreshes the panel. */
  maxWaitMs: number;
  /** Paths kept per batch. */
  maxPaths: number;
}

export const DEFAULT_BATCHER: BatcherOptions = { quietMs: 300, maxWaitMs: 1500, maxPaths: 200 };

/**
 * The debounce of the live refresh: events are collected and emitted as one batch 300 ms after the last one,
 * or at the latest `maxWaitMs` after the first. Pure timers, no file system, so the behaviour is tested with fake timers.
 */
export class Batcher {
  private paths = new Set<string>();
  private overflow = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private firstAt = 0;

  constructor(
    private readonly emit: (batch: PathBatch) => void,
    private readonly options: BatcherOptions = DEFAULT_BATCHER,
  ) {}

  add(path: string): void {
    if (this.paths.size < this.options.maxPaths) this.paths.add(path);
    else if (!this.paths.has(path)) this.overflow = true;
    this.schedule();
  }

  /** The OS reported a change without a filename; consumers must refresh the whole folder. */
  invalidate(): void {
    this.overflow = true;
    this.schedule();
  }

  private schedule(): void {
    const now = Date.now();
    if (this.timer === undefined) this.firstAt = now;
    else clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.options.quietMs, this.firstAt + this.options.maxWaitMs - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  /** Emits what has been collected now (also what the timer calls). */
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.paths.size === 0 && !this.overflow) return;
    const batch = { paths: [...this.paths].sort(), overflow: this.overflow };
    this.paths = new Set();
    this.overflow = false;
    this.emit(batch);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.paths = new Set();
    this.overflow = false;
  }
}
