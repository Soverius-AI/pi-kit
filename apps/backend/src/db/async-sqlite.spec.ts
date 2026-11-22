import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('read connections', () => {
  const slowRead =
    'SELECT count(*) AS n FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3000000) SELECT x FROM c)';
  const opened: { db: AsyncSqlite; dir: string }[] = [];
  afterEach(async () => {
    for (const { db, dir } of opened.splice(0)) {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  async function pooled(readers = 2) {
    const dir = mkdtempSync(join(tmpdir(), 'pk-async-readers-'));
    const db = await AsyncSqlite.open(join(dir, 'pool.sqlite'));
    opened.push({ db, dir });
    await db.pragma('journal_mode = WAL');
    await db.exec('CREATE TABLE t(value TEXT)');
    await db.openReaders(readers);
    return db;
  }

  it('runs consecutive reads side by side', async () => {
    const stamped = `SELECT (julianday('now') - 2440587.5) * 86400000 AS started, (${slowRead}) AS n`;
    const overlap = async (readers: number) => {
      const db = await pooled(readers);
      let firstDone = 0;
      const [first, second] = (await Promise.all([
        db
          .prepare(stamped)
          .get()
          .then((row) => {
            firstDone = Date.now();
            return row;
          }),
        db.prepare(stamped).get(),
      ])) as { started: number }[];
      return (second.started - first.started) / (firstDone - first.started);
    };
    expect(await overlap(0)).toBeGreaterThan(0.9);
    expect(await overlap(2)).toBeLessThan(0.5);
  });

  it('settles reads and writes in the order they were issued, failures included', async () => {
    const db = await pooled();
    const order: string[] = [];
    const settled = (name: string) => () => order.push(name);
    await Promise.all([
      db.prepare(slowRead).get().then(settled('slow read')),
      db.prepare('SELECT * FROM missing').get().catch(settled('failed read')),
      db.prepare('SELECT 1 AS one').get().then(settled('quick read')),
      db.prepare('INSERT INTO t VALUES (?)').run('a').then(settled('write')),
      db.prepare('SELECT value FROM t').all().then(settled('read after write')),
    ]);
    expect(order).toEqual(['slow read', 'failed read', 'quick read', 'write', 'read after write']);
  });

  it('never lets a read see a write issued after it', async () => {
    const db = await pooled();
    const slow = db.prepare(slowRead).get();
    const before = db.prepare('SELECT count(*) AS n FROM t').get();
    const write = db.prepare('INSERT INTO t VALUES (?)').run('later');
    const after = db.prepare('SELECT count(*) AS n FROM t').get();
    expect(await before).toEqual({ n: 0 });
    expect(await after).toEqual({ n: 1 });
    await Promise.all([slow, write]);
  });

  it('lets a read see every write queued before it, awaited or not', async () => {
    const db = await pooled();
    const write = db.prepare('INSERT INTO t VALUES (?)').run('queued');
    expect(await db.prepare('SELECT value FROM t').all()).toEqual([{ value: 'queued' }]);
    await write;
  });

  it('keeps reads inside a transaction on the writer and holds outside reads until it commits', async () => {
    const db = await pooled();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transaction = db
      .transaction(async () => {
        await db.prepare('INSERT INTO t VALUES (?)').run('uncommitted');
        const inside = await db.prepare('SELECT value FROM t').all();
        entered();
        await gate;
        return inside;
      })
      .immediate();
    await started;
    const outside = db.prepare('SELECT value FROM t').all();
    release();
    expect(await transaction).toEqual([{ value: 'uncommitted' }]);
    expect(await outside).toEqual([{ value: 'uncommitted' }]);
  });

  it('drains routed reads on close and rejects new work', async () => {
    const db = await pooled();
    const read = db.prepare(slowRead).get();
    const closing = db.close();
    await expect(db.prepare('SELECT 1').get()).rejects.toThrow(/closed/);
    expect(await read).toEqual({ n: 3000000 });
    await closing;
    expect(db.open).toBe(false);
  });
});
