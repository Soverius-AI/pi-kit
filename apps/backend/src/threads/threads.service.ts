import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { buildSessionTree } from '@pi-kit/pi-adapter';
import type { NewLocal, NewWorktree, PatchWorkspace, ThreadDetail, ThreadPlacement, ThreadSummary, WorktreeKeep, Workspace } from '@pi-kit/protocol';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { EventLogRepository } from '../db/event-log.repository';
import { MetaRepository } from '../db/meta.repository';
import { type ThreadRow, ThreadsRepository, type WorktreeFacts } from '../db/threads.repository';
import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { type NewPiSession, type PiThreadInfo, PiSessionService } from '../pi/pi-session.service';
import { WorktreeService } from '../worktree/worktree.service';
import { normalizePrefix } from '../worktree/worktree-paths';
import { currentBranch } from './branch';
import { OutcomesService } from './outcomes.service';
import { sessionMtime } from './session-files';
import { contextPercent, lastAssistantLine, lastContext } from './thread-context';
import { type StateLookups, ThreadStatusService } from './thread-status.service';

export const RECONCILE_INTERVAL_MS = 30_000;

/** What a run needs to know about its thread before pi is opened. */
export interface RunTarget {
  cwd: string;
  sessionPath: string;
  title: string | undefined;
  /** The leaf the app moved to, if the session file has not changed. */
  leafId: string | undefined;
  /** The thread is one of a worktree's: pi opens its session in `cwd` even when the file names another folder (the worktree is gone). */
  inWorktree: boolean;
}

/**
 * The thread list and everything that edits it. `threads` is a cache of pi's
 * session files plus our own flags; `reconcile()` keeps it honest against `SessionManager.listAll()`.
 */
@Injectable()
export class ThreadsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ThreadsService.name);
  private readonly deletedListeners = new Set<(threadId: string) => void>();
  private timer: NodeJS.Timeout | undefined;
  private reconciling: Promise<void> | undefined;
  /** Sessions the pi command line made before the first pass finished are the user's history, not news: they start out seen. */
  private firstPassDone = false;

  constructor(
    private readonly threads: ThreadsRepository,
    private readonly events: EventLogRepository,
    private readonly meta: MetaRepository,
    private readonly sessions: PiSessionService,
    private readonly status: ThreadStatusService,
    private readonly worktrees: WorktreeService,
    private readonly outcomes: OutcomesService,
    @Inject(CONFIG) private readonly config: BackendConfig,
  ) {}

  onApplicationBootstrap(): void {
    // The folder the backend was started in is always offered, even before it has a session.
    this.meta.touchWorkspace(this.config.defaultCwd, 0);
    // Not awaited: listening must not wait for a scan of every session file.
    void this.reconcile();
    // PI_KIT_RECONCILE_MS shortens the pass for the end-to-end tests, which write session files behind the app's back.
    const interval = Number(process.env['PI_KIT_RECONCILE_MS']) || RECONCILE_INTERVAL_MS;
    this.timer = setInterval(() => void this.reconcile(), interval);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ---- reads

  list(options: { workspace?: string; includeArchived?: boolean }): ThreadSummary[] {
    const lookups = this.status.lookups();
    const learning = this.meta.learningThreads();
    return this.threads.list({ cwd: options.workspace, includeArchived: options.includeArchived }).map((row) => this.summary(row, lookups, learning));
  }

  /** The thread, and it counts as opened now. */
  open(id: string): ThreadDetail {
    const row = this.require(id);
    this.threads.touchOpened(id);
    // A commit made in the thread's folder while it is open is its outcome: the folder is watched for it.
    void this.outcomes.track(this.workFolder(row));
    return this.detail(this.threads.get(id) as ThreadRow);
  }

  /** The projects of the sidebar, in its order, each with its folder name, branch, flags and thread count. */
  workspaces(): Workspace[] {
    const counts = new Map<string, number>();
    for (const row of this.threads.list()) counts.set(row.cwd, (counts.get(row.cwd) ?? 0) + 1);
    return this.meta.listWorkspaces().map((w) => ({
      cwd: w.cwd,
      name: w.name,
      lastOpenedAt: w.lastOpenedAt,
      threadCount: counts.get(w.cwd) ?? 0,
      collapsed: w.collapsed,
      hidden: w.hidden,
      attendant: !w.attendantOff,
      agents: !w.agentsOff,
      branch: currentBranch(w.cwd),
      worktree: this.worktrees.settingsOf(w.cwd),
    }));
  }

  /** The user looked at the thread (opened it, or watched a run end in it). */
  markSeen(id: string): void {
    this.require(id);
    this.threads.markSeen(id);
    this.status.touch(id);
  }

  /** A project's sidebar flags (folded, hidden, the attendant's and the background agents' opt-outs) and its worktree settings. */
  patchWorkspace(patch: PatchWorkspace): Workspace[] {
    const found = this.meta.patchWorkspace(patch.cwd, {
      collapsed: patch.collapsed,
      hidden: patch.hidden,
      attendantOff: patch.attendant === undefined ? undefined : !patch.attendant,
      agentsOff: patch.agents === undefined ? undefined : !patch.agents,
    });
    if (!found) throw new NotFoundException(`Workspace ${patch.cwd} is not known.`);
    if (patch.worktree) {
      const w = patch.worktree;
      this.meta.setWorktreeSettings(patch.cwd, {
        root: w.root,
        base: w.base,
        setup: w.setup,
        start: w.start,
        allowSwitch: w.allowBranchSwitch,
        carry: w.carryChanges,
        branchMode: w.branchMode,
        branchPrefix: w.branchPrefix === undefined ? undefined : normalizePrefix(w.branchPrefix),
        remove: w.removeFolder,
        scripts: w.setupScripts,
      });
    }
    this.status.listChanged();
    return this.workspaces();
  }

  /**
   * Forget a project (Settings › Projects): it leaves the sidebar and the list of projects. Its threads, session files and folder stay where they are, and
   * so do its settings; opening the folder again (or a new thread in it) brings it back. A run in the folder has to end first.
   */
  forgetWorkspace(cwd: string): Workspace[] {
    if (!this.meta.listWorkspaces().some((w) => w.cwd === cwd)) throw new NotFoundException(`Workspace ${cwd} is not known.`);
    if (this.list({ workspace: cwd }).some((t) => t.running)) throw new ConflictException('A run is going in this project. Stop it, then forget the project.');
    this.meta.forgetWorkspace(cwd);
    this.status.listChanged();
    return this.workspaces();
  }

  /** The order of the sidebar's project groups. */
  orderWorkspaces(order: string[]): Workspace[] {
    this.meta.orderWorkspaces(order);
    this.status.listChanged();
    return this.workspaces();
  }

  // ---- writes

  /**
   * A new thread in the project's folder, or, with `local`, in the folder on another branch (switched first), or, with `worktree`, in a git worktree
   * of it.
   */
  async create(cwd: string, title?: string, worktree?: NewWorktree, local?: NewLocal, options: { setup?: 'terminal' | 'skip'; onId?: (threadId: string) => void } = {}): Promise<ThreadDetail> {
    this.requireDirectory(cwd);
    const id = randomUUID();
    // The caller learns the id before the thread exists (a verification run marks it as one before anything can look at it).
    options.onId?.(id);
    // The branch is switched before anything else is made; a refusal (dirty folder, held branch) leaves nothing behind.
    if (local) {
      await this.worktrees.switchLocal(cwd, local);
      this.worktrees.runLocalSetup(cwd, local.setup);
    }
    const facts: WorktreeFacts | undefined = worktree ? await this.worktrees.create(cwd, { threadId: id, ...(title ? { title } : {}), request: worktree, ...(options.setup ? { setup: options.setup } : {}) }) : undefined;
    let session: NewPiSession;
    try {
      session = await this.sessions.createSession(facts?.path ?? cwd, id);
    } catch (error) {
      if (facts) await this.worktrees.discard(facts);
      throw error;
    }
    // Where the thread starts from: HEAD of the folder it works in; for a worktree its HEAD, which is the base branch's tip.
    const baseCommit = await this.outcomes.headOf(facts?.path ?? cwd);
    this.threads.insertDraft({ id: session.id, sessionPath: session.path, cwd: facts?.path ?? cwd, title, baseCommit, ...(facts ? { worktree: facts } : {}) });
    void this.outcomes.track(facts?.path ?? cwd);
    this.meta.touchWorkspace(cwd);
    this.status.listChanged();
    return this.detail(this.threads.get(session.id) as ThreadRow);
  }

  /**
   * Says where a thread that has no message yet runs (the Where row of the new-thread page): the folder on another branch, or a worktree. The empty thread
   * exists already when its page opens, so the choice is applied to it at the first Send: a worktree is made, the pi session is created again in its folder (pi keeps
   * a session under its folder), and the row moves there. A thread that has begun cannot move this way: that is a hand off.
   */
  async place(id: string, placement: ThreadPlacement): Promise<ThreadDetail> {
    const row = this.require(id);
    if (row.messageCount > 0 || existsSync(row.sessionPath) || row.worktreePath || row.origin !== 'app') {
      throw new ConflictException('This thread has begun, so its folder is fixed. Hand it off from the thread menu instead.');
    }
    if (this.events.lastRun(id)?.status === 'running') throw new ConflictException('A run has started in this thread.');
    const cwd = row.cwd;
    if (placement.local) {
      await this.worktrees.switchLocal(cwd, placement.local);
      this.worktrees.runLocalSetup(cwd, placement.local.setup);
    }
    if (placement.worktree) {
      const facts = await this.worktrees.create(cwd, { threadId: id, ...(row.title ? { title: row.title } : {}), request: placement.worktree });
      let session: NewPiSession;
      try {
        this.sessions.dispose(id);
        session = await this.sessions.createSession(facts.path, id);
      } catch (error) {
        await this.worktrees.discard(facts);
        throw error;
      }
      this.threads.relocateDraft(id, { sessionPath: session.path, worktree: facts });
      this.threads.setBase(id, await this.outcomes.headOf(facts.path), 'start');
      void this.outcomes.track(facts.path);
    } else if (placement.local) {
      // The checkout moved: the base the outcome is measured from is the branch's tip now.
      this.threads.setBase(id, await this.outcomes.headOf(cwd), 'start');
    }
    this.status.listChanged();
    this.status.touch(id);
    return this.detail(this.threads.get(id) as ThreadRow);
  }

  async patch(id: string, patch: { title?: string; pinned?: boolean; archived?: boolean; worktree?: WorktreeKeep }): Promise<ThreadDetail> {
    const row = this.require(id);
    // Archiving can take the thread's worktree with it; a worktree with uncommitted changes is not removed unasked (409 before anything changes).
    if (patch.archived === true && patch.worktree === 'remove' && row.worktreePath) await this.worktrees.remove(row, { force: false });
    if (patch.title !== undefined && patch.title !== row.title) {
      const before = sessionMtime(row.sessionPath);
      // pi gets the name too, so `pi --resume` shows it. Without a file yet, it waits in our row.
      await this.sessions.setName(id, row.sessionPath, patch.title);
      // Our own write is not an external change: keep the replay log valid across it.
      const after = sessionMtime(row.sessionPath);
      if (before !== null && after !== null && row.logMtime !== null && row.logMtime >= before) {
        this.threads.setLogMtime(id, after);
      }
    }
    this.threads.update(id, { title: patch.title, pinned: patch.pinned, archived: patch.archived });
    this.status.listChanged();
    this.status.touch(id);
    return this.detail(this.threads.get(id) as ThreadRow);
  }

  /** Deletes the thread and its session file. A thread's worktree stays unless asked (`remove`, only when clean; `force`, whatever it holds). */
  async remove(id: string, worktree: WorktreeKeep | 'force' = 'keep'): Promise<void> {
    const row = this.require(id);
    if (this.events.lastRun(id)?.status === 'running') {
      throw new ConflictException('Stop the run before deleting the thread.');
    }
    if (row.worktreePath && worktree !== 'keep') await this.worktrees.remove(row, { force: worktree === 'force' });
    this.sessions.dispose(id);
    const how = this.sessions.trashSession(row.sessionPath);
    this.forget(id);
    this.status.listChanged();
    this.logger.log(`Deleted thread ${id} (${how})`);
  }

  /** The one way a thread leaves the database, for a delete and for a session file that vanished: its rows, then the listeners (background agents). */
  private forget(id: string): void {
    this.threads.delete(id);
    this.status.gone(id);
    for (const listener of [...this.deletedListeners]) listener(id);
  }

  /** Called after a thread was deleted (its background agents go with it). */
  onDeleted(listener: (threadId: string) => void): () => void {
    this.deletedListeners.add(listener);
    return () => this.deletedListeners.delete(listener);
  }

  /** The whole history into a new thread, or, with `entryId`, only the path from the root to that entry (the tree's "Fork to new thread"). */
  async fork(id: string, options: { cwd?: string; entryId?: string } = {}): Promise<ThreadDetail> {
    if (options.entryId) return this.clone(id, options.entryId);
    const targetCwd = options.cwd;
    const row = this.require(id);
    const cwd = targetCwd ?? row.cwd;
    this.requireDirectory(cwd);
    if (!existsSync(row.sessionPath)) throw new ConflictException('This thread has no messages to fork yet.');
    return this.adopt(await this.sessions.forkSession(row.sessionPath, cwd), row);
  }

  async clone(id: string, entryId?: string): Promise<ThreadDetail> {
    const row = this.require(id);
    if (!existsSync(row.sessionPath)) throw new ConflictException('This thread has no messages to clone yet.');
    try {
      return await this.adopt(await this.sessions.cloneSession(row.sessionPath, entryId), row);
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) throw new NotFoundException(error.message);
      throw error;
    }
  }

  /**
   * `/import`: the history of a session file anywhere on disk becomes a new thread in `cwd`. pi's own import copies the
   * file under its old session id, which would be a second thread with the same id here; a fork writes a new session in
   * `cwd`'s session folder with a fresh id and keeps the source as its parent.
   */
  async importFrom(path: string, cwd: string): Promise<ThreadDetail> {
    this.requireDirectory(cwd);
    if (!existsSync(path) || !statSync(path).isFile()) throw new BadRequestException(`There is no session file at ${path}.`);
    try {
      return await this.adopt(await this.sessions.forkSession(path, cwd), { sessionPath: path });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(`That file is not a pi session: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** `POST /api/workspaces`: a folder the user opened becomes a known workspace. */
  addWorkspace(cwd: string): void {
    this.requireDirectory(cwd);
    this.meta.touchWorkspace(cwd);
    this.status.listChanged();
  }

  private async adopt(session: NewPiSession, source: Pick<ThreadRow, 'sessionPath'>): Promise<ThreadDetail> {
    this.threads.insertDraft({
      id: session.id,
      sessionPath: session.path,
      cwd: session.cwd,
      parentSessionPath: source.sessionPath,
      baseCommit: await this.outcomes.headOf(session.cwd),
    });
    this.meta.touchWorkspace(session.cwd);
    // pi has written the file already; pick up its counts, name and preview.
    await this.reconcile();
    return this.detail(this.threads.get(session.id) as ThreadRow);
  }

  // ---- sessions

  /**
   * Opens the thread's pi session (extensions loaded, MCP servers connecting) without running anything: the
   * command list, the model picker and the token meter need it before the first prompt.
   */
  async openSession(id: string): Promise<PiThreadInfo> {
    const row = this.require(id);
    const target = await this.prepareRun(id, row.cwd, { open: true });
    const info = await this.sessions.open(id, {
      cwd: target.cwd,
      sessionPath: target.sessionPath,
      title: target.title,
      leafId: target.leafId,
      ...(target.inWorktree ? { forceCwd: true } : {}),
    });
    this.sessionOpened(id, info);
    return info;
  }

  /** Throws a 404 for a thread the app does not know. */
  assertExists(id: string): void {
    this.require(id);
  }

  /** The folder the thread works in, if the thread exists: its worktree while it has one, else the project's folder. */
  cwdOf(id: string): string {
    return this.workFolder(this.require(id));
  }

  /** The worktree folders of the threads of a project (a trust answer for the project reaches them). */
  worktreeFoldersOf(project: string): string[] {
    return [...new Set(this.threads.all().filter((row) => row.cwd === project && row.worktreePath).map((row) => row.worktreePath as string))];
  }

  /** The project's folder the thread is listed under (the main checkout for a thread in a worktree). */
  projectOf(id: string): string {
    return this.require(id).cwd;
  }

  /** Where pi runs for the row: the worktree folder while it exists; a worktree that was deleted by hand is forgotten and the project's folder takes over. */
  private workFolder(row: ThreadRow): string {
    if (row.worktreePath && !existsSync(row.worktreePath)) {
      this.threads.clearWorktree(row.id);
      this.sessions.dispose(row.id);
      return row.cwd;
    }
    return row.worktreePath ?? row.cwd;
  }

  /** The thread's pi session file (it may not exist yet for a thread without messages). */
  sessionPathOf(id: string): string {
    return this.require(id).sessionPath;
  }

  // ---- the session tree

  /** The session's entries and leaf for the graph; the thread's open session if there is one, else its file. */
  async treeSource(id: string): Promise<{ entries: PiSessionEntry[]; leafId: string | null; path: string | undefined }> {
    const row = this.require(id);
    const valid = row.leafId !== null && row.leafMtime !== null && sessionMtime(row.sessionPath) === row.leafMtime;
    const source = await this.sessions.treeSource(id, row.sessionPath, valid ? (row.leafId ?? undefined) : undefined);
    const tree = buildSessionTree(source.entries, source.leafId);
    this.threads.setForkCount(id, tree.forks, sessionMtime(row.sessionPath));
    return source;
  }

  // ---- runs

  /**
   * Called when a run starts. A thread id the app has not seen (a client that makes up its own, or
   * `curl`) becomes a thread in `cwdHint`, with that id as its pi session id.
   */
  async prepareRun(threadId: string, cwdHint: string, options: { open?: boolean } = {}): Promise<RunTarget> {
    let row = this.threads.get(threadId);
    // A verification run is kept as a record after its scratch worktree is removed; without the worktree a run would fall back to the project's folder, which a verification never touches.
    if (row && !options.open && this.meta.isVerificationThread(threadId) && (!row.worktreePath || !existsSync(row.worktreePath))) {
      throw new ConflictException('This thread replayed a skill in a scratch worktree that is removed now, so it cannot run again. It stays as the record of that run.');
    }
    if (!row) {
      this.requireDirectory(cwdHint);
      const session = await this.sessions.createSession(cwdHint, threadId);
      this.threads.insertDraft({ id: session.id, sessionPath: session.path, cwd: cwdHint, baseCommit: await this.outcomes.headOf(cwdHint) });
      this.meta.touchWorkspace(cwdHint);
      row = this.threads.get(threadId) as ThreadRow;
    } else {
      // A thread that had no message yet starts from the folder as it is when the work begins, not as it was when the empty thread was made.
      await this.outcomes.refreshBase(row);
    }
    void this.outcomes.track(this.workFolder(row));
    // pi persists a leaf only by appending an entry; the one the app moved to counts while the file is as we left it.
    const leafValid = row.leafId !== null && row.leafMtime !== null && sessionMtime(row.sessionPath) === row.leafMtime;
    return {
      cwd: this.workFolder(row),
      sessionPath: row.sessionPath,
      title: row.title ?? undefined,
      leafId: leafValid ? (row.leafId ?? undefined) : undefined,
      inWorktree: this.workFolder(row) !== row.sessionCwd,
    };
  }

  /** pi may put a session that did not exist yet at a different path than the one we computed earlier. */
  sessionOpened(threadId: string, info: PiThreadInfo): void {
    const row = this.threads.get(threadId);
    if (row && info.sessionFile && info.sessionFile !== row.sessionPath) {
      this.threads.setSessionPath(threadId, info.sessionFile);
    }
  }

  // ---- reconcile

  /** One pass at a time; a call during a pass joins it. */
  reconcile(): Promise<void> {
    this.reconciling ??= this.runReconcile()
      .catch((error) => this.logger.warn(`Reconcile failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => (this.reconciling = undefined));
    return this.reconciling;
  }

  private async runReconcile(): Promise<void> {
    const started = Date.now();
    // Only files that are new or moved since the last pass were read; the rest is the index's memory.
    const scan = await this.sessions.scanSessions();
    const infos = scan.all;
    const seen = new Set<string>();
    let added = 0;
    const lastOpened = new Map<string, number>();
    const changed = new Set(scan.changed);
    // A worktree is not a project: its sessions count for the project it belongs to.
    const projectOfFolder = new Map<string, string>();
    for (const row of this.threads.all()) {
      if (row.sessionCwd !== row.cwd) projectOfFolder.set(row.sessionCwd, row.cwd);
      if (row.worktreePath) projectOfFolder.set(row.worktreePath, row.cwd);
    }
    for (const info of infos) {
      seen.add(info.id);
      const project = projectOfFolder.get(info.cwd) ?? info.cwd;
      lastOpened.set(project, Math.max(lastOpened.get(project) ?? 0, info.modified));
      if (!changed.has(info)) continue;
      const result = this.threads.upsertFromSession(
        {
          id: info.id,
          sessionPath: info.path,
          cwd: info.cwd,
          title: info.name,
          preview: info.firstMessage,
          parentSessionPath: info.parentSessionPath,
          messageCount: info.messageCount,
          createdAt: info.created,
          updatedAt: info.modified,
        },
        this.firstPassDone ? null : Date.now(),
      );
      if (result === 'inserted') added += 1;
    }
    for (const [cwd, at] of lastOpened) this.meta.touchWorkspace(cwd, at, { passive: true });

    // A session file that vanished (deleted with the CLI, say) takes its thread with it. A thread
    // that never had a file is a draft and stays.
    let removed = 0;
    for (const row of this.threads.all()) {
      if (seen.has(row.id) || existsSync(row.sessionPath)) continue;
      if (row.messageCount === 0 && row.origin === 'app') continue;
      if (this.events.lastRun(row.id)?.status === 'running') continue;
      this.forget(row.id);
      removed += 1;
    }
    if (added || removed || scan.read > 0) {
      this.logger.log(`Reconciled ${infos.length} sessions in ${Date.now() - started} ms (read ${scan.read}, +${added}, -${removed})`);
    }
    // Threads and projects are in the table now: tell the sidebars before the slower measuring below (a first pass over many sessions takes a while).
    if (added || removed || scan.read > 0) this.status.listChanged();
    await this.refreshForkCountsAndContexts();
    this.firstPassDone = true;
    // The file facts of many threads may have moved (a message count, a change from the CLI, a context share): push what changed.
    this.status.touchAll();
    // Worktree folders that were left for a week after a hand off go when they are due (Remove the folder: after 7 days).
    void this.worktrees.sweep().catch((error) => this.logger.warn(`Worktree sweep: ${error instanceof Error ? error.message : String(error)}`));
    // A thread that began before the base commit was kept gets an estimate, once: in the background, one git call at a time.
    void this.outcomes.estimateBases().catch((error) => this.logger.warn(`Base commits: ${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * The sidebar's "N forks" needs the tree of every thread, which the session list does not carry, and its context gauge needs the last response
   * of every thread: both come from one read of the session file. A file is read again only when it changed since its numbers were
   * made, one at a time with a breather in between so a first pass over many sessions does not hold up requests. An open session keeps its own
   * numbers current (runs, navigation) and pi knows its context.
   */
  private async refreshForkCountsAndContexts(): Promise<void> {
    for (const row of this.threads.all()) {
      const mtime = sessionMtime(row.sessionPath);
      if (mtime === null) continue;
      const forksCurrent = row.forkCountAt === mtime;
      const contextCurrent = row.contextAt === mtime;
      const lineCurrent = row.lastLineAt === mtime;
      if (forksCurrent && contextCurrent && lineCurrent) continue;
      if (this.sessions.has(row.id)) {
        if (!contextCurrent) this.threads.setContext(row.id, this.sessions.contextShare(row.id), mtime);
        if (!lineCurrent) {
          const tree = this.sessions.openTree(row.id);
          if (tree) this.threads.setLastLine(row.id, lastAssistantLine(tree.entries, tree.leafId), mtime);
        }
        continue;
      }
      try {
        const source = await this.sessions.treeSource(row.id, row.sessionPath);
        if (!forksCurrent) this.threads.setForkCount(row.id, buildSessionTree(source.entries, source.leafId).forks, mtime);
        if (!contextCurrent) {
          const sample = lastContext(source.entries, source.leafId);
          const pct = sample ? contextPercent(sample.tokens, await this.sessions.modelWindow(sample.provider, sample.model)) : null;
          this.threads.setContext(row.id, pct, mtime);
        }
        if (!lineCurrent) this.threads.setLastLine(row.id, lastAssistantLine(source.entries, source.leafId), mtime);
      } catch (error) {
        this.logger.warn(`Fork count and context of ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        this.threads.setForkCount(row.id, row.forkCount, mtime);
        this.threads.setContext(row.id, row.contextPct, mtime);
        this.threads.setLastLine(row.id, row.lastLine, mtime);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // ---- mapping

  private summary(row: ThreadRow, lookups?: StateLookups, learning = this.meta.learningThreads()): ThreadSummary {
    const parent = row.parentSessionPath ? this.threads.getBySessionPath(row.parentSessionPath) : undefined;
    const state = this.status.stateOf(row, lookups);
    const sourceThreadId = learning[row.id];
    return {
      id: row.id,
      cwd: row.cwd,
      title: row.title,
      preview: row.preview,
      lastLine: row.lastLine,
      pinned: row.pinned,
      archived: row.archived,
      origin: row.origin,
      messageCount: row.messageCount,
      running: state.activity === 'running',
      waiting: state.activity === 'waiting',
      lastRun: state.lastRun,
      parentThreadId: parent?.id ?? null,
      ...(sourceThreadId ? { learning: { sourceThreadId } } : {}),
      ...(this.worktrees.describe(row) ? { worktree: this.worktrees.describe(row) } : {}),
      forkCount: row.forkCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastOpenedAt: row.lastOpenedAt,
      state,
    };
  }

  private detail(row: ThreadRow): ThreadDetail {
    return { ...this.summary(row), sessionPath: row.sessionPath };
  }

  private require(id: string): ThreadRow {
    const row = this.threads.get(id);
    if (!row) throw new NotFoundException(`Thread ${id} not found.`);
    return row;
  }

  private requireDirectory(cwd: string): void {
    if (!isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new BadRequestException(`${cwd} is not an existing absolute folder.`);
    }
  }
}
