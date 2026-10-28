import { Injectable, Logger } from '@nestjs/common';

/** What changed in a folder: the paths (capped), whether more changed than are listed, whether git's `HEAD` moved, and when it was seen. */
export interface PathBatch {
  paths: string[];
  overflow: boolean;
  headMoved: boolean;
  at: number;
}

export type FolderListener = (batch: PathBatch) => void;

/** The paths of one batch are capped; past it the batch says `overflow`. */
export const MAX_BATCH_PATHS = 200;

/** A batch of `paths`, capped. */
export function batchOf(paths: readonly string[], at = Date.now()): PathBatch {
  return paths.length > MAX_BATCH_PATHS
    ? { paths: paths.slice(0, MAX_BATCH_PATHS), overflow: true, headMoved: false, at }
    : { paths: [...paths], overflow: false, headMoved: false, at };
}

/** Everything may have changed (a folder without snapshots, a run without a "before"). */
export const allChanged = (at = Date.now()): PathBatch => ({ paths: [], overflow: true, headMoved: false, at });

/** git's `HEAD` moved: a commit, checkout or reset. */
export const headChanged = (at = Date.now()): PathBatch => ({ paths: [], overflow: false, headMoved: true, at });

/**
 * What changed in a workspace folder, passed from whoever learns it to whoever needs it; nothing here watches or polls the folder. A run that
 * ended publishes the files it changed (`RunSnapshotsService`), a moved `HEAD` publishes `headChanged()` (`OutcomesService`, through `HeadWatcher`).
 * The Files and Changes panels listen through `GET /api/workspaces/:id/watch`; other services (the file index cache) take every batch with `onBatch`.
 */
@Injectable()
export class FolderChangesService {
  private readonly logger = new Logger(FolderChangesService.name);
  private readonly listeners = new Map<string, Set<FolderListener>>();
  private readonly anyListeners = new Set<(cwd: string, batch: PathBatch) => void>();

  /** Listens to `cwd`; returns the function that stops. */
  subscribe(cwd: string, listener: FolderListener): () => void {
    let set = this.listeners.get(cwd);
    if (!set) this.listeners.set(cwd, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(cwd) === set) this.listeners.delete(cwd);
    };
  }

  /** Every batch of every folder (the file index forgets its cache here). */
  onBatch(listener: (cwd: string, batch: PathBatch) => void): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  /** Tells everyone listening that `cwd` changed. */
  publish(cwd: string, batch: PathBatch): void {
    // One throwing consumer must not starve the others of the batch.
    for (const listener of [...this.anyListeners]) this.isolated(cwd, () => listener(cwd, batch));
    for (const listener of [...(this.listeners.get(cwd) ?? [])]) this.isolated(cwd, () => listener(batch));
  }

  private isolated(cwd: string, call: () => void): void {
    try {
      call();
    } catch (error) {
      this.logger.error(
        `A listener of ${cwd} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }
}
