import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore } from '@pi-kit/secret-store';
import { expect, it } from 'vitest';
import { BG_DB_FILE, DB_FILE, DatabaseService, DatabaseEncryptionMigrationError } from './database.service';
import { encryptDatabaseFile, isPlainDatabase, keyOpens, newDatabaseKey } from './encryption';

it('creates private plaintext without accessing credentials even when old encryption preference is enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-async-plain-'));
  const store = new MemorySecretStore();
  store.get = () => {
    throw new Error('must not access secrets');
  };
  store.set = () => {
    throw new Error('must not access secrets');
  };
  try {
    const db = await DatabaseService.create({ dataDir: dir }, store, true);
    expect(db.protection.state).toBe('plain');
    expect(db.recoveryKey()).toBeUndefined();
    await db.onApplicationShutdown();
    expect(isPlainDatabase(join(dir, DB_FILE))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('fails closed for unknown/encrypted headers in either database without touching original bytes or creating another DB', async () => {
  for (const name of [DB_FILE, BG_DB_FILE]) {
    const dir = mkdtempSync(join(tmpdir(), 'pk-async-retain-'));
    try {
      const bytes = Buffer.from('encrypted-original-never-open-or-replace');
      const path = join(dir, name);
      writeFileSync(path, bytes);
      await expect(DatabaseService.create({ dataDir: dir }, new MemorySecretStore(), false)).rejects.toThrow(
        DatabaseEncryptionMigrationError,
      );
      expect(readFileSync(path)).toEqual(bytes);
      expect(readdirSync(dir)).toEqual([name]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

it('retains pending-transition originals before opening a database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-async-transition-'));
  try {
    const path = join(dir, `${BG_DB_FILE}.plaintext`);
    writeFileSync(path, 'retained-original');
    await expect(DatabaseService.create({ dataDir: dir })).rejects.toThrow(/interrupted.*retained/);
    expect(readFileSync(path, 'utf8')).toBe('retained-original');
    expect(readdirSync(dir)).toEqual([`${BG_DB_FILE}.plaintext`]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps legacy encryption helpers available only for explicit offline recovery tooling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-legacy-recovery-'));
  try {
    const db = await DatabaseService.create({ dataDir: dir });
    await db.db.prepare("INSERT INTO settings(key,value_json) VALUES('retain','history')").run();
    await db.onApplicationShutdown();
    const path = join(dir, DB_FILE);
    const key = newDatabaseKey();
    const result = encryptDatabaseFile(path, key);
    expect(keyOpens(path, key)).toBe(true);
    expect(isPlainDatabase(path)).toBe(false);
    const before = readFileSync(path);
    await expect(DatabaseService.create({ dataDir: dir }, new MemorySecretStore())).rejects.toThrow(/retained/);
    expect(readFileSync(path)).toEqual(before);
    result.restoreOriginal();
    expect(isPlainDatabase(path)).toBe(true);
    const restored = await DatabaseService.create({ dataDir: dir });
    expect(await restored.db.prepare("SELECT value_json FROM settings WHERE key='retain'").get()).toEqual({
      value_json: 'history',
    });
    await restored.onApplicationShutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
