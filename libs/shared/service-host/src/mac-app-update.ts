import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { temporaryLocation } from './service-spec';

export interface MacAppUpdate {
  version(): string | undefined;
  preflight(): void;
  stage(archive: string, version: string): Promise<{ replace(): void; rollback?(): void; cleanup(): void }>;
}

/** Injection seam: commands never use a shell; filesystem operations otherwise use real directories. */
export interface MacAppUpdateSystem {
  run(file: string, args: string[]): { stdout: string; stderr: string };
  rename(from: string, to: string): void;
  writable(path: string): void;
}

const native: MacAppUpdateSystem = {
  run(file, args) {
    const result = spawnSync(file, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0)
      throw new Error(`${basename(file)} failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
    return { stdout: result.stdout, stderr: result.stderr };
  },
  rename: renameSync,
  writable: (path) => accessSync(path, constants.W_OK | constants.X_OK),
};

/**
 * Update a DMG-installed .app using the release zip, without modifying its signed contents or quarantine.
 * The caller must stop the background host and exclude an attached desktop before replace().
 * Successful replacements retain the previous bundle beside the install for manual recovery.
 */
export function macAppUpdate(root: string, system: Partial<MacAppUpdateSystem> = {}): MacAppUpdate {
  root = resolve(root);
  const ops = { ...native, ...system };
  const parent = dirname(root);
  const field = (app: string, key: string): string => {
    const plist = join(app, 'Contents', 'Info.plist');
    if (!lstatSync(plist).isFile()) throw new Error('App Info.plist must be a regular file.');
    const value = ops.run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]).stdout.trim();
    if (!value) throw new Error(`Missing ${key} in app bundle.`);
    return value;
  };
  const location = () => {
    const reason = temporaryLocation('darwin', root) || temporaryLocation('darwin', realpathSync(root));
    if (reason) throw new Error(reason);
    if (
      !root.endsWith('.app') ||
      !lstatSync(root).isDirectory() ||
      realpathSync(root) !== join(realpathSync(parent), basename(root))
    )
      throw new Error('Update target must be an installed, non-symlink .app directory.');
    try {
      ops.writable(parent);
    } catch (cause) {
      throw new Error(
        `App update needs write access to ${parent}. Use an administrator-authorized installation or move pi-kit to your user Applications folder; silent updates never request sudo. (${String(cause)})`,
        { cause },
      );
    }
  };
  const signature = (app: string, requirement?: string) =>
    ops.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', ...(requirement ? ['-R', requirement] : []), app]);

  return {
    preflight: location,
    version() {
      try {
        return field(root, 'CFBundleShortVersionString');
      } catch {
        return undefined;
      }
    },
    async stage(archive, version) {
      if (!version.trim()) throw new Error('An expected release version is required.');
      location();
      const lock = `${root}.update-lock`;
      try {
        mkdirSync(lock, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new Error(
            `Another app update is in progress. If no updater is running, remove the stale lock ${lock} and retry.`,
            { cause: error },
          );
        throw error;
      }
      let locked = true;
      const unlock = () => {
        if (locked) {
          rmdirSync(lock);
          locked = false;
        }
      };
      try {
        signature(root);
        const requirement = ops
          .run('/usr/bin/codesign', ['-d', '-r-', root])
          .stderr.split(/\r?\n/)
          .find((line) => line.startsWith('designated => '))
          ?.slice('designated => '.length)
          .trim();
        if (!requirement) throw new Error('Installed app has no designated code requirement.');
        const identifier = field(root, 'CFBundleIdentifier');
        const original = lstatSync(root);
        // ditto preserves bundle symlinks, signatures and extended attributes. Never extract over the installed app.
        const scratch = mkdtempSync(join(parent, '.pi-kit-update-'));
        let cleaned = false;
        let replaced = false;
        let recovery: string | undefined;
        let replacement: ReturnType<typeof lstatSync> | undefined;
        const cleanup = () => {
          try {
            if (!cleaned) {
              rmSync(scratch, { recursive: true, force: true });
              cleaned = true;
            }
          } finally {
            // Retry a failed lock removal even when scratch removal already succeeded.
            unlock();
          }
        };
        try {
          ops.run('/usr/bin/ditto', ['-x', '-k', resolve(archive), scratch]);
          const apps = readdirSync(scratch).filter((name) => name.endsWith('.app'));
          if (apps.length !== 1) throw new Error('Update archive must contain exactly one top-level .app.');
          const staged = join(scratch, apps[0]);
          const validate = () => {
            if (!lstatSync(staged).isDirectory() || realpathSync(staged) !== join(realpathSync(scratch), apps[0]))
              throw new Error('Staged app must be a non-symlink directory.');
            signature(staged, requirement);
            if (field(staged, 'CFBundleIdentifier') !== identifier)
              throw new Error('Update bundle identifier does not match the installed app.');
            if (field(staged, 'CFBundleShortVersionString') !== version)
              throw new Error('Update bundle version does not match the release.');
          };
          validate();
          return {
            replace() {
              if (cleaned || replaced) throw new Error('This staged update is no longer available.');
              try {
                location();
                const current = lstatSync(root);
                if (
                  current.dev !== original.dev ||
                  current.ino !== original.ino ||
                  current.mtimeMs !== original.mtimeMs
                )
                  throw new Error('Installed app changed while the update was staged.');
                validate();
                // Never overwrite an earlier recovery copy (including a dangling symlink).
                let previous = `${root}.previous`;
                try {
                  lstatSync(previous);
                  previous = `${root}.previous-${basename(scratch)}`;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
                ops.rename(root, previous);
                try {
                  ops.rename(staged, root);
                } catch (error) {
                  try {
                    ops.rename(previous, root);
                  } catch (rollback) {
                    throw new Error(
                      `App replacement failed (${String(error)}); rollback failed (${String(rollback)}). Recover the app from ${previous}.`,
                      { cause: rollback },
                    );
                  }
                  throw error;
                }
                replaced = true;
                recovery = previous;
                replacement = lstatSync(root);
              } catch (error) {
                cleanup();
                throw error;
              }
            },
            rollback() {
              if (cleaned || !replaced || !recovery || !replacement)
                throw new Error('No installed update to roll back.');
              const current = lstatSync(root);
              if (current.dev !== replacement.dev || current.ino !== replacement.ino)
                throw new Error('Installed app changed after replacement; refusing to overwrite it.');
              const failed = `${root}.failed-${basename(scratch)}`;
              ops.rename(root, failed);
              try {
                ops.rename(recovery, root);
              } catch (error) {
                ops.rename(failed, root);
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
      } catch (error) {
        unlock();
        throw error;
      }
    },
  };
}
