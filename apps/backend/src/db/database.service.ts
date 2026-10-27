import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { DB_KEY_ACCOUNT, type DatabaseProtection } from '@pi-kit/protocol';
import type { SecretStore } from '@pi-kit/secret-store';
import Database from 'better-sqlite3-multiple-ciphers';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { assertNoPendingDatabaseTransition, encryptDatabaseFile, isPlainDatabase, keyOpens, newDatabaseKey, useKey } from './encryption';

export const DB_FILE = 'pi-kit.sqlite';
export const BG_DB_FILE = 'bg-agents.sqlite';
interface DatabaseKey { key?: string; reason?: string }

/**
 * Owns the SQLite connection and applies the plain SQL files in `migrations/`
 * in name order at construction, each in its own transaction, recorded in `schema_migrations`. The
 * connection is open once the service exists, so repositories can use it from their constructors.
 *
 * Protection follows the startup preference: fresh macOS profiles use private plaintext storage;
 * opted-in profiles use `better-sqlite3-multiple-ciphers` with a random 256-bit key held as `pi-kit/db`.
 * Opt-in encrypts plaintext files on restart. Opt-out never decrypts existing data; encrypted
 * files and interrupted-transition originals are retained when access or verification fails.
 */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  readonly db: Database.Database;
  /** Typed queries share the already-keyed connection and its shutdown owner. */
  readonly orm: BetterSQLite3Database;
  readonly path: string;
  /** What Settings › Advanced says about the file. */
  readonly protection: Pick<DatabaseProtection, 'state' | 'path' | 'reason'>;
  private readonly key: string | undefined;

  constructor(@Inject(CONFIG) config: Pick<BackendConfig, 'dataDir'>, keyed: DatabaseKey = { reason: 'No credential store is configured for this backend.' }) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.path = join(config.dataDir, DB_FILE);
    this.key = keyed.key;
    this.db = this.open(this.key);
    try {
      // Plain storage is still private to the OS user; WAL sidecars inherit these permissions.
      chmodSync(this.path, 0o600);
      this.protection = { state: this.key ? 'encrypted' : 'plain', path: this.path, ...(keyed.reason ? { reason: keyed.reason } : {}) };
      // WAL: appends from the run loop never block readers; committed rows survive a killed process.
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 5000');
      // 32 MB of decrypted pages in memory (the default is 2 MB).
      this.db.pragma('cache_size = -32768');
      // The WAL file shrinks back to 64 MB after a checkpoint instead of keeping the size of the biggest compaction it ever held.
      this.db.pragma('journal_size_limit = 67108864');
      this.migrate(join(__dirname, 'migrations'));
      this.orm = drizzle(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Nest awaits this factory before any repository can open the encrypted database. */
  static async create(config: Pick<BackendConfig, 'dataDir'>, secrets?: SecretStore, encryptionEnabled = true): Promise<DatabaseService> {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const path = join(config.dataDir, DB_FILE);
    assertNoPendingDatabaseTransition(path);
    assertNoPendingDatabaseTransition(join(config.dataDir, BG_DB_FILE));
    const encrypted = [path, join(config.dataDir, BG_DB_FILE)]
      .find((file) => existsSync(file) && statSync(file).size > 0 && !isPlainDatabase(file));
    if (!encryptionEnabled && !encrypted) {
      return new DatabaseService(config, { reason: 'Protected storage is off. You can enable it in Settings.' });
    }
    // Existing app or agents data always keeps its original protection, even after opting out.
    const keyed = await DatabaseService.resolveKey(encrypted ?? path, secrets);
    if (encrypted && (!keyed.key || !keyOpens(encrypted, keyed.key))) {
      throw new Error('The original key is required to open the encrypted database. The database was retained.');
    }
    return new DatabaseService(config, keyed);
  }

  /** Keep storage available until session disposal and every module's asynchronous cleanup have finished. */
  onApplicationShutdown(): void {
    if (!this.db.open) return;
    // Lets SQLite refresh the statistics its planner uses for the queries this session ran; cheap, and skipped when nothing needs it.
    try { this.db.pragma('optimize'); } catch { /* a read-only or busy file is closed anyway */ }
    this.db.close();
  }

  /** The key, for the one-time "Export recovery key" (Settings › Advanced) and for nothing else. */
  recoveryKey(): string | undefined {
    return this.key;
  }

  /**
   * Which key opens the file, if any. `PI_KIT_DB_KEY` (a recovery key, 64 hex characters) wins and is written back into the store when the store has no entry. Otherwise the store's `pi-kit/db`; a
   * file that the key does not open is retained unchanged. Missing keys never cause a replacement database.
   */
  private static async resolveKey(path: string, secrets: SecretStore | undefined): Promise<DatabaseKey> {
    const recovery = process.env['PI_KIT_DB_KEY'];
    if (recovery && /^[0-9a-f]{64}$/.test(recovery)) {
      try {
        if (secrets?.available() && !(await secrets.get(DB_KEY_ACCOUNT))) await secrets.set(DB_KEY_ACCOUNT, recovery);
      } catch {
        // The store is not needed to use a key that was handed over.
      }
      return { key: recovery };
    }
    if (!secrets) return { reason: 'No credential store is configured for this backend.' };
    if (!secrets.available()) {
      if (secrets.protected) throw new Error('Biometric credential storage is unavailable. Use a signed pi-kit build with Keychain Sharing.');
      return { reason: `There is no credential store on this machine, so the key cannot be kept (${secrets.label}).` };
    }
    try {
      const held = await secrets.get(DB_KEY_ACCOUNT);
      const exists = existsSync(path) && statSync(path).size > 0;
      if (held && (!exists || isPlainDatabase(path) || keyOpens(path, held))) return { key: held };
      if (exists && !isPlainDatabase(path)) {
        throw new Error('The credential does not open the encrypted database. Restore its original key before retrying. The database was retained.');
      }
      // New encryption is explicit; never replace the key of an unreadable existing file.
      const key = held ?? newDatabaseKey();
      if (!held) await secrets.set(DB_KEY_ACCOUNT, key);
      return { key };
    } catch (error) {
      if (secrets.protected || (existsSync(path) && statSync(path).size > 0 && !isPlainDatabase(path))) throw error;
      return { reason: `The credential store did not take the database key: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private open(key: string | undefined): Database.Database {
    if (!key) {
      if (existsSync(this.path) && statSync(this.path).size > 0 && !isPlainDatabase(this.path)) {
        throw new Error(`${this.path} is encrypted and there is no key for it. Start pi-kit with PI_KIT_DB_KEY set to the recovery key, or move the file away (pi's session files rebuild the threads).`);
      }
      return new Database(this.path);
    }
    const openKeyed = (): Database.Database => {
      const db = new Database(this.path);
      try {
        useKey(db, key);
        db.prepare('SELECT count(*) FROM sqlite_master').get();
        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    };
    if (existsSync(this.path) && isPlainDatabase(this.path)) {
      const result = encryptDatabaseFile(this.path, key);
      let db: Database.Database | undefined;
      try {
        db = openKeyed();
        result.discardOriginal();
        this.logger.log(`Encrypted the database (${Object.keys(result.tables).length} tables); the plaintext file was removed.`);
        return db;
      } catch (error) {
        db?.close();
        result.restoreOriginal();
        throw error;
      }
    }
    return openKeyed();
  }

  /**
   * Applies the files of `migrations/` that this database has not seen, in name order, all in one `BEGIN IMMEDIATE` transaction so two
   * processes opening a fresh file do not both create the tables. Each file is recorded with a hash of its SQL (comments and spacing left
   * out): a database that recorded a file that is gone, or a different text of the same file, came from another pi-kit version and is refused.
   */
  private migrate(dir: string): void {
    const files = readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
    const applied = this.db.transaction(() => {
      this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, sha256 TEXT)');
      const recorded = new Map(
        (this.db.prepare('SELECT * FROM schema_migrations').all() as { name: string; sha256?: string | null }[]).map((row) => [row.name, row.sha256 ?? null]),
      );
      const changed = [...recorded].filter(([name, hash]) => {
        const file = files.find((f) => f.name === name);
        return !file || hash !== schemaHash(file.sql);
      });
      if (changed.length) {
        throw new Error(`${this.path} was created by a different pi-kit version (migrations ${changed.map(([name]) => name).join(', ')}). Delete it and restart to start fresh.`);
      }
      const added: string[] = [];
      for (const file of files) {
        if (recorded.has(file.name)) continue;
        this.db.exec(file.sql);
        this.db.prepare('INSERT INTO schema_migrations (name, applied_at, sha256) VALUES (?, ?, ?)').run(file.name, Date.now(), schemaHash(file.sql));
        added.push(file.name);
      }
      return added;
    }).immediate();
    for (const name of applied) this.logger.log(`Applied migration ${name}`);
    this.logger.log(`Database ready at ${this.path} (${this.protection.state})`);
  }
}

/** The hash a migration is recorded with: its SQL without `--` comments and with spacing collapsed, so editing a comment changes nothing. */
export function schemaHash(sql: string): string {
  const text = sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(text).digest('hex');
}
