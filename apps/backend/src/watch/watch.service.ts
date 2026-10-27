import { watch as watchNative } from 'node:fs';
import { relative, sep } from 'node:path';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { gitIgnoredPaths, rootIgnores, watchIgnored } from '../session/ignore';
import { Batcher, type PathBatch } from './batcher';
import { watchDirectories } from './dir-watcher';

export type WatchListener = (batch: PathBatch) => void;

interface Entry {
  cwd: string;
  /** Resolves when watching starts and any initial scan has finished. */
  ready: Promise<void>;
  watcher: Promise<{ close(): void | Promise<void> } | undefined>;
  batcher: Batcher;
  listeners: Set<WatchListener>;
}

/**
 * The one file watcher of a workspace folder, shared by the Files panel and the Changes panel: native recursive FSEvents on
 * macOS, one inotify watch per directory on Linux (`watchDirectories`), chokidar on Windows, excluding dependency/build folders,
 * root `.gitignore` names and what git ignores (`gitIgnoredPaths`), `.git`
 * reduced to the files a commit, checkout, add or reset changes (`watchIgnored`). Events are debounced by 300 ms into batches (`Batcher`). A watcher exists while somebody
 * listens (reference counted per folder) and is closed with the last listener, including background outcome/scoring listeners.
 * The panels reach it through `GET /api/workspaces/:id/watch`; other services (the file index cache) subscribe to every batch.
 */
@Injectable()
export class WatchService implements OnModuleDestroy {
  private readonly logger = new Logger(WatchService.name);
  private readonly entries = new Map<string, Entry>();
  private readonly anyListeners = new Set<(cwd: string, batch: PathBatch) => void>();

  /** Starts (or joins) the watcher of `cwd`; returns the function that leaves it. */
  subscribe(cwd: string, listener: WatchListener): () => void {
    let entry = this.entries.get(cwd);
    if (!entry) {
      entry = this.start(cwd);
      this.entries.set(cwd, entry);
    }
    entry.listeners.add(listener);
    return () => {
      const current = this.entries.get(cwd);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) this.stop(cwd);
    };
  }

  /** Resolves once watching starts and any initial scan is done. */
  ready(cwd: string): Promise<void> {
    return this.entries.get(cwd)?.ready ?? Promise.resolve();
  }

  /** Every batch of every watched folder (the file index forgets its cache here). */
  onBatch(listener: (cwd: string, batch: PathBatch) => void): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  /** Folders with a running watcher (tests, diagnostics). */
  watching(): string[] {
    return [...this.entries.keys()];
  }

  onModuleDestroy(): void {
    for (const cwd of [...this.entries.keys()]) this.stop(cwd);
  }

  private start(cwd: string): Entry {
    const names = rootIgnores(cwd);
    const listeners = new Set<WatchListener>();
    const batcher = new Batcher((batch) => {
      for (const listener of this.anyListeners) listener(cwd, batch);
      for (const listener of listeners) listener(batch);
    });
    const relativeOf = (path: string): string => relative(cwd, path).split(sep).join('/');
    let markReady = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
      // A folder that cannot be watched must not keep the stream waiting.
      setTimeout(resolve, 5000).unref();
    });
    // Chokidar 5 opens a handle (macOS) or an inotify watch (Linux) for every file, so large workspaces exhaust the process's
    // descriptors or the inotify limit. macOS uses one native recursive FSEvents watcher, Linux one inotify watch per directory
    // (`watchDirectories`); chokidar remains for Windows.
    const watcher = gitIgnoredPaths(cwd).then(async (ignoredPaths) => {
      const ignored = (rel: string): boolean => watchIgnored(rel, names, ignoredPaths);
      if (process.platform === 'darwin') {
        const w = watchNative(cwd, { recursive: true }, (_event, filename) => {
          if (filename === null) return batcher.invalidate();
          const rel = filename.split(sep).join('/');
          if (rel && !ignored(rel)) batcher.add(rel);
        });
        w.once('error', (error) => {
          w.close();
          this.logger.warn(`Watching ${cwd}: ${error.message}`);
        });
        markReady();
        return w;
      }
      if (process.platform === 'linux') {
        const w = watchDirectories(cwd, {
          ignored,
          onPath: (rel) => batcher.add(rel),
          onOverflow: () => batcher.invalidate(),
          onLimit: (error) => this.logger.warn(
            `Watching ${cwd}: ${error.message}. The folder is only partly watched; raise fs.inotify.max_user_watches (sysctl) to watch all of it.`,
          ),
        });
        void w.ready.then(() => {
          this.logger.debug(`Watching ${cwd}: ${w.watched().length} directories`);
          markReady();
        });
        return w;
      }
      const { watch } = await import('chokidar');
      const w = watch(cwd, {
        ignoreInitial: true,
        followSymlinks: false,
        ignored: (path) => ignored(relativeOf(path)),
      });
      w.on('all', (_event, path) => {
        const rel = relativeOf(path);
        if (rel) batcher.add(rel);
      });
      w.on('error', (error) => this.logger.warn(`Watching ${cwd}: ${error instanceof Error ? error.message : String(error)}`));
      w.once('ready', markReady);
      return w;
    })
      .catch((error: unknown) => {
        this.logger.warn(`Watching ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
        markReady();
        return undefined;
      });
    return { cwd, ready, watcher, batcher, listeners };
  }

  private stop(cwd: string): void {
    const entry = this.entries.get(cwd);
    if (!entry) return;
    this.entries.delete(cwd);
    entry.batcher.dispose();
    void entry.watcher.then((w) => w?.close()).catch(() => undefined);
  }
}
