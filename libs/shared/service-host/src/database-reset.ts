import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { DATABASE_RESET_PENDING_FILE } from '@pi-kit/protocol';
import { InstanceKeyStore } from './instance-key';

export type DatabaseBackup = { directory: string; files: string[] };

export class DatabaseReset {
  static backup(dataDir: string): DatabaseBackup {
    const root = lstatSync(dataDir);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The profile must be a regular directory.');
    const marker = join(dataDir, DATABASE_RESET_PENDING_FILE);
    if (DatabaseReset.stat(marker))
      throw new Error('A database reset is already pending; restore or complete it before retrying.');
    const key = InstanceKeyStore.file(dataDir);
    const keyParent = DatabaseReset.stat(dirname(key));
    if (keyParent && (!keyParent.isDirectory() || keyParent.isSymbolicLink()))
      throw new Error('The instance-keys directory must not be a symlink.');
    const sources = DatabaseReset.candidates(dataDir).filter((path) => {
      const source = DatabaseReset.stat(path);
      if (!source) return false;
      if (!source.isFile() || source.isSymbolicLink())
        throw new Error(`Refusing non-regular database reset source: ${path}`);
      return true;
    });
    const directory = join(
      dataDir,
      `database-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`,
    );
    mkdirSync(directory, { mode: 0o700 });
    const files = sources.map((path) => relative(dataDir, path));
    const backup = { directory, files };
    if (files.some((path) => dirname(path) !== '.')) mkdirSync(join(directory, 'instance-keys'), { mode: 0o700 });
    DatabaseReset.syncDirectory(directory);
    DatabaseReset.syncDirectory(dataDir);
    const markerFd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const moved: string[] = [];
    let completed = false;
    try {
      try {
        writeFileSync(markerFd, JSON.stringify({ version: 1, ...backup }, null, 2) + '\n');
        fsyncSync(markerFd);
      } finally {
        closeSync(markerFd);
      }
      DatabaseReset.syncDirectory(dataDir);
      for (const file of files) {
        const source = join(dataDir, file);
        const access = process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY;
        const fd = openSync(source, access | (constants.O_NOFOLLOW ?? 0));
        try {
          if (!fstatSync(fd).isFile()) throw new Error(`Refusing non-regular database reset source: ${source}`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(source, join(directory, file));
        moved.push(file);
        DatabaseReset.syncDirectory(dirname(join(directory, file)));
        DatabaseReset.syncDirectory(dirname(source));
      }
      DatabaseReset.durableFile(join(directory, 'backup.json'), { version: 1, completed: true, ...backup });
      DatabaseReset.syncDirectory(directory);
      DatabaseReset.syncDirectory(dataDir);
      completed = true;
      unlinkSync(marker);
      DatabaseReset.syncDirectory(dataDir);
      return backup;
    } catch (error) {
      if (completed) {
        if (!DatabaseReset.stat(marker)) DatabaseReset.durableFile(marker, { version: 1, ...backup });
        throw error;
      }
      let restored = true;
      for (const file of moved.reverse()) {
        try {
          linkSync(join(directory, file), join(dataDir, file));
          DatabaseReset.syncDirectory(dirname(join(dataDir, file)));
          unlinkSync(join(directory, file));
          DatabaseReset.syncDirectory(dirname(join(directory, file)));
        } catch {
          restored = false;
        }
      }
      if (restored) {
        try {
          unlinkSync(marker);
          DatabaseReset.syncDirectory(dataDir);
        } catch {
          throw error;
        }
      }
      throw error;
    }
  }

  static clearCompleted(dataDir: string): boolean {
    const pending = DatabaseReset.pending(dataDir);
    if (!pending) return false;
    try {
      const record = JSON.parse(readFileSync(join(pending.directory, 'backup.json'), 'utf8')) as {
        completed?: unknown;
      };
      if (record.completed !== true) return false;
    } catch {
      return false;
    }
    unlinkSync(join(dataDir, DATABASE_RESET_PENDING_FILE));
    DatabaseReset.syncDirectory(dataDir);
    return true;
  }

  static restore(dataDir: string): DatabaseBackup {
    const marker = join(dataDir, DATABASE_RESET_PENDING_FILE);
    if (!DatabaseReset.stat(marker)) throw new Error('No database reset is pending.');
    const pending = DatabaseReset.pending(dataDir);
    if (!pending)
      throw new Error(
        `${marker} is unreadable. Move the files of the newest database-backup folder back into ${dataDir} by hand, then delete the marker.`,
      );
    const restored: string[] = [];
    const conflicts: string[] = [];
    for (const file of pending.files) {
      const original = join(dataDir, file);
      const saved = join(pending.directory, file);
      const backup = DatabaseReset.stat(saved);
      if (!backup) continue;
      if (!backup.isFile()) throw new Error(`Refusing non-regular database backup file: ${saved}`);
      const current = DatabaseReset.stat(original);
      if (current && !(current.ino !== 0 && current.ino === backup.ino && current.dev === backup.dev)) {
        conflicts.push(file);
        continue;
      }
      if (!current) {
        const parent = DatabaseReset.stat(dirname(original));
        if (parent && !parent.isDirectory())
          throw new Error(`Refusing non-directory restore target: ${dirname(original)}`);
        mkdirSync(dirname(original), { recursive: true, mode: 0o700 });
        linkSync(saved, original);
        DatabaseReset.syncDirectory(dirname(original));
      }
      unlinkSync(saved);
      DatabaseReset.syncDirectory(dirname(saved));
      restored.push(file);
    }
    if (conflicts.length)
      throw new Error(
        `These files exist both in ${dataDir} and in ${pending.directory}: ${conflicts.join(', ')}. Keep one copy of each, then restore again.`,
      );
    rmSync(join(pending.directory, 'backup.json'), { force: true });
    for (const directory of [join(pending.directory, 'instance-keys'), pending.directory])
      if (DatabaseReset.stat(directory)?.isDirectory() && readdirSync(directory).length === 0) rmdirSync(directory);
    unlinkSync(marker);
    DatabaseReset.syncDirectory(dataDir);
    return { directory: pending.directory, files: restored };
  }

  private static candidates(dataDir: string): string[] {
    return [
      ...['pi-kit.sqlite', 'bg-agents.sqlite'].flatMap((name) =>
        ['', '.plaintext', '.encrypted', '.encrypting', '.decrypting'].flatMap((artifact) =>
          ['', '-wal', '-shm', '-journal'].map((sidecar) => join(dataDir, name + artifact + sidecar)),
        ),
      ),
      InstanceKeyStore.file(dataDir),
    ];
  }

  private static pending(dataDir: string): DatabaseBackup | undefined {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(dataDir, DATABASE_RESET_PENDING_FILE), 'utf8'));
    } catch {
      return undefined;
    }
    const { directory, files } = (value ?? {}) as Partial<DatabaseBackup>;
    if (typeof directory !== 'string' || !basename(directory).startsWith('database-backup-')) return undefined;
    const known = DatabaseReset.candidates(dataDir).map((path) => relative(dataDir, path));
    if (!Array.isArray(files) || !files.every((file) => known.includes(file))) return undefined;
    return { directory: join(dataDir, basename(directory)), files };
  }

  private static stat(path: string): ReturnType<typeof lstatSync> | undefined {
    try {
      return lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private static syncDirectory(path: string): void {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY);
      fsyncSync(fd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        !['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(code ?? '') &&
        !(process.platform === 'win32' && code === 'EPERM')
      )
        throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private static durableFile(path: string, value: unknown): void {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
