import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import type { FileStatus } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { AgentSpansRepository } from '../db/agent-spans.repository';
import { EventLogRepository } from '../db/event-log.repository';
import { type ThreadRow, ThreadsRepository } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { workFolderOf } from '../threads/work-folder';
import { allChanged, batchOf, FolderChangesService } from '../folder-changes/folder-changes.service';
import { type FileChange, ShadowRegistry, ShadowRepo } from './shadow-repo';

/**
 * A run waits this long at most for the snapshot of its folder before pi gets the prompt. A snapshot that finishes later is not kept: pi may
 * already have changed files, and the run has no "before" then.
 */
export const START_WAIT_MS = 10_000;
/** The folder as it is now is captured once for the requests of one refresh (the list, the badges, the candidates of a commit). */
const NOW_REUSE_MS = 500;
/** The changes between stored trees kept in memory. */
const MAX_CACHED_CHANGES = 500;
/** How often a run of a thread that does not exist yet looks for its row. */
const ROW_POLL_MS = 25;

/** A file a thread changed: the snapshot from before the run that first changed it, and that run. */
export interface ThreadChange {
  path: string;
  /** The tree that has the file as it was before the thread touched it. */
  before: string;
  /** 1-based number of the run (of the thread's runs) that first changed it; absent when a background agent of the thread did. */
  run?: number;
  /** When that run (or the agent's stretch of work) started. */
  at: number;
  /** What that run did to it: `A` means the file did not exist before the thread. */
  status: FileStatus;
}

/** A stretch of work with snapshots around it: a run of the thread, or a background agent's work in the thread's folder. */
interface Span {
  key: string;
  folder: string | null;
  shadowDir: string | null;
  shadowPrefix: string | null;
  startTree: string | null;
  /** The snapshot when it ended; else where the next run in its folder starts (a run that ended without one). */
  endTree: string | undefined;
  /** Still going: it ends at the folder as it is now. */
  open: boolean;
  startedAt: number;
  run?: number;
}

/**
 * Snapshots of a thread's folder around each of its runs, in the folder's `ShadowRepo`: one before pi gets the prompt (the run waits for it, up to
 * `START_WAIT_MS`) and one when the run ends, kept on the run's row. What a thread changed is what changed between those pairs; a run that ended
 * also tells the panels which files it changed. A folder outside a git work tree has no snapshots, and its runs end with a full refresh. A
 * background agent that works in the thread's folder is snapshotted the same way around each stretch of its work (`agentStarted`/`agentEnded`).
 */
@Injectable()
export class RunSnapshotsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunSnapshotsService.name);
  private readonly registry = new ShadowRegistry();
  private readonly shadows = new Map<string, Promise<ShadowRepo | undefined>>();
  /** The snapshot being taken before a thread's run, and the moment the run stops waiting for it; the run's end snapshot waits for it too. */
  private readonly starting = new Map<string, { done: Promise<void>; deadline: Promise<void> }>();
  /** The snapshot being taken after a run, by run: a read of the thread's changes waits for it. */
  private readonly ending = new Map<string, Promise<void>>();
  private readonly nows = new Map<ShadowRepo, { at: number; tree: Promise<string> }>();
  /** What changed between two stored trees never changes. */
  private readonly changed = new Map<string, Promise<FileChange[]>>();
  private off: (() => void) | undefined;

  constructor(
    private readonly log: EventLogRepository,
    private readonly threads: ThreadsRepository,
    private readonly folderChanges: FolderChangesService,
    @Inject(CONFIG) private readonly config: BackendConfig,
    /** Says whether pi is already working when a run starts (a turn it started by itself); absent in tests that do not care. */
    @Optional() private readonly sessions?: PiSessionService,
    /** The stretches of work of background agents; absent in tests that do not care. */
    @Optional() private readonly agentSpans?: AgentSpansRepository,
  ) {}

  onModuleInit(): void {
    this.off = this.log.onRunChange((threadId, change) =>
      change === 'start' ? this.started(threadId) : this.ended(threadId),
    );
  }

  onModuleDestroy(): void {
    this.off?.();
  }

  /** Resolves when the snapshot before the thread's current run is taken, or after `START_WAIT_MS`: asked just before pi gets the prompt. */
  whenStarted(threadId: string): Promise<void> {
    const pending = this.starting.get(threadId);
    return pending ? Promise.race([pending.done, pending.deadline]) : Promise.resolve();
  }

  /** The folder's private snapshot repository; `undefined` outside a git work tree (asked again next time: the user may initialise one). */
  async shadow(folder: string): Promise<ShadowRepo | undefined> {
    let pending = this.shadows.get(folder);
    if (!pending) {
      pending = ShadowRepo.open(folder, this.config.dataDir, this.registry);
      this.shadows.set(folder, pending);
    }
    const shadow = await pending.catch(() => undefined);
    if (!shadow) this.shadows.delete(folder);
    return shadow;
  }

  /**
   * The files the thread changed in `folder`, each with the snapshot from before the first run that changed it, and the folder now. `undefined`
   * when the folder has no snapshots.
   */
  async threadChanges(
    threadId: string,
    folder: string,
  ): Promise<{ shadow: ShadowRepo; now: string; files: ThreadChange[] } | undefined> {
    const shadow = await this.shadow(folder);
    if (!shadow) return undefined;
    const now = await this.now(shadow);
    return { shadow, now, files: await this.firstChanges(threadId, folder, async () => now) };
  }

  /**
   * The files the thread's runs (and its background agents) changed, each read in the folder it worked in (a worktree that is gone keeps its
   * snapshots): what the score and the attribution of a commit need. Nothing is captured except for work that is still going.
   */
  runChanges(threadId: string): Promise<ThreadChange[]> {
    return this.firstChanges(threadId, undefined, (shadow) => this.now(shadow), false);
  }

  /**
   * Each file the thread's runs and agents (in `folder`, or anywhere) changed, with the run that changed it first. A run without its end snapshot
   * ends where the next one in its folder starts; else, still going or with `toNow`, at the folder now (`now`), or it is left out. Work whose
   * snapshots are gone (pruned after 30 days, or an object git removed) is left out.
   */
  private async firstChanges(
    threadId: string,
    folder: string | undefined,
    now: (shadow: ShadowRepo) => Promise<string>,
    toNow = true,
  ): Promise<ThreadChange[]> {
    // Work that just ended may still be taking its end snapshot: what it changed is known once that is done.
    const spans = this.spansOf(threadId);
    await Promise.all(spans.flatMap((span) => this.ending.get(span.key) ?? []));
    const files = new Map<string, ThreadChange>();
    for (const span of this.spansOf(threadId)) {
      if (!span.folder || !span.startTree || (folder !== undefined && span.folder !== folder)) continue;
      const shadow = await this.shadowOf(span);
      if (!shadow) continue;
      const end = span.endTree ?? (span.open || toNow ? await now(shadow) : undefined);
      if (!end) continue;
      for (const change of await this.changesOf(shadow, span.startTree, end, span.endTree !== undefined)) {
        if (!files.has(change.path))
          files.set(change.path, {
            path: change.path,
            before: span.startTree,
            ...(span.run ? { run: span.run } : {}),
            at: span.startedAt,
            status: change.status,
          });
      }
    }
    return [...files.values()];
  }

  /** The thread's runs and the stretches of work of its background agents, oldest first. */
  private spansOf(threadId: string): Span[] {
    const runs = this.log.runsOf(threadId);
    const ofRuns = runs.map((run, i): Span => ({
      ...run,
      key: run.runId,
      endTree:
        run.endTree ??
        runs.slice(i + 1).find((next) => next.folder === run.folder && next.startTree)?.startTree ??
        undefined,
      open: run.status === 'running',
      run: i + 1,
    }));
    const ofAgents = (this.agentSpans?.ofThread(threadId) ?? []).map((span): Span => ({
      ...span,
      key: agentKey(span.id),
      endTree: span.endTree ?? undefined,
      open: span.endTree === null,
    }));
    return [...ofRuns, ...ofAgents].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The repository a span's snapshots are in: opened from its folder, or, when the folder is gone, from where the span said it was. */
  private async shadowOf(span: Pick<Span, 'folder' | 'shadowDir' | 'shadowPrefix'>): Promise<ShadowRepo | undefined> {
    const open = span.folder ? await this.shadow(span.folder) : undefined;
    if (open) return open;
    return span.shadowDir
      ? ShadowRepo.stored({ dir: span.shadowDir, prefix: span.shadowPrefix ?? '' }, this.registry)
      : undefined;
  }

  /**
   * A background agent of the thread is about to work in `folder` (the thread's, not a worktree of its own): the folder is snapshotted first, so
   * what the agent changes is the thread's. Waits `START_WAIT_MS` at most; a snapshot that takes longer is not kept.
   */
  async agentStarted(agentId: string, threadId: string, folder: string): Promise<void> {
    const spans = this.agentSpans;
    if (!spans) return;
    const deadline = startDeadline();
    // When the work began, as for a run: the order of first changes compares it with runs' starts.
    const startedAt = Date.now();
    const capture = (async () => {
      // A follow-up right after the agent finished: its previous stretch may still be taking its end snapshot.
      const previous = spans.open(agentId);
      if (previous) await this.ending.get(agentKey(previous.id));
      if (spans.open(agentId)) return;
      const shadow = await this.shadow(folder);
      if (!shadow) return;
      const tree = await this.fresh(shadow);
      if (deadline.passed())
        return this.logger.warn(`The snapshot of ${folder} took longer than agent ${agentId} waited for it.`);
      spans.start({
        agentId,
        threadId,
        folder,
        shadowDir: shadow.location.dir,
        shadowPrefix: shadow.location.prefix,
        startTree: tree,
        startedAt,
      });
    })().catch((error: unknown) => this.logger.warn(`Snapshot before agent ${agentId}: ${message(error)}`));
    await Promise.race([capture, deadline.reached]);
  }

  /** The agent stopped working (done, failed, stopped): the folder is snapshotted, and the panels are told what the agent changed. */
  agentEnded(agentId: string): void {
    const spans = this.agentSpans;
    const span = spans?.open(agentId);
    if (!spans || !span) return;
    const pending = (async () => {
      const shadow = await this.shadowOf(span);
      if (!shadow) return;
      const end = await this.fresh(shadow);
      spans.end(span.id, end, Date.now());
      this.folderChanges.publish(
        span.folder,
        batchOf((await this.changesOf(shadow, span.startTree, end, true)).map((c) => c.path)),
      );
    })().catch((error: unknown) => this.logger.warn(`Snapshot after agent ${agentId}: ${message(error)}`));
    this.track(this.ending, agentKey(span.id), pending);
  }

  /** The folder was just changed by pi-kit itself (a revert): the next request captures it again. */
  forgetNow(): void {
    this.nows.clear();
  }

  /** A capture before or after a run: a "now" taken earlier is older than it, so the next request captures again. */
  private fresh(shadow: ShadowRepo): Promise<string> {
    this.nows.delete(shadow);
    return shadow.capture();
  }

  /** The folder as it is now, captured at most once per `NOW_REUSE_MS`. */
  private now(shadow: ShadowRepo): Promise<string> {
    const recent = this.nows.get(shadow);
    if (recent && Date.now() - recent.at < NOW_REUSE_MS) return recent.tree;
    const tree = shadow.capture();
    this.nows.set(shadow, { at: Date.now(), tree });
    tree.catch(() => this.nows.delete(shadow));
    return tree;
  }

  /** What changed between two trees; `[]` when a tree is gone. Pairs of stored trees never change, so the newest are kept. */
  private async changesOf(shadow: ShadowRepo, from: string, to: string, keep: boolean): Promise<FileChange[]> {
    const read = (): Promise<FileChange[]> =>
      shadow.changes(from, to).catch((error: unknown) => {
        this.logger.debug(`Snapshot ${from}..${to} is gone: ${message(error)}`);
        return [];
      });
    if (!keep) return read();
    // The same trees read from another folder of the repository give other (relative) paths.
    const key = `${shadow.location.dir}|${shadow.location.prefix}|${from}..${to}`;
    let pending = this.changed.get(key);
    if (pending) {
      // Most recently used last: the oldest goes first when the cache is full.
      this.changed.delete(key);
    } else {
      pending = read();
      if (this.changed.size >= MAX_CACHED_CHANGES) this.changed.delete(this.changed.keys().next().value as string);
    }
    this.changed.set(key, pending);
    return pending;
  }

  private started(threadId: string): void {
    const run = this.log.lastRun(threadId);
    if (!run) return;
    // pi is already working (a turn it started by itself, not one we prompted): a capture now would already hold its first edits. The folder
    // as the thread's previous run left it is the "before" then.
    const already = !!this.sessions?.has(threadId) && this.sessions.isStreaming(threadId);
    const deadline = startDeadline();
    const capture = async (folder: string): Promise<void> => {
      const shadow = await this.shadow(folder);
      if (already) {
        // The previous run may still be taking its end snapshot, which is this run's "before".
        const others = this.log.runsOf(threadId).filter((r) => r.runId !== run.runId);
        await Promise.all(others.flatMap((r) => this.ending.get(r.runId) ?? []));
        const previous = this.log
          .runsOf(threadId)
          .filter((r) => r.runId !== run.runId && r.folder === folder && r.endTree)
          .at(-1);
        this.log.setStartTree(run.runId, folder, previous?.endTree ?? null, shadow?.location);
        return;
      }
      const tree = shadow ? await this.fresh(shadow) : null;
      const late = deadline.passed();
      if (late)
        this.logger.warn(
          `The snapshot of ${folder} took longer than the run waited for it: run ${run.runId} has no "before".`,
        );
      this.log.setStartTree(run.runId, folder, late ? null : tree, shadow?.location);
    };
    const failed = (error: unknown): void => this.logger.warn(`Snapshot before run ${run.runId}: ${message(error)}`);
    const row = this.threads.get(threadId);
    // A thread this request creates has no row yet: it appears while the run prepares the thread, before pi gets the prompt (`whenStarted` is
    // asked then). It is snapshotted as soon as it is there.
    const done = (
      row
        ? capture(workFolderOf(row))
        : this.rowOf(threadId).then((found) => (found ? capture(workFolderOf(found)) : undefined))
    ).catch(failed);
    const entry = { done, deadline: deadline.reached };
    this.starting.set(threadId, entry);
    void done.finally(() => {
      if (this.starting.get(threadId) === entry) this.starting.delete(threadId);
    });
  }

  /** The thread's row, once it exists (a thread the run itself creates); `undefined` after `START_WAIT_MS`. */
  private async rowOf(threadId: string): Promise<ThreadRow | undefined> {
    for (let waited = 0; waited < START_WAIT_MS; waited += ROW_POLL_MS) {
      const row = this.threads.get(threadId);
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, ROW_POLL_MS).unref());
    }
    return this.threads.get(threadId);
  }

  /** Keeps `pending` under `runId` until it settles. */
  private track(map: Map<string, Promise<void>>, runId: string, pending: Promise<void>): void {
    map.set(runId, pending);
    void pending.finally(() => {
      if (map.get(runId) === pending) map.delete(runId);
    });
  }

  private ended(threadId: string): void {
    const runId = this.log.lastRun(threadId)?.runId;
    if (!runId) return;
    // This run's own start snapshot (the next run cannot start before this one ended): a turn that follows waits for this end, not the reverse.
    const started = this.starting.get(threadId)?.done;
    const pending = (async () => {
      await started;
      const run = this.log.runsOf(threadId).find((r) => r.runId === runId);
      if (!run?.folder) return;
      const shadow = await this.shadow(run.folder);
      if (!shadow) return this.folderChanges.publish(run.folder, allChanged());
      const end = await this.fresh(shadow);
      this.log.setEndTree(runId, end);
      // Without a "before" the run's files are unknown: everything is read again.
      if (!run.startTree) return this.folderChanges.publish(run.folder, allChanged());
      this.folderChanges.publish(
        run.folder,
        batchOf((await this.changesOf(shadow, run.startTree, end, true)).map((c) => c.path)),
      );
    })().catch((error: unknown) => this.logger.warn(`Snapshot after run ${runId}: ${message(error)}`));
    this.track(this.ending, runId, pending);
  }
}

const agentKey = (id: number): string => `agent:${id}`;

/** The wait for a snapshot before work starts: `reached` resolves after `START_WAIT_MS`, and `passed()` tells a capture that finished later. */
function startDeadline(): { reached: Promise<void>; passed: () => boolean } {
  let passed = false;
  const reached = new Promise<void>((resolve) =>
    setTimeout(() => {
      passed = true;
      resolve();
    }, START_WAIT_MS).unref(),
  );
  return { reached, passed: () => passed };
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
