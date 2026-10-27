import { type BaseEvent, EventType } from '@ag-ui/client';
import { compactableIndices, mapUiEvent } from '@pi-kit/pi-adapter';
import type { EventLogRepository } from '../db/event-log.repository';
import { composerChanges, foldComposer } from './composer-log';

/**
 * Event-log compaction thresholds. The log is a cache of pi's session file plus streamed detail; the last
 * `MESSAGES_SNAPSHOT` in it repeats the whole active branch, so what comes before it is only worth keeping as long as it is cheap.
 */
export const COMPACTION = {
  /**
   * A thread whose log has more rows than this after a run is collapsed: every run except the newest `keepRuns` is deleted
   * outright (their structure; the newest snapshot, which holds the whole transcript, stays). Measured with the recorded tool-run
   * fixture (88 streamed events): a run leaves about 19 rows after the per-run pass, so 2,000 rows is about 100 runs. The replay the client applies on
   * every open is then about 2,000 events plus the snapshot, and `connect()` reads it in about a millisecond; without a ceiling it
   * grows by 19 rows per run for the life of the thread.
   */
  maxRows: 2000,
  /** The newest runs a collapse keeps whole, so the transcript's recent `pi.*` custom events and `aborted` markers survive it. */
  keepRuns: 10,
} as const;

export interface CompactionResult {
  /** Content deltas, earlier snapshots and streamed activities dropped by the per-run pass. */
  trimmed: number;
  /** Rows of old runs dropped by the collapse. */
  collapsed: number;
}

/**
 * Runs after a run ends (or after the branch moved outside a run). Two passes, both bounded by what changed and not by the age of the
 * thread: the per-run pass trims the rows since the previous snapshot (everything older was trimmed by its own run) and deletes that
 * snapshot, which the new one supersedes; the collapse pass keeps the log under `maxRows`.
 */
export class LogCompactor {
  constructor(
    private readonly log: EventLogRepository,
    private readonly limits: { maxRows: number; keepRuns: number } = COMPACTION,
  ) {}

  compact(threadId: string, options: { full?: boolean } = {}): CompactionResult {
    const result: CompactionResult = { trimmed: 0, collapsed: 0 };
    const last = this.log.lastSnapshotSeq(threadId);
    if (last === 0) return result;
    // A full pass repairs logs whose earlier incremental passes left deltas behind (e.g. duplicate final snapshots).
    const previous = options.full ? 0 : this.log.lastSnapshotSeq(threadId, last);

    // The window starts at the previous snapshot (included: it is deleted) and holds this run, plus whatever earlier runs that never
    // reached a snapshot left behind. `compactableIndices` only looks before the last snapshot of the window, which is `last`.
    const window = this.log.readAfter(threadId, Math.max(0, previous - 1));
    const drop = compactableIndices(window.map((s) => s.event));
    if (drop.length > 0) {
      this.log.deleteSeqs(threadId, drop.map((i) => window[i].seq));
      result.trimmed = drop.length;
    }
    if (this.log.count(threadId) > this.limits.maxRows) result.collapsed = this.collapse(threadId, last);
    return result;
  }

  /** Deletes the runs older than the newest `keepRuns`, provided a snapshot survives in the ones that stay. */
  private collapse(threadId: string, lastSnapshot: number): number {
    const runs = this.log.runsWithEvents(threadId);
    if (runs.length <= this.limits.keepRuns) return 0;
    const cut = runs[runs.length - this.limits.keepRuns].firstSeq;
    if (lastSnapshot < cut) return 0; // the newest snapshot belongs to an older run: nothing may go
    // Toolbar actions and suggestions extensions registered (`pi.composer`) are state, not history: a registration that only an
    // old run holds is written again, in a run of its own after the newest ones, before the old runs go.
    const all = this.log.read(threadId);
    const registered = foldComposer(all.map((s) => s.event));
    const survivors = foldComposer(all.filter((s) => s.seq >= cut).map((s) => s.event));
    const deleted = this.log.deleteBefore(threadId, cut);
    const lost = [...registered.values()].filter((registration) => composerChanges(survivors, registration));
    if (lost.length > 0) {
      const runId = `composer-${Date.now()}`;
      const events = [
        { type: EventType.RUN_STARTED, threadId, runId },
        ...lost.flatMap((registration) => mapUiEvent({ kind: 'composer', registration })),
        { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } },
      ] as BaseEvent[];
      for (const event of events) this.log.append(threadId, runId, event);
    }
    return deleted;
  }
}
