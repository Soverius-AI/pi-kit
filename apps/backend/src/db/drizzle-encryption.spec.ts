import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, it } from 'vitest';
import { MemorySecretStore } from '@pi-kit/secret-store';
import { DatabaseService } from './database.service';
import { isPlainDatabase, newDatabaseKey, useKey } from './encryption';

const rows = sqliteTable('drizzle_compatibility', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  value: text('value').notNull(),
});

it('uses the existing encrypted connection for typed reads, writes, rollback and reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-drizzle-encrypted-'));
  const database = await DatabaseService.create({ dataDir: dir }, new MemorySecretStore());
  const key = database.recoveryKey() as string;
  const marker = 'encrypted-drizzle-marker';
  try {
    database.db.exec('CREATE TABLE drizzle_compatibility (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)');
    database.db.prepare('INSERT INTO drizzle_compatibility (value) VALUES (?)').run('existing row');
    const db = drizzle(database.db);
    expect(db.$client).toBe(database.db);
    expect(db.select().from(rows).all()).toEqual([{ id: 1, value: 'existing row' }]);
    const inserted = db.transaction((tx) => tx.insert(rows).values({ value: marker }).returning().get());
    expect(inserted).toEqual({ id: 2, value: marker });
    expect(() => db.transaction((tx) => {
      tx.insert(rows).values({ value: 'rolled back' }).run();
      throw new Error('rollback marker');
    })).toThrow('rollback marker');
    expect(db.select().from(rows).all()).toHaveLength(2);
    database.onApplicationShutdown();
    expect(isPlainDatabase(database.path)).toBe(false);
    expect(readFileSync(database.path).includes(Buffer.from(marker))).toBe(false);
    for (const suppliedKey of [undefined, newDatabaseKey()]) {
      const unreadable = new Database(database.path, { readonly: true });
      try {
        if (suppliedKey) useKey(unreadable, suppliedKey);
        expect(() => unreadable.prepare('SELECT * FROM drizzle_compatibility').all()).toThrow();
      } finally { unreadable.close(); }
    }
    const reopened = new Database(database.path);
    try {
      useKey(reopened, key);
      expect(drizzle(reopened).select().from(rows).all()).toEqual([{ id: 1, value: 'existing row' }, inserted]);
    } finally { reopened.close(); }
  } finally {
    database.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
