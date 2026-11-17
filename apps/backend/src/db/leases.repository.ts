import { Injectable } from '@nestjs/common';
import { LEASE_TTL_MS, type Lease, renewLease } from '../coordination/leases';
import { DatabaseService } from './database.service';

interface RawLease {
  thread_id: string;
  cwd: string;
  path: string;
  since: number;
  at: number;
}

const toLease = (r: RawLease): Lease => ({ threadId: r.thread_id, cwd: r.cwd, path: r.path, since: r.since, at: r.at });

/** `file_leases`: which thread edited or wrote which file lately. Soft: nothing here stops an edit. */
@Injectable()
export class LeasesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** The thread edited or wrote `path` (relative to `cwd`) just now. */
  async take(threadId: string, cwd: string, path: string, now = Date.now()): Promise<Lease> {
    return await this.database.db
      .transaction(async () => {
        const previous = (await this.db
          .prepare('SELECT * FROM file_leases WHERE thread_id = ? AND cwd = ? AND path = ?')
          .get(threadId, cwd, path)) as RawLease | undefined;
        const lease = renewLease(previous && toLease(previous), { threadId, cwd, path }, now);
        await this.db
          .prepare(
            `INSERT INTO file_leases (thread_id, cwd, path, since, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (thread_id, cwd, path) DO UPDATE SET since = excluded.since, at = excluded.at`,
          )
          .run(threadId, cwd, path, lease.since, lease.at);
        return lease;
      })
      .immediate();
  }

  /** The leases of the folder that have not expired, newest activity first. */
  async activeIn(cwd: string, now = Date.now()): Promise<Lease[]> {
    return (
      (await this.db
        .prepare('SELECT * FROM file_leases WHERE cwd = ? AND at > ? ORDER BY at DESC')
        .all(cwd, now - LEASE_TTL_MS)) as RawLease[]
    ).map(toLease);
  }

  /** The leases one thread holds that have not expired. */
  async activeOf(threadId: string, now = Date.now()): Promise<Lease[]> {
    return (
      (await this.db
        .prepare('SELECT * FROM file_leases WHERE thread_id = ? AND at > ? ORDER BY at DESC')
        .all(threadId, now - LEASE_TTL_MS)) as RawLease[]
    ).map(toLease);
  }

  /** A thread that was deleted holds nothing. */
  async release(threadId: string): Promise<void> {
    await this.db.prepare('DELETE FROM file_leases WHERE thread_id = ?').run(threadId);
  }

  /** Expired rows are dropped; nobody reads them, but the table stays small. */
  async prune(now = Date.now()): Promise<number> {
    return (await this.db.prepare('DELETE FROM file_leases WHERE at <= ?').run(now - LEASE_TTL_MS)).changes;
  }
}
