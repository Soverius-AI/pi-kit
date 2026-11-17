import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import { AsyncSqlite } from '../db/async-sqlite';
import { assertNoPendingDatabaseTransition, isPlainDatabase } from '../db/database-file-guards';

/** The durable store of the background agents and the owner's note next to it, both in `PI_KIT_DATA_DIR`. */
export const STORE_FILE = 'bg-agents.sqlite';
export const LOCK_FILE = 'bg-agents.lock';
/** The committed ownership epoch; a separate SQLite writer transaction holds the OS lock across its commit. */
const OWNER_FILE = 'bg-agents-owner.sqlite';
const OWNER_MUTEX = 'bg-agents-owner-lock.sqlite';

/**
 * Open pi-durable through the asynchronous SQLite driver.
 * The caller must hold the owner lock before opening/migrating. No credential store is queried here.
 */
export async function openDurableStore(path: string): Promise<SqliteDatabase> {
  assertNoPendingDatabaseTransition(path);
  if (existsSync(path) && statSync(path).size > 0 && !isPlainDatabase(path)) {
    throw new Error(
      'Encrypted background agents store retained unchanged. Use the previous encrypted release and original key to export/recover it before opening with the async SQLite driver.',
    );
  }
  const connection = await AsyncSqlite.open(path);
  try {
    await connection.pragma('busy_timeout = 5000');
    chmodSync(path, 0o600);
    await connection.pragma('journal_mode = WAL');
    await connection.pragma('synchronous = NORMAL');
  } catch (error) {
    await connection.close();
    throw error;
  }
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const executor = (active: () => boolean): SqliteExecutor => {
    const run = <T>(operation: () => Promise<T>): Promise<T> => {
      if (!active()) return Promise.reject(new Error('The transaction has ended.'));
      try {
        return operation();
      } catch (error) {
        return Promise.reject(error);
      }
    };
    return {
      exec: (sql) =>
        run(async () => {
          await connection.exec(sql);
        }),
      run: (sql, ...params: SqliteValue[]) =>
        run(async () => {
          await connection.prepare(sql).run(...params);
        }),
      runCounted: (sql, ...params: SqliteValue[]) =>
        run(async () => (await connection.prepare(sql).run(...params)).changes),
      get: <T extends object>(sql: string, ...params: SqliteValue[]) =>
        run(async () => (await connection.prepare(sql).get(...params)) as T | undefined),
      all: <T extends object>(sql: string, ...params: SqliteValue[]) =>
        run(async () => (await connection.prepare(sql).all(...params)) as T[]),
    };
  };
  const direct = executor(() => true);
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error('The agents store is closing.'));
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    exec: (sql) => enqueue(() => direct.exec(sql)),
    run: (sql, ...params) => enqueue(() => direct.run(sql, ...params)),
    runCounted: (sql, ...params) => enqueue(() => direct.runCounted(sql, ...params)),
    get: (sql, ...params) => enqueue(() => direct.get(sql, ...params)),
    all: (sql, ...params) => enqueue(() => direct.all(sql, ...params)),
    transaction: (callback) =>
      enqueue(async () => {
        await connection.exec('BEGIN IMMEDIATE');
        let active = true;
        try {
          const value = await callback(executor(() => active));
          active = false;
          await connection.exec('COMMIT');
          return value;
        } catch (error) {
          active = false;
          try {
            await connection.exec('ROLLBACK');
          } catch (rollback) {
            throw new AggregateError([error, rollback], 'The transaction failed and could not be rolled back.', {
              cause: rollback,
            });
          }
          throw error;
        }
      }),
    close: () => {
      closing ??= tail.then(async () => {
        try {
          await connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } finally {
          await connection.close();
        }
      });
      return closing;
    },
  };
}

export interface OwnerLock {
  /** Grows with every owner of the store; rows this backend writes to `bg_agents` carry it. */
  epoch: number;
  release(): Promise<void>;
}

/** Thrown by `takeOwnerLock` while another live process owns the store. */
export class StoreOwnedError extends Error {
  constructor(readonly pid?: number) {
    super(`Another backend${pid === undefined ? '' : ` (pid ${pid})`} owns the background agents store.`);
  }
}

/**
 * The owner's note (`LOCK_FILE`), written after the lock is held: it names the holder for the refusal message, because
 * the refusal path need not open either SQLite database. It decides nothing: neither admission nor the epoch.
 */
interface OwnerNote {
  pid: number;
  epoch: number;
  takenAt: number;
}

const notedPid = (path: string): number | undefined => {
  try {
    const { pid } = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerNote>;
    return typeof pid === 'number' ? pid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A held SQLite write transaction is the ownership authority until close or process death. Its database is never written
 * while held, so contenders can read its schema without preventing acquisition. A separate database commits the fencing
 * epoch under that lock; the diagnostic note has no admission or epoch authority.
 */
export async function takeOwnerLock(dir: string): Promise<OwnerLock> {
  mkdirSync(dir, { recursive: true });
  const note = join(dir, LOCK_FILE);
  let connection: AsyncSqlite | undefined;
  let epoch: number;
  try {
    const mutex = join(dir, OWNER_MUTEX);
    // Publish a complete, immutable lock database once. Opening the same empty SQLite file concurrently can refuse both contenders.
    if (!existsSync(mutex)) {
      const seedPath = `${mutex}.${randomUUID()}`;
      try {
        const seed = await AsyncSqlite.open(seedPath);
        try {
          await seed.pragma('user_version = 1');
        } finally {
          await seed.close();
        }
        try {
          linkSync(seedPath, mutex);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      } finally {
        rmSync(seedPath, { force: true });
      }
    }
    connection = await AsyncSqlite.open(mutex);
    // A reserved writer lock excludes other owners while allowing their schema reads. Keep this transaction open until release.
    await connection.pragma('busy_timeout = 0');
    await connection.exec('BEGIN IMMEDIATE');
    const counter = await AsyncSqlite.open(join(dir, OWNER_FILE));
    try {
      // Only the mutex holder opens the counter, so its committed epoch cannot contend with another contender's schema reads.
      epoch = await counter
        .transaction(async () => {
          await counter.exec(
            'CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL)',
          );
          const previous = (await counter.prepare('SELECT epoch FROM owner WHERE id = 1').get()) as
            { epoch: number } | undefined;
          const next = (previous?.epoch ?? 0) + 1;
          await counter.prepare('INSERT OR REPLACE INTO owner (id, epoch) VALUES (1, ?)').run(next);
          return next;
        })
        .immediate();
    } finally {
      await counter.close();
    }
  } catch (error) {
    await connection?.close();
    if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string }).code ?? ''))
      throw new StoreOwnedError(notedPid(note));
    throw error;
  }
  // Diagnostics are best effort: their failure must not undo a valid SQLite acquisition.
  const record: OwnerNote = { pid: process.pid, epoch, takenAt: Date.now() };
  const staging = `${note}.${process.pid}`;
  try {
    writeFileSync(staging, JSON.stringify(record));
    renameSync(staging, note);
  } catch {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* An unavailable diagnostic path has no ownership authority. */
    }
  }
  let released = false;
  return {
    epoch,
    release: async () => {
      if (released) return;
      released = true;
      try {
        rmSync(note, { force: true }); // ours: a note is only ever written behind the lock this handle still holds
      } catch {
        /* A diagnostic failure must not prevent release. */
      } finally {
        await connection.close();
      }
    },
  };
}

/** Whether a store exists in the folder (for a backend that could not open it: nothing was created). */
export const storeExists = (dir: string): boolean => existsSync(join(dir, STORE_FILE));
