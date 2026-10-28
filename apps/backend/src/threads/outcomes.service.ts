import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ThreadOutcome } from '@pi-kit/protocol';
import { EventLogRepository } from '../db/event-log.repository';
import { OutcomesRepository } from '../db/outcomes.repository';
import { type ThreadRow, ThreadsRepository } from '../db/threads.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { RunSnapshotsService } from '../snapshots/run-snapshots.service';
import { FolderChangesService, headChanged } from '../folder-changes/folder-changes.service';
import * as wt from '../worktree/worktree-git';
import { attribute, type Candidate, EMPTY_TREE, type Incoming, isCommitSubject, nextOutcome } from './outcome-rules';
import { HeadWatcher } from './head-watcher';
import { ThreadStatusService } from './thread-status.service';
import { workFolderOf } from './work-folder';

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** A commit counts for a thread that touched a file up to this long after the commit's (whole-second) timestamp: a clock's rounding, not a later edit. */
const COMMIT_CLOCK_SLACK_MS = 1500;
/** The `HEAD` remembered for a repository that has no commit yet: its first commit is a move from here. */
const NO_COMMIT = '';
/** The commits of one move of `HEAD` that are looked at (a rebase of a long branch is one move). */
const MAX_COMMITS_PER_MOVE = 50;

/**
 * How threads end: the base commit a thread starts from, and the outcome it reaches. `merged` and `pr` come from the worktree
 * service; `committed` from `HEAD` moving after a commit made in a terminal: the new commits' files are matched against the files each thread of
 * the folder changed in its runs (`RunSnapshotsService`) by `attribute()`. The folder opened last is watched (`HeadWatcher`); any other folder is
 * compared with the `HEAD` last seen when one of its threads runs or is opened.
 */
@Injectable()
export class OutcomesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutcomesService.name);
  /** The `HEAD` each tracked folder was on when it was last looked at. */
  private readonly heads = new Map<string, string>();
  private readonly headWatcher = new HeadWatcher((folder) => this.enqueue(folder, () => this.headMoved(folder)));
  private readonly starting = new Map<string, Promise<void>>();
  /** Counts `track` calls: only the newest one moves the watch. */
  private tracked = 0;
  /** One folder's work at a time, in order. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Commits pi-kit made itself (the merge commit of a merge back): they are the worktree's outcome, not a terminal commit. */
  private readonly own = new Set<string>();
  private excluded: ((threadId: string) => boolean) | undefined;
  private estimating = false;
  private offRun: (() => void) | undefined;
  private readonly outcomeListeners = new Set<
    (threadId: string, kind: ThreadOutcome['kind'], firstTime: boolean) => void
  >();

  constructor(
    private readonly threads: ThreadsRepository,
    private readonly outcomes: OutcomesRepository,
    private readonly events: EventLogRepository,
    private readonly sessions: PiSessionService,
    private readonly folderChanges: FolderChangesService,
    private readonly status: ThreadStatusService,
    private readonly snapshots: RunSnapshotsService,
  ) {}

  onModuleInit(): void {
    // A run's start and end compare its folder with the `HEAD` last seen: a commit made meanwhile in a terminal is found then.
    this.offRun = this.events.onRunChange((threadId) => {
      const row = this.threads.get(threadId);
      if (row) void this.remember(workFolderOf(row));
    });
  }

  onModuleDestroy(): void {
    this.offRun?.();
    this.headWatcher.stop();
  }

  /** Told whenever an outcome is written (`firstTime`: the thread had none before). The learning service uses it to draft a skill; a listener's failure is its own. */
  onOutcome(listener: (threadId: string, kind: ThreadOutcome['kind'], firstTime: boolean) => void): () => void {
    this.outcomeListeners.add(listener);
    return () => this.outcomeListeners.delete(listener);
  }

  // ---- reads

  /** The whole outcome of a thread, or `undefined`. */
  get(threadId: string): ThreadOutcome | undefined {
    const row = this.outcomes.get(threadId);
    const thread = this.threads.get(threadId);
    if (!row || !thread) return undefined;
    return {
      kind: row.kind,
      base: row.baseCommit,
      head: row.headCommit,
      merge: row.mergeCommit,
      prUrl: row.prUrl,
      at: row.at,
      files: row.files,
      baseBranch: thread.baseBranch,
      baseSource: thread.baseSource === 'start' || thread.baseSource === 'estimated' ? thread.baseSource : null,
    };
  }

  /** The two commits the Outcome source of review mode compares, if the thread has an outcome. */
  range(threadId: string): { base: string; head: string } | undefined {
    const row = this.outcomes.get(threadId);
    return row && { base: row.baseCommit, head: row.headCommit };
  }

  // ---- the base commit

  /** `HEAD` of a folder, in full; `null` outside a repository or before the first commit. */
  async headOf(folder: string): Promise<string | null> {
    if (!existsSync(folder)) return null;
    const result = await wt.run(folder, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return result.ok ? result.stdout.trim() || null : null;
  }

  /** A thread that has not had a message yet starts from `HEAD` as it is now, however long ago it was created. */
  async refreshBase(row: ThreadRow): Promise<void> {
    if (row.messageCount > 0 || row.baseSource === 'estimated') return;
    const head = await this.headOf(workFolderOf(row));
    if (head !== row.baseCommit) this.threads.setBase(row.id, head, head ? 'start' : 'none');
  }

  /**
   * Best effort for a thread that began before the base was kept: the newest commit older than its first message (`git rev-list -1 --before`), looked
   * for once and recorded, found or not. A folder that is not there right now is left for a later pass.
   */
  async estimateBases(): Promise<void> {
    if (this.estimating) return;
    this.estimating = true;
    try {
      await this.estimateAll();
    } finally {
      this.estimating = false;
    }
  }

  private async estimateAll(): Promise<void> {
    for (const row of this.threads.all()) {
      if (row.baseSource !== null) continue;
      const folder = workFolderOf(row);
      if (!existsSync(folder)) continue;
      try {
        const inside = await wt.run(folder, ['rev-parse', '--is-inside-work-tree']);
        if (!inside.ok) {
          this.threads.setBase(row.id, null, 'none');
          continue;
        }
        const found = await wt.run(folder, [
          'rev-list',
          '-1',
          `--before=${new Date(row.createdAt).toISOString()}`,
          'HEAD',
        ]);
        const commit = found.ok ? found.stdout.trim() : '';
        this.threads.setBase(row.id, commit || null, commit ? 'estimated' : 'none');
      } catch (error) {
        this.logger.debug(
          `Could not estimate the base of ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // ---- merged and pr (from the worktree service)

  /** A worktree was merged back (`git merge --no-ff`): the merge commit is the thread's outcome, `base..merge` what it landed. */
  async recordMerged(row: ThreadRow, commit: string): Promise<void> {
    const project = row.cwd;
    try {
      const head = await this.resolve(project, commit);
      const base = await this.resolve(project, `${head}^1`);
      if (!head || !base) return;
      // The merge commit and the commits it brought in are this thread's, not a terminal commit the folder watcher should attribute to someone else.
      if (this.own.size > 5000) this.own.clear();
      this.own.add(head);
      const brought = await wt.run(project, ['rev-list', '--max-count=500', `${base}..${head}`]);
      for (const sha of brought.stdout.split('\n').filter(Boolean)) this.own.add(sha);
      await this.put({
        threadId: row.id,
        kind: 'merged',
        base,
        head,
        merge: head,
        at: Date.now(),
        files: await this.filesOf(project, head),
      });
    } catch (error) {
      this.logger.warn(
        `Could not record the merge of ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** `gh pr create` returned a pull request for the thread's branch (checked out in `folder`): the branch tip is the outcome's head. */
  async recordPullRequest(row: ThreadRow, folder: string, url: string): Promise<void> {
    try {
      const head = await this.headOf(folder);
      if (!head) return;
      // What the pull request shows is the branch against where it left the base branch; the thread's own base commit when git cannot say.
      const fork = row.baseBranch ? await wt.run(folder, ['merge-base', row.baseBranch, head]) : undefined;
      const base = (fork?.ok ? fork.stdout.trim() : '') || row.baseCommit;
      if (!base) return;
      await this.put({
        threadId: row.id,
        kind: 'pr',
        base,
        head,
        prUrl: url,
        at: Date.now(),
        files: await this.filesBetween(folder, base, head),
      });
    } catch (error) {
      this.logger.warn(
        `Could not record the pull request of ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---- committed (from HEAD moving)

  /** The folder was opened: its reflog becomes the one watched, and a commit made since its `HEAD` was last seen is found now. */
  async track(folder: string | null | undefined): Promise<void> {
    const ticket = ++this.tracked;
    if (!folder || !(await this.remember(folder))) return;
    // A folder opened meanwhile is the one watched: a slower repository finishing last must not take the watch back.
    if (ticket === this.tracked) this.headWatcher.watch(folder);
  }

  /**
   * Knows the folder's `HEAD` from now on and catches up with commits made since it was last seen; false for a folder whose commits are not
   * looked at: one outside git, a worktree (its `.git` is a file) or a subfolder, whose threads get their outcome from the merge back.
   */
  private remember(folder: string): Promise<boolean> {
    if (this.heads.has(folder)) {
      this.enqueue(folder, () => this.headMoved(folder));
      return Promise.resolve(true);
    }
    const pending = this.starting.get(folder);
    if (pending) return pending.then(() => this.heads.has(folder));
    const start = (async () => {
      try {
        const head = await this.headOf(folder);
        // A repository without a commit yet (just initialised) is known too, so its first commit is seen.
        if (isDirectory(join(folder, '.git')) && !this.heads.has(folder)) this.heads.set(folder, head ?? NO_COMMIT);
      } catch (error) {
        this.logger.debug(
          `Could not read the HEAD of ${folder}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.starting.delete(folder);
      }
    })();
    this.starting.set(folder, start);
    return start.then(() => this.heads.has(folder));
  }

  private enqueue(folder: string, work: () => Promise<void>): void {
    const next = (this.queues.get(folder) ?? Promise.resolve())
      .then(work)
      .catch((error) =>
        this.logger.warn(`Commits in ${folder}: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        if (this.queues.get(folder) === next) this.queues.delete(folder);
      });
    this.queues.set(folder, next);
  }

  /** Resolves when the folder's pending work is done (tests). */
  async idle(): Promise<void> {
    while (this.queues.size > 0 || this.starting.size > 0)
      await Promise.all([...this.queues.values(), ...this.starting.values()]);
  }

  /** `HEAD` of the folder may have moved: if it was a commit (not a checkout or a reset), attribute the new commits one by one. */
  async headMoved(folder: string): Promise<void> {
    const head = await this.headOf(folder);
    const old = this.heads.get(folder);
    if (!head) return;
    this.heads.set(folder, head);
    if (old === undefined || old === head) return;
    // The panels show the folder's git state: a commit, checkout or reset changes it.
    this.folderChanges.publish(folder, headChanged());
    const subject = (await wt.run(folder, ['reflog', '-1', '--format=%gs', 'HEAD'])).stdout.trim();
    if (!isCommitSubject(subject)) return;
    const listed = await wt.run(folder, [
      'rev-list',
      '--reverse',
      `--max-count=${MAX_COMMITS_PER_MOVE}`,
      old === NO_COMMIT ? head : `${old}..${head}`,
    ]);
    const commits = (listed.ok ? listed.stdout.split('\n').filter(Boolean) : [head]).filter(
      (sha) => !this.own.has(sha),
    );
    for (const sha of commits) await this.attributeCommit(folder, sha);
  }

  /** One commit made in `folder`: whose is it? */
  async attributeCommit(folder: string, sha: string): Promise<string | undefined> {
    const files = await this.filesOf(folder, sha);
    if (files.length === 0) return undefined;
    const when = Number((await wt.run(folder, ['log', '-1', '--format=%ct', sha])).stdout.trim()) * 1000 || Date.now();
    const threadId = attribute(files, await this.candidates(folder, when));
    if (!threadId) return undefined;
    const row = this.threads.get(threadId);
    if (!row) return undefined;
    const parent = await this.resolve(folder, `${sha}^`);
    await this.put({
      threadId,
      kind: 'committed',
      base: row.baseCommit ?? parent ?? EMPTY_TREE,
      head: sha,
      at: when,
      files,
    });
    return threadId;
  }

  /** Threads that never get an outcome (a verification run: it replays work, it does not do any). The learning service registers the test. */
  excludeThreads(excluded: ((threadId: string) => boolean) | undefined): void {
    this.excluded = excluded;
  }

  /** The threads that work in the folder, as `attribute()` wants them. A thread that already merged or opened a pull request is not asked: a commit does not replace those. */
  private async candidates(folder: string, commitAt: number): Promise<Candidate[]> {
    const rows = this.threads.all().filter((row) => workFolderOf(row) === folder && !this.excluded?.(row.id));
    const runs = this.events.lastRunByThread();
    const newest = Math.max(0, ...rows.map((row) => runs.get(row.id)?.startedAt ?? 0));
    const out: Candidate[] = [];
    for (const row of rows) {
      const existing = this.outcomes.get(row.id);
      if (existing && existing.kind !== 'committed') continue;
      const lastRunAt = runs.get(row.id)?.startedAt ?? 0;
      const changed = await this.snapshots.runChanges(row.id);
      out.push({
        threadId: row.id,
        touched: new Set(changed.filter((f) => f.at <= commitAt + COMMIT_CLOCK_SLACK_MS).map((f) => f.path)),
        open: this.sessions.has(row.id),
        lastToRun: lastRunAt > 0 && lastRunAt === newest,
        lastRunAt,
      });
    }
    return out;
  }

  // ---- internals

  /** Writes the outcome the rules allow and tells the sidebars. */
  private async put(incoming: Incoming): Promise<void> {
    if (this.excluded?.(incoming.threadId)) return;
    const existing = this.outcomes.get(incoming.threadId);
    const next = nextOutcome(existing, incoming);
    if (!next) return;
    this.outcomes.put(next);
    this.status.touch(incoming.threadId);
    this.logger.log(
      `Thread ${incoming.threadId}: ${next.kind} at ${next.headCommit.slice(0, 7)} (${next.files.length} files)`,
    );
    for (const listener of [...this.outcomeListeners]) {
      try {
        listener(incoming.threadId, next.kind, existing === undefined);
      } catch (error) {
        this.logger.warn(`An outcome listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async resolve(folder: string, rev: string): Promise<string | null> {
    const result = await wt.run(folder, ['rev-parse', '--verify', '--quiet', rev]);
    return result.ok ? result.stdout.trim() || null : null;
  }

  /** The files a commit changed against its first parent (a root commit: against nothing), relative to `folder`. */
  private async filesOf(folder: string, sha: string): Promise<string[]> {
    const parent = (await this.resolve(folder, `${sha}^`)) ?? EMPTY_TREE;
    return this.filesBetween(folder, parent, sha);
  }

  private async filesBetween(folder: string, base: string, head: string): Promise<string[]> {
    const result = await wt.run(folder, [
      'diff-tree',
      '--name-only',
      '-r',
      '-z',
      '--no-renames',
      '--relative',
      base,
      head,
    ]);
    return result.ok ? result.stdout.split('\0').filter(Boolean).sort() : [];
  }
}
