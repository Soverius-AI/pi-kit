import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { BaseEvent } from '@ag-ui/core';
import { and, asc, count, desc, eq, getTableColumns, gt, isNotNull, lt, max, sql } from 'drizzle-orm';
import { DatabaseService } from './database.service';
import { runRecords, threadEvents } from './event-log.schema';
import { RedactionService } from './redaction.service';

export type RunRow = typeof runRecords.$inferSelect;
export type RunStatus = RunRow['status'];
export type StoredEvent = Pick<typeof threadEvents.$inferSelect, 'seq' | 'runId' | 'event'>;

/** The AG-UI replay log (`thread_events`) and the run lock rows (`runs`). */
@Injectable()
export class EventLogRepository {
  private readonly db: DatabaseService['orm'];
  private readonly generations = new Map<string, string>();
  private readonly runListeners = new Set<(threadId: string, change: 'start' | 'end') => void>();

  constructor(
    database: DatabaseService,
    /** Masks key shapes in what is written; absent in tests that do not care. */
    @Optional() private readonly redaction?: RedactionService,
  ) {
    this.db = database.orm;
  }

  /** SQLite allocates the ID inside the insert; no application counter can become stale. */
  append(threadId: string, runId: string | null, event: BaseEvent): number {
    return this.db
      .insert(threadEvents)
      .values({
        threadId,
        runId,
        event: this.redaction ? this.redaction.event(threadId, event) : event,
        type: event.type,
      })
      .returning({ seq: threadEvents.seq })
      .get().seq;
  }

  read(threadId: string): StoredEvent[] {
    return this.readAfter(threadId, 0);
  }

  cursor(threadId: string, seq: number): string {
    let generation = this.generations.get(threadId);
    if (!generation) this.generations.set(threadId, (generation = randomUUID()));
    return `${generation}:${seq}`;
  }

  /** Reject cursors from a restart, rebuilt branch, or a row removed by compaction. */
  resolveCursor(threadId: string, cursor: string | undefined): number | undefined {
    if (!cursor) return undefined;
    const split = cursor.lastIndexOf(':');
    const seq = Number(cursor.slice(split + 1));
    if (split < 0 || !Number.isSafeInteger(seq) || seq < 0 || cursor !== this.cursor(threadId, seq)) return undefined;
    if (seq === 0) return this.count(threadId) === 0 ? 0 : undefined;
    return this.db
      .select({ seq: threadEvents.seq })
      .from(threadEvents)
      .where(and(eq(threadEvents.threadId, threadId), eq(threadEvents.seq, seq)))
      .get()
      ? seq
      : undefined;
  }

  /** The events after `seq`, in order: what a compaction pass looks at instead of the whole log. */
  readAfter(threadId: string, seq: number): StoredEvent[] {
    return this.db
      .select({ seq: threadEvents.seq, runId: threadEvents.runId, event: threadEvents.event })
      .from(threadEvents)
      .where(and(eq(threadEvents.threadId, threadId), gt(threadEvents.seq, seq)))
      .orderBy(asc(threadEvents.seq))
      .all();
  }

  /**
   * Sequence number of the newest `MESSAGES_SNAPSHOT`, optionally before `before`; 0 if there is none. The type is a literal in the SQL so
   * SQLite uses the partial index `thread_events_snapshot`, the one index on this table besides the thread's own.
   */
  lastSnapshotSeq(threadId: string, before = Number.MAX_SAFE_INTEGER): number {
    return (
      this.db
        .select({ seq: max(threadEvents.seq) })
        .from(threadEvents)
        .where(
          and(
            eq(threadEvents.threadId, threadId),
            sql`${threadEvents.type} = 'MESSAGES_SNAPSHOT'`,
            lt(threadEvents.seq, before),
          ),
        )
        .get()?.seq ?? 0
    );
  }

  /** The runs that have events, oldest first, each with the first sequence number it wrote. */
  runsWithEvents(threadId: string): { runId: string; firstSeq: number }[] {
    return this.db
      .select({ runId: sql<string>`${threadEvents.runId}`, firstSeq: sql<number>`MIN(${threadEvents.seq})` })
      .from(threadEvents)
      .where(and(eq(threadEvents.threadId, threadId), isNotNull(threadEvents.runId)))
      .groupBy(threadEvents.runId)
      .orderBy(sql`MIN(${threadEvents.seq})`)
      .all();
  }

  /** Deletes every event before `seq`; returns how many rows went. */
  deleteBefore(threadId: string, seq: number): number {
    return this.db
      .delete(threadEvents)
      .where(and(eq(threadEvents.threadId, threadId), lt(threadEvents.seq, seq)))
      .run().changes;
  }

  count(threadId: string): number {
    return this.db.select({ n: count() }).from(threadEvents).where(eq(threadEvents.threadId, threadId)).get()?.n ?? 0;
  }

  deleteSeqs(threadId: string, seqs: number[]): void {
    const del = this.db
      .delete(threadEvents)
      .where(and(eq(threadEvents.threadId, threadId), eq(threadEvents.seq, sql.placeholder('seq'))))
      .prepare();
    this.db.transaction(() => {
      for (const seq of seqs) del.run({ seq });
    });
  }

  /** Forgets the log, e.g. when the session file changed behind our back and is the better source. */
  clear(threadId: string): void {
    this.db.delete(threadEvents).where(eq(threadEvents.threadId, threadId)).run();
    this.generations.delete(threadId);
  }

  /** Takes the lock. Throws if the thread already has a 'running' row (partial unique index). */
  beginRun(threadId: string, runId: string): void {
    this.db.insert(runRecords).values({ runId, threadId, status: 'running', startedAt: Date.now() }).run();
    this.notifyRun(threadId, 'start');
  }

  endRun(runId: string, status: Exclude<RunStatus, 'running'>): void {
    const row = this.db
      .update(runRecords)
      .set({ status, endedAt: Date.now() })
      .where(eq(runRecords.runId, runId))
      .returning({ threadId: runRecords.threadId })
      .get();
    if (row) this.notifyRun(row.threadId, 'end');
  }

  /**
   * A run started or ended (the lock row changed): `ThreadStatusService` (among others) listens, so the sidebar learns it without polling.
   * Called synchronously from `beginRun` and `endRun`; a listener that needs the run's bookkeeping to be complete defers itself.
   */
  onRunChange(listener: (threadId: string, change: 'start' | 'end') => void): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  private notifyRun(threadId: string, change: 'start' | 'end'): void {
    for (const listener of [...this.runListeners]) {
      try {
        listener(threadId, change);
      } catch {
        // a listener must not break the run lock
      }
    }
  }

  /** Where the run worked and the snapshot of that folder before it started; `tree` is `null` outside a git work tree. */
  setStartTree(runId: string, folder: string, tree: string | null, shadow?: { dir: string; prefix: string }): void {
    this.db
      .update(runRecords)
      .set({ folder, startTree: tree, shadowDir: shadow?.dir ?? null, shadowPrefix: shadow?.prefix ?? null })
      .where(eq(runRecords.runId, runId))
      .run();
  }

  /** The snapshot of the run's folder when it ended. */
  setEndTree(runId: string, tree: string | null): void {
    this.db.update(runRecords).set({ endTree: tree }).where(eq(runRecords.runId, runId)).run();
  }

  /** Every run of a thread, oldest first. */
  runsOf(threadId: string): RunRow[] {
    return this.db
      .select()
      .from(runRecords)
      .where(eq(runRecords.threadId, threadId))
      .orderBy(asc(sql`${runRecords}.rowid`))
      .all();
  }

  /** Runs left 'running' by a process that no longer exists. */
  staleRuns(): RunRow[] {
    return this.db.select().from(runRecords).where(eq(runRecords.status, 'running')).all();
  }

  /** The newest run of a thread: the last row written, as in `lastRunByThread` (a clock that steps back does not reorder runs). */
  lastRun(threadId: string): RunRow | undefined {
    return this.db
      .select()
      .from(runRecords)
      .where(eq(runRecords.threadId, threadId))
      .orderBy(desc(sql`${runRecords}.rowid`))
      .limit(1)
      .get();
  }

  /** Latest run per thread, for the thread list. */
  lastRunByThread(): Map<string, RunRow> {
    const latest = this.db
      .select({ rowId: sql<number>`MAX(${runRecords}.rowid)`.as('row_id') })
      .from(runRecords)
      .groupBy(runRecords.threadId)
      .as('latest');
    const rows = this.db
      .select(getTableColumns(runRecords))
      .from(runRecords)
      .innerJoin(latest, eq(sql`${runRecords}.rowid`, latest.rowId))
      .all();
    return new Map(rows.map((row) => [row.threadId, row]));
  }
}
