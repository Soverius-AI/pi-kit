import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DB_KEY_ACCOUNT } from '@pi-kit/protocol';
import { MemorySecretStore, type SecretStore } from '@pi-kit/secret-store';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BG_DB_FILE, DB_FILE, DatabaseService } from './database.service';
import { encryptDatabaseFile, isPlainDatabase, keyOpens, newDatabaseKey } from './encryption';

const scratch = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'pk-dbenc-')));
const SECRET = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123';

/** A database file as the version before 8l wrote it: plaintext, WAL, with rows in the tables the app has. */
function plainFixture(dir: string): string {
  const service = new DatabaseService({ dataDir: dir });
  service.db.prepare("INSERT INTO threads (id, session_path, cwd, created_at, updated_at) VALUES ('t1', '/s/1.jsonl', '/p', 1, 1)").run();
  service.db.prepare("INSERT INTO thread_events (thread_id, seq, run_id, event_json, type) VALUES ('t1', 1, 'r1', ?, 'TEXT_MESSAGE_CONTENT')").run(JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', delta: `my key is ${SECRET}` }));
  service.db.prepare("INSERT INTO settings (key, value_json) VALUES ('theme', '\"dark\"')").run();
  service.onApplicationShutdown();
  return join(dir, DB_FILE);
}

const count = (dir: string, key: string, table: string): number => {
  const db = new Database(join(dir, DB_FILE));
  try {
    db.pragma("cipher='chacha20'");
    db.pragma(`key="x'${key}'"`);
    return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe('encrypting pi-kit’s database', () => {
  let dir: string;
  beforeEach(async () => {
    dir = scratch();
  });
  afterEach(() => {
    delete process.env['PI_KIT_DB_KEY'];
  });

  it('a plaintext file from an earlier version is encrypted at the first start with a store: every row survives, the plaintext is gone, the key is in the store', async () => {
    const file = plainFixture(dir);
    expect(isPlainDatabase(file)).toBe(true);
    expect(readFileSync(file).includes(Buffer.from(SECRET))).toBe(true);

    const store = new MemorySecretStore();
    const service = await DatabaseService.create({ dataDir: dir }, store);
    expect(service.protection).toMatchObject({ state: 'encrypted', path: file });
    expect(service.db.prepare('SELECT count(*) AS n FROM threads').get()).toEqual({ n: 1 });
    expect(service.db.prepare("SELECT value_json FROM settings WHERE key = 'theme'").get()).toEqual({ value_json: '"dark"' });
    expect((service.db.prepare('SELECT event_json FROM thread_events').get() as { event_json: string }).event_json).toContain(SECRET);
    service.onApplicationShutdown();

    expect(isPlainDatabase(file)).toBe(false);
    // The secret is not readable anywhere on disk: not in the file, not in a leftover of the migration.
    for (const name of readdirSync(dir)) expect(readFileSync(join(dir, name)).includes(Buffer.from(SECRET)), `${name} holds the plaintext`).toBe(false);
    expect(readdirSync(dir).filter((n) => n.includes('plaintext') || n.includes('encrypting'))).toEqual([]);
    const key = store.get(DB_KEY_ACCOUNT) as string;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(count(dir, key, 'threads')).toBe(1);
  });

  it('the file is unreadable with plain sqlite3 and with the wrong key, and readable again after a restart with the key from the store', async () => {
    plainFixture(dir);
    const store = new MemorySecretStore();
    (await DatabaseService.create({ dataDir: dir }, store)).onApplicationShutdown();
    const file = join(dir, DB_FILE);
    const sqlite = spawnSync('sqlite3', [file, 'select count(*) from sqlite_master'], { encoding: 'utf8' });
    if (!sqlite.error) expect(sqlite.stderr + sqlite.stdout).toMatch(/not a database|encrypted/i);
    expect(keyOpens(file, newDatabaseKey())).toBe(false);
    expect(keyOpens(file, store.get(DB_KEY_ACCOUNT) as string)).toBe(true);
    const again = await DatabaseService.create({ dataDir: dir }, store);
    expect(again.db.prepare('SELECT count(*) AS n FROM threads').get()).toEqual({ n: 1 });
    expect(again.protection.state).toBe('encrypted');
    again.onApplicationShutdown();
  });

  it('a new install starts encrypted, and the key is the one in the store', async () => {
    const store = new MemorySecretStore();
    const service = await DatabaseService.create({ dataDir: dir }, store);
    expect(service.protection.state).toBe('encrypted');
    expect(service.recoveryKey()).toBe(store.get(DB_KEY_ACCOUNT));
    service.onApplicationShutdown();
    expect(isPlainDatabase(join(dir, DB_FILE))).toBe(false);
  });

  it('preserves the encrypted database when credential access is denied, and reopens it after access returns', async () => {
    const store = new MemorySecretStore();
    const service = await DatabaseService.create({ dataDir: dir }, store);
    service.db.prepare("INSERT INTO settings (key, value_json) VALUES ('preserved', '1')").run();
    service.onApplicationShutdown();
    const file = join(dir, DB_FILE);
    const before = readFileSync(file);
    const read = store.get.bind(store);
    store.get = () => { throw new Error('Credential access denied'); };
    await expect(DatabaseService.create({ dataDir: dir }, store)).rejects.toThrow(/Credential access denied/);
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(dir).some((name) => name.includes('unreadable'))).toBe(false);
    store.get = read;
    const reopened = await DatabaseService.create({ dataDir: dir }, store);
    expect(reopened.db.prepare("SELECT value_json FROM settings WHERE key = 'preserved'").get()).toEqual({ value_json: '1' });
    reopened.onApplicationShutdown();
  });

  it('preserves an encrypted database when biometric authentication is cancelled or its key conflicts', async () => {
    const store = new MemorySecretStore();
    const service = await DatabaseService.create({ dataDir: dir }, store);
    service.db.prepare("INSERT INTO settings (key, value_json) VALUES ('preserved', '1')").run();
    service.onApplicationShutdown();
    const file = join(dir, DB_FILE);
    const before = readFileSync(file);
    const biometric: SecretStore = {
      kind: 'keychain', label: 'Touch ID', protected: true, available: () => true,
      get: async () => { throw new Error('Authentication cancelled'); },
      set: async () => undefined, delete: async () => false, list: async () => [],
    };
    await expect(DatabaseService.create({ dataDir: dir }, biometric)).rejects.toThrow(/cancelled/);
    biometric.get = async () => newDatabaseKey();
    await expect(DatabaseService.create({ dataDir: dir }, biometric)).rejects.toThrow(/does not open/);
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(dir).some((name) => name.includes('unreadable'))).toBe(false);
  });

  it('without a credential store the file stays plaintext and says why', async () => {
    const none: SecretStore = { kind: 'none', label: 'none', available: () => false, get: () => undefined, set: () => undefined, delete: () => false, list: () => [] };
    const service = await DatabaseService.create({ dataDir: dir }, none);
    expect(service.protection.state).toBe('plain');
    expect(service.protection.reason).toMatch(/no credential store/i);
    expect(service.recoveryKey()).toBeUndefined();
    service.onApplicationShutdown();
    expect(isPlainDatabase(join(dir, DB_FILE))).toBe(true);
    expect(new DatabaseService({ dataDir: scratch() }).protection.state).toBe('plain');
  });

  it('a store that refuses the key keeps the file plaintext instead of locking the person out', async () => {
    const locked: SecretStore = { ...new MemorySecretStore(), kind: 'keychain', label: 'macOS Keychain', available: () => true, get: () => undefined, set: () => { throw new Error('The keychain is locked'); }, delete: () => false, list: () => [] };
    const service = await DatabaseService.create({ dataDir: dir }, locked);
    expect(service.protection).toMatchObject({ state: 'plain', reason: expect.stringContaining('keychain is locked') });
    service.onApplicationShutdown();
  });

  it('a wrong key throws without renaming or resetting the database, and the original key recovers it', async () => {
    const first = new MemorySecretStore();
    const service = await DatabaseService.create({ dataDir: dir }, first);
    service.db.prepare("INSERT INTO settings (key, value_json) VALUES ('keep', '1')").run();
    const oldKey = service.recoveryKey() as string;
    service.onApplicationShutdown();
    const file = join(dir, DB_FILE);
    const before = readFileSync(file);
    const names = readdirSync(dir);
    const lost = new MemorySecretStore();
    const wrongKey = newDatabaseKey();
    lost.set(DB_KEY_ACCOUNT, wrongKey);
    await expect(DatabaseService.create({ dataDir: dir }, lost)).rejects.toThrow(/does not open/);
    expect(readFileSync(file)).toEqual(before);
    expect(readdirSync(dir)).toEqual(names);
    expect(lost.get(DB_KEY_ACCOUNT)).toBe(wrongKey);
    process.env['PI_KIT_DB_KEY'] = oldKey;
    const recovered = await DatabaseService.create({ dataDir: dir }, lost);
    expect(recovered.db.prepare("SELECT value_json FROM settings WHERE key = 'keep'").get()).toEqual({ value_json: '1' });
    recovered.onApplicationShutdown();
  });

  it('explicitly disabled encryption never probes a store for a fresh or plaintext database', async () => {
    const store = new MemorySecretStore();
    const calls = ['available', 'get', 'set', 'delete'].map((method) => vi.spyOn(store, method as 'get'));
    process.env['PI_KIT_DB_KEY'] = newDatabaseKey();
    const fresh = await DatabaseService.create({ dataDir: dir }, store, false);
    expect(fresh.protection.state).toBe('plain');
    expect(fresh.recoveryKey()).toBeUndefined();
    fresh.onApplicationShutdown();
    const again = await DatabaseService.create({ dataDir: dir }, store, false);
    expect(again.protection.state).toBe('plain');
    again.onApplicationShutdown();
    for (const call of calls) expect(call).not.toHaveBeenCalled();
    expect(isPlainDatabase(join(dir, DB_FILE))).toBe(true);
  });

  it('creates a private database and WAL sidecars in a private new data directory', async () => {
    if (process.platform === 'win32') return; // POSIX mode bits are not Windows ACLs.
    const dataDir = join(dir, 'new-profile');
    const service = await DatabaseService.create({ dataDir }, new MemorySecretStore(), false);
    try {
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dataDir, DB_FILE)).mode & 0o777).toBe(0o600);
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = join(dataDir, `${DB_FILE}${suffix}`);
        expect(existsSync(sidecar)).toBe(true);
        expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }
    } finally {
      service.onApplicationShutdown();
    }
  });

  it('credential opt-out retains encrypted rows, original key, and encrypted bytes', async () => {
    const file = plainFixture(dir);
    const store = new MemorySecretStore();
    (await DatabaseService.create({ dataDir: dir }, store)).onApplicationShutdown();
    const key = store.get(DB_KEY_ACCOUNT);
    const bytes = readFileSync(file);
    const set = vi.spyOn(store, 'set');
    const remove = vi.spyOn(store, 'delete');
    const service = await DatabaseService.create({ dataDir: dir }, store, false);
    expect(service.protection.state).toBe('encrypted');
    expect(service.db.prepare('SELECT count(*) AS n FROM threads').get()).toEqual({ n: 1 });
    expect((service.db.prepare('SELECT event_json FROM thread_events').get() as { event_json: string }).event_json).toContain(SECRET);
    expect(service.db.prepare("SELECT value_json FROM settings WHERE key = 'theme'").get()).toEqual({ value_json: '"dark"' });
    service.onApplicationShutdown();
    expect(isPlainDatabase(file)).toBe(false);
    expect(readFileSync(file)).toEqual(bytes);
    expect(store.get(DB_KEY_ACCOUNT)).toBe(key);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([DB_FILE]);
  });

  it('keeps an encrypted WAL snapshot valid across opted-out startup and retains committed updates', async () => {
    const store = new MemorySecretStore();
    const first = await DatabaseService.create({ dataDir: dir }, store);
    first.db.prepare("INSERT INTO settings (key, value_json) VALUES ('snapshot', '1')").run();
    first.onApplicationShutdown();
    const key = store.get(DB_KEY_ACCOUNT) as string;
    const file = join(dir, DB_FILE);
    const reader = new Database(file);
    try {
      reader.pragma("cipher='chacha20'");
      reader.pragma(`key="x'${key}'"`);
      reader.exec('BEGIN');
      expect(reader.prepare("SELECT value_json FROM settings WHERE key = 'snapshot'").get()).toEqual({ value_json: '1' });
      const bytes = readFileSync(file);
      const service = await DatabaseService.create({ dataDir: dir }, store, false);
      try {
        expect(service.protection.state).toBe('encrypted');
        expect(readFileSync(file)).toEqual(bytes);
        service.db.prepare("UPDATE settings SET value_json = '2' WHERE key = 'snapshot'").run();
        expect(reader.prepare("SELECT value_json FROM settings WHERE key = 'snapshot'").get()).toEqual({ value_json: '1' });
      } finally {
        service.onApplicationShutdown();
      }
    } finally {
      reader.close();
    }
    const reopened = await DatabaseService.create({ dataDir: dir }, store, false);
    try {
      expect(reopened.db.prepare("SELECT value_json FROM settings WHERE key = 'snapshot'").get()).toEqual({ value_json: '2' });
      expect(isPlainDatabase(file)).toBe(false);
    } finally {
      reopened.onApplicationShutdown();
    }
  });

  it.each(['denied', 'wrong', 'missing'] as const)('opt-out with a %s original key preserves the encrypted file unchanged', async (failure) => {
    plainFixture(dir);
    const store = new MemorySecretStore();
    (await DatabaseService.create({ dataDir: dir }, store)).onApplicationShutdown();
    const originalKey = store.get(DB_KEY_ACCOUNT) as string;
    const file = join(dir, DB_FILE);
    const bytes = readFileSync(file);
    const names = readdirSync(dir);
    if (failure === 'denied') vi.spyOn(store, 'get').mockImplementation(() => { throw new Error('denied'); });
    else if (failure === 'wrong') store.set(DB_KEY_ACCOUNT, newDatabaseKey());
    else store.delete(DB_KEY_ACCOUNT);
    await expect(DatabaseService.create({ dataDir: dir }, store, false)).rejects.toThrow();
    expect(readFileSync(file)).toEqual(bytes);
    expect(readdirSync(dir)).toEqual(names);
    vi.restoreAllMocks();
    store.set(DB_KEY_ACCOUNT, originalKey);
    const recovered = await DatabaseService.create({ dataDir: dir }, store);
    expect(recovered.db.prepare('SELECT count(*) AS n FROM threads').get()).toEqual({ n: 1 });
    recovered.onApplicationShutdown();
  });

  it('reuses a background-only encrypted database key to encrypt the main database despite opt-out', async () => {
    const file = join(dir, BG_DB_FILE);
    const key = newDatabaseKey();
    const background = new Database(file);
    try {
      background.pragma("cipher='chacha20'");
      background.pragma(`key="x'${key}'"`);
      background.exec("CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('background content')");
    } finally {
      background.close();
    }
    const bytes = readFileSync(file);
    const store = new MemorySecretStore();
    store.set(DB_KEY_ACCOUNT, key);
    const set = vi.spyOn(store, 'set');
    const remove = vi.spyOn(store, 'delete');
    const service = await DatabaseService.create({ dataDir: dir }, store, false);
    expect(service.protection.state).toBe('encrypted');
    expect(service.recoveryKey()).toBe(key);
    service.onApplicationShutdown();
    expect(keyOpens(join(dir, DB_FILE), key)).toBe(true);
    expect(readFileSync(file)).toEqual(bytes);
    expect(keyOpens(file, key)).toBe(true);
    expect(store.get(DB_KEY_ACCOUNT)).toBe(key);
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(['wrong', 'missing'] as const)('preserves a background-only encrypted file with a %s original key', async (failure) => {
    const file = join(dir, BG_DB_FILE);
    const background = new Database(file);
    try {
      background.pragma("cipher='chacha20'");
      background.pragma(`key="x'${newDatabaseKey()}'"`);
      background.exec('CREATE TABLE retained (value TEXT)');
    } finally {
      background.close();
    }
    const bytes = readFileSync(file);
    const store = new MemorySecretStore();
    if (failure === 'wrong') store.set(DB_KEY_ACCOUNT, newDatabaseKey());
    const set = vi.spyOn(store, 'set');
    await expect(DatabaseService.create({ dataDir: dir }, store, false)).rejects.toThrow();
    expect(readFileSync(file)).toEqual(bytes);
    expect(readdirSync(dir)).toEqual([BG_DB_FILE]);
    expect(set).not.toHaveBeenCalled();
  });

  it('PI_KIT_DB_KEY opens an encrypted file whose entry was lost, and writes the key back into the store', async () => {
    const store = new MemorySecretStore();
    const service = await DatabaseService.create({ dataDir: dir }, store);
    service.db.prepare("INSERT INTO settings (key, value_json) VALUES ('keep', '1')").run();
    const key = service.recoveryKey() as string;
    service.onApplicationShutdown();

    const empty = new MemorySecretStore();
    process.env['PI_KIT_DB_KEY'] = key;
    const reopened = await DatabaseService.create({ dataDir: dir }, empty);
    expect(reopened.db.prepare("SELECT count(*) AS n FROM settings WHERE key = 'keep'").get()).toEqual({ n: 1 });
    expect(empty.get(DB_KEY_ACCOUNT)).toBe(key);
    reopened.onApplicationShutdown();
  });

  it('an encrypted file with no key at all is a clear error, not an empty database', async () => {
    const store = new MemorySecretStore();
    (await DatabaseService.create({ dataDir: dir }, store)).onApplicationShutdown();
    expect(() => new DatabaseService({ dataDir: dir })).toThrow(/encrypted and there is no key/);
  });
});

describe('the migration keeps the old file until the new one is verified', () => {
  it('leaves the plaintext original beside the new file until discarded, and can put it back', async () => {
    const dir = scratch();
    const file = plainFixture(dir);
    const key = newDatabaseKey();
    const result = encryptDatabaseFile(file, key);
    expect(isPlainDatabase(file)).toBe(false);
    expect(existsSync(`${file}.plaintext`)).toBe(true);
    expect(result.tables['threads']).toBe(1);
    result.restoreOriginal();
    expect(isPlainDatabase(file)).toBe(true);
    expect(existsSync(`${file}.plaintext`)).toBe(false);
    const again = encryptDatabaseFile(file, key);
    again.discardOriginal();
    expect(readdirSync(dir).filter((n) => n.includes('plaintext'))).toEqual([]);
    expect(keyOpens(file, key)).toBe(true);
  });

  it('leaves the original untouched and no copy behind when the original cannot be copied', async () => {
    const dir = scratch();
    const file = join(dir, DB_FILE);
    writeFileSync(file, 'this is not a database');
    expect(() => encryptDatabaseFile(file, newDatabaseKey())).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('this is not a database');
    expect(readdirSync(dir)).toEqual([DB_FILE]);
  });

  it('refuses a key that is not 64 hexadecimal characters (it is spliced into a pragma)', async () => {
    const dir = scratch();
    const file = plainFixture(dir);
    expect(() => encryptDatabaseFile(file, "'; DROP TABLE threads; --")).toThrow(/64 hexadecimal/);
    expect(isPlainDatabase(file)).toBe(true);
  });
});


describe('interrupted database transitions fail closed at startup', () => {
  it.each([
    [DB_FILE, '.encrypted', false], [DB_FILE, '.plaintext', false],
    [DB_FILE, '.encrypted', true], [DB_FILE, '.plaintext', true],
    [BG_DB_FILE, '.encrypted', false], [BG_DB_FILE, '.plaintext', false],
    [BG_DB_FILE, '.encrypted', true], [BG_DB_FILE, '.plaintext', true],
  ] as const)('retains %s%s without creating a replacement (encryption enabled=%s)', async (name, suffix, enabled) => {
    const dir = scratch();
    const file = plainFixture(dir);
    const key = newDatabaseKey();
    if (suffix === '.encrypted') encryptDatabaseFile(file, key).discardOriginal();
    const retained = join(dir, `${name}${suffix}`);
    renameSync(file, retained);
    const bytes = readFileSync(retained);
    const names = readdirSync(dir);
    const store = new MemorySecretStore();
    const calls = ['available', 'get', 'set', 'delete'].map((method) => vi.spyOn(store, method as 'get'));
    await expect(DatabaseService.create({ dataDir: dir }, store, enabled)).rejects.toThrow(/interrupted database protection transition/);
    expect(existsSync(join(dir, DB_FILE))).toBe(false);
    expect(existsSync(join(dir, BG_DB_FILE))).toBe(false);
    expect(readFileSync(retained)).toEqual(bytes);
    expect(readdirSync(dir)).toEqual(names);
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it.each(['.encrypting', '.decrypting'] as const)('also preserves incomplete %s copies before creating a new database', async (suffix) => {
    const dir = scratch();
    const retained = join(dir, `${DB_FILE}${suffix}`);
    writeFileSync(retained, 'incomplete transition data');
    await expect(DatabaseService.create({ dataDir: dir }, new MemorySecretStore(), false)).rejects.toThrow(/interrupted database protection transition/);
    expect(readdirSync(dir)).toEqual([`${DB_FILE}${suffix}`]);
    expect(readFileSync(retained, 'utf8')).toBe('incomplete transition data');
  });
});

describe('existing database file permissions', () => {
  it('closes its opened connection when post-open initialization fails', () => {
    const dir = scratch();
    const close = vi.spyOn(Database.prototype, 'close');
    const pragma = vi.spyOn(Database.prototype, 'pragma').mockImplementationOnce(() => { throw new Error('post-open failure'); });
    try {
      expect(() => new DatabaseService({ dataDir: dir })).toThrow('post-open failure');
      expect(close).toHaveBeenCalledTimes(1);
      expect((close.mock.contexts[0] as Database.Database).open).toBe(false);
    } finally {
      pragma.mockRestore();
      close.mockRestore();
    }
  });

  it('the constructor restricts an existing plaintext database and its new sidecars to 0600', () => {
    if (process.platform === 'win32') return;
    const dir = scratch();
    const file = plainFixture(dir);
    chmodSync(file, 0o644);
    const service = new DatabaseService({ dataDir: dir });
    try {
      for (const suffix of ['', '-wal', '-shm']) expect(statSync(`${file}${suffix}`).mode & 0o777).toBe(0o600);
      expect(service.db.prepare('SELECT count(*) AS n FROM threads').get()).toEqual({ n: 1 });
    } finally {
      service.onApplicationShutdown();
    }
  });

});
