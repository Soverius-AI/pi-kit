import { type FSWatcher, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DirWatcherOptions {
  /** Whether a path (relative, `/`-separated) is skipped: an ignored directory is neither watched nor walked. */
  ignored(rel: string): boolean;
  /** A path that changed: a file, or a directory that appeared or went. */
  onPath(rel: string): void;
  /** The OS could not say what changed: refresh everything. */
  onOverflow(): void;
  /** No more watches could be added (the inotify limit); called once, the directories watched so far stay watched. */
  onLimit(error: Error): void;
}

export interface DirWatcher {
  /** Resolves when the first walk is done. */
  ready: Promise<void>;
  /** Directories with a watch (tests, diagnostics). */
  watched(): string[];
  close(): void;
}

/**
 * A recursive watcher for Linux that holds one inotify watch per directory and none per file: a directory's watch already
 * reports what happens to the files in it. Chokidar watches every file as well, so a large folder used up the inotify limit
 * (`fs.inotify.max_user_watches`). Directories that appear are walked and watched, directories that go are dropped.
 */
export function watchDirectories(root: string, options: DirWatcherOptions): DirWatcher {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let limited = false;

  const childOf = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

  const unwatch = (rel: string): void => {
    for (const [dir, watcher] of watchers) {
      if (dir === rel || dir.startsWith(`${rel}/`)) {
        watcher.close();
        watchers.delete(dir);
      }
    }
  };

  const add = (rel: string): boolean => {
    if (closed || limited || watchers.has(rel)) return false;
    let watcher: FSWatcher;
    try {
      watcher = watch(join(root, rel), { persistent: false }, (event, filename) => {
        if (closed) return;
        if (filename === null) return options.onOverflow();
        const child = childOf(rel, filename.toString());
        if (options.ignored(child)) return;
        options.onPath(child);
        if (event === 'rename') void renamed(child);
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' || code === 'EMFILE') {
        limited = true;
        options.onLimit(error as Error);
      }
      return false;
    }
    // The directory itself went away (deleted or moved): its parent reports that, so only the watch is dropped.
    watcher.on('error', () => unwatch(rel));
    watchers.set(rel, watcher);
    return true;
  };

  /** Watches `rel` and every directory below it; with `report`, also reports what it finds (a directory that just appeared). */
  const walk = async (rel: string, report: boolean): Promise<void> => {
    if (!add(rel)) return;
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      const child = childOf(rel, entry.name);
      if (options.ignored(child)) continue;
      if (report) options.onPath(child);
      // A symbolic link is not followed: `isDirectory()` is false for it.
      if (entry.isDirectory()) dirs.push(child);
    }
    for (const dir of dirs) await walk(dir, report);
  };

  /** A name appeared or went in a watched directory. */
  const renamed = async (rel: string): Promise<void> => {
    try {
      if ((await stat(join(root, rel))).isDirectory()) await walk(rel, true);
    } catch {
      unwatch(rel);
    }
  };

  const ready = walk('', false);
  return {
    ready,
    watched: () => [...watchers.keys()],
    close: () => {
      closed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
