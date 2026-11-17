import { AsyncLocalStorage } from 'node:async_hooks';
import sqlite3, { type BindParams } from '@appthreat/sqlite3';

type Connection = Awaited<ReturnType<typeof sqlite3.open>>;
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}
export type AsyncTransaction<A extends unknown[], T> = ((...args: A) => Promise<T>) & {
  immediate(...args: A): Promise<T>;
  deferred(...args: A): Promise<T>;
  exclusive(...args: A): Promise<T>;
};

/** Promise-only boundary. One queue owns the connection, including the entire awaited transaction body. */
export class AsyncSqlite {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<{ active: boolean; transaction: boolean }>();
  private closing = false;
  private closed = false;
  private closePromise?: Promise<void>;
  private savepoint = 0;
  // Keep the native cache disabled: cached VMs can retain cursors across COMMIT/checkpoint.
  // Correct connection ownership takes precedence over avoiding statement preparation.
  private constructor(private readonly connection: Connection) {}
  static async open(path: string, options?: Parameters<typeof sqlite3.open>[1]): Promise<AsyncSqlite> {
    return new AsyncSqlite(await sqlite3.open(path, options));
  }
  get open(): boolean {
    return !this.closed;
  }

  /** Exclusive scope also fences synchronous-mode changes around security-sensitive writes. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.schedule(async () => {
      const inherited = this.context.getStore();
      if (inherited?.active) return work();
      const scope = { active: true, transaction: false };
      return this.context.run(scope, async () => {
        try {
          return await work();
        } finally {
          scope.active = false;
        }
      });
    });
  }
  private schedule<T>(work: () => Promise<T>): Promise<T> {
    const scope = this.context.getStore();
    if (scope && !scope.active)
      return Promise.reject(
        new Error(
          'SQLite operation escaped its completed transaction/exclusive scope. Await all database work inside the callback.',
        ),
      );
    if (scope?.active) return work();
    if (this.closing) return Promise.reject(new Error('The database is closed.'));
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  prepare(sql: string): AsyncStatement {
    return new AsyncStatement(this, sql);
  }
  exec(sql: string): Promise<void> {
    return this.schedule(async () => {
      await this.connection.exec(sql);
    });
  }
  pragma(sql: string, options?: { simple?: boolean }): Promise<any> {
    return this.schedule(async () => {
      const rows = await this.connection.all(`PRAGMA ${sql}`);
      return options?.simple ? (rows[0] ? Object.values(rows[0])[0] : undefined) : rows;
    });
  }
  query<T>(method: 'get' | 'all' | 'run', sql: string, args: unknown[]): Promise<T> {
    return this.schedule(async () => {
      const normalized = bindings(sql, args);
      const first = normalized[0];
      const params = (
        normalized.length === 1 &&
        first !== null &&
        typeof first === 'object' &&
        !ArrayBuffer.isView(first) &&
        !(first instanceof ArrayBuffer)
          ? first
          : normalized
      ) as BindParams;
      if (method === 'run') {
        const result = await this.connection.run(sql, params);
        return { changes: result.changes, lastInsertRowid: result.lastID } as T;
      }
      // Drain the VM even for get(): UPDATE/INSERT ... RETURNING must reach SQLITE_DONE
      // before COMMIT (native get() can leave a statement positioned on its first row).
      if (method === 'get') return (await this.connection.all(sql, params))[0] as T;
      return (await this.connection.all(sql, params)) as T;
    });
  }
  transaction<A extends unknown[], T>(body: (...args: A) => Promise<T>): AsyncTransaction<A, T> {
    const invoke = (mode: string, args: A): Promise<T> =>
      this.exclusive(async () => {
        const scope = this.context.getStore()!;
        const nested = scope.transaction;
        const point = `pk_${++this.savepoint}`;
        await this.exec(nested ? `SAVEPOINT ${point}` : `BEGIN ${mode}`);
        const transactionScope = { active: true, transaction: true };
        try {
          // Expire the body context before COMMIT. Detached tasks must not become independent writes later.
          const value = await this.context.run(transactionScope, async () => {
            try {
              return await body(...args);
            } finally {
              transactionScope.active = false;
            }
          });
          await this.exec(nested ? `RELEASE ${point}` : 'COMMIT');
          return value;
        } catch (error) {
          try {
            await this.exec(nested ? `ROLLBACK TO ${point}` : 'ROLLBACK');
            if (nested) await this.exec(`RELEASE ${point}`);
          } catch {
            /* Preserve the original error. */
          }
          throw error;
        } finally {
          transactionScope.active = false;
        }
      });
    const fn = ((...args: A) => invoke('DEFERRED', args)) as AsyncTransaction<A, T>;
    fn.immediate = (...args) => invoke('IMMEDIATE', args);
    fn.deferred = (...args) => invoke('DEFERRED', args);
    fn.exclusive = (...args) => invoke('EXCLUSIVE', args);
    return fn;
  }
  close(): Promise<void> {
    if (this.context.getStore()?.active)
      return Promise.reject(new Error('Cannot close SQLite inside an active exclusive scope.'));
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(async () => {
      await this.connection.close();
      this.closed = true;
    });
    return this.closePromise;
  }
}

export class AsyncStatement {
  private bound: unknown[] = [];
  constructor(
    private readonly db: AsyncSqlite,
    private readonly sql: string,
  ) {}
  bind(...args: unknown[]): this {
    this.bound = args;
    return this;
  }
  get<T = any>(...args: unknown[]): Promise<T | undefined> {
    return this.db.query('get', this.sql, args.length ? args : this.bound);
  }
  all<T = any>(...args: unknown[]): Promise<T[]> {
    return this.db.query('all', this.sql, args.length ? args : this.bound);
  }
  run(...args: unknown[]): Promise<RunResult> {
    return this.db.query('run', this.sql, args.length ? args : this.bound);
  }
}

/** Accept bare object keys and ignore surplus named fields for existing repository bindings. */
function bindings(sql: string, args: unknown[]): unknown[] {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  if (
    args.length !== 1 ||
    !args[0] ||
    typeof args[0] !== 'object' ||
    ArrayBuffer.isView(args[0]) ||
    args[0] instanceof ArrayBuffer
  )
    return args;
  const input = args[0] as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  // Skip comments, quoted identifiers and string literals when finding parameters.
  const tokens =
    sql.match(
      /'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|[@:$][A-Za-z_][A-Za-z_0-9]*/g,
    ) ?? [];
  for (const key of tokens)
    if (/^[@:$]/.test(key)) {
      const bare = key.slice(1);
      if (key in input) output[key] = input[key];
      else if (bare in input) output[key] = input[bare];
      else throw new Error(`Missing named SQLite parameter ${key}`);
    }
  return [output];
}
