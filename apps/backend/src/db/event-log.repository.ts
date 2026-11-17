import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { BaseEvent } from '@ag-ui/core';
import { DatabaseService } from './database.service';
import { runRecords, threadEvents } from './event-log.schema';
import { RedactionService } from './redaction.service';

export type RunRow = typeof runRecords.$inferSelect;
export type RunStatus = RunRow['status'];
export type StoredEvent = Pick<typeof threadEvents.$inferSelect, 'seq' | 'runId' | 'event'>;

/** Async durable replay log. SQLite's partial unique index arbitrates run ownership. */
@Injectable()
export class EventLogRepository {
  private readonly db: DatabaseService['db'];
  private readonly generations = new Map<string, string>();
  private readonly runListeners = new Set<(threadId: string, change: 'start' | 'end') => void>();
  constructor(
    database: DatabaseService,
    @Optional() private readonly redaction?: RedactionService,
  ) {
    this.db = database.db;
  }
  async append(threadId: string, runId: string | null, event: BaseEvent): Promise<number> {
    const result = await this.db
      .prepare('INSERT INTO thread_events(thread_id,run_id,event_json,type) VALUES(?,?,?,?)')
      .run(
        threadId,
        runId,
        JSON.stringify(this.redaction ? await this.redaction.event(threadId, event) : event),
        event.type,
      );
    return Number(result.lastInsertRowid);
  }
  read(threadId: string): Promise<StoredEvent[]> {
    return this.readAfter(threadId, 0);
  }
  cursor(threadId: string, seq: number): string {
    let generation = this.generations.get(threadId);
    if (!generation) this.generations.set(threadId, (generation = randomUUID()));
    return `${generation}:${seq}`;
  }
  async resolveCursor(threadId: string, cursor: string | undefined): Promise<number | undefined> {
    if (!cursor) return undefined;
    const split = cursor.lastIndexOf(':');
    const seq = Number(cursor.slice(split + 1));
    if (split < 0 || !Number.isSafeInteger(seq) || seq < 0 || cursor !== this.cursor(threadId, seq)) return undefined;
    if (seq === 0) return (await this.count(threadId)) === 0 ? 0 : undefined;
    return (await this.db.prepare('SELECT seq FROM thread_events WHERE thread_id=? AND seq=?').get(threadId, seq))
      ? seq
      : undefined;
  }
  async readAfter(threadId: string, seq: number): Promise<StoredEvent[]> {
    const rows = await this.db
      .prepare(
        'SELECT seq,run_id AS runId,event_json AS event FROM thread_events WHERE thread_id=? AND seq>? ORDER BY seq',
      )
      .all(threadId, seq);
    return (rows as { seq: number; runId: string | null; event: string }[]).map((row) => ({
      ...row,
      event: JSON.parse(row.event) as BaseEvent,
    }));
  }
  async lastSnapshotSeq(threadId: string, before = Number.MAX_SAFE_INTEGER): Promise<number> {
    const row = (await this.db
      .prepare("SELECT MAX(seq) AS seq FROM thread_events WHERE thread_id=? AND type='MESSAGES_SNAPSHOT' AND seq<?")
      .get(threadId, before)) as { seq: number | null } | undefined;
    return row?.seq ?? 0;
  }
  async runsWithEvents(threadId: string): Promise<{ runId: string; firstSeq: number }[]> {
    return (await this.db
      .prepare(
        'SELECT run_id AS runId,MIN(seq) AS firstSeq FROM thread_events WHERE thread_id=? AND run_id IS NOT NULL GROUP BY run_id ORDER BY MIN(seq)',
      )
      .all(threadId)) as { runId: string; firstSeq: number }[];
  }
  async deleteBefore(threadId: string, seq: number): Promise<number> {
    return (await this.db.prepare('DELETE FROM thread_events WHERE thread_id=? AND seq<?').run(threadId, seq)).changes;
  }
  async count(threadId: string): Promise<number> {
    return (
      (
        (await this.db.prepare('SELECT COUNT(*) AS n FROM thread_events WHERE thread_id=?').get(threadId)) as
          { n: number } | undefined
      )?.n ?? 0
    );
  }
  async deleteSeqs(threadId: string, seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;
    // Each async statement crosses the native worker boundary. Delete bounded sets instead
    // of paying a prepare/dispatch/await for every event during a large compaction pass.
    // Keep all chunks in one transaction, including rollback if a later chunk fails.
    const chunkSize = 500;
    await this.db.transaction(async () => {
      for (let offset = 0; offset < seqs.length; offset += chunkSize) {
        const chunk = seqs.slice(offset, offset + chunkSize);
        await this.db
          .prepare(`DELETE FROM thread_events WHERE thread_id=? AND seq IN (${chunk.map(() => '?').join(',')})`)
          .run(threadId, ...chunk);
      }
    })();
  }
  async clear(threadId: string): Promise<void> {
    // Rotate before yielding: cursors issued to writes queued after this clear use the new generation.
    this.generations.delete(threadId);
    await this.db.prepare('DELETE FROM thread_events WHERE thread_id=?').run(threadId);
  }
  async beginRun(threadId: string, runId: string): Promise<void> {
    await this.db
      .prepare("INSERT INTO runs(run_id,thread_id,status,started_at) VALUES(?,?,'running',?)")
      .run(runId, threadId, Date.now());
    this.notifyRun(threadId, 'start');
  }
  async endRun(runId: string, status: Exclude<RunStatus, 'running'>): Promise<void> {
    const row = (
      await this.db
        .prepare('UPDATE runs SET status=?,ended_at=? WHERE run_id=? RETURNING thread_id AS threadId')
        .all(status, Date.now(), runId)
    )[0] as { threadId: string } | undefined;
    if (row) this.notifyRun(row.threadId, 'end');
  }
  onRunChange(listener: (threadId: string, change: 'start' | 'end') => void): () => void {
    this.runListeners.add(listener);
    return () => {
      this.runListeners.delete(listener);
    };
  }
  private notifyRun(threadId: string, change: 'start' | 'end'): void {
    for (const listener of [...this.runListeners]) {
      try {
        listener(threadId, change);
      } catch {
        /* observers cannot break locks */
      }
    }
  }
  async setStartTree(
    runId: string,
    folder: string,
    tree: string | null,
    shadow?: { dir: string; prefix: string },
  ): Promise<void> {
    await this.db
      .prepare('UPDATE runs SET folder=?,start_tree=?,shadow_dir=?,shadow_prefix=? WHERE run_id=?')
      .run(folder, tree, shadow?.dir ?? null, shadow?.prefix ?? null, runId);
  }
  async setEndTree(runId: string, tree: string | null): Promise<void> {
    await this.db.prepare('UPDATE runs SET end_tree=? WHERE run_id=?').run(tree, runId);
  }
  async runsOf(threadId: string): Promise<RunRow[]> {
    return (await this.db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE thread_id=? ORDER BY rowid`)
      .all(threadId)) as RunRow[];
  }
  async staleRuns(): Promise<RunRow[]> {
    return (await this.db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE status='running'`).all()) as RunRow[];
  }
  async lastRun(threadId: string): Promise<RunRow | undefined> {
    return (await this.db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE thread_id=? ORDER BY rowid DESC LIMIT 1`)
      .get(threadId)) as RunRow | undefined;
  }
  async lastRunByThread(): Promise<Map<string, RunRow>> {
    const rows = (await this.db
      .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE rowid IN (SELECT MAX(rowid) FROM runs GROUP BY thread_id)`)
      .all()) as RunRow[];
    return new Map(rows.map((row) => [row.threadId, row]));
  }
}
const RUN_COLUMNS =
  'run_id AS runId,thread_id AS threadId,status,started_at AS startedAt,ended_at AS endedAt,folder,shadow_dir AS shadowDir,shadow_prefix AS shadowPrefix,start_tree AS startTree,end_tree AS endTree';
