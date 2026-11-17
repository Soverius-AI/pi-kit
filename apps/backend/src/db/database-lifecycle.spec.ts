import { mkdtempSync, openSync, closeSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { expect, it, vi } from 'vitest';
import { AsyncSqlite } from './async-sqlite';
import { DatabaseBrokenError, DatabaseVersionError, DatabaseService, DB_FILE, schemaHash } from './database.service';

const scratch = () => mkdtempSync(join(tmpdir(), 'pk-db-life-'));

it('keeps SQLite open until asynchronous module teardown finishes', async () => {
  const dir = scratch();
  const database = await DatabaseService.create({ dataDir: dir });
  let wrote = false;
  const app = await Test.createTestingModule({
    providers: [
      { provide: DatabaseService, useValue: database },
      {
        provide: 'producer',
        useValue: {
          async onModuleDestroy() {
            await new Promise<void>((resolve) => setImmediate(resolve));
            await database.db.prepare("INSERT INTO settings(key,value_json) VALUES('shutdown','true')").run();
            wrote = true;
          },
        },
      },
    ],
  }).compile();
  try {
    await app.close();
    expect(wrote).toBe(true);
    expect(database.db.open).toBe(false);
  } finally {
    await database.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses a pre-squash schema and preserves original rows', async () => {
  const dir = scratch();
  try {
    const old = await AsyncSqlite.open(join(dir, DB_FILE));
    await old.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)');
    await old.prepare('INSERT INTO schema_migrations VALUES(?,?)').run('0022_follow_up_prompts.sql', 0);
    await old.close();
    await expect(DatabaseService.create({ dataDir: dir })).rejects.toThrow(DatabaseVersionError);
    await expect(DatabaseService.create({ dataDir: dir })).rejects.toThrow(
      /different pi-kit version.*0022_follow_up_prompts.sql.*retained/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('distinguishes genuine page corruption from key and schema errors', async () => {
  const dir = scratch();
  try {
    await (await DatabaseService.create({ dataDir: dir })).onApplicationShutdown();
    const fd = openSync(join(dir, DB_FILE), 'r+');
    writeSync(fd, Buffer.alloc(3996, 0xff), 0, 3996, 100);
    closeSync(fd);
    await expect(DatabaseService.create({ dataDir: dir })).rejects.toThrow(DatabaseBrokenError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects changed or unknown migration hashes without destructive recreation', async () => {
  for (const changed of [true, false]) {
    const dir = scratch();
    try {
      const first = await DatabaseService.create({ dataDir: dir });
      await first.db.prepare("INSERT INTO settings(key,value_json) VALUES('keep-me','history')").run();
      if (changed)
        await first.db.prepare("UPDATE schema_migrations SET sha256='other' WHERE name='0001_init.sql'").run();
      else await first.db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run('9999_future.sql', 0, 'future');
      await first.onApplicationShutdown();
      await expect(DatabaseService.create({ dataDir: dir })).rejects.toThrow(DatabaseVersionError);
      const verify = await AsyncSqlite.open(join(dir, DB_FILE));
      expect(await verify.prepare("SELECT value_json FROM settings WHERE key='keep-me'").get()).toEqual({
        value_json: 'history',
      });
      await verify.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  expect(schemaHash('CREATE TABLE a ( x INTEGER ); -- note')).toBe(
    schemaHash('-- other\nCREATE TABLE a (\n x INTEGER\n);'),
  );
  expect(schemaHash('CREATE TABLE a (x INTEGER);')).not.toBe(schemaHash('CREATE TABLE a (x TEXT);'));
});

it('awaits readiness, hydrates a persistent identity, and reopens without replaying migrations', async () => {
  const dir = scratch();
  try {
    const first = new DatabaseService({ dataDir: dir });
    expect(() => first.instanceId).toThrow(/not ready/);
    await first.ready;
    const id = first.instanceId;
    await first.onApplicationShutdown();
    const again = await DatabaseService.create({ dataDir: dir });
    expect(again.instanceId).toBe(id);
    expect(await again.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({
      n: readdirSync(join(__dirname, 'migrations')).filter((f) => f.endsWith('.sql')).length,
    });
    await again.onApplicationShutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('fences FULL durability through async writes and restores NORMAL after failures', async () => {
  const dir = scratch();
  const db = await DatabaseService.create({ dataDir: dir });
  try {
    await expect(
      db.durable(async () => {
        expect(await db.db.pragma('synchronous', { simple: true })).toBe(2);
        await db.db
          .transaction(async () => {
            await db.db.prepare("INSERT INTO settings(key,value_json) VALUES('durable','true')").run();
          })
          .immediate();
        throw new Error('durable failure');
      }),
    ).rejects.toThrow('durable failure');
    expect(await db.db.pragma('synchronous', { simple: true })).toBe(1);
    expect(await db.db.prepare("SELECT value_json FROM settings WHERE key='durable'").get()).toEqual({
      value_json: 'true',
    });
  } finally {
    await db.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('commits owner identity at FULL before publishing it and restores NORMAL', async () => {
  const dir = scratch();
  const original = AsyncSqlite.prototype.exec;
  const identityCommitModes: unknown[] = [];
  const spy = vi.spyOn(AsyncSqlite.prototype, 'exec').mockImplementation(async function (
    this: AsyncSqlite,
    sql: string,
  ) {
    if (sql === 'COMMIT') {
      const row = await this.prepare('SELECT count(*) AS n FROM instance_identity').get();
      if (row!.n > 0) identityCommitModes.push(await this.pragma('synchronous', { simple: true }));
    }
    return original.call(this, sql);
  });
  let db: DatabaseService | undefined;
  try {
    db = await DatabaseService.create({ dataDir: dir });
    expect(identityCommitModes).toEqual([2]);
    expect(await db.db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    spy.mockRestore();
    await db?.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses an invalid stored owner identity without replacing it', async () => {
  const dir = scratch();
  try {
    const db = await DatabaseService.create({ dataDir: dir });
    await db.db.prepare("UPDATE instance_identity SET instance_id='invalid-identity' WHERE singleton=1").run();
    await db.onApplicationShutdown();
    await expect(DatabaseService.create({ dataDir: dir })).rejects.toThrow();
    const raw = await AsyncSqlite.open(join(dir, DB_FILE));
    expect(await raw.prepare('SELECT instance_id FROM instance_identity WHERE singleton=1').get()).toEqual({
      instance_id: 'invalid-identity',
    });
    await raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
