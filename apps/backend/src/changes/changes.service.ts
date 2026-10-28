import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { addedFileHunks } from '@pi-kit/pi-adapter';
import {
  badgeOf,
  type ChangedFile,
  type ChangeSource,
  type ChangesList,
  type DiffModel,
  type EditableSource,
  type FileStatus,
  type ReviewComment,
  type WorkspaceStatus,
} from '@pi-kit/protocol';
import { ChangesRepository } from '../db/changes.repository';
import { PiSessionService } from '../pi/pi-session.service';
import { insideWorkspace, posixRelative } from '../session/safe-path';
import { RunSnapshotsService, type ThreadChange } from '../snapshots/run-snapshots.service';
import { OutcomesService } from '../threads/outcomes.service';
import { ThreadsService } from '../threads/threads.service';
import { emptyModel, looksBinary, modelFromAddedText, modelFromPatch } from './diff';
import * as git from './git';

/** The Changes panel lists this many files at most. */
export const MAX_FILES = 300;

/** The Files panel decorates this many changed files at most (a folder with thousands of untracked files is a build output). */
export const MAX_STATUS_ENTRIES = 5000;

/** What is said when a snapshot's objects are gone (pruned after 30 days, or removed by the project's own `git gc`). */
export const GONE_NOTE = 'The snapshot from before this change is no longer available.';

/** Diffs are built from git; a folder without a repository says how to get one. */
export const NOT_GIT_NOTE = 'Diffs need a git repository. Initialise git in this folder to see what changed.';

/**
 * The Changes panel and review mode: the three sources of changed files, the diff model of one file, the pending comment batch, and the file
 * actions (revert, stage). Everything is git's: "This thread" compares the folder now with the snapshot taken before the run that first changed each
 * file (`RunSnapshotsService`), "Working tree" is `git diff HEAD`, "Outcome" the diff of the thread's commits.
 */
@Injectable()
export class ChangesService {
  private readonly logger = new Logger(ChangesService.name);

  constructor(
    private readonly repo: ChangesRepository,
    private readonly sessions: PiSessionService,
    private readonly threads: ThreadsService,
    private readonly outcomes: OutcomesService,
    private readonly snapshots: RunSnapshotsService,
  ) {}

  // ---- reads

  async list(threadId: string, source: ChangeSource): Promise<ChangesList> {
    const cwd = this.threads.cwdOf(threadId);
    const notGit: ChangesList = { source, cwd, git: false, files: [], note: NOT_GIT_NOTE };
    if (source !== 'thread') {
      if (!(await git.isWorkTree(cwd))) return notGit;
      return source === 'worktree' ? this.worktreeList(cwd) : this.outcomeList(threadId, cwd);
    }
    // The snapshots answer whether this is a git work tree too.
    const files = await this.threadFiles(threadId, cwd);
    if (!files) return notGit;
    const shown = files.slice(0, MAX_FILES);
    return {
      source,
      cwd,
      git: true,
      files: shown,
      ...(files.length > shown.length ? { note: `Showing the first ${MAX_FILES} of ${files.length} files.` } : {}),
    };
  }

  async file(threadId: string, source: ChangeSource, path: string): Promise<DiffModel> {
    const cwd = this.threads.cwdOf(threadId);
    const rel = posixRelative(path);
    insideWorkspace(cwd, rel);
    if (source !== 'thread') {
      if (!(await git.isWorkTree(cwd))) return emptyModel(rel, 'M', { note: NOT_GIT_NOTE });
      return source === 'worktree' ? this.worktreeFile(cwd, rel) : this.outcomeFile(threadId, cwd, rel);
    }
    const state = await this.snapshots.threadChanges(threadId, cwd);
    if (!state) return emptyModel(rel, 'M', { note: NOT_GIT_NOTE });
    const change = state.files.find((f) => f.path === rel);
    if (!change) return emptyModel(rel, 'M', { note: 'pi has not changed this file in this thread.' });
    try {
      const [diffed] = await state.shadow.changes(change.before, state.now, [rel]);
      if (!diffed) return emptyModel(rel, 'M', { note: 'This file has no changes.' });
      if (diffed.added === null) return emptyModel(rel, diffed.status, { binary: true });
      return modelFromPatch({
        path: rel,
        status: diffed.status,
        patch: await state.shadow.patch(change.before, state.now, rel),
      });
    } catch (error) {
      this.logger.debug(`Diff of ${rel}: ${error instanceof Error ? error.message : String(error)}`);
      return emptyModel(rel, 'M', { note: GONE_NOTE });
    }
  }

  /**
   * What the Files panel decorates: git's badge per changed file under `cwd`, and, if a thread is given, the files pi
   * edited or wrote in it that still differ from how they were before ("changed in this thread", a marker apart from the git badge:
   * a file can be dirty because of the user, because of pi, or both).
   */
  async fileStatus(cwd: string, threadId?: string): Promise<WorkspaceStatus> {
    const isGit = await git.isWorkTree(cwd);
    const all = isGit ? await git.statusBadges(cwd) : [];
    let thread: string[] = [];
    if (threadId && this.threads.cwdOf(threadId) === cwd) {
      try {
        thread = (await this.list(threadId, 'thread')).files.map((f) => f.path);
      } catch (error) {
        this.logger.warn(
          `Could not list the files of thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      git: isGit,
      entries: all.slice(0, MAX_STATUS_ENTRIES),
      thread,
      ...(all.length > MAX_STATUS_ENTRIES ? { truncated: true } : {}),
    };
  }

  // ---- actions

  /** "Revert file": puts the file back as it was before the thread (or, in the working tree, as `HEAD` has it). The caller has confirmed. */
  async revert(threadId: string, source: EditableSource, path: string): Promise<void> {
    const cwd = this.threads.cwdOf(threadId);
    const rel = posixRelative(path);
    const absolute = insideWorkspace(cwd, rel);
    this.requireIdle(threadId);
    const notGit = new ConflictException('This folder is not a git repository, so there is nothing to revert to.');
    if (source === 'thread') {
      const state = await this.snapshots.threadChanges(threadId, cwd);
      if (!state) throw notGit;
      const change = state.files.find((f) => f.path === rel);
      if (!change) throw new NotFoundException(`pi has not changed ${rel} in this thread.`);
      await state.shadow.restore(change.before, rel).catch(() => {
        throw new ConflictException(`${GONE_NOTE} ${rel} cannot be put back.`);
      });
      this.snapshots.forgetNow();
      return;
    }
    if (!(await git.isWorkTree(cwd))) throw notGit;
    const entry = (await git.statusEntries(cwd)).find((e) => e.path === rel);
    if (entry?.x === '?' && entry.y === '?') rmSync(absolute, { force: true });
    else await git.restoreToHead(cwd, rel);
    this.snapshots.forgetNow();
  }

  /** "Stage all": `git add` for the working tree, or for the files of "This thread". */
  async stage(threadId: string, source: EditableSource, files?: string[]): Promise<{ staged: number }> {
    const cwd = this.threads.cwdOf(threadId);
    if (!(await git.isWorkTree(cwd)))
      throw new ConflictException('This folder is not a git repository, so there is nothing to stage into.');
    const paths = files?.map((f) => posixRelative(f));
    for (const path of paths ?? []) insideWorkspace(cwd, path);
    if (source === 'thread' && (!paths || paths.length === 0))
      throw new BadRequestException('Name the files to stage.');
    await git.stage(cwd, source === 'thread' ? paths : undefined);
    return {
      staged:
        source === 'thread'
          ? (paths?.length ?? 0)
          : (await git.statusEntries(cwd)).filter((e) => e.x !== ' ' && e.x !== '?').length,
    };
  }

  // ---- pending comments

  comments(threadId: string): ReviewComment[] {
    this.threads.cwdOf(threadId);
    return this.repo.comments(threadId);
  }

  putComments(threadId: string, comments: ReviewComment[]): void {
    this.threads.cwdOf(threadId);
    this.repo.replaceComments(threadId, comments);
  }

  // ---- "This thread"

  /** The files the thread changed that still differ from how they were before it: one `git diff` per snapshot they are compared with. */
  private async threadFiles(threadId: string, cwd: string): Promise<ChangedFile[] | undefined> {
    const state = await this.snapshots.threadChanges(threadId, cwd);
    if (!state) return undefined;
    const byBefore = new Map<string, Map<string, ThreadChange>>();
    for (const change of state.files) {
      const group = byBefore.get(change.before) ?? new Map<string, ThreadChange>();
      group.set(change.path, change);
      byBefore.set(change.before, group);
    }
    const out: ChangedFile[] = [];
    for (const [before, group] of byBefore) {
      // A snapshot that is gone leaves its files out of the list rather than failing it.
      const diffs = await state.shadow.changes(before, state.now, [...group.keys()]).catch(() => []);
      for (const diffed of diffs) {
        const run = group.get(diffed.path)?.run;
        out.push({
          path: diffed.path,
          status: diffed.status,
          added: diffed.added ?? 0,
          removed: diffed.removed ?? 0,
          ...(diffed.added === null ? { binary: true } : {}),
          ...(run ? { run } : {}),
        });
      }
    }
    return out.sort((a, b) => (a.run ?? 0) - (b.run ?? 0) || a.path.localeCompare(b.path));
  }

  // ---- "Working tree"

  private async worktreeList(cwd: string): Promise<ChangesList> {
    const base = await git.baseRevision(cwd);
    const [entries, stats] = await Promise.all([git.statusEntries(cwd), git.numstat(cwd, base)]);
    const files: ChangedFile[] = [];
    for (const entry of entries.slice(0, MAX_FILES)) {
      const untracked = entry.x === '?' && entry.y === '?';
      const status: FileStatus = untracked || entry.x === 'A' ? 'A' : entry.x === 'D' || entry.y === 'D' ? 'D' : 'M';
      const stat = stats.get(entry.path);
      const conflict = badgeOf(entry.x, entry.y) === 'C';
      // A new file (untracked, or added to the index) is all added lines; its size is the file's.
      if (status === 'A' && !conflict) {
        const counted = countLines(join(cwd, entry.path));
        files.push({
          path: entry.path,
          status,
          added: counted?.added ?? 0,
          removed: 0,
          ...(counted ? {} : { binary: true }),
        });
      } else if (stat === null) {
        files.push({ path: entry.path, status, added: 0, removed: 0, binary: true, ...(conflict ? { conflict } : {}) });
      } else {
        files.push({
          path: entry.path,
          status,
          added: stat?.added ?? 0,
          removed: stat?.removed ?? 0,
          ...(conflict ? { conflict } : {}),
        });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      source: 'worktree',
      cwd,
      git: true,
      files,
      ...(entries.length > MAX_FILES ? { note: `Showing the first ${MAX_FILES} of ${entries.length} files.` } : {}),
    };
  }

  private async worktreeFile(cwd: string, rel: string): Promise<DiffModel> {
    const entry = (await git.statusEntries(cwd)).find((e) => e.path === rel);
    if (!entry) return emptyModel(rel, 'M', { note: 'This file has no changes against HEAD.' });
    const untracked = entry.x === '?' && entry.y === '?';
    const status: FileStatus = untracked || entry.x === 'A' ? 'A' : entry.x === 'D' || entry.y === 'D' ? 'D' : 'M';
    const absolute = join(cwd, rel);
    if (status === 'A') {
      if (!existsSync(absolute)) return emptyModel(rel, 'A', {});
      const buffer = readFileSync(absolute);
      if (looksBinary(buffer)) return emptyModel(rel, 'A', { binary: true });
      return modelFromAddedText(rel, buffer.toString('utf8'));
    }
    const patch = await git.diffFile(cwd, await git.baseRevision(cwd), rel);
    if (/^Binary files .* differ$/m.test(patch)) return emptyModel(rel, status, { binary: true });
    return modelFromPatch({ path: rel, status, patch });
  }

  // ---- "Outcome"

  /** `git diff base..head` of the thread's outcome: the commits that are its result, in the folder it works in (the project's once its worktree is gone). */
  private async outcomeList(threadId: string, cwd: string): Promise<ChangesList> {
    const range = this.outcomes.range(threadId);
    if (!range)
      return {
        source: 'outcome',
        cwd,
        git: true,
        files: [],
        note: 'This thread has no outcome yet. It gets one when its worktree is merged back, a pull request is opened, or a commit contains files it changed.',
      };
    const [statuses, stats] = await Promise.all([
      git.nameStatusRange(cwd, range.base, range.head),
      git.numstat(cwd, range.base, range.head),
    ]);
    const paths = [...statuses.keys()].sort((a, b) => a.localeCompare(b));
    const files: ChangedFile[] = paths.slice(0, MAX_FILES).map((path) => {
      const stat = stats.get(path);
      const status = statuses.get(path) ?? 'M';
      return stat === null
        ? { path, status, added: 0, removed: 0, binary: true }
        : { path, status, added: stat?.added ?? 0, removed: stat?.removed ?? 0 };
    });
    return {
      source: 'outcome',
      cwd,
      git: true,
      files,
      ...(paths.length > files.length ? { note: `Showing the first ${MAX_FILES} of ${paths.length} files.` } : {}),
    };
  }

  private async outcomeFile(threadId: string, cwd: string, rel: string): Promise<DiffModel> {
    const range = this.outcomes.range(threadId);
    if (!range) return emptyModel(rel, 'M', { note: 'This thread has no outcome yet.' });
    const status = (await git.nameStatusRange(cwd, range.base, range.head)).get(rel);
    if (!status) return emptyModel(rel, 'M', { note: 'The outcome did not change this file.' });
    const patch = await git.diffFile(cwd, range.base, rel, range.head);
    if (/^Binary files .* differ$/m.test(patch)) return emptyModel(rel, status, { binary: true });
    return modelFromPatch({ path: rel, status, patch });
  }

  /** A revert changes files under a running pi; wait for it to be idle. */
  private requireIdle(threadId: string): void {
    if (this.sessions.has(threadId) && this.sessions.isStreaming(threadId))
      throw new ConflictException('Stop the run before you change files.');
  }
}

/** Added lines of a new file, or `undefined` if it is binary or unreadable. */
function countLines(path: string): { added: number } | undefined {
  try {
    const buffer = readFileSync(path);
    if (looksBinary(buffer)) return undefined;
    return { added: addedFileHunks(buffer.toString('utf8')).reduce((n, h) => n + h.newLines, 0) };
  } catch {
    return undefined;
  }
}
