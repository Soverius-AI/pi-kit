import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linuxAppUpdate, type LinuxAppUpdateSystem } from './linux-app-update';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'linux-app-update-test-'));
  directories.push(parent);
  const root = join(parent, 'custom name.AppImage');
  const archive = join(parent, 'download');
  const bytes = (version: string) => {
    const header = Buffer.alloc(20);
    header.write('7f454c46', 0, 'hex');
    header[4] = process.arch === 'ia32' || process.arch === 'arm' ? 1 : 2;
    header[5] = 1;
    header.write('414902', 8, 'hex');
    header.writeUInt16LE(({ x64: 62, arm64: 183, ia32: 3, arm: 40 } as Record<string, number>)[process.arch], 18);
    return Buffer.concat([header, Buffer.from(version)]);
  };
  writeFileSync(root, bytes('1.0.0'), { mode: 0o751 });
  writeFileSync(archive, bytes('2.0.0'));
  const commands: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const run: LinuxAppUpdateSystem['run'] = (file, args, env) => {
    commands.push({ file, args, env });
    return { stdout: readFileSync(file).subarray(20).toString(), stderr: '' };
  };
  const updater = (ops: Partial<LinuxAppUpdateSystem> = {}) => linuxAppUpdate(root, { run, ...ops });
  const version = (path = root) => readFileSync(path).subarray(20).toString();
  return { parent, root, archive, bytes, commands, updater, version };
}

describe('Linux AppImage updates (scratch files and fake commands only)', () => {
  it('stages beside the original path, preserves executable mode and retains the old image', async () => {
    const f = fixture();
    expect(f.updater().version()).toBe('1.0.0');
    const staged = await f.updater().stage(f.archive, '2.0.0');
    expect(f.version()).toBe('1.0.0');
    const command = f.commands.at(-1)!;
    expect(command.file.startsWith(join(f.parent, '.pi-kit-update-'))).toBe(true);
    expect(command.args).toEqual(['-e', expect.stringContaining("'resources', 'package.json'"), '--', '--no-sandbox']);
    expect(command.env?.['ELECTRON_RUN_AS_NODE']).toBe('1');
    staged.replace();
    staged.cleanup();
    staged.cleanup();
    expect(f.version()).toBe('2.0.0');
    expect(f.version(`${f.root}.previous`)).toBe('1.0.0');
    expect(lstatSync(f.root).mode & 0o777).toBe(0o751);
    expect(existsSync(`${f.root}.update-lock`)).toBe(false);
    expect(readdirSync(f.parent).some((name) => name.startsWith('.pi-kit-update-'))).toBe(false);
    expect(() => staged.replace()).toThrow('no longer available');
  });

  it.each(['parent', 'image'] as const)('preflights %s permissions before executing any image', async (denied) => {
    const f = fixture();
    const updater = f.updater({
      writable(path) {
        if (path === (denied === 'parent' ? f.parent : f.root)) throw new Error('denied');
      },
    });
    expect(() => updater.preflight()).toThrow(/needs write access.*no automatic sudo/);
    await expect(updater.stage(f.archive, '2.0.0')).rejects.toThrow('needs write access');
    expect(f.commands).toEqual([]);
    expect(existsSync(`${f.root}.update-lock`)).toBe(false);
  });

  it('detects an existing file without write permission bits even under root', () => {
    const f = fixture();
    chmodSync(f.root, 0o555);
    expect(() => f.updater().preflight()).toThrow('needs write access');
  });

  it.each(['elf', 'architecture', 'version', 'symlink', 'short'] as const)(
    'rejects invalid %s before replacement and cleans scratch',
    async (failure) => {
      const f = fixture();
      const bytes = f.bytes('2.0.0');
      if (failure === 'elf') bytes[8] = 0;
      if (failure === 'architecture') bytes.writeUInt16LE(0, 18);
      if (failure === 'version') writeFileSync(f.archive, f.bytes('9.0.0'));
      else if (failure === 'symlink') {
        rmSync(f.archive);
        symlinkSync(f.root, f.archive);
      } else writeFileSync(f.archive, failure === 'short' ? Buffer.from('ELF') : bytes);
      await expect(f.updater().stage(f.archive, '2.0.0')).rejects.toThrow();
      expect(f.version()).toBe('1.0.0');
      expect(readdirSync(f.parent).sort()).toEqual(['custom name.AppImage', 'download']);
      if (failure !== 'version') expect(f.commands).toEqual([]);
    },
  );

  it('does not chown an image whose ownership already matches', async () => {
    const f = fixture();
    const staged = await f
      .updater({
        chown() {
          throw new Error('unnecessary chown');
        },
      })
      .stage(f.archive, '2.0.0');
    staged.replace();
    staged.cleanup();
    expect(lstatSync(f.root).uid).toBe(process.getuid!());
    expect(lstatSync(f.root).gid).toBe(lstatSync(f.archive).gid);
  });

  it.runIf(process.getuid?.() === 0)('preserves user ownership when an elevated updater stages the image', async () => {
    const f = fixture();
    chownSync(f.root, 12345, 12345);
    const staged = await f.updater().stage(f.archive, '2.0.0');
    const scratch = f.commands.at(-1)!.file;
    expect(lstatSync(scratch).uid).toBe(12345);
    expect(lstatSync(scratch).gid).toBe(12345);
    staged.replace();
    staged.cleanup();
    expect(lstatSync(f.root).uid).toBe(12345);
    expect(lstatSync(f.root).gid).toBe(12345);
    expect(lstatSync(f.root).mode & 0o777).toBe(0o751);
  });

  it.runIf(process.getuid?.() === 0)(
    'fails staging before image execution if ownership cannot be preserved',
    async () => {
      const f = fixture();
      chownSync(f.root, 12345, 12345);
      await expect(
        f
          .updater({
            chown() {
              throw new Error('permission denied');
            },
          })
          .stage(f.archive, '2.0.0'),
      ).rejects.toThrow(/Cannot preserve AppImage ownership.*no automatic sudo/);
      expect(f.commands).toEqual([]);
      expect(f.version()).toBe('1.0.0');
      expect(existsSync(`${f.root}.update-lock`)).toBe(false);
      expect(readdirSync(f.parent).some((name) => name.startsWith('.pi-kit-update-'))).toBe(false);
    },
  );

  it('rejects a symlink root', async () => {
    const f = fixture();
    const alias = join(f.parent, 'alias.AppImage');
    symlinkSync(f.root, alias);
    await expect(linuxAppUpdate(alias).stage(f.archive, '2.0.0')).rejects.toThrow('non-symlink');
    expect(f.version()).toBe('1.0.0');
  });

  it('excludes concurrent stages until cleanup and never steals a stale lock', async () => {
    const f = fixture();
    const staged = await f.updater().stage(f.archive, '2.0.0');
    await expect(f.updater().stage(f.archive, '2.0.0')).rejects.toThrow('stale lock');
    staged.replace();
    await expect(f.updater().stage(f.archive, '2.0.0')).rejects.toThrow('Another AppImage update');
    staged.cleanup();
    const next = await f.updater().stage(f.archive, '2.0.0');
    next.cleanup();
  });

  it('does not overwrite existing recovery files, including dangling symlinks', async () => {
    const f = fixture();
    symlinkSync(join(f.parent, 'missing'), `${f.root}.previous`);
    const inode = lstatSync(`${f.root}.previous`).ino;
    const staged = await f.updater().stage(f.archive, '2.0.0');
    staged.replace();
    staged.cleanup();
    expect(lstatSync(`${f.root}.previous`).ino).toBe(inode);
    const previous = readdirSync(f.parent).find((name) => name.startsWith('custom name.AppImage.previous-'))!;
    expect(f.version(join(f.parent, previous))).toBe('1.0.0');
  });

  it('rolls back when the second rename fails and releases the lock', async () => {
    const f = fixture();
    let count = 0;
    const staged = await f
      .updater({
        rename(from, to) {
          if (++count === 2) throw new Error('rename failed');
          renameSync(from, to);
        },
      })
      .stage(f.archive, '2.0.0');
    expect(() => staged.replace()).toThrow('rename failed');
    expect(count).toBe(3);
    expect(f.version()).toBe('1.0.0');
    expect(existsSync(`${f.root}.update-lock`)).toBe(false);
    staged.cleanup();
  });

  it('preserves the recovery file with actionable advice if rollback fails too', async () => {
    const f = fixture();
    let count = 0;
    const staged = await f
      .updater({
        rename(from, to) {
          if (++count > 1) throw new Error('disk failure');
          renameSync(from, to);
        },
      })
      .stage(f.archive, '2.0.0');
    expect(() => staged.replace()).toThrow(/rollback failed.*Recover the AppImage from/);
    expect(f.version(`${f.root}.previous`)).toBe('1.0.0');
    staged.cleanup();
  });

  it('supports rollback after restarting the new backend fails', async () => {
    const f = fixture();
    const staged = await f.updater().stage(f.archive, '2.0.0');
    staged.replace();
    staged.rollback!();
    staged.cleanup();
    expect(f.version()).toBe('1.0.0');
    expect(f.version(`${f.root}.failed`)).toBe('2.0.0');
  });

  it('rejects an install changed during staging without overwriting it', async () => {
    const f = fixture();
    const staged = await f.updater().stage(f.archive, '2.0.0');
    writeFileSync(f.root, f.bytes('1.0.0-modified'));
    expect(() => staged.replace()).toThrow('changed while');
    expect(f.version()).toBe('1.0.0-modified');
    expect(existsSync(`${f.root}.update-lock`)).toBe(false);
  });

  it('revalidates the staged image immediately before replacement', async () => {
    const f = fixture();
    const staged = await f.updater().stage(f.archive, '2.0.0');
    writeFileSync(f.commands.at(-1)!.file, f.bytes('9.0.0'));
    expect(() => staged.replace()).toThrow('version does not match');
    expect(f.version()).toBe('1.0.0');
  });

  it('refuses rollback over an independently replaced image', async () => {
    const f = fixture();
    const staged = await f.updater().stage(f.archive, '2.0.0');
    staged.replace();
    renameSync(f.root, join(f.parent, 'other'));
    writeFileSync(f.root, f.bytes('3.0.0'));
    expect(() => staged.rollback!()).toThrow('changed after');
    staged.cleanup();
    expect(f.version()).toBe('3.0.0');
  });
});
