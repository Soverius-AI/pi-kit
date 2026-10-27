import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { PendingDialog, PiSessionEntry, PiUiEvent } from '@pi-kit/pi-adapter';
import { type CompleteResponse, type ComposerRegistration, type Cycle, REVIEW_ENTRY_TYPE, type QueueSnapshot, type QueueTarget, endsWithQuestion, type ModelList, type PiDialogAnswer, type PiDialogRequest, type ReviewBatch, type SessionContext, type SessionStats, SKILLS_ENTRY_TYPE, type SkillsEntry, type ThinkingLevel } from '@pi-kit/protocol';
// Type-only imports are erased at build time; the runtime import goes through `loadPi()` below.
// Runtime SDK access stays behind the pi/ adapter’s loadPi() entry point.
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { LiteLlmService } from '../setup/litellm.service';
import type { ChipResources } from '../agui/chip-expansion';
import type { CoordinationHook } from './coordination-extension';
import type { AgentsHook } from '../bg-agents/agent-tools';
import type { BrowserHook } from './browser-extension';
import { loadPi } from './load-pi';
import { PiPluginService } from './pi-plugin.service';
import { discoverSessionCommands, type PiDiscoveredCommand, sessionChipResources } from './session-resources';
import { SessionLifecycle, type OpenTarget, type OpenThread, type PiThreadInfo } from './session-lifecycle';
import { SessionModels, type SessionModelChange } from './session-models';
import type { PiImage } from './session-queue';
import type { McpCommandOptions, McpCommandResult } from './session-mcp';
import { type ScanResult, SessionIndex, type SessionSummary } from './session-index';
import { type ContextMessage, type ContextTool, buildContextItems, groupContextItems } from './context-items';
import { type SkillUse, skillsUsedBy } from './skill-use';
import { TrustService } from './trust.service';
import type { DialogAnswer } from './ui-bridge';
import type { SessionUiHooks } from './session-ui';

export { loadPi };
export type { PiThreadInfo } from './session-lifecycle';
export type { PiDiscoveredCommand } from './session-resources';
export { QueueStaleError, type PiImage } from './session-queue';
export { mcpCallToolResult, type McpMessage } from './session-mcp';

/** A dialog the person answered: what pi asked and what they said. */
export interface DialogAnswered {
  request: PiDialogRequest;
  answer: DialogAnswer;
}
/** An event delivered by `session.subscribe()`. */
export type PiSessionEvent = AgentSessionEvent;

export interface BashRun {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
}

/** What `SessionManager.listAll()` knows about one session file. Times are epoch milliseconds. */
export type PiSessionSummary = SessionSummary;

/** A session file read through `SessionManager`: the active branch, root to leaf. */
export interface PiSessionContents {
  id: string;
  path: string | undefined;
  cwd: string;
  name: string | undefined;
  leafId: string | null;
  parentSessionPath: string | undefined;
  entries: PiSessionEntry[];
}

/** The entries of a session (all branches, file order) and its current leaf. */
export interface PiTreeSource {
  entries: PiSessionEntry[];
  leafId: string | null;
  path: string | undefined;
}

export interface PiNavigateResult {
  editorText?: string;
  cancelled: boolean;
  leafId: string | null;
  summaryId?: string;
}

export interface NewPiSession {
  id: string;
  /** Where pi will write the file; it does not exist until the first assistant message. */
  path: string;
  cwd: string;
}

/** A tool call that is about to run, announced before pi executes it (`tool_execution_start`). */
export interface ToolStart {
  threadId: string;
  cwd: string;
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * All pi access goes through here: one `AgentSession` per open thread, created like the
 * CLI creates its own, with the MCP, codemode and tool-search extensions added so the tool set
 * matches `pi`. `prompt()` resolves when the run (including retries) has finished; stream progress
 * through `subscribe()`.
 */
@Injectable()
export class PiSessionService implements OnModuleDestroy {
  private readonly logger = new Logger(PiSessionService.name);
  private readonly lifecycle: SessionLifecycle;
  private readonly treeListeners = new Set<(threadId: string) => void>();
  private readonly unattachedUiListeners = new Set<(threadId: string, event: PiUiEvent) => void>();
  private readonly toolStartListeners = new Set<(start: ToolStart) => void>();
  private readonly dialogsChangedListeners = new Set<(threadId: string) => void>();
  private readonly turnListeners = new Set<(threadId: string) => void>();
  private readonly sessionModels: SessionModels;
  private index: SessionIndex | undefined;
  private coordination: CoordinationHook | undefined;
  private browser: BrowserHook | undefined;
  private agents: AgentsHook | undefined;
  private readonly answeredListeners = new Set<(threadId: string, answer: DialogAnswered) => void>();
  private readonly skillUseListeners = new Set<(threadId: string, uses: SkillUse[]) => void>();

  constructor(trust: TrustService, private readonly plugins: PiPluginService, liteLlm: LiteLlmService) {
    this.sessionModels = new SessionModels(liteLlm);
    this.lifecycle = new SessionLifecycle(trust, plugins, {
      coordination: () => this.coordination,
      browser: () => this.browser,
      agents: () => this.agents,
      ui: (id, cwd) => this.uiHooks(id, cwd),
      opened: (thread) => this.followTurns(thread),
    });
  }

  /** The backend's answers for the coordination extension every session carries; sessions read it when they run, so it may arrive after they open. */
  setCoordination(hook: CoordinationHook | undefined): void {
    this.coordination = hook;
  }

  setBrowser(hook: BrowserHook | undefined): void {
    this.browser = hook;
  }

  /** The backend's answers for the `agent_*` tools every session carries; sessions read it when they run. */
  setAgents(hook: AgentsHook | undefined): void {
    this.agents = hook;
  }

  /** The user's answer to a background agent's question, arriving as an AG-UI resume; false if the id is not an agent's question. */
  answerAgentQuestion(interruptId: string, answer: PiDialogAnswer | 'cancelled'): Promise<boolean> {
    return this.agents?.answerInterrupt(interruptId, answer) ?? Promise.resolve(false);
  }

  /**
   * A message an extension would send with `pi.sendMessage` (a background agent's report, a question, the receipt of an answer): pi shows it when
   * `display` is set and sends it to the model. While the thread streams it is queued as a steer; idle, `triggerTurn` starts a turn (which
   * the runner follows).
   */
  async sendCustomMessage(threadId: string, message: { customType: string; content: string; display: boolean; details?: unknown }, options: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' } = {}): Promise<void> {
    await this.lifecycle.get(threadId).session.sendCustomMessage(message, options);
  }

  /**
   * Opens the thread's session, or returns the already open one. The thread id is the pi session id
   * an existing `sessionPath` is opened as it is, so the next prompt appends to the same
   * file; otherwise a new persisted session with that id is created in `cwd`, named `title` if given.
   */
  async open(threadId: string, target: OpenTarget): Promise<PiThreadInfo> {
    return (await this.lifecycle.ensure(threadId, target)).info;
  }

  /** The thread's active branch from the open session (what the CLI would load), root to leaf. */
  branch(threadId: string): { entries: PiSessionEntry[]; path: string | undefined } {
    const { session } = this.lifecycle.get(threadId);
    return { entries: session.sessionManager.getBranch() as unknown as PiSessionEntry[], path: session.sessionFile };
  }

  /**
   * Every session file's summary, incrementally: only files that are new or whose mtime or size moved are read, so a pass over
   * hundreds of sessions costs a directory scan, not hundreds of megabytes of parsing. `changed` is what to write to SQLite.
   */
  async scanSessions(): Promise<ScanResult> {
    const pi = await loadPi();
    this.index ??= new SessionIndex(() => join(pi.getAgentDir(), 'sessions'));
    return this.index.scan();
  }

  async listSessions(): Promise<PiSessionSummary[]> {
    return (await this.scanSessions()).all;
  }

  /** Reads a session file without opening an `AgentSession` (no extensions, no MCP servers). */
  async readSession(path: string): Promise<PiSessionContents> {
    const pi = await loadPi();
    const manager = pi.SessionManager.open(path);
    return {
      id: manager.getSessionId(),
      path: manager.getSessionFile(),
      cwd: manager.getCwd(),
      name: manager.getSessionName(),
      leafId: manager.getLeafId(),
      parentSessionPath: manager.getHeader()?.parentSession,
      entries: manager.getBranch() as unknown as PiSessionEntry[],
    };
  }

  /** A new, empty persisted session with the given id; nothing is written until its first assistant message. */
  async createSession(cwd: string, id: string): Promise<NewPiSession> {
    const pi = await loadPi();
    const manager = pi.SessionManager.create(cwd, undefined, { id });
    return { id: manager.getSessionId(), path: manager.getSessionFile() as string, cwd };
  }

  /** `/fork` outside the TUI: a new session in `targetCwd` with the source's full history. */
  async forkSession(sourcePath: string, targetCwd: string): Promise<NewPiSession> {
    const pi = await loadPi();
    const manager = pi.SessionManager.forkFrom(sourcePath, targetCwd);
    return { id: manager.getSessionId(), path: manager.getSessionFile() as string, cwd: targetCwd };
  }

  /**
   * `/clone`: a new session file holding the path from the root to `entryId` (default: the current
   * leaf). Done on a throwaway manager, because `createBranchedSession` switches its manager over to
   * the new file and the source must stay as it is.
   */
  async cloneSession(sourcePath: string, entryId?: string): Promise<NewPiSession> {
    const pi = await loadPi();
    const source = pi.SessionManager.open(sourcePath);
    const leaf = entryId ?? source.getLeafId();
    if (!leaf) throw new Error('The session has no entries to clone.');
    const path = source.createBranchedSession(leaf);
    if (!path) throw new Error('pi did not create a session file.');
    const clone = pi.SessionManager.open(path);
    return { id: clone.getSessionId(), path, cwd: clone.getCwd() };
  }

  /**
   * Writes the session name (`session_info`, what `/name` does). Returns false if there is no file
   * to write to yet; the title then lives in our database and is applied when the session first opens.
   */
  async setName(threadId: string, sessionPath: string, name: string): Promise<boolean> {
    const open = this.lifecycle.threads.get(threadId);
    if (open) {
      open.session.setSessionName(name);
      return true;
    }
    if (!existsSync(sessionPath)) return false;
    const pi = await loadPi();
    pi.SessionManager.open(sessionPath).appendSessionInfo(name);
    return true;
  }

  /**
   * Removes a session file the way pi's session picker does: `trash` if it is installed, else
   * unlink. Returns how it went; a file that is already gone counts as trashed.
   */
  trashSession(path: string): 'trash' | 'unlink' | 'missing' {
    if (!existsSync(path)) return 'missing';
    const args = path.startsWith('-') ? ['--', path] : [path];
    const result = spawnSync('trash', args, { encoding: 'utf-8' });
    if (result.status === 0 || !existsSync(path)) return 'trash';
    unlinkSync(path);
    return 'unlink';
  }

  // ---- the session tree

  /**
   * Every entry of the session and its leaf: from the open session if there is one (it knows the leaf the app moved
   * to), else from the file, with `leafHint` standing in for the leaf the app last moved to. A session without a file
   * (a draft) is empty.
   */
  async treeSource(threadId: string, sessionPath: string, leafHint?: string): Promise<PiTreeSource> {
    const open = this.lifecycle.threads.get(threadId);
    if (open) return { ...(this.openTree(threadId) as { entries: PiSessionEntry[]; leafId: string | null }), path: open.session.sessionFile };
    if (!existsSync(sessionPath)) return { entries: [], leafId: null, path: undefined };
    const pi = await loadPi();
    const manager = pi.SessionManager.open(sessionPath);
    const leafId = leafHint && manager.getEntry(leafHint) ? leafHint : manager.getLeafId();
    return { entries: manager.getEntries() as unknown as PiSessionEntry[], leafId, path: sessionPath };
  }

  /** Entries and leaf of the open session, synchronously; `undefined` if the thread is not open. */
  openTree(threadId: string): { entries: PiSessionEntry[]; leafId: string | null } | undefined {
    const open = this.lifecycle.threads.get(threadId);
    if (!open) return undefined;
    const manager = open.session.sessionManager;
    return { entries: manager.getEntries() as unknown as PiSessionEntry[], leafId: manager.getLeafId() };
  }

  /** The current leaf of the open session. */
  leafId(threadId: string): string | null {
    return this.lifecycle.get(threadId).session.sessionManager.getLeafId();
  }

  /** One entry by id, from the open session. */
  entry(threadId: string, entryId: string): PiSessionEntry | undefined {
    return this.lifecycle.get(threadId).session.sessionManager.getEntry(entryId) as unknown as PiSessionEntry | undefined;
  }

  /**
   * Moves the leaf (`navigateTree`): the next prompt appends there. A user message as the target puts the leaf on its
   * parent and hands back its text, as pi's `/tree` does. With `summarize` the branch being left is summarised by the
   * model and the summary is written at the target. Throws while the thread runs.
   */
  async navigate(threadId: string, targetId: string, options: { summarize?: boolean; instructions?: string } = {}): Promise<PiNavigateResult> {
    const { session } = this.lifecycle.get(threadId);
    const result = await session.navigateTree(targetId, {
      ...(options.summarize ? { summarize: true } : {}),
      ...(options.instructions ? { customInstructions: options.instructions } : {}),
    });
    const leafId = session.sessionManager.getLeafId();
    if (!result.cancelled) this.emitTreeChanged(threadId);
    return {
      cancelled: result.cancelled,
      leafId,
      ...(result.editorText !== undefined ? { editorText: result.editorText } : {}),
      ...(result.summaryEntry ? { summaryId: result.summaryEntry.id } : {}),
    };
  }

  /** Sets or clears a label on an entry (appends a `label` entry at the leaf, as `/tree` does). */
  setLabel(threadId: string, targetId: string, label: string | undefined): void {
    const { session } = this.lifecycle.get(threadId);
    if (!session.sessionManager.getEntry(targetId)) throw new Error(`Entry ${targetId} not found`);
    session.sessionManager.appendLabelChange(targetId, label);
    this.emitTreeChanged(threadId);
  }

  /** Called after the leaf moved or an entry was appended outside a run (navigate, label, summarise, extension). */
  onTreeChanged(listener: (threadId: string) => void): () => void {
    this.treeListeners.add(listener);
    return () => this.treeListeners.delete(listener);
  }

  private emitTreeChanged(threadId: string): void {
    for (const listener of this.treeListeners) {
      try {
        listener(threadId);
      } catch (error) {
        this.logger.warn(`Tree listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Called when pi starts a turn nobody prompted through `prompt()`: an extension's `pi.sendMessage(…, { triggerTurn: true })` or
   * `pi.sendUserMessage()` in an idle thread. The runner opens a run of its own for it; `whenPromptDone()` covers such a turn.
   */
  onTurnStarted(listener: (threadId: string) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  /** Called before every tool call of every open thread runs; the changes view reads the file here. */
  onToolStart(listener: (start: ToolStart) => void): () => void {
    this.toolStartListeners.add(listener);
    return () => this.toolStartListeners.delete(listener);
  }

  /**
   * Records a review batch in the session before the prompt it is sent: a `custom` entry, which
   * pi never sends to the model and the CLI's export keeps. Returns the entry id.
   */
  appendReview(threadId: string, batch: ReviewBatch): string {
    return this.lifecycle.get(threadId).session.sessionManager.appendCustomEntry(REVIEW_ENTRY_TYPE, batch);
  }

  /**
   * Records the chips of a message before the prompt they are sent with: a `custom` entry, which pi never sends to the model. It
   * carries the sentence the person typed, because the message after it holds the expanded instructions. Returns the entry id.
   */
  appendSkills(threadId: string, entry: SkillsEntry): string {
    return this.lifecycle.get(threadId).session.sessionManager.appendCustomEntry(SKILLS_ENTRY_TYPE, entry);
  }

  /** What chips expand: the skills and prompt templates of the open session, and pi's frontmatter stripper. */
  async chipResources(threadId: string): Promise<ChipResources> {
    return sessionChipResources(this.lifecycle.get(threadId).session);
  }

  /** The folder of an open thread. */
  cwdOf(threadId: string): string | undefined {
    return this.lifecycle.threads.get(threadId)?.info.cwd;
  }

  /**
   * A project-trust answer changes what a session may load, so the idle open threads of that folder are closed; their
   * next use opens them again with the new answer. Returns the threads that are running (they keep what they loaded
   * until `/reload` or the next open).
   */
  applyTrust(cwd: string): { closed: string[]; running: string[] } {
    const closed: string[] = [];
    const running: string[] = [];
    for (const [threadId, thread] of [...this.lifecycle.threads]) {
      if (thread.info.cwd !== cwd) continue;
      if (thread.session.isStreaming || thread.prompting || thread.ui.size > 0) running.push(threadId);
      else {
        this.dispose(threadId);
        closed.push(threadId);
      }
    }
    return { closed, running };
  }

  /** The settings dialog's auto-compaction switch reaches the sessions that are open (new ones read pi's settings). */
  setAutoCompaction(enabled: boolean): void {
    for (const { session } of this.lifecycle.threads.values()) session.setAutoCompactionEnabled(enabled);
  }

  /** The settings dialog's retry and queue-mode switches reach the sessions that are open (new ones read pi's settings). */
  applySettings(change: { retryEnabled?: boolean; steeringMode?: 'all' | 'one-at-a-time'; followUpMode?: 'all' | 'one-at-a-time' }): void {
    for (const { session } of this.lifecycle.threads.values()) {
      if (change.retryEnabled !== undefined) session.setAutoRetryEnabled(change.retryEnabled);
      if (change.steeringMode) session.setSteeringMode(change.steeringMode);
      if (change.followUpMode) session.setFollowUpMode(change.followUpMode);
    }
  }

  has(threadId: string): boolean {
    return this.lifecycle.threads.has(threadId);
  }

  isStreaming(threadId: string): boolean {
    return this.lifecycle.get(threadId).session.isStreaming;
  }

  /**
   * Starts a prompt. The returned promise resolves when the run (or the extension command) is done, which
   * may be a long time after the AG-UI run that started it ended, if an extension dialog interrupted it.
   * It is also kept as `whenPromptDone()`, so the run that resumes the dialog can wait for the same thing.
   */
  prompt(threadId: string, text: string, options: { images?: PiImage[] } = {}): Promise<void> {
    const thread = this.lifecycle.get(threadId);
    const { session } = thread;
    this.noteSkills(threadId, text, thread);
    return this.track(
      thread,
      session.prompt(text, {
        images: options.images?.map((image) => ({ type: 'image' as const, ...image })),
        // A prompt that arrives mid-run is a steering message unless the caller used followUp().
        streamingBehavior: session.isStreaming ? 'steer' : undefined,
      }),
    );
  }

  /**
   * A turn pi starts by itself (an extension's `pi.sendMessage(…, { triggerTurn: true })` or `pi.sendUserMessage()` in an idle thread) gets a
   * promise like a prompt's, settled at `agent_settled`, so a resume and the trust check see it, and the runner is told.
   */
  private followTurns(thread: OpenThread): void {
    let settle: (() => void) | undefined;
    thread.session.subscribe((event) => {
      if (event.type === 'agent_start' && !thread.prompting) {
        void this.track(thread, new Promise<void>((resolve) => (settle = resolve)));
        this.emitTurnStarted(thread.info.threadId);
      } else if (event.type === 'agent_settled') {
        settle?.();
        settle = undefined;
      }
    });
  }

  /** Keeps `turn` as the thread's `prompting` until it settles. Only the promise that set it clears it, so a turn that begins as another ends is not forgotten. */
  private track(thread: OpenThread, turn: Promise<void>): Promise<void> {
    const tracked: Promise<void> = turn.finally(() => {
      if (thread.prompting === tracked) thread.prompting = undefined;
    });
    thread.prompting = tracked;
    return tracked;
  }

  /** Told when a prompt, steer or follow-up uses a skill (a chip's block or a typed `/skill:name`): the learned skills' record counts these. A listener's failure is its own. */
  onSkillsUsed(listener: (threadId: string, uses: SkillUse[]) => void): () => void {
    this.skillUseListeners.add(listener);
    return () => this.skillUseListeners.delete(listener);
  }

  private noteSkills(threadId: string, text: string, thread: OpenThread): void {
    if (this.skillUseListeners.size === 0 || !text.includes('skill')) return;
    let uses: SkillUse[] = [];
    try {
      uses = skillsUsedBy(text, (name) => thread.session.resourceLoader.getSkills().skills.find((s) => s.name === name)?.filePath);
    } catch (error) {
      this.logger.debug(`Could not read the skills of a prompt of ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (uses.length === 0) return;
    for (const listener of this.skillUseListeners) {
      try {
        listener(threadId, uses);
      } catch (error) {
        this.logger.warn(`A skill-use listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** The in-flight prompt of the thread, if there is one (it is pending while a dialog waits for an answer). */
  whenPromptDone(threadId: string): Promise<void> | undefined {
    return this.lifecycle.threads.get(threadId)?.prompting;
  }

  steer(threadId: string, text: string, images: PiImage[] = []): Promise<'queued' | 'handled'> {
    const thread = this.lifecycle.get(threadId);
    this.noteSkills(threadId, text, thread);
    return thread.queue.enqueue('steer', text, images);
  }

  followUp(threadId: string, text: string, images: PiImage[] = []): Promise<'queued' | 'handled'> {
    const thread = this.lifecycle.get(threadId);
    this.noteSkills(threadId, text, thread);
    return thread.queue.enqueue('followUp', text, images);
  }

  // ---- the queue of messages that wait for the running turn

  /** pi's canonical queued texts; a closed session has no queue. */
  queue(threadId: string): QueueSnapshot {
    return this.lifecycle.threads.get(threadId)?.queue.snapshot() ?? { steering: [], followUp: [] };
  }

  promoteQueued(threadId: string, target: QueueTarget): Promise<QueueSnapshot> {
    return this.lifecycle.get(threadId).queue.promote(target);
  }

  removeQueued(threadId: string, target: QueueTarget): Promise<QueueSnapshot> {
    return this.lifecycle.get(threadId).queue.remove(target);
  }

  mergeQueued(threadId: string): Promise<QueueSnapshot> {
    return this.lifecycle.get(threadId).queue.merge();
  }

  clearQueued(threadId: string): Promise<QueueSnapshot> {
    return this.lifecycle.get(threadId).queue.clear();
  }

  /**
   * An assistant turn that ended in a question and nothing is running: the thread is "waiting" for the user the same way
   * it is while a dialog is open. Only a thread whose session is open can say; the list shows the others as they were.
   */
  askedAQuestion(threadId: string): boolean {
    return this.proseQuestion(threadId) !== undefined;
  }

  /** The question itself (its last line) when `askedAQuestion`, for the sidebar's waiting badge. */
  proseQuestion(threadId: string): string | undefined {
    const thread = this.lifecycle.threads.get(threadId);
    if (!thread || thread.session.isStreaming || thread.ui.size > 0) return undefined;
    const last = thread.session.messages.at(-1);
    if (last?.role !== 'assistant') return undefined;
    const content = (last as { content?: unknown }).content;
    const text = Array.isArray(content) ? content.map((part) => (part && typeof part === 'object' && (part as { type?: string }).type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).join('') : '';
    if (!endsWithQuestion(text)) return undefined;
    return text.trimEnd().slice(text.trimEnd().lastIndexOf('\n') + 1).trim();
  }

  /**
   * Stops the active run and waits for the session to become idle. Safe on an idle or unknown thread.
   * What an extension is waiting on is ended first, or the run could never end: its plugin requests (a `/score` or `/learn` model call, whose host hears the abort
   * and whose command gets a cancelled answer; pi's own `abort()` knows nothing of a command's awaits) and its dialogs.
   */
  async abort(threadId: string): Promise<void> {
    const thread = this.lifecycle.threads.get(threadId);
    if (!thread) return;
    this.plugins.cancel(threadId);
    thread.ui.cancelAll();
    await thread.session.abort();
  }

  // ---- extension dialogs and UI calls

  /** Dialogs pi is waiting on; with `onlyNew`, those not yet reported to a client. */
  pendingDialogs(threadId: string, onlyNew = false): PendingDialog[] {
    return this.lifecycle.threads.get(threadId)?.ui.list(onlyNew) ?? [];
  }

  /** A thread's set of pending dialogs changed (one opened, one was answered or dismissed): the thread-state service pushes it to the sidebar. */
  onDialogsChanged(listener: (threadId: string) => void): () => void {
    this.dialogsChangedListeners.add(listener);
    return () => this.dialogsChangedListeners.delete(listener);
  }

  markDialogsReported(threadId: string, ids: readonly string[]): void {
    this.lifecycle.threads.get(threadId)?.ui.markReported(ids);
  }

  /** Told when the person answered a dialog (not when a stop dismissed it): the Meat Proxy Score's ledger keeps what they said. */
  onDialogAnswered(listener: (threadId: string, answer: DialogAnswered) => void): () => void {
    this.answeredListeners.add(listener);
    return () => this.answeredListeners.delete(listener);
  }

  /** Answers a dialog; false if it is gone. */
  answerDialog(threadId: string, id: string, answer: DialogAnswer): boolean {
    const ui = this.lifecycle.threads.get(threadId)?.ui;
    const request = ui?.list().find((d) => d.id === id)?.request;
    const delivered = ui?.answer(id, answer) ?? false;
    if (delivered && request) {
      for (const listener of [...this.answeredListeners]) {
        try {
          listener(threadId, { request, answer });
        } catch (error) {
          this.logger.debug(`A dialog listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return delivered;
  }

  /** True once if a stop dismissed dialogs, so the run that resumes them can end as "stopped". */
  takeAbortedWhileWaiting(threadId: string): boolean {
    return this.lifecycle.threads.get(threadId)?.ui.takeAborted() ?? false;
  }

  onUiEvent(threadId: string, listener: (event: PiUiEvent) => void): () => void {
    return this.lifecycle.get(threadId).ui.onUi(listener);
  }

  /**
   * Events that extensions produced while no run was listening (a toolbar action registered at `session_start`, before the
   * first prompt): the runner writes them to the replay log, so a client that connects later still gets them.
   */
  onUnattachedUiEvent(listener: (threadId: string, event: PiUiEvent) => void): () => void {
    this.unattachedUiListeners.add(listener);
    return () => this.unattachedUiListeners.delete(listener);
  }

  /** The toolbar actions and suggestions the extensions of the open session have registered. */
  composerRegistrations(threadId: string): ComposerRegistration[] {
    return this.lifecycle.threads.get(threadId)?.ui.composerRegistrations() ?? [];
  }

  /** Argument completion from the extensions' autocomplete providers (`ctx.ui.addAutocompleteProvider`). */
  complete(threadId: string, text: string, cursor: number): Promise<CompleteResponse> {
    return this.lifecycle.get(threadId).ui.complete(text, cursor, {
      onError: (error) => this.logger.debug(`Autocomplete provider failed: ${error instanceof Error ? error.message : String(error)}`),
    });
  }

  onDialogRequested(threadId: string, listener: () => void): () => void {
    return this.lifecycle.get(threadId).ui.onDialog(listener);
  }

  /** Current status-bar texts of the extensions, by key. */
  statuses(threadId: string): Record<string, string> {
    return Object.fromEntries(this.lifecycle.threads.get(threadId)?.ui.statuses ?? []);
  }

  // ---- MCP

  /** pi's agent folder (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), where the user-level `mcp.json` lives. */
  async agentDir(): Promise<string> {
    return (await loadPi()).getAgentDir();
  }

  /** Whether pi reads the thread folder's `.pi/mcp.json` (project trust, `docs/security.md`). */
  isProjectTrusted(threadId: string): boolean {
    return this.lifecycle.get(threadId).session.extensionRunner.createContext().isProjectTrusted();
  }

  /** The `ui://` resource an MCP tool links, as the server listed it; `undefined` for a thread that is not open. */
  mcpAppResource(threadId: string, server: string, tool: string): string | undefined {
    return this.lifecycle.threads.get(threadId)?.tap.uiResourceUri(server, tool);
  }

  /** Whether an MCP App may call the tool (`_meta.ui.visibility`); true for a tool we know nothing about. */
  mcpAppMayCall(threadId: string, server: string, tool: string): boolean {
    return this.lifecycle.threads.get(threadId)?.tap.appMayCall(server, tool) ?? true;
  }

  /** The tools a server listed in this thread's session (names, first line of the description, the `ui://` resource of an MCP App); empty before it connects. */
  mcpTools(threadId: string, server: string): { name: string; description?: string; app?: string }[] {
    return this.lifecycle.threads.get(threadId)?.tap.toolList(server) ?? [];
  }

  /** `mcpAppResource` bound to a thread, for the adapter (`MapContext.mcpApp`, `sessionToMessages`). */
  mcpAppLookup(threadId: string): ((server: string, tool: string) => string | undefined) | undefined {
    const thread = this.lifecycle.threads.get(threadId);
    return thread && ((server, tool) => thread.tap.uiResourceUri(server, tool));
  }

  /** Runs the MCP extension command, collecting notifications while an unfinished sign-in continues in the background. */
  async mcpCommand(threadId: string, args: string, options: McpCommandOptions): Promise<McpCommandResult> {
    return this.lifecycle.get(threadId).mcp.command(args, options);
  }

  /** A user action from an MCP App, through the tool on the connection the session already holds. */
  async callMcpTool(threadId: string, server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.lifecycle.get(threadId).mcp.callTool(server, tool, args, signal);
  }

  /** Reads an app resource and preserves the metadata observed on the session's MCP transport. */
  async readMcpResource(threadId: string, server: string, uri: string, signal?: AbortSignal): Promise<{ contents: Record<string, unknown>[] }> {
    return this.lifecycle.get(threadId).mcp.readResource(server, uri, signal);
  }

  // ---- commands, models and session actions

  /** pi's `get_commands`: extension commands, prompt templates and skills of the open session. */
  commands(threadId: string): PiDiscoveredCommand[] {
    return discoverSessionCommands(this.lifecycle.get(threadId).session);
  }

  /** The available models, current selection, effort levels, pins and defaults. */
  async models(threadId: string): Promise<ModelList> {
    return this.sessionModels.list(this.lifecycle.get(threadId).session);
  }

  /** Switch the model and/or effort level, recording the change in the session. */
  async setModel(threadId: string, change: SessionModelChange): Promise<void> {
    return this.sessionModels.set(this.lifecycle.get(threadId).session, change);
  }

  /** Cycle pinned models or thinking levels through the SDK's session operations. */
  async cycle(threadId: string, cycle: Cycle): Promise<void> {
    return this.sessionModels.cycle(this.lifecycle.get(threadId).session, cycle);
  }

  async compact(threadId: string, instructions?: string): Promise<{ tokensBefore: number; summary: string }> {
    const result = await this.lifecycle.get(threadId).session.compact(instructions);
    return { tokensBefore: result.tokensBefore, summary: result.summary };
  }

  async reload(threadId: string): Promise<void> {
    const thread = this.lifecycle.get(threadId);
    thread.tap.clear();
    await thread.ui.reloading(() => thread.session.reload());
  }

  /** Reloads every open session that is not running a prompt, so a package that was installed, updated or removed is seen. Returns how many reloaded; a session that fails to reload is logged and skipped. */
  async reloadIdleSessions(): Promise<number> {
    let reloaded = 0;
    for (const [id, thread] of [...this.lifecycle.threads]) {
      if (thread.session.isStreaming) continue;
      try {
        await this.reload(id);
        reloaded++;
      } catch (error) {
        this.logger.warn(`Could not reload thread ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return reloaded;
  }

  /** `/export`: HTML by default, JSONL when the path ends in `.jsonl`. Returns where pi wrote it. */
  async exportSession(threadId: string, path?: string): Promise<{ path: string; format: 'html' | 'jsonl' }> {
    const { session, info } = this.lifecycle.get(threadId);
    // pi writes relative paths (and its default file name) into the process's folder; the thread's folder is the one that makes sense.
    const target = path ? resolve(info.cwd, path) : join(info.cwd, `pi-session-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
    if (target.toLowerCase().endsWith('.jsonl')) return { path: session.exportToJsonl(target), format: 'jsonl' };
    return { path: await session.exportToHtml(target), format: 'html' };
  }

  /** Model context-window lookup for the open session's history. */
  contextWindowLookup(threadId: string): (provider: string | undefined, model: string) => number | undefined {
    return this.sessionModels.contextWindowLookup(this.lifecycle.get(threadId).session);
  }

  /**
   * Whole percent of the model's window the open session's context fills (pi's `getContextUsage()`), for the sidebar's gauge; null while unknown
   * (right after a compaction, before the first response) or when the thread is not open.
   */
  contextShare(threadId: string): number | null {
    const open = this.lifecycle.threads.get(threadId);
    if (!open) return null;
    const usage = open.session.getContextUsage();
    if (!usage || usage.tokens === null || !usage.contextWindow) return null;
    return Math.max(0, Math.round((usage.tokens / usage.contextWindow) * 100));
  }

  /** The context window from the model registry, without opening a session. */
  async modelWindow(provider: string | undefined, model: string): Promise<number | undefined> {
    return this.sessionModels.modelWindow(provider, model);
  }

  /** The context of the session, piece by piece (the context inspector): what pi keeps for the model right now, and what each piece costs. */
  context(threadId: string): SessionContext {
    const { session } = this.lifecycle.get(threadId);
    const usage = session.getContextUsage();
    const contextWindow = usage?.contextWindow ?? (session.model ? this.contextWindowLookup(threadId)(session.model.provider, session.model.id) : undefined) ?? null;
    const summaries = (session.sessionManager.getBranch() as { type: string; summary?: string }[]).filter((entry) => entry.type === 'compaction' && entry.summary).map((entry) => entry.summary as string);
    const items = buildContextItems(session.agent.state.messages as unknown as ContextMessage[], session.agent.state.tools as unknown as ContextTool[], summaries);
    return {
      contextTokens: usage?.tokens ?? null,
      contextWindow,
      estimatedTokens: items.reduce((sum, item) => sum + item.tokens, 0),
      model: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : null,
      groups: groupContextItems(items),
      items,
    };
  }

  /** `/session`, the composer's token meter and the status bar. */
  stats(threadId: string): SessionStats {
    const { session, info, ui } = this.lifecycle.get(threadId);
    const stats = session.getSessionStats();
    const usage = session.getContextUsage();
    const contextWindow = usage?.contextWindow ?? (session.model ? this.contextWindowLookup(threadId)(session.model.provider, session.model.id) : undefined) ?? null;
    const compaction = session.settingsManager.getCompactionSettings(session.model);
    return {
      sessionId: stats.sessionId,
      sessionFile: stats.sessionFile ?? null,
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      toolResults: stats.toolResults,
      totalMessages: stats.totalMessages,
      tokens: stats.tokens,
      cost: stats.cost,
      contextTokens: usage?.tokens ?? null,
      contextWindow,
      model: session.model ? { provider: session.model.provider, id: session.model.id, name: session.model.name } : null,
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
      autoCompaction: session.autoCompactionEnabled,
      compactionThreshold: session.autoCompactionEnabled && contextWindow ? Math.max(0, contextWindow - compaction.reserveTokens) : null,
      streaming: session.isStreaming,
      waitingForAnswer: ui.size > 0,
      cwd: info.cwd,
    };
  }

  /** `!command`: runs the shell command through pi (recorded in the session, sent to the model with the next prompt). */
  executeBash(threadId: string, command: string, onChunk: (chunk: string) => void, excludeFromContext = false): Promise<BashRun> {
    return this.lifecycle.get(threadId).session.executeBash(command, onChunk, { excludeFromContext });
  }

  abortBash(threadId: string): void {
    this.lifecycle.threads.get(threadId)?.session.abortBash();
  }

  isBashRunning(threadId: string): boolean {
    return this.lifecycle.threads.get(threadId)?.session.isBashRunning ?? false;
  }

  /** Subscribes to the session's events; returns the unsubscribe function. */
  subscribe(threadId: string, listener: (event: PiSessionEvent) => void): () => void {
    return this.lifecycle.get(threadId).session.subscribe(listener);
  }

  dispose(threadId: string): void {
    this.lifecycle.dispose(threadId);
  }

  onModuleDestroy(): void {
    this.lifecycle.close();
  }

  private uiHooks(threadId: string, cwd: string): SessionUiHooks {
    return {
      dialogsChanged: () => {
        for (const listener of [...this.dialogsChangedListeners]) listener(threadId);
      },
      unattached: (event) => {
        for (const listener of [...this.unattachedUiListeners]) {
          try {
            listener(threadId, event);
          } catch (error) {
            this.logger.warn(`Unattached UI listener failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },
      treeChanged: () => this.emitTreeChanged(threadId),
      toolStarting: (toolName, args) => {
        const start: ToolStart = { threadId, cwd, toolName, args };
        for (const listener of this.toolStartListeners) {
          try {
            listener(start);
          } catch (error) {
            this.logger.warn(`Tool start listener failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      },
    };
  }

  private emitTurnStarted(threadId: string): void {
    for (const listener of [...this.turnListeners]) {
      try {
        listener(threadId);
      } catch (error) {
        this.logger.warn(`Turn listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
