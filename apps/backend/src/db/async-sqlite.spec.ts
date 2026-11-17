import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AsyncSqlite } from './async-sqlite';
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

it('fences unrelated operations out of an awaited transaction and rolls back only its writes', async () => {
  const db = await AsyncSqlite.open(':memory:');
  await db.exec('CREATE TABLE t(value TEXT)');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tx = db
    .transaction(async () => {
      await db.prepare('INSERT INTO t VALUES (?)').run('transaction');
      entered();
      await gate;
      throw new Error('rollback');
    })
    .immediate();
  const rejection = expect(tx).rejects.toThrow('rollback');
  await started;
  let outsideFinished = false;
  const external = db
    .prepare('INSERT INTO t VALUES (?)')
    .run('outside')
    .then(() => {
      outsideFinished = true;
    });
  await delay(20);
  expect(outsideFinished).toBe(false);
  release();
  await rejection;
  await external;
  expect(await db.prepare('SELECT * FROM t').all()).toEqual([{ value: 'outside' }]);
  await db.close();
});

it('waits for genuine file lock contention without blocking timers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-async-lock-'));
  const a = await AsyncSqlite.open(join(dir, 'lock.sqlite'));
  const b = await AsyncSqlite.open(join(dir, 'lock.sqlite'));
  try {
    await a.exec('CREATE TABLE t(value TEXT)');
    await b.pragma('busy_timeout = 2000');
    await a.exec('BEGIN IMMEDIATE');
    await a.prepare('INSERT INTO t VALUES (?)').run('a');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const waiting = b.prepare('INSERT INTO t VALUES (?)').run('b');
    await delay(80);
    await a.exec('COMMIT');
    await waiting;
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(3);
    expect(await b.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 2 });
  } finally {
    await a.close();
    await b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('supports nested rollback/savepoints, bindings, and queue recovery after errors', async () => {
  const db = await AsyncSqlite.open(':memory:');
  try {
    await db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, value BLOB)');
    const insert = db.prepare('INSERT INTO t(value) VALUES (:value)').bind({ value: Buffer.from('one'), ignored: 1 });
    await db
      .transaction(async () => {
        expect((await insert.run()).lastInsertRowid).toBe(1);
        await expect(
          db.transaction(async () => {
            await db.prepare('INSERT INTO t(value) VALUES (?)').run('nested');
            throw new Error('nested');
          })(),
        ).rejects.toThrow('nested');
        await db.prepare('INSERT INTO t(value) VALUES (?)').run(['two']);
      })
      .exclusive();
    await expect(db.exec('nonsense')).rejects.toThrow();
    expect(await db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 2 });
    expect(await db.prepare('SELECT :x AS x, @y AS y, $z AS z').get({ x: 1, y: 2, z: 3, unused: 4 })).toEqual({
      x: 1,
      y: 2,
      z: 3,
    });
  } finally {
    await db.close();
  }
});

it('drains accepted operations on close and rejects new work', async () => {
  const db = await AsyncSqlite.open(':memory:');
  await db.exec('CREATE TABLE t(value TEXT)');
  const writes = Array.from({ length: 20 }, (_, i) => db.prepare('INSERT INTO t VALUES (?)').run(String(i)));
  const closing = db.close();
  await expect(db.prepare('SELECT * FROM t').all()).rejects.toThrow(/closed/);
  await Promise.all(writes);
  await closing;
  expect(db.open).toBe(false);
  await db.close();
});

it('rejects escaped callback work instead of silently committing it outside the transaction', async () => {
  const db = await AsyncSqlite.open(':memory:');
  await db.exec('CREATE TABLE t(value TEXT)');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let escaped!: Promise<unknown>;
  await db.transaction(async () => {
    await db.prepare('INSERT INTO t VALUES (?)').run('awaited');
    escaped = (async () => {
      await gate;
      return db.prepare('INSERT INTO t VALUES (?)').run('escaped');
    })();
  })();
  const rejection = expect(escaped).rejects.toThrow(/escaped.*completed/);
  release();
  await rejection;
  expect(await db.prepare('SELECT * FROM t').all()).toEqual([{ value: 'awaited' }]);
  await db.close();
});

it('closing outside an accepted transaction drains the whole awaited callback before closing', async () => {
  const db = await AsyncSqlite.open(':memory:');
  await db.exec('CREATE TABLE t(value TEXT)');
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = db.transaction(async () => {
    entered();
    await gate;
    await db.prepare('INSERT INTO t VALUES (?)').run('accepted');
    return (await db.prepare('SELECT count(*) AS n FROM t').get())!.n;
  })();
  await started;
  const closing = db.close();
  await expect(db.exec('SELECT 1')).rejects.toThrow(/closed/);
  release();
  expect(await transaction).toBe(1);
  await closing;
  expect(db.open).toBe(false);
});

it('drains get RETURNING statements before committing', async () => {
  const db = await AsyncSqlite.open(':memory:');
  try {
    await db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)');
    await db
      .transaction(async () => {
        expect(await db.prepare('INSERT INTO t(value) VALUES (?) RETURNING id').get('one')).toEqual({ id: 1 });
        expect(await db.prepare('UPDATE t SET value=? WHERE id=? RETURNING id').get('two', 1)).toEqual({ id: 1 });
      })
      .immediate();
    expect(await db.prepare('SELECT value FROM t').get()).toEqual({ value: 'two' });
  } finally {
    await db.close();
  }
});

it('releases read and returning cursors before checkpoint, schema changes and close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-async-vm-'));
  const db = await AsyncSqlite.open(join(dir, 'cursor.sqlite'));
  try {
    await db.pragma('journal_mode = WAL');
    await db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)');
    for (let i = 0; i < 8; i++) await db.prepare('INSERT INTO t(value) VALUES (?) RETURNING id').get(String(i));
    expect(await db.prepare('SELECT * FROM t').get()).toEqual({ id: 1, value: '0' });
    await db
      .transaction(async () => {
        expect(await db.prepare('UPDATE t SET value=? RETURNING id').get('updated')).toEqual({ id: 1 });
      })
      .immediate();
    const result = await db.pragma('wal_checkpoint(TRUNCATE)');
    expect(result[0].busy).toBe(0);
    await db.exec('DROP TABLE t');
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
