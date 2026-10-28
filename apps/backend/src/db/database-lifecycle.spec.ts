import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import Database from 'better-sqlite3-multiple-ciphers';
import { expect, it } from 'vitest';
import { DatabaseService, DB_FILE, schemaHash } from './database.service';

it('keeps SQLite open until asynchronous module teardown finishes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-db-lifecycle-'));
  const database = new DatabaseService({ dataDir: dir });
  let wroteDuringTeardown = false;
  const app = await Test.createTestingModule({
    providers: [
      { provide: DatabaseService, useValue: database },
      {
        provide: 'event-producer',
        useValue: {
          async onModuleDestroy() {
            await new Promise<void>((resolve) => setImmediate(resolve));
            database.db.prepare("INSERT INTO settings (key, value_json) VALUES ('shutdown', 'true')").run();
            wroteDuringTeardown = true;
          },
        },
      },
    ],
  }).compile();
  try {
    await app.close();
    expect(wroteDuringTeardown).toBe(true);
    expect(database.db.open).toBe(false);
  } finally {
    database.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses a database made by a build from before the migrations were squashed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-db-legacy-'));
  try {
    const legacy = new Database(join(dir, DB_FILE));
    legacy.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('0022_follow_up_prompts.sql', 0);
    legacy.close();
    expect(() => new DatabaseService({ dataDir: dir })).toThrow(
      /different pi-kit version .*0022_follow_up_prompts\.sql.*Delete it/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses a database made from a different text of a migration, but not for a changed comment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-db-changed-'));
  try {
    new DatabaseService({ dataDir: dir }).onApplicationShutdown();
    const raw = new Database(join(dir, DB_FILE));
    raw.prepare("UPDATE schema_migrations SET sha256 = 'other' WHERE name = '0001_init.sql'").run();
    raw.close();
    expect(() => new DatabaseService({ dataDir: dir })).toThrow(/different pi-kit version .*0001_init\.sql/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect(schemaHash('CREATE TABLE a ( x INTEGER ); -- a note')).toBe(
    schemaHash('-- another note\nCREATE TABLE a (\n  x INTEGER\n);'),
  );
  expect(schemaHash('CREATE TABLE a (x INTEGER);')).not.toBe(schemaHash('CREATE TABLE a (x TEXT);'));
});

it('opens a database it made before without applying anything again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-db-reopen-'));
  try {
    new DatabaseService({ dataDir: dir }).onApplicationShutdown();
    const again = new DatabaseService({ dataDir: dir });
    expect(again.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({
      n: readdirSync(join(__dirname, 'migrations')).filter((f) => f.endsWith('.sql')).length,
    });
    again.onApplicationShutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
