import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  chownSync,
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface LinuxAppUpdate {
  version(): string | undefined;
  preflight(): void;
  stage(archive: string, version: string): Promise<{ replace(): void; rollback?(): void; cleanup(): void }>;
}

/** Commands use no shell. Tests inject commands but operate on real scratch files. */
export interface LinuxAppUpdateSystem {
  run(file: string, args: string[], env?: NodeJS.ProcessEnv): { stdout: string; stderr: string };
  rename(from: string, to: string): void;
  writable(path: string): void;
  chown(path: string, uid: number, gid: number): void;
}

const native: LinuxAppUpdateSystem = {
  run(file, args, env) {
    const result = spawnSync(file, args, { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0)
      throw new Error(`${basename(file)} failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
    return { stdout: result.stdout, stderr: result.stderr };
  },
  rename: renameSync,
  chown: chownSync,
  writable(path) {
    const stat = lstatSync(path);
    if (!(stat.mode & 0o222)) throw new Error('No write permission bits are set.');
    accessSync(path, constants.W_OK | (stat.isDirectory() ? constants.X_OK : 0));
  },
};

/** The caller verifies the release SHA512 BEFORE stage(), and stops the host only after stage() succeeds.
 * This operates on the original external AppImage, never its mounted APPDIR. Linux has no signing check.
 */
export function linuxAppUpdate(image: string, system: Partial<LinuxAppUpdateSystem> = {}): LinuxAppUpdate {
  image = resolve(image);
  const parent = dirname(image);
  const ops = { ...native, ...system };
  const preflight = () => {
    if (!lstatSync(image).isFile() || lstatSync(image).isSymbolicLink())
      throw new Error('Update target must be a regular, non-symlink AppImage file.');
    for (const path of [parent, image]) {
      try {
        ops.writable(path);
      } catch (cause) {
        throw new Error(
          `AppImage update needs write access to ${path}. Grant your user write access or move the AppImage to a writable location; no automatic sudo is performed.`,
          { cause },
        );
      }
    }
  };
  const versionOf = (path: string) => {
    const script = `process.stdout.write(require(require('path').join(process.execPath, '..', 'resources', 'package.json')).version)`;
    const value = ops
      .run(path, ['-e', script, '--', '--no-sandbox'], { ...process.env, ELECTRON_RUN_AS_NODE: '1' })
      .stdout.trim();
    if (!/^\d+\.\d+\.\d+/.test(value)) throw new Error('Cannot read AppImage version.');
    return value;
  };
  const validateImage = (path: string) => {
    if (!lstatSync(path).isFile()) throw new Error('Release must be a regular, non-symlink AppImage file.');
    const header = Buffer.alloc(20);
    const fd = openSync(path, 'r');
    try {
      if (readSync(fd, header, 0, header.length, 0) !== header.length)
        throw new Error('Release is not an AppImage ELF.');
    } finally {
      closeSync(fd);
    }
    if (header.toString('hex', 0, 4) !== '7f454c46' || header.toString('hex', 8, 11) !== '414902' || header[5] !== 1)
      throw new Error('Release is not a supported type-2 AppImage ELF.');
    const architectures: Record<string, number[]> = { x64: [2, 62], arm64: [2, 183], ia32: [1, 3], arm: [1, 40] };
    const arch = architectures[process.arch];
    if (!arch || header[4] !== arch[0] || header.readUInt16LE(18) !== arch[1])
      throw new Error(`AppImage architecture does not match ${process.arch}.`);
  };
  return {
    preflight,
    version() {
      try {
        return versionOf(image);
      } catch {
        return undefined;
      }
    },
    async stage(archive, version) {
      if (!version.trim()) throw new Error('An expected release version is required.');
      preflight();
      const lock = `${image}.update-lock`;
      try {
        mkdirSync(lock, { mode: 0o700 });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error(
            `Another AppImage update is in progress. If no updater is running, remove the stale lock ${lock} and retry.`,
            { cause },
          );
        throw cause;
      }
      let locked = true;
      const unlock = () => {
        if (locked) {
          rmdirSync(lock);
          locked = false;
        }
      };
      let scratch: string | undefined;
      let cleaned = false;
      const cleanup = () => {
        try {
          if (!cleaned) {
            if (scratch) rmSync(scratch, { recursive: true, force: true });
            cleaned = true;
          }
        } finally {
          unlock();
        }
      };
      try {
        const original = lstatSync(image);
        validateImage(resolve(archive));
        scratch = mkdtempSync(join(parent, '.pi-kit-update-'));
        const scratchName = basename(scratch);
        const staged = join(scratch, basename(image));
        copyFileSync(resolve(archive), staged, constants.COPYFILE_EXCL);
        const copied = lstatSync(staged);
        if (copied.uid !== original.uid || copied.gid !== original.gid) {
          try {
            ops.chown(staged, original.uid, original.gid);
          } catch (cause) {
            throw new Error(
              `Cannot preserve AppImage ownership (${original.uid}:${original.gid}). Grant permission to preserve the installed file's owner and group before updating; no automatic sudo is performed.`,
              { cause },
            );
          }
        }
        // chown may clear executable/security mode bits, so apply the retained mode afterwards.
        chmodSync(staged, (original.mode & 0o777) | 0o100);
        const validate = () => {
          validateImage(staged);
          if (versionOf(staged) !== version) throw new Error('AppImage version does not match the release.');
        };
        validate();
        let replaced = false;
        let recovery: string | undefined;
        let replacement: ReturnType<typeof lstatSync> | undefined;
        const unique = (base: string) => {
          let path = base;
          let suffix = 0;
          for (;;) {
            try {
              lstatSync(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path;
              throw error;
            }
            path = `${base}-${scratchName}-${++suffix}`;
          }
        };
        return {
          replace() {
            if (cleaned || replaced) throw new Error('This staged update is no longer available.');
            try {
              preflight();
              const current = lstatSync(image);
              if (
                current.dev !== original.dev ||
                current.ino !== original.ino ||
                current.mtimeMs !== original.mtimeMs ||
                current.size !== original.size ||
                current.uid !== original.uid ||
                current.gid !== original.gid
              )
                throw new Error('Installed AppImage changed while the update was staged.');
              validate();
              const previous = unique(`${image}.previous`);
              ops.rename(image, previous);
              try {
                ops.rename(staged, image);
              } catch (error) {
                try {
                  ops.rename(previous, image);
                } catch (rollback) {
                  throw new Error(
                    `AppImage replacement failed (${String(error)}); rollback failed (${String(rollback)}). Recover the AppImage from ${previous}.`,
                    { cause: rollback },
                  );
                }
                throw error;
              }
              replaced = true;
              recovery = previous;
              replacement = lstatSync(image);
            } catch (error) {
              cleanup();
              throw error;
            }
          },
          rollback() {
            if (cleaned || !replaced || !recovery || !replacement) throw new Error('No installed update to roll back.');
            const current = lstatSync(image);
            if (
              current.dev !== replacement.dev ||
              current.ino !== replacement.ino ||
              current.mtimeMs !== replacement.mtimeMs
            )
              throw new Error('Installed AppImage changed after replacement; refusing to overwrite it.');
            const failed = unique(`${image}.failed`);
            ops.rename(image, failed);
            try {
              ops.rename(recovery, image);
            } catch (error) {
              ops.rename(failed, image);
              throw error;
            }
            replaced = false;
          },
          cleanup,
        };
      } catch (error) {
        cleanup();
        throw error;
      }
    },
  };
}
