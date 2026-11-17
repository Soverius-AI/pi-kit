import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_RESET_PENDING_FILE } from '@pi-kit/protocol';
import { DatabaseReset } from './database-reset';
import { InstanceKeyStore } from './instance-key';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), openSync: vi.fn(actual.openSync) };
});
const scratch: string[] = [];
function profile(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pk-reset-'));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  vi.mocked(fs.renameSync).mockReset().mockImplementation(realRename);
  vi.mocked(fs.openSync).mockClear();
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const realRename = (await vi.importActual<typeof import('node:fs')>('node:fs')).renameSync;

describe('DatabaseReset.backup (scratch profiles only)', () => {
  it.each(['win32', 'darwin'] as const)(
    'uses the required source fsync access flags on mocked %s without changing original bytes',
    (platform) => {
      const dir = profile();
      const source = join(dir, 'pi-kit.sqlite');
      const bytes = Buffer.from([0, 255, 1, 128, 42, 0]);
      fs.writeFileSync(source, bytes);
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
      try {
        const backup = DatabaseReset.backup(dir);
        const access = platform === 'win32' ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
        expect(fs.openSync).toHaveBeenCalledWith(source, access | (fs.constants.O_NOFOLLOW ?? 0));
        expect(fs.readFileSync(join(backup.directory, 'pi-kit.sqlite'))).toEqual(bytes);
      } finally {
        platformSpy.mockRestore();
      }
    },
  );
  it('preserves both databases, every transition artifact/sidecar, and sealed identity, but nothing else', () => {
    const dir = profile();
    const files = ['pi-kit.sqlite', 'bg-agents.sqlite'].flatMap((name) =>
      ['', '.plaintext', '.encrypted', '.encrypting', '.decrypting'].flatMap((suffix) =>
        ['', '-wal', '-shm', '-journal'].map((sidecar) => name + suffix + sidecar),
      ),
    );
    fs.mkdirSync(join(dir, 'instance-keys'));
    files.push('instance-keys/identity.v1.enc');
    for (const name of files) fs.writeFileSync(join(dir, name), `original:${name}`, { mode: 0o600 });
    const untouched = [
      'ui.json',
      'credentials.json',
      'owner-epoch.sqlite',
      'mutex.sqlite',
      'service.json',
      'discovery.json',
    ];
    for (const name of untouched) fs.writeFileSync(join(dir, name), 'untouched');
    const backup = DatabaseReset.backup(dir);
    expect(backup.files.sort()).toEqual(files.sort());
    for (const name of files) {
      expect(fs.existsSync(join(dir, name))).toBe(false);
      expect(fs.readFileSync(join(backup.directory, name), 'utf8')).toBe(`original:${name}`);
    }
    expect(fs.existsSync(InstanceKeyStore.file(dir))).toBe(false);
    for (const name of untouched) expect(fs.readFileSync(join(dir, name), 'utf8')).toBe('untouched');
    expect(JSON.parse(fs.readFileSync(join(backup.directory, 'backup.json'), 'utf8')).completed).toBe(true);
    expect(fs.existsSync(join(dir, DATABASE_RESET_PENDING_FILE))).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(backup.directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(join(backup.directory, 'backup.json')).mode & 0o777).toBe(0o600);
    }
    const second = DatabaseReset.backup(dir);
    expect(second.directory).not.toBe(backup.directory);
    expect(fs.existsSync(backup.directory)).toBe(true);
  });

  it('refuses an existing pending marker without changing originals', () => {
    const dir = profile();
    fs.writeFileSync(join(dir, DATABASE_RESET_PENDING_FILE), 'pending');
    fs.writeFileSync(join(dir, 'pi-kit.sqlite'), 'original');
    expect(() => DatabaseReset.backup(dir)).toThrow('already pending');
    expect(fs.readFileSync(join(dir, 'pi-kit.sqlite'), 'utf8')).toBe('original');
  });

  it.each(['source', 'instance-keys'])('refuses a symlink %s before moving anything', (kind) => {
    const dir = profile();
    const target = profile();
    if (kind === 'source') {
      fs.writeFileSync(join(target, 'database'), 'original');
      fs.symlinkSync(join(target, 'database'), join(dir, 'pi-kit.sqlite'));
    } else fs.symlinkSync(target, join(dir, 'instance-keys'), 'dir');
    expect(() => DatabaseReset.backup(dir)).toThrow(/symlink|non-regular/);
    expect(fs.existsSync(join(dir, DATABASE_RESET_PENDING_FILE))).toBe(false);
  });

  it.each([false, true])('rolls back partial moves without overwriting a new original (conflict=%s)', (conflict) => {
    const dir = profile();
    fs.writeFileSync(join(dir, 'pi-kit.sqlite'), 'main');
    fs.writeFileSync(join(dir, 'pi-kit.sqlite-wal'), 'wal');
    let calls = 0;
    vi.mocked(fs.renameSync).mockImplementation((a, b) => {
      expect(fs.existsSync(join(dir, DATABASE_RESET_PENDING_FILE))).toBe(true);
      if (++calls === 2) {
        if (conflict) fs.writeFileSync(join(dir, 'pi-kit.sqlite'), 'new original');
        throw new Error('injected move failure');
      }
      realRename(a, b);
    });
    expect(() => DatabaseReset.backup(dir)).toThrow('injected move failure');
    expect(fs.readFileSync(join(dir, 'pi-kit.sqlite'), 'utf8')).toBe(conflict ? 'new original' : 'main');
    expect(fs.readFileSync(join(dir, 'pi-kit.sqlite-wal'), 'utf8')).toBe('wal');
    expect(fs.existsSync(join(dir, DATABASE_RESET_PENDING_FILE))).toBe(conflict);
    if (conflict) {
      const pending = JSON.parse(fs.readFileSync(join(dir, DATABASE_RESET_PENDING_FILE), 'utf8'));
      expect(fs.readFileSync(join(pending.directory, 'pi-kit.sqlite'), 'utf8')).toBe('main');
      expect(() => DatabaseReset.backup(dir)).toThrow('already pending');
    }
  });
});

describe('DatabaseReset.restore and clearCompleted (scratch profiles only)', () => {
  function interrupted(dir: string, moved: Record<string, string>, files = Object.keys(moved)) {
    const directory = join(dir, 'database-backup-interrupted');
    fs.mkdirSync(join(directory, 'instance-keys'), { recursive: true });
    for (const [name, text] of Object.entries(moved)) fs.writeFileSync(join(directory, name), text);
    fs.writeFileSync(join(dir, DATABASE_RESET_PENDING_FILE), JSON.stringify({ version: 1, directory, files }));
    return directory;
  }

  it('moves every original back, recreating instance-keys, and removes the marker and the empty backup folder', () => {
    const dir = profile();
    const key = InstanceKeyStore.file(dir);
    const directory = interrupted(dir, { 'pi-kit.sqlite': 'main', [join('instance-keys', 'identity.v1.enc')]: 'key' });
    expect(DatabaseReset.restore(dir)).toEqual({
      directory,
      files: ['pi-kit.sqlite', join('instance-keys', 'identity.v1.enc')],
    });
    expect(fs.readFileSync(join(dir, 'pi-kit.sqlite'), 'utf8')).toBe('main');
    expect(fs.readFileSync(key, 'utf8')).toBe('key');
    expect(fs.existsSync(join(dir, DATABASE_RESET_PENDING_FILE))).toBe(false);
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('undoes a completed backup too', () => {
    const dir = profile();
    fs.writeFileSync(join(dir, 'pi-kit.sqlite'), 'main');
    fs.writeFileSync(join(dir, 'bg-agents.sqlite-wal'), 'wal');
    const backup = DatabaseReset.backup(dir);
    fs.writeFileSync(join(dir, DATABASE_RESET_PENDING_FILE), JSON.stringify({ version: 1, ...backup }));
    expect(DatabaseReset.restore(dir).files.sort()).toEqual(['bg-agents.sqlite-wal', 'pi-kit.sqlite']);
    expect(fs.readFileSync(join(dir, 'pi-kit.sqlite'), 'utf8')).toBe('main');
    expect(fs.existsSync(backup.directory)).toBe(false);
  });

  it('keeps the marker and names conflicting files, then finishes once one copy is kept', () => {
    const dir = profile();
    interrupted(dir, { 'pi-kit.sqlite': 'main', 'pi-kit.sqlite-wal': 'wal' });
    fs.writeFileSync(join(dir, 'pi-kit.sqlite'), 'new original');
    expect(() => DatabaseReset.restore(dir)).toThrow(/pi-kit\.sqlite\. Keep one copy/);
    expect(fs.readFileSync(join(dir, 'pi-kit.sqlite-wal'), 'utf8')).toBe('wal');
    expect(fs.readFileSync(join(dir, 'pi-kit.sqlite'), 'utf8')).toBe('new original');
    expect(fs.existsSync(join(dir, DATABASE_RESET_PENDING_FILE))).toBe(true);
    fs.rmSync(join(dir, 'pi-kit.sqlite'));
    expect(DatabaseReset.restore(dir).files).toEqual(['pi-kit.sqlite']);
    expect(fs.readFileSync(join(dir, 'pi-kit.sqlite'), 'utf8')).toBe('main');
    expect(fs.existsSync(join(dir, DATABASE_RESET_PENDING_FILE))).toBe(false);
  });

  it('treats a half-finished rollback link as the same file, not a conflict', () => {
    const dir = profile();
    const directory = interrupted(dir, { 'pi-kit.sqlite': 'main' });
    fs.linkSync(join(directory, 'pi-kit.sqlite'), join(dir, 'pi-kit.sqlite'));
    expect(DatabaseReset.restore(dir).files).toEqual(['pi-kit.sqlite']);
    expect(fs.readFileSync(join(dir, 'pi-kit.sqlite'), 'utf8')).toBe('main');
    expect(fs.existsSync(directory)).toBe(false);
  });

  it.each([
    ['unreadable', 'not json'],
    ['outside the profile', JSON.stringify({ version: 1, directory: '/elsewhere', files: [] })],
    ['an unknown file', JSON.stringify({ version: 1, directory: 'database-backup-x', files: ['../ui.json'] })],
  ])('refuses an %s marker without touching files', (_kind, marker) => {
    const dir = profile();
    fs.writeFileSync(join(dir, DATABASE_RESET_PENDING_FILE), marker);
    expect(() => DatabaseReset.restore(dir)).toThrow('is unreadable');
    expect(DatabaseReset.clearCompleted(dir)).toBe(false);
    expect(fs.readFileSync(join(dir, DATABASE_RESET_PENDING_FILE), 'utf8')).toBe(marker);
  });

  it('clears only the marker of a backup recorded as completed', () => {
    const dir = profile();
    expect(DatabaseReset.clearCompleted(dir)).toBe(false);
    const directory = interrupted(dir, { 'pi-kit.sqlite': 'main' });
    expect(DatabaseReset.clearCompleted(dir)).toBe(false);
    fs.writeFileSync(join(directory, 'backup.json'), JSON.stringify({ version: 1, completed: true }));
    expect(DatabaseReset.clearCompleted(dir)).toBe(true);
    expect(fs.existsSync(join(dir, DATABASE_RESET_PENDING_FILE))).toBe(false);
    expect(fs.readFileSync(join(directory, 'pi-kit.sqlite'), 'utf8')).toBe('main');
  });
});
