import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DATABASE_RESET_PENDING_FILE } from '@pi-kit/protocol';
import { DatabaseReset } from '@pi-kit/service-host';
import {
  BG_DB_FILE,
  DB_FILE,
  DatabaseService,
  DatabaseEncryptionMigrationError,
  DatabaseResetIncompleteError,
} from './database.service';
import { isPlainDatabase } from './database-file-guards';

it('creates a private plaintext database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-async-plain-'));
  try {
    const db = await DatabaseService.create({ dataDir: dir });
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
      await expect(DatabaseService.create({ dataDir: dir })).rejects.toThrow(DatabaseEncryptionMigrationError);
      expect(readFileSync(path)).toEqual(bytes);
      expect(readdirSync(dir)).toEqual([name]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

it('starts a fresh database only after all incompatible originals have been safely archived', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-confirmed-fresh-start-'));
  let fresh: DatabaseService | undefined;
  try {
    mkdirSync(join(dir, 'instance-keys'));
    const originalNames = [
      DB_FILE,
      `${DB_FILE}-wal`,
      BG_DB_FILE,
      `${BG_DB_FILE}.encrypted`,
      'instance-keys/identity.v1.enc',
    ];
    for (const name of originalNames) writeFileSync(join(dir, name), `retained original ${name}`);
    writeFileSync(join(dir, 'ui-storage.json'), 'keep settings');
    await expect(DatabaseService.create({ dataDir: dir })).rejects.toThrow(DatabaseEncryptionMigrationError);
    const backup = DatabaseReset.backup(dir);
    expect(backup.files.sort()).toEqual(originalNames.sort());
    expect(existsSync(join(dir, DATABASE_RESET_PENDING_FILE))).toBe(false);
    fresh = await DatabaseService.create({ dataDir: dir });
    expect(isPlainDatabase(fresh.path)).toBe(true);
    expect(readFileSync(join(dir, 'ui-storage.json'), 'utf8')).toBe('keep settings');
    for (const name of originalNames)
      expect(readFileSync(join(backup.directory, name), 'utf8')).toBe(`retained original ${name}`);
  } finally {
    await fresh?.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses an interrupted backup/reset before creating or opening either database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-reset-interrupted-'));
  try {
    writeFileSync(join(dir, DATABASE_RESET_PENDING_FILE), '{"backup":"retained-originals"}');
    writeFileSync(join(dir, BG_DB_FILE), 'retained-original');
    await expect(DatabaseService.create({ dataDir: dir })).rejects.toThrow(DatabaseResetIncompleteError);
    expect(readFileSync(join(dir, BG_DB_FILE), 'utf8')).toBe('retained-original');
    expect(readdirSync(dir).sort()).toEqual([BG_DB_FILE, DATABASE_RESET_PENDING_FILE].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(
  [DB_FILE, BG_DB_FILE].flatMap((name) =>
    ['.plaintext', '.encrypted', '.encrypting', '.decrypting'].map((suffix) => `${name}${suffix}`),
  ),
)('retains pending-transition original %s before opening either database', async (name) => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-async-transition-'));
  try {
    const path = join(dir, name);
    writeFileSync(path, 'retained-original');
    await expect(DatabaseService.create({ dataDir: dir })).rejects.toThrow(/interrupted.*retained/);
    expect(readFileSync(path, 'utf8')).toBe('retained-original');
    expect(readdirSync(dir)).toEqual([name]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
