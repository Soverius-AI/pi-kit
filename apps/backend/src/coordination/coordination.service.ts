import { existsSync, statSync } from 'node:fs';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { FileLease, OtherAgentInfo } from '@pi-kit/protocol';
import { LeasesRepository } from '../db/leases.repository';
import { type ThreadRow, ThreadsRepository } from '../db/threads.repository';
import { normalizeToolPath } from '../changes/touched';
import type { CoordinationHook } from '../pi/coordination-extension';
import { PiSessionService, type ToolStart } from '../pi/pi-session.service';
import { currentBranch } from '../threads/branch';
import { ThreadStatusService } from '../threads/thread-status.service';
import { LEASE_TTL_MS } from './leases';
import { buildSection, computeNotices, type OtherAgent, type OtherLease } from './section';

const PRUNE_MS = 10 * 60_000;

/** The folder a thread's pi runs in. */
const folderOf = (row: ThreadRow): string => row.worktreePath ?? row.cwd;

/**
 * Who else is working here. It records file leases at `edit` / `write` tool starts (the same fan-out as the change baselines:
 * `PiSessionService.onToolStart`), and answers the coordination extension every session carries: the system-prompt section and the notices for
 * files another thread changed. Soft by design: nothing here blocks an edit.
 */
@Injectable()
export class CoordinationService implements CoordinationHook, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoordinationService.name);
  /** What each thread read or edited, and when (this run of the backend): the files a notice may be about. */
  private readonly touched = new Map<string, Map<string, number>>();
  /** The activity time of the change each thread was last told about, per file. */
  private readonly told = new Map<string, Map<string, number>>();
  private unsubscribe: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly threads: ThreadsRepository,
    private readonly leases: LeasesRepository,
    private readonly sessions: PiSessionService,
    private readonly status: ThreadStatusService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.sessions.onToolStart((start) => this.record(start));
    this.sessions.setCoordination(this);
    this.timer = setInterval(() => this.leases.prune(), PRUNE_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    this.sessions.setCoordination(undefined);
    if (this.timer) clearInterval(this.timer);
  }

  // ---- capture

  /** A tool call is about to run: `edit` and `write` take the lease on the file; `read` only remembers that this thread knows the file. */
  record(start: ToolStart, now = Date.now()): void {
    const tool = start.toolName;
    if (tool !== 'edit' && tool !== 'write' && tool !== 'read') return;
    const path = normalizeToolPath(start.cwd, start.args['path']);
    if (!path) return;
    const mine = this.touched.get(start.threadId) ?? new Map<string, number>();
    mine.set(path, now);
    this.touched.set(start.threadId, mine);
    if (tool === 'read') return;
    try {
      this.leases.take(start.threadId, start.cwd, path, now);
    } catch (error) {
      this.logger.warn(`Could not record the lease on ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- who else is here

  /**
   * The other agents next to a thread: other threads of the same project that run in the same folder or in a worktree of it, if they are working (running,
   * waiting) or edited a file lately or were active in the last 30 minutes, and sessions of the pi command line in the same folder that wrote
   * lately ("pi in a terminal", no lease details).
   */
  others(threadId: string, now = Date.now()): OtherAgent[] {
    const me = this.threads.get(threadId);
    if (!me) return [];
    const folder = folderOf(me);
    const out: OtherAgent[] = [];
    for (const other of this.threads.all()) {
      if (other.id === threadId || other.archived || other.cwd !== me.cwd) continue;
      const otherFolder = folderOf(other);
      const sameFolder = otherFolder === folder;
      const state = this.status.stateOf(other).activity;
      const files = this.leases.activeOf(other.id, now).filter((l) => l.cwd === otherFolder).map((l) => ({ path: l.path, at: l.at }));
      const modified = fileMtime(other.sessionPath);
      const recent = modified !== null && now - modified < LEASE_TTL_MS;
      const terminal = other.origin === 'cli' && !this.sessions.has(other.id) && recent;
      if (!terminal && state === 'idle' && files.length === 0 && !(recent && other.messageCount > 0)) continue;
      // A command-line session in another folder of the repository is not next to this one.
      if (terminal && !sameFolder) continue;
      out.push({
        title: other.title ?? other.preview ?? 'Untitled thread',
        state: terminal ? 'terminal' : state,
        relation: sameFolder ? 'same-folder' : 'worktree',
        branch: other.worktreePath ? currentBranch(other.worktreePath) ?? other.branch : null,
        files,
        ...(terminal && modified !== null ? { lastActiveAt: modified } : {}),
      });
    }
    return out;
  }

  /** The same, for the renderer's Files panel ("Also working here: ..."). */
  othersInfo(threadId: string): OtherAgentInfo[] {
    return this.others(threadId).map((a) => ({ title: a.title, state: a.state, relation: a.relation }));
  }

  /** Other threads' active leases in the folder the thread runs in (the "being edited by" chip of the Files panel and review mode). */
  leasesFor(threadId: string, now = Date.now()): FileLease[] {
    const me = this.threads.get(threadId);
    if (!me) return [];
    const folder = folderOf(me);
    const out: FileLease[] = [];
    for (const lease of this.leases.activeIn(folder, now)) {
      if (lease.threadId === threadId) continue;
      const owner = this.threads.get(lease.threadId);
      if (!owner || owner.archived) continue;
      out.push({ path: lease.path, threadId: lease.threadId, title: owner.title ?? owner.preview ?? 'Untitled thread', since: lease.since, at: lease.at });
    }
    return out;
  }

  // ---- CoordinationHook (the extension every session carries)

  section(threadId: string): string | undefined {
    try {
      return buildSection(this.others(threadId), Date.now());
    } catch (error) {
      this.logger.warn(`Could not build the section for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  notices(threadId: string): string[] {
    try {
      const mine = this.touched.get(threadId);
      if (!mine || mine.size === 0) return [];
      const others: OtherLease[] = this.leasesFor(threadId).map((l) => ({ threadId: l.threadId, title: l.title, path: l.path, at: l.at }));
      const told = this.told.get(threadId) ?? new Map<string, number>();
      const notices = computeNotices({ touched: mine, leases: others, told });
      for (const notice of notices) told.set(notice.path, notice.at);
      this.told.set(threadId, told);
      return notices.map((n) => n.text);
    } catch (error) {
      this.logger.warn(`Could not work out the notices for ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}

function fileMtime(path: string): number | null {
  try {
    return existsSync(path) ? Math.floor(statSync(path).mtimeMs) : null;
  } catch {
    return null;
  }
}
