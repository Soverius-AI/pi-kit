import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';

/**
 * Encryption of pi-kit's SQLite file: SQLite3 Multiple Ciphers through `better-sqlite3-multiple-ciphers`, a random 256-bit key held in the operating system's credential store.
 * The key is a raw key (`x'<64 hex>'`), so opening the database costs no key derivation (about 0.6 ms) and the file is readable by any SQLite3 Multiple Ciphers build given `CIPHER` and the same key.
 * This file is the mechanics (the header check, the key pragma, the one-time migration of a plaintext file); `DatabaseService` decides when to use them.
 */

const PLAIN_HEADER = 'SQLite format 3\0';
/**
 * The cipher of the file. SQLite3 Multiple Ciphers' default, ChaCha20-Poly1305 per page, because it was the fastest of the four that were measured on this machine for the write pattern of the replay log (about
 * ninety small commits per run): 2.2 times the plain file's time for a run's appends and compaction, against 4.1 times for SQLCipher 4 (AES-256-CBC with HMAC-SHA512) and 3.1 times for AES-256-CBC alone.
 * The cipher is not recorded in the file: changing it later means migrating every file, so it is a constant, not a setting.
 */
const CIPHER = 'chacha20';

/** Whether the file starts with SQLite's plain header: an encrypted file starts with random bytes. A missing or empty file is neither. */
export function isPlainDatabase(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(16);
    const read = readSync(fd, head, 0, 16, 0);
    return read === 16 && head.toString('latin1') === PLAIN_HEADER;
  } finally {
    closeSync(fd);
  }
}

/** A new database key: 32 random bytes as 64 hex characters. */
export const newDatabaseKey = (): string => randomBytes(32).toString('hex');

/** The pragma value for a raw key. The key is validated here, because it is spliced into a pragma (which takes no bound parameter). */
function keyPragma(hexKey: string): string {
  if (!/^[0-9a-f]{64}$/.test(hexKey)) throw new Error('The database key must be 64 hexadecimal characters.');
  return `"x'${hexKey}'"`;
}

/** Tells an open connection to use `CIPHER` and the key. Call it before the first statement. */
export function useKey(db: Database.Database, hexKey: string): void {
  db.pragma(`cipher='${CIPHER}'`);
  db.pragma(`key=${keyPragma(hexKey)}`);
}

/** Reads one statement through a keyed connection: true when the key opens the file. */
export function keyOpens(path: string, hexKey: string): boolean {
  if (!existsSync(path)) return false;
  const db = new Database(path, { fileMustExist: true });
  try {
    useKey(db, hexKey);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/** Every table with its row count, for comparing a file before and after migration. */
function tableCounts(db: Database.Database): Record<string, number> {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, (db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number }).n]));
}

const sidecars = (path: string): string[] => [`${path}-wal`, `${path}-shm`, `${path}-journal`];

export interface EncryptResult {
  /** Rows per table, equal before and after. */
  tables: Record<string, number>;
  /** The caller opened the encrypted file and it works: the plaintext file (kept until now) and its sidecars are deleted. */
  discardOriginal(): void;
  /** The caller could not open the encrypted file: the plaintext file is put back. */
  restoreOriginal(): void;
}

/** Throws when a protection transition of `path` was interrupted (a `.plaintext`, `.encrypted`, `.encrypting` or `.decrypting` file is beside it), so nothing replaces the retained originals. */
export function assertNoPendingDatabaseTransition(path: string): void {
  if (['.plaintext', '.encrypted', '.encrypting', '.decrypting'].some((suffix) => existsSync(`${path}${suffix}`))) {
    throw new Error('An interrupted database protection transition needs recovery. Original database files were retained; do not delete them or start a replacement database.');
  }
}

/**
 * Encrypts a plaintext database file in place, keeping the old one until the new one is verified:
 *  1. the plaintext file is checkpointed and copied (`<path>.encrypting`), the copy is rekeyed (`rekey` on a plaintext database encrypts it);
 *  2. the copy is opened with the key and compared with the original (every table, the same row count; `integrity_check` is `ok`);
 *  3. only then the copy takes the place of the original, which stays beside it as `<path>.plaintext` until `discardOriginal()` (the caller has opened the new file).
 * Any failure before that leaves the original untouched and removes the copy.
 */
export function encryptDatabaseFile(path: string, hexKey: string): EncryptResult {
  const copy = `${path}.encrypting`;
  const clean = (): void => {
    for (const file of [copy, ...sidecars(copy)]) rmSync(file, { force: true });
  };
  clean();
  let before: Record<string, number>;
  chmodSync(path, 0o600);
  const source = new Database(path, { fileMustExist: true });
  try {
    source.pragma('wal_checkpoint(TRUNCATE)');
    before = tableCounts(source);
    // Reserve a private empty destination before VACUUM writes any plaintext into it.
    writeFileSync(copy, '', { mode: 0o600, flag: 'wx' });
    source.prepare('VACUUM INTO ?').run(copy);
  } catch (error) {
    clean();
    throw error;
  } finally {
    source.close();
  }
  try {
    const target = new Database(copy);
    try {
      target.pragma('journal_mode = DELETE');
      target.pragma(`cipher='${CIPHER}'`);
      target.pragma(`rekey=${keyPragma(hexKey)}`);
    } finally {
      target.close();
    }
    if (isPlainDatabase(copy)) throw new Error('The copy is still plaintext after the rekey.');
    const check = new Database(copy, { fileMustExist: true });
    try {
      useKey(check, hexKey);
      const after = tableCounts(check);
      if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`The encrypted copy differs from the original (${JSON.stringify(after)} against ${JSON.stringify(before)}).`);
      const integrity = check.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new Error(`The encrypted copy failed its integrity check: ${String(integrity)}.`);
    } finally {
      check.close();
    }
  } catch (error) {
    clean();
    throw error;
  }
  // Verified: the copy takes the original's place, and the original is kept beside it (`.plaintext`) until the caller has opened the new file.
  const kept = `${path}.plaintext`;
  for (const file of [kept, ...sidecars(kept)]) rmSync(file, { force: true });
  renameSync(path, kept);
  for (const file of sidecars(path)) if (existsSync(file)) renameSync(file, `${kept}${file.slice(path.length)}`);
  renameSync(copy, path);
  return {
    tables: before,
    discardOriginal: () => {
      for (const file of [kept, ...sidecars(kept)]) rmSync(file, { force: true });
    },
    restoreOriginal: () => {
      for (const file of [path, ...sidecars(path)]) rmSync(file, { force: true });
      renameSync(kept, path);
      for (const file of sidecars(kept)) if (existsSync(file)) renameSync(file, `${path}${file.slice(kept.length)}`);
    },
  };
}
