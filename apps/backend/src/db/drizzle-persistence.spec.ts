import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DatabaseService } from './database.service';

it('uses the promise-only connection for reads, writes, rollback and reopening (no synchronous ORM)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-async-compat-'));
  let database = await DatabaseService.create({ dataDir: dir });
  try {
    await database.db.exec('CREATE TABLE compatibility(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const result = await database.db
      .prepare('INSERT INTO compatibility(value) VALUES (@value)')
      .run({ value: 'existing', ignored: true });
    expect(result).toEqual({ changes: 1, lastInsertRowid: 1 });
    await expect(
      database.db.transaction(async () => {
        await database.db.prepare('INSERT INTO compatibility(value) VALUES (?)').run('rolled back');
        throw new Error('rollback marker');
      })(),
    ).rejects.toThrow('rollback marker');
    expect(await database.db.prepare('SELECT * FROM compatibility').all()).toEqual([{ id: 1, value: 'existing' }]);
    await database.onApplicationShutdown();
    database = await DatabaseService.create({ dataDir: dir });
    expect(await database.db.prepare('SELECT * FROM compatibility').all()).toEqual([{ id: 1, value: 'existing' }]);
  } finally {
    await database.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
