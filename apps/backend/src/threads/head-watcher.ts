import { existsSync, type FSWatcher, watch as watchPath } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';

/** Git writes a commit's reflog line, refs and index in quick succession: one look after they settled. */
const SETTLE_MS = 200;
/** One look this long after a watch starts, for a change it may have missed while starting. */
const ARMED_LOOK_MS = 500;

/**
 * Watches one file for one folder: its reflog `.git/logs/HEAD`, to which git appends a line for every commit, checkout or reset (a commit on a
 * branch rewrites only `refs/heads/<branch>`, so watching `HEAD` itself would miss it). Watching another folder ends the watch before. Before the
 * first commit there is no reflog yet, so `.git` is watched until it appears; a reflog git replaces (gc, `reflog expire`) is watched again. `onMove`
 * hears that `HEAD` may have moved, a moment after git settled, and once shortly after every (re)start: macOS can drop the first moments of a watch.
 */
export class HeadWatcher {
  private readonly logger = new Logger(HeadWatcher.name);
  private current: { folder: string; watcher: FSWatcher | undefined; timer?: NodeJS.Timeout } | undefined;

  constructor(private readonly onMove: (folder: string) => void) {}

  watch(folder: string): void {
    if (this.current?.folder === folder) return;
    this.stop();
    this.current = { folder, watcher: undefined };
    this.arm(folder);
  }

  stop(): void {
    clearTimeout(this.current?.timer);
    this.current?.watcher?.close();
    this.current = undefined;
  }

  private arm(folder: string): void {
    const watched = this.current;
    if (watched?.folder !== folder) return;
    watched.watcher?.close();
    const reflog = join(folder, '.git', 'logs', 'HEAD');
    const target = existsSync(reflog) ? reflog : join(folder, '.git');
    const look = (delay: number): void => {
      clearTimeout(watched.timer);
      watched.timer = setTimeout(() => this.onMove(folder), delay);
      watched.timer.unref();
    };
    try {
      watched.watcher = watchPath(target, { persistent: false }, (event) => {
        if (event === 'rename' || target !== reflog) this.arm(folder);
        look(SETTLE_MS);
      });
      watched.watcher.on('error', () => this.stop());
    } catch (error) {
      this.logger.debug(`Could not watch ${target}: ${error instanceof Error ? error.message : String(error)}`);
      watched.watcher = undefined;
    }
    look(ARMED_LOOK_MS);
  }
}
