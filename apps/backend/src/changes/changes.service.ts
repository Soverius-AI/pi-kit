import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { addedFileHunks } from '@pi-kit/pi-adapter';
import {
  badgeOf,
  type Baseline,
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
import { PiSessionService, type ToolStart } from '../pi/pi-session.service';
import { insideWorkspace, posixRelative } from '../session/safe-path';
import { OutcomesService } from '../threads/outcomes.service';
import { ThreadsService } from '../threads/threads.service';
import { emptyModel, looksBinary, MAX_DIFF_CHARS, modelFromPatch, modelFromTexts } from './diff';
import * as git from './git';
import { collectTouched, normalizeToolPath, reconstructBaseline, type TouchedFile } from './touched';

/** The Changes panel lists this many files at most. */
export const MAX_FILES = 300;

/** The Files panel decorates this many changed files at most (a folder with thousands of untracked files is a build output). */
export const MAX_STATUS_ENTRIES = 5000;

/** A file bigger than this is not kept as a baseline. */
const MAX_BASELINE_BYTES = 2 * 1024 * 1024;

/** The words the viewer shows when the "before" side of a "This thread" diff is not what pi-kit captured. */
export const BASELINE_NOTE: Partial<Record<Baseline, string>> = {
  reconstructed: 'pi-kit did not see this file before pi edited it, so the earlier version was rebuilt by undoing the edits recorded in the session.',
  'git-head': "pi-kit has no copy of this file from before pi's first edit, so it is compared with git's HEAD instead. Changes you made yourself are included.",
  empty: 'pi-kit has no copy of this file from before pi touched it, and git has none either, so the whole file is shown as added.',
};

interface Analysis {
  file: ChangedFile;
  model: DiffModel;
  /** What the file was before the thread touched it, for "Revert file"; `undefined` when only git can say. */
  restore?: { existed: boolean; content: string };
}

/**
 * The Changes panel and review mode: the two sources of changed files, the diff model of one file,
 * the pending comment batch, and the file actions (revert, stage). "This thread" is built from what pi did, read
 * from the session file, against copies of the files that this service takes just before pi's first `edit` / `write`
 * of each file (`tool_execution_start` reaches us before pi executes the tool, and the tool result does not carry the old
 * content). "Working tree" is git's own diff.
 */
@Injectable()
export class ChangesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChangesService.name);
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly repo: ChangesRepository,
    private readonly sessions: PiSessionService,
    private readonly threads: ThreadsService,
    private readonly outcomes: OutcomesService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.sessions.onToolStart((start) => this.capture(start));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  // ---- capture

  /** Keeps the file as it is right now, if this is the thread's first edit or write of it. Synchronous on purpose: pi runs the tool right after. */
  capture(start: ToolStart): void {
    if (start.toolName !== 'edit' && start.toolName !== 'write') return;
    const path = normalizeToolPath(start.cwd, start.args['path']);
    if (!path || this.repo.baseline(start.threadId, path)) return;
    const absolute = join(start.cwd, path);
    try {
      if (!existsSync(absolute)) {
        this.repo.putBaseline(start.threadId, path, { existed: false, content: '' });
        return;
      }
      const stat = statSync(absolute);
      if (!stat.isFile()) return;
      if (stat.size > MAX_BASELINE_BYTES) return void this.repo.putBaseline(start.threadId, path, { existed: true, content: null });
      const buffer = readFileSync(absolute);
      this.repo.putBaseline(start.threadId, path, { existed: true, content: looksBinary(buffer) ? null : buffer.toString('utf8') });
    } catch (error) {
      this.logger.warn(`Could not keep ${path} before pi's edit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- reads

  async list(threadId: string, source: ChangeSource): Promise<ChangesList> {
    const cwd = this.threads.cwdOf(threadId);
    const isGit = await git.isWorkTree(cwd);
    if (source === 'worktree') return this.worktreeList(cwd, isGit);
    if (source === 'outcome') return this.outcomeList(threadId, cwd, isGit);
    const analyses = await this.threadAnalyses(threadId, cwd, isGit);
    const shown = analyses.slice(0, MAX_FILES);
    return {
      source,
      cwd,
      git: isGit,
      files: shown.map((a) => a.file),
      ...(analyses.length > shown.length ? { note: `Showing the first ${MAX_FILES} of ${analyses.length} files.` } : {}),
    };
  }

  async file(threadId: string, source: ChangeSource, path: string): Promise<DiffModel> {
    const cwd = this.threads.cwdOf(threadId);
    const rel = posixRelative(path);
    insideWorkspace(cwd, rel);
    const isGit = await git.isWorkTree(cwd);
    if (source === 'worktree') return this.worktreeFile(cwd, rel, isGit);
    if (source === 'outcome') return this.outcomeFile(threadId, cwd, rel, isGit);
    const touched = (await this.touched(threadId, cwd)).find((t) => t.path === rel);
    if (!touched) return emptyModel(rel, 'M', { note: 'pi has not edited or written this file in this thread.' });
    return (await this.analyse(threadId, cwd, touched, isGit))?.model ?? emptyModel(rel, 'M', { note: 'This file has no changes.' });
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
        this.logger.warn(`Could not list the files of thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { git: isGit, entries: all.slice(0, MAX_STATUS_ENTRIES), thread, ...(all.length > MAX_STATUS_ENTRIES ? { truncated: true } : {}) };
  }

  // ---- actions

  /** "Revert file": puts the file back as it was before the thread (or, in the working tree, as `HEAD` has it). The caller has confirmed. */
  async revert(threadId: string, source: EditableSource, path: string): Promise<void> {
    const cwd = this.threads.cwdOf(threadId);
    const rel = posixRelative(path);
    const absolute = insideWorkspace(cwd, rel);
    this.requireIdle(threadId);
    const isGit = await git.isWorkTree(cwd);
    if (source === 'thread') {
      const touched = (await this.touched(threadId, cwd)).find((t) => t.path === rel);
      if (!touched) throw new NotFoundException(`pi has not edited ${rel} in this thread.`);
      const analysis = await this.analyse(threadId, cwd, touched, isGit);
      if (!analysis) return; // nothing differs, nothing to revert
      if (analysis.restore) {
        if (analysis.restore.existed) writeFileSync(absolute, analysis.restore.content);
        else rmSync(absolute, { force: true });
        return;
      }
      if (!isGit) throw new ConflictException(`There is no copy of ${rel} from before pi's edit and no git to restore it from.`);
    } else if (!isGit) {
      throw new ConflictException('This folder is not a git repository, so there is no working tree to revert.');
    }
    const entry = (await git.statusEntries(cwd)).find((e) => e.path === rel);
    if (entry?.x === '?' && entry.y === '?') rmSync(absolute, { force: true });
    else await git.restoreToHead(cwd, rel);
  }

  /** "Stage all": `git add` for the working tree, or for the files of "This thread". */
  async stage(threadId: string, source: EditableSource, files?: string[]): Promise<{ staged: number }> {
    const cwd = this.threads.cwdOf(threadId);
    if (!(await git.isWorkTree(cwd))) throw new ConflictException('This folder is not a git repository, so there is nothing to stage into.');
    const paths = files?.map((f) => posixRelative(f));
    for (const path of paths ?? []) insideWorkspace(cwd, path);
    if (source === 'thread' && (!paths || paths.length === 0)) throw new BadRequestException('Name the files to stage.');
    await git.stage(cwd, source === 'thread' ? paths : undefined);
    return { staged: source === 'thread' ? (paths?.length ?? 0) : (await git.statusEntries(cwd)).filter((e) => e.x !== ' ' && e.x !== '?').length };
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

  private async touched(threadId: string, cwd: string): Promise<TouchedFile[]> {
    const branch = await this.branchOf(threadId);
    const touched = collectTouched(branch, cwd);
    // Files a background agent of the thread edited or wrote have a baseline but no call in pi's session: listed from the baseline,
    // attributed to the thread's current turn.
    const known = new Set(touched.map((file) => file.path));
    const turn = Math.max(1, branch.filter((entry) => entry.type === 'message' && (entry as { message?: { role?: string } }).message?.role === 'user').length);
    for (const { path } of this.repo.touchedPaths(threadId)) if (!known.has(path)) touched.push({ path, turn, steps: [] });
    return touched;
  }

  /** The active branch of the thread: from the open session, else from its file. */
  private async branchOf(threadId: string): Promise<PiSessionEntry[]> {
    if (this.sessions.has(threadId)) return this.sessions.branch(threadId).entries;
    const path = this.threads.sessionPathOf(threadId);
    return existsSync(path) ? (await this.sessions.readSession(path)).entries : [];
  }

  private async threadAnalyses(threadId: string, cwd: string, isGit: boolean): Promise<Analysis[]> {
    const out: Analysis[] = [];
    for (const touched of await this.touched(threadId, cwd)) {
      const analysis = await this.analyse(threadId, cwd, touched, isGit);
      if (analysis) out.push(analysis);
    }
    return out;
  }

  /** One touched file against its "before"; `undefined` when it ends up identical (reverted by hand, say). */
  private async analyse(threadId: string, cwd: string, touched: TouchedFile, isGit: boolean): Promise<Analysis | undefined> {
    const absolute = join(cwd, touched.path);
    const exists = existsSync(absolute) && statSync(absolute).isFile();
    const buffer = exists ? readFileSync(absolute) : undefined;
    const binary = buffer ? looksBinary(buffer) : false;
    const current = buffer && !binary ? buffer.toString('utf8') : undefined;

    // Where the "before" side comes from, best first.
    let before: { existed: boolean; text: string } | undefined;
    let baseline: Baseline = 'captured';
    const kept = this.repo.baseline(threadId, touched.path);
    if (kept && (kept.content !== null || !kept.existed)) {
      before = { existed: kept.existed, text: kept.content ?? '' };
    } else if (current !== undefined) {
      const rebuilt = reconstructBaseline(current, touched.steps);
      if (rebuilt !== undefined) {
        before = { existed: true, text: rebuilt };
        baseline = 'reconstructed';
      }
    }
    let restore: Analysis['restore'];
    if (before) {
      restore = { existed: before.existed, content: before.text };
    } else {
      const head = isGit ? await git.headContent(cwd, touched.path) : undefined;
      before = { existed: head !== undefined, text: head ?? '' };
      baseline = head === undefined ? 'empty' : 'git-head';
      // `HEAD`'s text is a fair thing to restore, except when it is not text.
      if (head !== undefined && !looksBinary(head)) restore = { existed: true, content: head };
    }

    const status: FileStatus | undefined = before.existed ? (exists ? 'M' : 'D') : exists ? 'A' : undefined;
    if (!status) return undefined;
    const note = BASELINE_NOTE[baseline];
    const file = { path: touched.path, turn: touched.turn, baseline };
    if (binary) {
      const model = emptyModel(touched.path, status, { binary: true, ...(note ? { note } : {}) });
      return { file: { ...file, status, added: 0, removed: 0, binary: true }, model: { ...model, baseline }, restore: undefined };
    }
    if (status === 'M' && current === before.text) return undefined;
    const newText = current ?? '';
    if (newText.length > MAX_DIFF_CHARS || before.text.length > MAX_DIFF_CHARS) {
      return { file: { ...file, status, added: 0, removed: 0 }, model: { ...emptyModel(touched.path, status, { tooLarge: true }), baseline }, restore };
    }
    const model = modelFromTexts({ path: touched.path, status, oldText: before.text, newText, baseline, ...(note ? { note } : {}) });
    return { file: { ...file, status, added: model.added, removed: model.removed }, model, restore };
  }

  // ---- "Working tree"

  private async worktreeList(cwd: string, isGit: boolean): Promise<ChangesList> {
    if (!isGit) return { source: 'worktree', cwd, git: false, files: [], note: 'This folder is not a git repository, so there is no working tree to compare. “This thread” still works.' };
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
        files.push({ path: entry.path, status, added: counted?.added ?? 0, removed: 0, ...(counted ? {} : { binary: true }) });
      } else if (stat === null) {
        files.push({ path: entry.path, status, added: 0, removed: 0, binary: true, ...(conflict ? { conflict } : {}) });
      } else {
        files.push({ path: entry.path, status, added: stat?.added ?? 0, removed: stat?.removed ?? 0, ...(conflict ? { conflict } : {}) });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { source: 'worktree', cwd, git: true, files, ...(entries.length > MAX_FILES ? { note: `Showing the first ${MAX_FILES} of ${entries.length} files.` } : {}) };
  }

  private async worktreeFile(cwd: string, rel: string, isGit: boolean): Promise<DiffModel> {
    if (!isGit) return emptyModel(rel, 'M', { note: 'This folder is not a git repository.' });
    const entry = (await git.statusEntries(cwd)).find((e) => e.path === rel);
    if (!entry) return emptyModel(rel, 'M', { note: 'This file has no changes against HEAD.' });
    const untracked = entry.x === '?' && entry.y === '?';
    const status: FileStatus = untracked || entry.x === 'A' ? 'A' : entry.x === 'D' || entry.y === 'D' ? 'D' : 'M';
    const absolute = join(cwd, rel);
    if (status === 'A') {
      if (!existsSync(absolute)) return emptyModel(rel, 'A', {});
      const buffer = readFileSync(absolute);
      if (looksBinary(buffer)) return emptyModel(rel, 'A', { binary: true });
      return modelFromTexts({ path: rel, status: 'A', oldText: '', newText: buffer.toString('utf8') });
    }
    const patch = await git.diffFile(cwd, await git.baseRevision(cwd), rel);
    if (/^Binary files .* differ$/m.test(patch)) return emptyModel(rel, status, { binary: true });
    return modelFromPatch({ path: rel, status, patch });
  }

  // ---- "Outcome"

  /** `git diff base..head` of the thread's outcome: the commits that are its result, in the folder it works in (the project's once its worktree is gone). */
  private async outcomeList(threadId: string, cwd: string, isGit: boolean): Promise<ChangesList> {
    const range = this.outcomes.range(threadId);
    if (!isGit) return { source: 'outcome', cwd, git: false, files: [], note: 'This folder is not a git repository, so there is no outcome to compare.' };
    if (!range) return { source: 'outcome', cwd, git: true, files: [], note: 'This thread has no outcome yet. It gets one when its worktree is merged back, a pull request is opened, or a commit contains files it changed.' };
    const [statuses, stats] = await Promise.all([git.nameStatusRange(cwd, range.base, range.head), git.numstat(cwd, range.base, range.head)]);
    const paths = [...statuses.keys()].sort((a, b) => a.localeCompare(b));
    const files: ChangedFile[] = paths.slice(0, MAX_FILES).map((path) => {
      const stat = stats.get(path);
      const status = statuses.get(path) ?? 'M';
      return stat === null ? { path, status, added: 0, removed: 0, binary: true } : { path, status, added: stat?.added ?? 0, removed: stat?.removed ?? 0 };
    });
    return { source: 'outcome', cwd, git: true, files, ...(paths.length > files.length ? { note: `Showing the first ${MAX_FILES} of ${paths.length} files.` } : {}) };
  }

  private async outcomeFile(threadId: string, cwd: string, rel: string, isGit: boolean): Promise<DiffModel> {
    const range = this.outcomes.range(threadId);
    if (!isGit) return emptyModel(rel, 'M', { note: 'This folder is not a git repository.' });
    if (!range) return emptyModel(rel, 'M', { note: 'This thread has no outcome yet.' });
    const status = (await git.nameStatusRange(cwd, range.base, range.head)).get(rel);
    if (!status) return emptyModel(rel, 'M', { note: 'The outcome did not change this file.' });
    const patch = await git.diffFile(cwd, range.base, rel, range.head);
    if (/^Binary files .* differ$/m.test(patch)) return emptyModel(rel, status, { binary: true });
    return modelFromPatch({ path: rel, status, patch });
  }

  /** A revert changes files under a running pi; wait for it to be idle. */
  private requireIdle(threadId: string): void {
    if (this.sessions.has(threadId) && this.sessions.isStreaming(threadId)) throw new ConflictException('Stop the run before you change files.');
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
