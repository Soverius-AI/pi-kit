import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import Database from 'better-sqlite3-multiple-ciphers';
import { assertNoPendingDatabaseTransition, encryptDatabaseFile, isPlainDatabase, useKey, type EncryptResult } from '../db/encryption';

/** The durable store of the background agents and the owner's note next to it, both in `PI_KIT_DATA_DIR`. */
export const STORE_FILE = 'bg-agents.sqlite';
export const LOCK_FILE = 'bg-agents.lock';
/** The committed ownership epoch; a separate SQLite writer transaction holds the OS lock across its commit. */
const OWNER_FILE = 'bg-agents-owner.sqlite';
const OWNER_MUTEX = 'bg-agents-owner-lock.sqlite';

/**
 * Open pi-durable with the app database's protection, including explicit startup transitions.
 * The caller must hold the owner lock before opening/migrating. No credential store is queried here.
 */
export function openDurableStore(path: string, key?: string): SqliteDatabase {
  assertNoPendingDatabaseTransition(path);
  let transition: EncryptResult | undefined;
  if (existsSync(path) && statSync(path).size > 0) {
    const plain = isPlainDatabase(path);
    if (plain && key) transition = encryptDatabaseFile(path, key);
    else if (!plain && !key) {
      throw new Error('The original key is required to open the encrypted background agents store. Original data was retained.');
    }
  }
  let opening: Database.Database | undefined;
  try {
    opening = new Database(path, { timeout: 5000 });
    const connection = opening;
    chmodSync(path, 0o600); // WAL/SHM inherit the private database mode.
    if (key) useKey(connection, key);
    connection.prepare('SELECT count(*) FROM sqlite_master').get();
    if (connection.pragma('journal_mode = WAL', { simple: true }) !== 'wal') throw new Error('WAL journaling is unavailable for the agents store.');
    connection.pragma('synchronous = NORMAL');
  } catch (error) {
    opening?.close();
    transition?.restoreOriginal();
    throw error;
  }
  // Only discard after the replacement has opened and its runtime pragmas succeeded.
  try { transition?.discardOriginal(); } catch (error) {
    opening.close();
    throw error; // Keep any recovery original; never hide cleanup failure.
  }
  const connection = opening;
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  const executor = (active: () => boolean): SqliteExecutor => {
    const run = <T>(operation: () => T): Promise<T> => {
      if (!active()) return Promise.reject(new Error('The transaction has ended.'));
      try {
        return Promise.resolve(operation());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    return {
      exec: (sql) => run(() => void connection.exec(sql)),
      run: (sql, ...params: SqliteValue[]) => run(() => void connection.prepare(sql).run(...params)),
      get: <T extends object>(sql: string, ...params: SqliteValue[]) => run(() => connection.prepare(sql).get(...params) as T | undefined),
      all: <T extends object>(sql: string, ...params: SqliteValue[]) => run(() => connection.prepare(sql).all(...params) as T[]),
    };
  };
  const direct = executor(() => true);
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error('The agents store is closing.'));
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    exec: (sql) => enqueue(() => direct.exec(sql)),
    run: (sql, ...params) => enqueue(() => direct.run(sql, ...params)),
    get: (sql, ...params) => enqueue(() => direct.get(sql, ...params)),
    all: (sql, ...params) => enqueue(() => direct.all(sql, ...params)),
    transaction: (callback) =>
      enqueue(async () => {
        connection.exec('BEGIN IMMEDIATE');
        let active = true;
        try {
          const value = await callback(executor(() => active));
          active = false;
          connection.exec('COMMIT');
          return value;
        } catch (error) {
          active = false;
          try {
            connection.exec('ROLLBACK');
          } catch (rollback) {
            throw new AggregateError([error, rollback], 'The transaction failed and could not be rolled back.', { cause: rollback });
          }
          throw error;
        }
      }),
    close: () => {
      closing ??= tail.then(() => {
        try {
          connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } finally {
          connection.close();
        }
      });
      return closing;
    },
  };
}

export interface OwnerLock {
  /** Grows with every owner of the store; rows this backend writes to `bg_agents` carry it. */
  epoch: number;
  release(): void;
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
export function takeOwnerLock(dir: string): OwnerLock {
  mkdirSync(dir, { recursive: true });
  const note = join(dir, LOCK_FILE);
  let connection: Database.Database | undefined;
  let epoch: number;
  try {
    const mutex = join(dir, OWNER_MUTEX);
    // Publish a complete, immutable lock database once. Opening the same empty SQLite file concurrently can refuse both contenders.
    if (!existsSync(mutex)) {
      const seedPath = `${mutex}.${randomUUID()}`;
      try {
        const seed = new Database(seedPath, { timeout: 0 });
        try { seed.pragma('user_version = 1'); } finally { seed.close(); }
        try { linkSync(seedPath, mutex); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } finally { rmSync(seedPath, { force: true }); }
    }
    connection = new Database(mutex, { timeout: 0 });
    // A reserved writer lock excludes other owners while allowing their schema reads. Keep this transaction open until release.
    connection.exec('BEGIN IMMEDIATE');
    const counter = new Database(join(dir, OWNER_FILE), { timeout: 0 });
    try {
      // Only the mutex holder opens the counter, so its committed epoch cannot contend with another contender's schema reads.
      epoch = counter.transaction(() => {
        counter.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL)');
        const previous = counter.prepare('SELECT epoch FROM owner WHERE id = 1').get() as { epoch: number } | undefined;
        const next = (previous?.epoch ?? 0) + 1;
        counter.prepare('INSERT OR REPLACE INTO owner (id, epoch) VALUES (1, ?)').run(next);
        return next;
      }).immediate();
    } finally { counter.close(); }
  } catch (error) {
    connection?.close();
    if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string }).code ?? '')) throw new StoreOwnedError(notedPid(note));
    throw error;
  }
  // Diagnostics are best effort: their failure must not undo a valid SQLite acquisition.
  const record: OwnerNote = { pid: process.pid, epoch, takenAt: Date.now() };
  const staging = `${note}.${process.pid}`;
  try {
    writeFileSync(staging, JSON.stringify(record));
    renameSync(staging, note);
  } catch {
    try { rmSync(staging, { force: true }); } catch { /* An unavailable diagnostic path has no ownership authority. */ }
  }
  let released = false;
  return {
    epoch,
    release: () => {
      if (released) return;
      released = true;
      try {
        rmSync(note, { force: true }); // ours: a note is only ever written behind the lock this handle still holds
      } catch { /* A diagnostic failure must not prevent release. */ }
      finally {
        connection.close();
      }
    },
  };
}

/** Whether a store exists in the folder (for a backend that could not open it: nothing was created). */
export const storeExists = (dir: string): boolean => existsSync(join(dir, STORE_FILE));
