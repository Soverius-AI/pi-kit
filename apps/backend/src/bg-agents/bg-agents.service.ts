import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { BACKGROUND_CONTEXT, type Context, withAbortSignal, withCancel } from '@earendil-works/chord/context';
import { type Conversation, type ConversationId, createRegistry, type Harness as DurableHarness, Harness, type Submission, type SubmissionId, UsageDoc, watchEvents } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import type { Models } from '@earendil-works/pi-ai';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { DatabaseService } from '../db/database.service';
import { loadPi } from '../pi/load-pi';
import { createModelRuntime } from '../pi/model-runtime';
import { type AgentTokens, type AgentQuestionDialog, type BgAgent, type PiDialogAnswer } from '@pi-kit/protocol';
import { AgentDoc, agentMessage, type AgentRecord, createAgentExtension } from './agent-extension';
import type { AgentsHook } from './agent-tools';
import { BgAgentRunner } from './bg-agent-runner';
import { type AgentPermission, type AgentStatus, type BgAgentRow, BgAgentsRepository } from './bg-agents.repository';
import { openDurableStore, type OwnerLock, STORE_FILE, StoreOwnedError, takeOwnerLock } from './durable-storage';
import { crashLoop, Holds } from './process-job';
import type { AnsweredBy } from './questions';
import { AgentQuestions } from './agent-questions';
import { REPORT_MESSAGE, THREAD_HOST, type ThreadHost } from './thread-host';

const ctx: Context = BACKGROUND_CONTEXT;

/** A tool call of an agent about to run, as the coordination lease takes it (the shape of `ToolStart`). */
export interface AgentToolStart {
  threadId: string;
  cwd: string;
  toolName: string;
  args: Record<string, unknown>;
}
/** What is told about an agent's work in its thread's folder: `started` is awaited before the agent gets the work. */
export interface AgentWorkWatch {
  started(agentId: string, threadId: string, folder: string): Promise<void>;
  ended(agentId: string): void;
}
/** The statuses of an agent that does no work: a stretch of its work ends with one of them. */
const STOPPED: ReadonlySet<AgentStatus> = new Set(['done', 'failed', 'stopped']);
/** pi-durable's ids are branded numbers; `bg_agents` keeps them as text. */
const conversationId = (id: string): ConversationId => Number(id) as ConversationId;
const submissionId = (id: string): SubmissionId => Number(id) as SubmissionId;

export interface SpawnInput {
  threadId: string;
  name: string;
  role: string;
  brief: string;
  permission?: AgentPermission;
  /** `provider/modelId` (the model id may have slashes of its own); absent: the host's default model. */
  model?: string;
}

/** Whether background agents run in this backend, and why not (`GET /api/health`). */
export interface BgAgentsState {
  enabled: boolean;
  reason?: string;
}

/**
 * The one durable host of the backend: a pi-durable `Harness` on `bg-agents.sqlite` behind the
 * owner lock, opened after the model runtime, resumed, closed on destroy. Owns the agent lifecycle, runner,
 * permissions and reports; AgentQuestions owns question transitions behind this facade.
 */
@Injectable()
export class BgAgentsService implements OnModuleInit, OnModuleDestroy, AgentsHook {
  private readonly logger = new Logger(BgAgentsService.name);
  private harness: DurableHarness | undefined;
  private lock: OwnerLock | undefined;
  private disabled: string | undefined = 'Background agents have not started yet.';
  /** Set by `onModuleInit`: a new `ModelRuntime` when the agent folder's `models.json` or `auth.json` changed since the last one. */
  private refreshModels: (() => Promise<void>) | undefined;
  /** The context window of `provider/modelId` from pi's model registry; undefined for a model pi does not know or the host's default. */
  private windowOf: ((model: string | null) => number | undefined) | undefined;
  private readonly changeListeners = new Set<(threadId: string) => void>();
  readonly holds = new Holds();
  private readonly questions: AgentQuestions;
  /** Each agent's record, as last read or written (its counts, its worktree). */
  private readonly records = new Map<string, AgentRecord>();
  private readonly toolListeners = new Set<(start: AgentToolStart) => void>();
  /** Told when an agent sets to work in its thread's folder and when it stops (the snapshots around its work); see `watchWork`. */
  private work: AgentWorkWatch | undefined;
  /** `<agentId>/<ref>` of the synthetic reports already handed over by this process. */
  private readonly endings = new Set<string>();

  constructor(
    @Inject(CONFIG) private readonly config: Pick<BackendConfig, 'dataDir'>,
    private readonly database: DatabaseService,
    private readonly agents: BgAgentsRepository,
    @Inject(THREAD_HOST) private readonly threads: ThreadHost,
    private readonly runner: BgAgentRunner,
  ) {
    this.questions = new AgentQuestions(() => this.require(), this.agents, this.threads, (id) => this.changed(id));
    this.runner.useActions({ send: (id, text, mode, requestId) => this.send(id, text, mode, requestId), stop: (id) => this.stop(id) });
    this.runner.onLive = (id) => this.changed(id);
  }

  /** Told when the agents of a thread changed (a spawn, a status, what one does right now): the status channel pushes the list. */
  onChange(listener: (threadId: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async onModuleInit(): Promise<void> {
    try {
      // The main sessions get a runtime each time they open; the Harness keeps one `Models`, so it is a proxy to the current runtime,
      // which is made again when the files it reads changed (a provider added in Settings, the e2e tests' fake model).
      const pi = await loadPi();
      const dir = pi.getAgentDir();
      const stampOf = (): string => ['models.json', 'auth.json'].map((file) => { try { return statSync(join(dir, file)).mtimeMs; } catch { return 0; } }).join(':');
      let current = await createModelRuntime(pi);
      let stamp = stampOf();
      this.refreshModels = async () => {
        if (stampOf() === stamp) return;
        current = await createModelRuntime(pi);
        stamp = stampOf();
      };
      this.windowOf = (model) => {
        if (!model) return undefined;
        const slash = model.indexOf('/');
        return slash > 0 ? current.getModel(model.slice(0, slash), model.slice(slash + 1))?.contextWindow : undefined;
      };
      const models = new Proxy({} as Models, {
        get: (_target, key) => {
          const value = (current as unknown as Record<PropertyKey, unknown>)[key];
          return typeof value === 'function' ? value.bind(current) : value;
        },
      });
      await this.open(models);
    } catch (error) {
      this.disabled = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Background agents are off: ${this.disabled}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  state(): BgAgentsState {
    return this.harness ? { enabled: true } : { enabled: false, reason: this.disabled };
  }

  /**
   * Opens the store with `models` (pi-kit's `ModelRuntime`, which is a pi-ai `Models`): the lock first, then the Harness, then
   * every unfinished agent is held or followed again. The durable store follows the app database's protection.
   */
  async open(models: Models): Promise<void> {
    if (this.harness) return;
    const key = this.database.recoveryKey();
    let lock: OwnerLock;
    try {
      lock = takeOwnerLock(this.config.dataDir);
    } catch (error) {
      if (error instanceof StoreOwnedError) throw new Error(`Another backend${error.pid === undefined ? '' : ` (pid ${error.pid})`} owns the background agents of this data folder.`, { cause: error });
      throw error;
    }
    try {
      const registry = createRegistry();
      registry.install(
        createAgentExtension({
          holds: this.holds,
          cleanup: { begin: (id, intent) => this.patch(id, { cleanup: intent }), end: (id) => this.patch(id, { cleanup: null }) },
          report: (id, reportId, text) => this.report(id, reportId, text),
          asked: (id, questionId) => this.questions.asked(id, questionId),
          askUser: (id, questionId, origin, text, choices, signal) => this.questions.askUser(id, questionId, origin, text, choices, signal),
          allowAll: (id) => this.allowAll(id),
          toolStarting: (id, call) => this.toolStarting(id, call),
          beforeRequest: (id) => this.beforeRequest(id),
          sendFrom: (from, to, text, mode, requestId) => this.sendFrom(from, to, text, mode, requestId),
          listFor: (id) => this.listFor(id),
        }),
      );
      const storage = await SqliteStorage.open(openDurableStore(join(this.config.dataDir, STORE_FILE), key));
      this.harness = await Harness.open(
        storage,
        {
          models,
          registry,
          env: async ({ conversationId, read }, context) => {
            const agent = await read.snapshot(AgentDoc, conversationId, context);
            const cwd = agent?.worktree?.path ?? (agent?.threadId ? this.folderOf(agent.threadId) : undefined);
            return cwd ? new NodeExecutionEnv({ cwd }) : undefined;
          },
          onReport: (error) => this.logger.warn(`pi-durable reported: ${error instanceof Error ? error.message : String(error)}`),
        },
        ctx,
      );
      this.lock = lock;
      this.disabled = undefined;
      void this.harness.closed.then((end) => {
        if (end.reason === 'failed') {
          this.disabled = `The agents store failed: ${end.error instanceof Error ? end.error.message : String(end.error)}`;
          this.logger.error(this.disabled);
          this.harness = undefined;
        }
      });
      this.recover();
      this.harness.resume();
      this.logger.log(`Background agents ready (store owner epoch ${lock.epoch}).`);
    } catch (error) {
      lock.release();
      throw error;
    }
  }

  async close(): Promise<void> {
    const harness = this.harness;
    this.harness = undefined;
    this.disabled = 'The backend is shutting down.';
    if (harness) await harness.close(ctx).catch((error: unknown) => this.logger.warn(`Closing the agents store failed: ${error instanceof Error ? error.message : String(error)}`));
    this.lock?.release();
    this.lock = undefined;
  }

  available(): boolean {
    return !!this.harness;
  }

  /** Told before a tool of an agent runs: the coordination lease is taken. */
  onToolStart(listener: (start: AgentToolStart) => void): () => void {
    this.toolListeners.add(listener);
    return () => this.toolListeners.delete(listener);
  }

  /**
   * Told when an agent is about to work in its thread's folder (awaited: the folder is snapshotted before the agent gets the work) and when it
   * stops (done, failed or stopped). An agent in a worktree of its own is not told about: what it changes comes back with the merge.
   */
  watchWork(work: AgentWorkWatch): void {
    this.work = work;
  }

  /**
   * Starts an agent for the thread: an ownerless conversation with the brief as its first input, in the thread's folder or,
   * `isolated`, in a worktree of its own; refused while the project is untrusted or has switched agents off.
   */
  async spawn(input: SpawnInput): Promise<BgAgentRow> {
    const harness = this.require();
    const refused = await this.threads.allowed(input.threadId);
    if (refused) throw new Error(refused);
    await this.refreshModels?.();
    const permission = input.permission ?? 'read-only';
    const record: AgentRecord = { threadId: input.threadId, name: input.name, role: input.role, brief: input.brief, permission, worktree: null, turns: 0 };
    const slash = input.model?.indexOf('/') ?? -1;
    const [provider, modelId] = input.model && slash > 0 ? [input.model.slice(0, slash), input.model.slice(slash + 1)] : [];
    const conversation = await harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { cwd: this.folderOf(input.threadId), ...(provider && modelId ? { model: { provider, modelId } } : {}) },
        init: async (tx, id) => {
          Object.assign(await tx.doc(AgentDoc, id), record);
        },
      },
      ctx,
    );
    const id = String(conversation.id);
    this.agents.insert(
      { id, threadId: input.threadId, name: input.name, role: input.role, model: input.model ?? null, permission, brief: input.brief, submissionId: null, status: 'active', createdAt: Date.now() },
      this.epoch,
    );
    this.records.set(id, record);
    if (permission === 'isolated') await this.writeRecord(id, { worktree: await this.threads.isolate(input.threadId, id, input.name) });
    await this.settingToWork(id, input.threadId);
    const submission = await conversation.submit({ type: 'input', content: input.brief, requestId: `spawn:${id}` }, ctx);
    this.patch(id, { submissionId: String(submission.id) });
    await this.attach(id);
    this.follow(id, submission);
    return this.agents.get(id) as BgAgentRow;
  }

  /** More instructions for a running agent, through its inbox; `requestId` keeps a retried call from sending twice. */
  async send(id: string, text: string, mode: 'steer' | 'followUp', requestId: string): Promise<void> {
    const conversation = await this.require().conversation(conversationId(id), ctx);
    const row = this.agents.get(id);
    if (!conversation || !row) throw new Error(`Agent ${id} does not exist.`);
    if (row.status === 'stopped' || row.status === 'failed') throw new Error(`Agent ${id} is ${row.status}; start another.`);
    // A finished agent that gets more to do is at work again: followed into its log before the input lands, and active in the panel.
    if (!this.runner.liveOf(id)) await this.attach(id);
    if (row.status === 'done') {
      await this.settingToWork(id, row.threadId);
      // Deleted or stopped during the snapshot: it gets no more work.
      const now = this.agents.get(id)?.status;
      if (!now || now === 'stopped' || now === 'failed') throw new Error(`Agent ${id} was stopped or deleted.`);
    }
    const submission = await conversation.submit({ type: 'input', content: text, whenBusy: mode, requestId }, ctx);
    // Its old report answered the old task: cleared, so a follow-up that ends without one is told to the main agent too.
    if (this.agents.get(id)?.status === 'done') this.patch(id, { status: 'active', finishedAt: null, report: null });
    this.follow(id, submission);
  }

  /** The agent's status once its run ends; cancelling the caller's wait leaves the agent running. */
  async wait(id: string, signal?: AbortSignal): Promise<AgentStatus> {
    signal?.throwIfAborted();
    const row = this.agents.get(id);
    if (!row) throw new Error(`Agent ${id} does not exist.`);
    if (row.status !== 'active' || !row.submissionId) return row.status;
    const waiting = withCancel(signal ? withAbortSignal(signal, ctx) : ctx);
    try {
      const submission = await this.require().submission(submissionId(row.submissionId), waiting.context);
      await submission?.wait(waiting.context);
      await new Promise((resolve) => setImmediate(resolve)); // `follow` records the end right after the wait settles
      return this.agents.get(id)?.status ?? row.status;
    } finally {
      waiting.cancel();
    }
  }

  /** The agent's report goes to its thread as a custom message the main agent sees and the transcript attributes. */
  private async report(id: string, reportId: string, text: string): Promise<void> {
    const row = this.agents.get(id);
    if (!row) throw new Error(`Agent ${id} does not exist.`);
    this.patch(id, { report: text });
    await this.threads.deliver(row.threadId, { customType: REPORT_MESSAGE, content: `Report from agent "${row.name}": ${text}`, display: true, details: { agentId: id, name: row.name, ref: reportId, reportId } });
  }

  /** `agent_reply`: the main agent's answer; refused for a user question. */
  async reply(id: string, questionId: string, text: string): Promise<void> {
    await this.questions.answer(id, questionId, 'main', text);
  }

  async forward(id: string, questionId: string, note?: string): Promise<void> {
    await this.questions.forward(id, questionId, note);
  }

  async answerInterrupt(interruptId: string, answer: PiDialogAnswer | 'cancelled'): Promise<boolean> {
    return this.questions.answerInterrupt(interruptId, answer);
  }

  async answer(id: string, questionId: string, by: AnsweredBy, text: string | null): Promise<void> {
    await this.questions.answer(id, questionId, by, text);
  }

  /** "Allow all" on a blocked action: the agent is `edit` from now on, in its record (what the hook reads) and its row (what the panel shows). */
  private async allowAll(id: string): Promise<void> {
    const row = this.agents.get(id);
    if (!row || row.permission !== 'read-only') return;
    await this.writeRecord(id, { permission: 'edit' });
    this.patch(id, { permission: 'edit' });
    this.logger.log(`Agent ${id} (${row.name}) may edit from now on: the user allowed all.`);
    this.changed(id, row.threadId);
  }

  private toolStarting(id: string, call: { name: string; arguments: unknown }): void {
    const row = this.agents.get(id);
    const cwd = this.records.get(id)?.worktree?.path ?? (row ? this.folderOf(row.threadId) : undefined);
    if (!row || !cwd) return;
    for (const listener of [...this.toolListeners]) listener({ threadId: row.threadId, cwd, toolName: call.name, args: (call.arguments ?? {}) as Record<string, unknown> });
  }

  /** Records the turn count and refreshes spend before a model request. */
  private async beforeRequest(id: string): Promise<void> {
    const row = this.agents.get(id);
    const record = await this.recordOf(id);
    if (!row) return;
    await this.refreshUsage(id);
    await this.writeRecord(id, { turns: record.turns + 1 });
  }

  /** `agent_send` between agents: the same thread only, shown to the recipient as a message from the sender. */
  private async sendFrom(fromId: string, toId: string, text: string, mode: 'steer' | 'followUp', requestId: string): Promise<void> {
    const from = this.agents.get(fromId);
    const to = this.agents.get(toId);
    if (!from || !to || to.threadId !== from.threadId) throw new Error(`There is no agent ${toId} in your thread (agent_list names them).`);
    await this.recordOf(fromId);
    await this.send(toId, agentMessage({ id: fromId, name: from.name }, text), mode, requestId);
  }

  private listFor(id: string): { agentId: string; name: string; role: string; status: string }[] {
    const row = this.agents.get(id);
    return row ? this.agents.byThread(row.threadId).filter((other) => other.id !== id).map((other) => ({ agentId: other.id, name: other.name, role: other.role, status: other.status })) : [];
  }

  private async recordOf(id: string): Promise<AgentRecord> {
    const cached = this.records.get(id);
    if (cached) return cached;
    const doc = await this.require().snapshot(AgentDoc, conversationId(id), ctx);
    if (!doc) throw new Error(`Agent ${id} has no record.`);
    this.records.set(id, doc);
    return doc;
  }

  private async writeRecord(id: string, patch: Partial<AgentRecord>): Promise<void> {
    await this.require().commit(async (tx) => {
      Object.assign(await tx.doc(AgentDoc, conversationId(id)), patch);
    }, ctx);
    this.records.set(id, { ...(await this.recordOf(id)), ...patch } as AgentRecord);
  }

  /** The user-facing dialogs published by the thread status channel. */
  userQuestions(threadId: string): AgentQuestionDialog[] {
    return this.questions.userQuestions(threadId);
  }

  /** A deleted thread takes its agents along: stopped, and gone from the index (their durable conversations stay in the store). */
  async deleteThread(threadId: string): Promise<void> {
    for (const row of this.agents.byThread(threadId)) await this.deleteAgent(row.id);
  }

  /** Stops the agent if it runs and forgets it: its row, its transcript log (`pi-bg`'s rows); its durable conversation stays in the store. */
  async deleteAgent(id: string): Promise<void> {
    const row = this.agents.get(id);
    if (!row) return;
    if (this.harness && (row.status === 'active' || row.status === 'blocked')) await this.stop(id).catch(() => undefined);
    await this.runner.forget(id);
    const worktree = (this.harness ? await this.recordOf(id).catch(() => undefined) : undefined)?.worktree;
    if (worktree) await this.threads.discard(worktree).catch((error: unknown) => this.logger.warn(`The worktree of agent ${id} stays: ${error instanceof Error ? error.message : String(error)}`));
    this.agents.remove(id);
    this.records.delete(id);
    this.changed(id, row.threadId);
  }

  /** The row as the API shows it, with what the agent does right now. */
  toAgent(row: BgAgentRow): BgAgent {
    const { id, threadId, name, role, model, permission, brief, status, createdAt, finishedAt, cost, report } = row;
    const live = this.runner.liveOf(id);
    const question = status === 'active' || status === 'blocked' ? this.questions.current(id) : null;
    const record = this.records.get(id);
    return { id, threadId, name, role, model, permission, brief, status, createdAt, finishedAt, cost, report, blocked: this.holds.reasonOf(row.id) ?? null, activity: live?.activity ?? 'idle', tool: live?.tool ?? null, question, answered: this.questions.lastAnswer(id), turns: record?.turns ?? 0, worktree: record?.worktree?.path ?? null, tokens: record?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, context: live && live.contextTokens !== null && (status === 'active' || status === 'blocked') ? { tokens: live.contextTokens, window: this.windowOf?.(model) ?? null } : null };
  }

  /** Aborts the agent's work, background tasks included; its row stays for History. */
  async stop(id: string): Promise<void> {
    const conversation = await this.require().conversation(conversationId(id), ctx);
    this.holds.release(id);
    this.patch(id, { status: 'stopped', finishedAt: Date.now(), cost: await this.refreshUsage(id) });
    await conversation?.abort(ctx, { background: true });
  }

  /** Reads the records of a thread's agents that are not cached yet (finished ones after a restart), so `toAgent` has their turns and tokens. */
  async warm(threadId: string): Promise<void> {
    for (const row of this.agents.byThread(threadId)) {
      if (this.records.has(row.id) || !this.harness) continue;
      try { await this.recordOf(row.id); } catch { /* a record that cannot be read shows zeros */ }
    }
  }

  list(threadId: string): BgAgentRow[] {
    return this.agents.byThread(threadId);
  }

  get(id: string): BgAgentRow | undefined {
    return this.agents.get(id);
  }

  /** The user says the processes of the interrupted command are gone (or may be): the agent goes on. */
  discardCleanup(id: string): void {
    if (!this.agents.get(id)) throw new Error(`Agent ${id} does not exist.`);
    this.patch(id, { cleanup: null, status: 'active' });
    this.holds.release(id);
  }

  /** The user lets an agent go on after the crash-loop limit paused it. */
  resumeAgent(id: string): void {
    if (!this.agents.get(id)) throw new Error(`Agent ${id} does not exist.`);
    this.patch(id, { failures: [], status: 'active' });
    this.holds.release(id);
  }

  // ---- internals

  private get epoch(): number {
    return this.lock?.epoch ?? 0;
  }

  private require(): DurableHarness {
    if (!this.harness) throw new Error(this.disabled ?? 'Background agents are off.');
    return this.harness;
  }

  /** The agent gets work in its thread's folder: the watcher snapshots the folder first. */
  private async settingToWork(id: string, threadId: string): Promise<void> {
    const folder = this.folderOf(threadId);
    if (!this.work || !folder || (await this.recordOf(id)).worktree) return;
    await this.work
      .started(id, threadId, folder)
      .catch((error: unknown) => this.logger.warn(`The snapshot before agent ${id} failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private patch(id: string, patch: Parameters<BgAgentsRepository['update']>[2]): void {
    const was = this.agents.get(id)?.status;
    if (!this.agents.update(id, this.epoch, patch)) this.logger.warn(`A newer backend owns agent ${id}; this write was dropped.`);
    if (patch.status !== undefined || patch.report !== undefined || patch.cost !== undefined || patch.permission !== undefined) this.changed(id);
    if (patch.status && STOPPED.has(patch.status) && was && !STOPPED.has(was)) this.work?.ended(id);
  }

  private changed(id: string, threadId = this.agents.get(id)?.threadId): void {
    if (!threadId) return;
    for (const listener of [...this.changeListeners]) {
      try {
        listener(threadId);
      } catch (error) {
        this.logger.debug(`An agents listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** The agent's transcript, followed into the log for the `pi-bg` agent. */
  private async attach(id: string): Promise<void> {
    if (!this.harness) return;
    try {
      this.runner.attach(id, await watchEvents(this.harness, conversationId(id), ctx));
    } catch (error) {
      this.logger.warn(`Could not follow agent ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private folderOf(threadId: string): string | undefined {
    try {
      return this.threads.cwdOf(threadId);
    } catch {
      return undefined;
    }
  }

  /** What a start does with the agents the last process left: hold what must wait, follow the rest. */
  private recover(): void {
    const now = Date.now();
    for (const row of this.agents.unfinished()) {
      if (row.cleanup) {
        this.holds.hold(row.id, 'cleanup');
        this.patch(row.id, { status: 'blocked' });
        this.logger.warn(`Agent ${row.name} (${row.id}) is held: its command "${row.cleanup.command}" may still run from before the restart.`);
      } else {
        const loop = crashLoop(row.failures, now);
        if (loop.looping) {
          this.holds.hold(row.id, 'crash-loop');
          this.patch(row.id, { failures: loop.failures, status: 'blocked' });
          this.logger.warn(`Agent ${row.name} (${row.id}) is held: it was interrupted ${loop.failures.length} times in ten minutes.`);
        } else {
          this.patch(row.id, { failures: loop.failures, status: 'active' });
        }
      }
      void this.attach(row.id).then(() => this.followAgain(row));
      void this.recordOf(row.id).catch(() => undefined);
      void this.questions.recover(row.id);
    }
  }

  private async followAgain(row: BgAgentRow): Promise<void> {
    if (!row.submissionId || !this.harness) return;
    const submission = await this.harness.submission(submissionId(row.submissionId), ctx).catch(() => undefined);
    if (submission) this.follow(row.id, submission);
  }

  /**
   * Records how the agent's run ends: done, or failed (which counts toward the crash-loop limit). A failed run, and a done one that
   * never called `report`, is told to the main agent, which waits for a report and does not poll; a stopped one is not (someone chose it).
   */
  private follow(id: string, submission: Submission): void {
    void submission
      .wait(ctx)
      .then(async (settled) => {
        const row = this.agents.get(id);
        if (!row || row.status === 'stopped') return;
        if (settled.status === 'done') {
          if (!(await this.inboxEmpty(id))) return; // another input follows: the agent goes on
          this.patch(id, { status: 'done', finishedAt: Date.now(), cost: await this.refreshUsage(id) });
          await this.runner.detach(id);
          const now = this.agents.get(id);
          if (now?.status === 'done' && now.report == null) await this.ended(id, row.name, String(submission.id), `Agent "${row.name}" ended without a report.`);
        } else {
          const reason = typeof settled.detail === 'string' ? settled.detail : (settled.reason ?? null);
          this.patch(id, { status: 'failed', finishedAt: Date.now(), cost: await this.refreshUsage(id), failures: [...row.failures, Date.now()], report: reason });
          if (this.agents.get(id)?.status === 'failed') await this.ended(id, row.name, String(submission.id), `Agent "${row.name}" failed: ${reason ?? 'no reason given'}`);
        }
      })
      .catch((error: unknown) => this.logger.debug(`Following agent ${id} ended: ${error instanceof Error ? error.message : String(error)}`));
  }

  /**
   * The synthetic report of a run that ended without one. Its ref is the submission's, and the row left `active` before it goes out,
   * so a restart (which follows only unfinished agents) or a second follower of the same submission does not say it twice.
   */
  private async ended(id: string, name: string, submission: string, text: string): Promise<void> {
    const ref = `end:${submission}`;
    if (this.endings.has(`${id}/${ref}`)) return;
    this.endings.add(`${id}/${ref}`);
    const row = this.agents.get(id);
    if (!row) return;
    await this.threads.deliver(row.threadId, { customType: REPORT_MESSAGE, content: text, display: true, details: { agentId: id, name, ref } }).catch((error: unknown) => this.logger.warn(`Telling thread ${row.threadId} that agent ${id} ended failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Whether nothing waits in the agent's inbox: a settled input with a queued follow-up is not the end of the agent. */
  private async inboxEmpty(id: string): Promise<boolean> {
    try {
      const inspection = await this.require().inspect(ctx);
      return !inspection.submissions.some((s) => String(s.conversationId) === id && (s.status === 'queued' || s.status === 'placed'));
    } catch {
      return true;
    }
  }

  /** The agent's spend and tokens so far, summed over its models (the conversation's own usage ledger). */
  private async usageOf(id: string): Promise<{ cost: number; tokens: AgentTokens }> {
    const tokens: AgentTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      const usage = await this.require().snapshot(UsageDoc, conversationId(id), ctx);
      let cost = 0;
      for (const u of Object.values(usage?.models ?? {})) {
        cost += u.cost?.total ?? 0;
        tokens.input += u.input ?? 0;
        tokens.output += u.output ?? 0;
        tokens.cacheRead += u.cacheRead ?? 0;
        tokens.cacheWrite += u.cacheWrite ?? 0;
      }
      return { cost, tokens };
    } catch {
      return { cost: 0, tokens };
    }
  }

  /** Writes the agent's tokens to its record and its cost to its row, so the panel shows live numbers. */
  private async refreshUsage(id: string): Promise<number> {
    const { cost, tokens } = await this.usageOf(id);
    try { await this.writeRecord(id, { tokens }); } catch { /* a finished conversation may refuse the write; the row's cost still lands */ }
    if (this.agents.get(id)) this.patch(id, { cost });
    return cost;
  }

  /** For specs: the conversation of an agent. */
  async conversationOf(id: string): Promise<Conversation | undefined> {
    return this.require().conversation(conversationId(id), ctx);
  }
}
