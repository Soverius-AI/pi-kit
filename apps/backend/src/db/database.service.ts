import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { DATABASE_RESET_PENDING_FILE, EnvironmentSchema } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { AsyncSqlite } from './async-sqlite';
import { assertNoPendingDatabaseTransition, isPlainDatabase } from './database-file-guards';

export const DB_FILE = 'pi-kit.sqlite';
export const BG_DB_FILE = 'bg-agents.sqlite';
/** Damaged; the desktop may offer recreation. Never thrown for key/version problems. */
export class DatabaseBrokenError extends Error {}
/** Incompatible schema is not corruption. Never offer a reset; the matching pi-kit version opens it. */
export class DatabaseVersionError extends Error {}
/** Encrypted originals require offline migration or an explicitly confirmed backup and reset. */
export class DatabaseEncryptionMigrationError extends Error {}
export class DatabaseResetIncompleteError extends Error {}

/** Owns the async SQLite connection. Nest's factory awaits every migration and identity hydration. */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  db!: AsyncSqlite;
  readonly ready: Promise<void>;
  readonly path: string;
  private cachedInstanceId?: string;
  get instanceId(): string {
    if (!this.cachedInstanceId)
      throw new Error('Database identity is not ready; await DatabaseService.create() or ready.');
    return this.cachedInstanceId;
  }

  constructor(@Inject(CONFIG) config: Pick<BackendConfig, 'dataDir'>) {
    this.path = join(config.dataDir, DB_FILE);
    this.ready = this.initialize(config.dataDir);
  }

  private async initialize(dataDir: string): Promise<void> {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (existsSync(join(dataDir, DATABASE_RESET_PENDING_FILE))) {
      throw new DatabaseResetIncompleteError(
        `A database reset was interrupted in ${dataDir}. Startup stopped before opening either database. ` +
          `${DATABASE_RESET_PENDING_FILE} names the database-backup folder holding the original files; the desktop app can move them back.`,
      );
    }
    // Check both files BEFORE opening either. Unknown headers may be encrypted, not corrupt.
    for (const path of [this.path, join(dataDir, BG_DB_FILE)]) {
      try {
        assertNoPendingDatabaseTransition(path);
      } catch (error) {
        throw new DatabaseEncryptionMigrationError((error as Error).message, { cause: error });
      }
      if (existsSync(path) && statSync(path).size > 0 && !isPlainDatabase(path)) {
        throw new DatabaseEncryptionMigrationError(
          `${path} is encrypted or has an unrecognized header and cannot be opened by this version of pi-kit. ` +
            'All original files were retained unchanged.',
        );
      }
    }
    this.db = await AsyncSqlite.open(this.path);
    try {
      chmodSync(this.path, 0o600);
      await this.db.pragma('busy_timeout = 5000');
      await this.db.pragma('journal_mode = WAL');
      await this.db.pragma('synchronous = NORMAL');
      await this.db.pragma('cache_size = -32768');
      await this.db.pragma('journal_size_limit = 67108864');
      await this.migrate(join(__dirname, 'migrations'));
      // Owner identity must survive a power loss before startup publishes it. Do not call durable()
      // here: it waits on ready, which initialization itself is resolving.
      this.cachedInstanceId = await this.withFullDurability(async () =>
        this.db
          .transaction(async () => {
            await this.db
              .prepare(
                'INSERT OR IGNORE INTO instance_identity(singleton, instance_id, name, created_at) VALUES (1, ?, ?, ?)',
              )
              .run(randomUUID(), hostname().slice(0, 80) || 'My pi-kit', Date.now());
            const row = (await this.db
              .prepare('SELECT instance_id, name FROM instance_identity WHERE singleton = 1')
              .get<{ instance_id: string; name: string }>())!;
            // Never silently replace an invalid stored identity: it may already be trusted by peers.
            return EnvironmentSchema.parse({ instanceId: row.instance_id, name: row.name, protocolVersion: 1 })
              .instanceId;
          })
          .immediate(),
      );
      this.logger.log(`Database ready at ${this.path}`);
    } catch (error) {
      await this.db.close().catch(() => undefined);
      if (isCorruption(error))
        throw new DatabaseBrokenError(`${this.path} is damaged (${(error as Error).message}).`, { cause: error });
      throw error;
    }
  }

  /** Security-sensitive writes use FULL through the commit; the entire scope is fenced from other work. */
  async durable<T>(write: () => Promise<T>): Promise<T> {
    await this.ready;
    return this.withFullDurability(write);
  }

  private async withFullDurability<T>(write: () => Promise<T>): Promise<T> {
    return this.db.exclusive(async () => {
      const previous = (await this.db.pragma('synchronous', { simple: true })) as number;
      await this.db.pragma('synchronous = FULL');
      try {
        return await write();
      } finally {
        await this.db.pragma(`synchronous = ${previous}`);
      }
    });
  }

  static async create(config: Pick<BackendConfig, 'dataDir'>): Promise<DatabaseService> {
    const service = new DatabaseService(config);
    await service.ready;
    return service;
  }

  /** Drain accepted writes only after all modules finish their asynchronous disposal. */
  async onApplicationShutdown(): Promise<void> {
    await this.ready.catch(() => undefined);
    if (!this.db?.open) return;
    try {
      await this.db.pragma('optimize');
    } catch {
      /* Busy/read-only connections still close. */
    }
    await this.db.close();
  }

  private async migrate(dir: string): Promise<void> {
    const files = readdirSync(dir)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
    const applied = await this.db
      .transaction(async () => {
        await this.db.exec(
          'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL, sha256 TEXT)',
        );
        // Older pre-squash tables lack sha256; SELECT * deliberately supports recognizing them.
        const recorded = new Map(
          (
            await this.db.prepare('SELECT * FROM schema_migrations').all<{ name: string; sha256?: string | null }>()
          ).map((row) => [row.name, row.sha256 ?? null]),
        );
        const changed = [...recorded].filter(([name, hash]) => {
          const file = files.find((f) => f.name === name);
          return !file || hash !== schemaHash(file.sql);
        });
        if (changed.length)
          throw new DatabaseVersionError(
            `${this.path} was created by a different pi-kit version (migrations ${changed.map(([name]) => name).join(', ')}). The database was retained. Open it with the matching app version or restore a compatible backup; recreating it would lose metadata.`,
          );
        const added: string[] = [];
        for (const file of files) {
          if (recorded.has(file.name)) continue;
          await this.db.exec(file.sql);
          await this.db
            .prepare('INSERT INTO schema_migrations (name, applied_at, sha256) VALUES (?, ?, ?)')
            .run(file.name, Date.now(), schemaHash(file.sql));
          added.push(file.name);
        }
        return added;
      })
      .immediate();
    for (const name of applied) this.logger.log(`Applied migration ${name}`);
  }
}

/** NOTADB is deliberately not corruption: encrypted/wrong-key files must never trigger recreation. */
function isCorruption(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && String(error.code).startsWith('SQLITE_CORRUPT')
  );
}

/** Hash SQL without line comments and with spacing collapsed. */
export function schemaHash(sql: string): string {
  return createHash('sha256')
    .update(
      sql
        .replace(/--[^\n]*/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .digest('hex');
}
