import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { macAppUpdate, type MacAppUpdateSystem } from './mac-app-update';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'mac-app-update-test-'));
  directories.push(parent);
  const root = join(parent, 'pi-kit.app');
  const bundle = (path: string, version: string, identifier = 'dev.pi-kit') => {
    mkdirSync(join(path, 'Contents'), { recursive: true });
    writeFileSync(
      join(path, 'Contents', 'Info.plist'),
      JSON.stringify({ CFBundleIdentifier: identifier, CFBundleShortVersionString: version }),
    );
    writeFileSync(join(path, 'signed-bytes'), version);
  };
  bundle(root, '1.0.0');
  const commands: Array<{ file: string; args: string[] }> = [];
  let newVersion = '2.0.0';
  let newIdentifier = 'dev.pi-kit';
  let invalid = false;
  let requirement = 'identifier "dev.pi-kit" and anchor apple generic';
  let extraction: ((scratch: string) => void) | undefined;
  const run: MacAppUpdateSystem['run'] = (file, args) => {
    commands.push({ file, args });
    if (basename(file) === 'ditto') {
      const scratch = args[args.length - 1];
      if (extraction) extraction(scratch);
      else bundle(join(scratch, 'pi-kit.app'), newVersion, newIdentifier);
    }
    if (basename(file) === 'plutil')
      return { stdout: JSON.parse(readFileSync(args[args.length - 1], 'utf8'))[args[1]], stderr: '' };
    if (args[0] === '-d')
      return { stdout: '', stderr: requirement ? `Executable=...\ndesignated => ${requirement}\n` : '' };
    if (basename(file) === 'codesign' && args.includes('-R') && invalid) throw new Error('signature rejected');
    return { stdout: '', stderr: '' };
  };
  const updater = (ops: Partial<MacAppUpdateSystem> = {}) => macAppUpdate(root, { run, ...ops });
  return {
    root,
    parent,
    bundle,
    updater,
    commands,
    badVersion: () => {
      newVersion = '9.0.0';
    },
    badIdentifier: () => {
      newIdentifier = 'other';
    },
    badSignature: () => {
      invalid = true;
    },
    noRequirement: () => {
      requirement = '';
    },
    extract: (fn: (scratch: string) => void) => {
      extraction = fn;
    },
  };
}

describe('headless macOS app replacement (scratch bundles and fake Apple tools only)', () => {
  it('validates before mutation, preserves bundle bytes and retains previous installs through cleanup', async () => {
    const f = fixture();
    expect(f.updater().version()).toBe('1.0.0');
    const staged = await f.updater().stage('/release.zip', '2.0.0');
    expect(f.updater().version()).toBe('1.0.0');
    expect(f.commands).toContainEqual({
      file: '/usr/bin/codesign',
      args: [
        '--verify',
        '--deep',
        '--strict',
        '-R',
        'identifier "dev.pi-kit" and anchor apple generic',
        expect.any(String),
      ],
    });
    staged.replace();
    staged.cleanup();
    staged.cleanup();
    expect(f.updater().version()).toBe('2.0.0');
    expect(readFileSync(join(f.root, 'signed-bytes'), 'utf8')).toBe('2.0.0');
    expect(readFileSync(join(`${f.root}.previous`, 'signed-bytes'), 'utf8')).toBe('1.0.0');
    expect(() => staged.replace()).toThrow('no longer available');
  });

  it.each(['badVersion', 'badIdentifier', 'badSignature', 'noRequirement'] as const)(
    'rejects %s without touching the install or leaking scratch',
    async (failure) => {
      const f = fixture();
      f[failure]();
      await expect(f.updater().stage('/release.zip', '2.0.0')).rejects.toThrow();
      expect(f.updater().version()).toBe('1.0.0');
      const { readdirSync } = await import('node:fs');
      expect(readdirSync(f.parent)).toEqual(['pi-kit.app']);
    },
  );

  it('can restore the retained app after a new service fails to start', async () => {
    const f = fixture();
    const staged = await f.updater().stage('/release.zip', '2.0.0');
    staged.replace();
    expect(f.updater().version()).toBe('2.0.0');
    staged.rollback!();
    staged.cleanup();
    expect(f.updater().version()).toBe('1.0.0');
    const { readdirSync } = await import('node:fs');
    const failed = readdirSync(f.parent).find((name) => name.startsWith('pi-kit.app.failed-'))!;
    expect(readFileSync(join(f.parent, failed, 'signed-bytes'), 'utf8')).toBe('2.0.0');
  });

  it('rolls back when the second rename fails', async () => {
    const f = fixture();
    let renames = 0;
    const staged = await f
      .updater({
        rename(from, to) {
          if (++renames === 2) throw new Error('second rename failed');
          renameSync(from, to);
        },
      })
      .stage('/release.zip', '2.0.0');
    expect(() => staged.replace()).toThrow('second rename failed');
    expect(renames).toBe(3);
    staged.cleanup();
    expect(f.updater().version()).toBe('1.0.0');
    expect(existsSync(`${f.root}.previous`)).toBe(false);
  });

  it('preserves recovery bundle when rollback also fails', async () => {
    const f = fixture();
    let renames = 0;
    const staged = await f
      .updater({
        rename(from, to) {
          if (++renames > 1) throw new Error('disk failure');
          renameSync(from, to);
        },
      })
      .stage('/release.zip', '2.0.0');
    expect(() => staged.replace()).toThrow(/rollback failed.*Recover the app from/);
    staged.cleanup();
    expect(readFileSync(join(`${f.root}.previous`, 'signed-bytes'), 'utf8')).toBe('1.0.0');
  });

  it('rejects unwritable parents before extraction', async () => {
    const f = fixture();
    await expect(
      f
        .updater({
          writable() {
            throw new Error('not writable');
          },
        })
        .stage('/release.zip', '2.0.0'),
    ).rejects.toThrow('not writable');
    expect(f.commands).toEqual([]);
  });

  it('rejects translocated locations and symlink install targets', async () => {
    const f = fixture();
    await expect(macAppUpdate('/Volumes/installer/pi-kit.app').stage('/release.zip', '2.0.0')).rejects.toThrow(
      'temporary location',
    );
    const alias = join(f.parent, 'alias.app');
    symlinkSync(f.root, alias);
    await expect(macAppUpdate(alias).stage('/release.zip', '2.0.0')).rejects.toThrow('non-symlink');
  });

  it('rejects a symlink staged bundle without deleting its target', async () => {
    const f = fixture();
    f.extract((scratch) => symlinkSync(f.root, join(scratch, 'pi-kit.app')));
    await expect(f.updater().stage('/release.zip', '2.0.0')).rejects.toThrow('non-symlink');
    expect(f.updater().version()).toBe('1.0.0');
  });

  it('revalidates staged signatures and rejects a changed install before renaming', async () => {
    const f = fixture();
    const staged = await f.updater().stage('/release.zip', '2.0.0');
    f.badSignature();
    expect(() => staged.replace()).toThrow('signature rejected');
    staged.cleanup();
    expect(f.updater().version()).toBe('1.0.0');
  });

  it('excludes concurrent stages until cleanup, without stealing stale locks', async () => {
    const f = fixture();
    const staged = await f.updater().stage('/release.zip', '2.0.0');
    await expect(f.updater().stage('/release.zip', '2.0.0')).rejects.toThrow('stale lock');
    staged.replace();
    await expect(f.updater().stage('/release.zip', '2.0.0')).rejects.toThrow('Another app update');
    staged.cleanup();
    expect(existsSync(`${f.root}.update-lock`)).toBe(false);
    const next = await f.updater().stage('/release.zip', '2.0.0');
    next.cleanup();
  });

  it('releases the lock after validation or replacement failure', async () => {
    const f = fixture();
    f.badSignature();
    await expect(f.updater().stage('/release.zip', '2.0.0')).rejects.toThrow('signature rejected');
    expect(existsSync(`${f.root}.update-lock`)).toBe(false);
    const g = fixture();
    const staged = await g
      .updater({
        rename() {
          throw new Error('rename failed');
        },
      })
      .stage('/release.zip', '2.0.0');
    expect(() => staged.replace()).toThrow('rename failed');
    expect(existsSync(`${g.root}.update-lock`)).toBe(false);
    expect(g.updater().version()).toBe('1.0.0');
  });

  it('does not overwrite an earlier previous bundle', async () => {
    const f = fixture();
    f.bundle(`${f.root}.previous`, '0.9.0');
    const previousInode = lstatSync(`${f.root}.previous`).ino;
    const staged = await f.updater().stage('/release.zip', '2.0.0');
    staged.replace();
    staged.cleanup();
    expect(lstatSync(`${f.root}.previous`).ino).toBe(previousInode);
    expect(readFileSync(join(`${f.root}.previous`, 'signed-bytes'), 'utf8')).toBe('0.9.0');
  });
});
