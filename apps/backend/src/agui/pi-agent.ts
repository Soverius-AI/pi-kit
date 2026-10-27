import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AbstractAgent } from '@ag-ui/client';
import { type AgentCapabilities, type BaseEvent, EventType, type Message, type RunAgentInput } from '@ag-ui/core';
import { closeOpenBlocks, createMapContext, interruptFinished, type MapContext, mapEvent, mapUiEvent, type PiEvent, reviewActivity, skillsActivity, subagentRunIdOf } from '@pi-kit/pi-adapter';
import { A2UI_EVENT_TOOL_NAME, isProxiedMcpRun, parseAgentQuestionId, type PiDialogAnswer, type ProxiedMcpRequest, proxiedMcpRequestOf, reviewBatchOf, skillChipsOf } from '@pi-kit/protocol';
import { Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ResumeEntrySchema } from '@ag-ui/core/schemas';
import type { PiDialogRequest } from '@pi-kit/protocol';
import { type PiImage, type PiThreadInfo, PiSessionService } from '../pi/pi-session.service';
import type { DialogAnswer } from '../pi/ui-bridge';
import { expandChips } from './chip-expansion';
import { expandFileRefs, fileRefsOf } from './file-refs';

/** Where a thread's pi session lives; implemented by `ThreadsService` (thread id == session id). */
export interface ThreadResolver {
  prepareRun(threadId: string, cwdHint: string): Promise<{ cwd: string; sessionPath: string; title: string | undefined; leafId?: string; inWorktree?: boolean }>;
  sessionOpened(threadId: string, info: PiThreadInfo): void;
}

export interface PiAgentOptions {
  /** Working folder for a thread the app has not seen before, unless the run names one in `forwardedProps.cwd`. */
  defaultCwd: string;
  threads: ThreadResolver;
  /**
   * Mapping state of runs that ended in an interrupt, by thread. The runtime clones the agent per request,
   * so the state that lets the resuming run continue the same assistant message lives here.
   */
  carry: Map<string, MapContext>;
  /** Answers an MCP App's request (`forwardedProps.__proxiedMCPRequest`) on pi's own MCP connection. */
  relayMcp: (threadId: string, request: ProxiedMcpRequest, signal?: AbortSignal) => Promise<unknown>;
  /** Called once a review batch is recorded in the session: the pending comments of the thread are sent, so they are dropped. */
  reviewRecorded?: (threadId: string) => void;
}

const logger = new Logger('PiAgent');

/** The window in which several dialogs opened together are reported as one interrupt. */
const INTERRUPT_BATCH_MS = 30;

/**
 * The AG-UI face of pi: `CopilotRuntime` registers one of these as agent `pi`, calls
 * `clone()` per request and `run()` for each user turn. A run opens (or reuses) the thread's pi
 * session, maps its events with `mapEvent` and prompts it with the newest user message.
 *
 * Five kinds of run:
 * - a prompt: the newest message is the user's; the run ends when pi settles;
 * - a queued input: `forwardedProps.streamingBehavior` is `steer` or `followUp` while pi is running; the
 *   text is queued with `steer()` / `followUp()` and this run ends at once, the answer streams in the run
 *   that is already going;
 * - a resume: `input.resume` answers the dialogs of an earlier run that ended with
 *   `RUN_FINISHED { outcome: { type: 'interrupt' } }`. pi is still inside the same prompt, so the run
 *   attaches to it, resolves the dialogs and carries on streaming until pi settles or asks again (an answer to a
 *   background agent's question goes to the agents instead, and the run ends at once);
 * - a followed turn: `forwardedProps.followTurn` attaches to a turn pi started by itself, as a resume does;
 * - an MCP App's request: `forwardedProps.__proxiedMCPRequest` (a resource load or a tool call from a widget in the
 *   transcript). It never reaches pi as a prompt: the run relays it to the MCP server pi is connected to and ends
 *   with the server's answer as `RUN_FINISHED.result`, which is where `@copilotkit/angular/mcp-apps` reads it.
 *
 * The run's lifetime belongs to `PiAgentRunner`, which subscribes to this observable and
 * keeps the run going when the HTTP client goes away; only `stop()` aborts it.
 */
export class PiAgent extends AbstractAgent {
  private activeThreadId?: string;

  constructor(
    private readonly sessions: PiSessionService,
    private readonly options: PiAgentOptions,
  ) {
    super({ agentId: 'pi', description: 'pi coding agent' });
  }

  override clone(): PiAgent {
    return new PiAgent(this.sessions, this.options);
  }

  override async getCapabilities(): Promise<AgentCapabilities> {
    return {
      identity: { name: 'pi', type: 'coding-agent' },
      transport: { streaming: true, resumable: true },
      tools: { supported: true, clientProvided: false },
      humanInTheLoop: { supported: true, interrupts: true, approvals: true },
      custom: { a2ui: true, openGenerativeUI: true },
    };
  }

  override abortRun(): void {
    if (this.activeThreadId) void this.sessions.abort(this.activeThreadId);
  }

  /** `pi.tree`: the session gained an entry, so the tree view refetches. */
  private emitTree(threadId: string, emit: (events: BaseEvent[]) => void): void {
    try {
      const leafId = this.sessions.leafId(threadId);
      emit([{ type: EventType.CUSTOM, name: 'pi.tree', value: { leafId, changed: leafId ? [leafId] : [] } } as BaseEvent]);
    } catch {
      // The session was closed in the meantime; there is no tree to announce.
    }
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const { threadId, runId } = input;
      const unsubscribers: (() => void)[] = [];
      let finished = false;
      let interrupted = false;

      const emit = (events: BaseEvent[]): void => {
        for (const event of events) {
          if (subscriber.closed || finished) return;
          subscriber.next(event);
          if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) finished = true;
        }
        if (finished && !subscriber.closed) subscriber.complete();
      };
      const fail = (message: string, code = 'error'): void => {
        if (finished) return;
        emit([{ type: EventType.RUN_ERROR, message, code } as BaseEvent]);
      };
      /**
       * A resume that cannot be applied. While pi still waits on dialogs the thread stays suspended: the run says why the answer was refused
       * (`pi.notify`) and ends with the same interrupt again, so the log keeps ending in it and the dialogs stay answerable (they are already
       * reported, so no later attach would advertise them). A failed run here would be snapshotted mid-prompt and drop the dialogs. Only
       * when nothing is pending any more is the resume a failed run.
       */
      const refuse = (message: string): void => {
        if (this.sessions.pendingDialogs(threadId).length === 0) return fail(message, 'invalid_resume');
        stillWaiting(mapUiEvent({ kind: 'notify', level: 'error', message }));
      };
      /**
       * Ends a run that did not resume pi while pi still waits on its own dialogs: the dialogs are advertised again and pi's map context
       * stays carried, so the answer that does resume pi continues the same assistant message. Returns false when nothing is pending.
       */
      const stillWaiting = (before: BaseEvent[] = []): boolean => {
        const pending = this.sessions.pendingDialogs(threadId);
        if (pending.length === 0) return false;
        this.sessions.markDialogsReported(threadId, pending.map((d) => d.id));
        interrupted = true;
        const ctx = this.options.carry.get(threadId) ?? createMapContext({ threadId, runId, skipUserMessages: 0 });
        ctx.runId = runId;
        this.options.carry.set(threadId, ctx);
        emit([...before, ...closeOpenBlocks(ctx), interruptFinished(threadId, runId, pending)]);
        return true;
      };

      /** Forwards pi's session events, the extensions' UI calls and their dialogs into this run. */
      const attach = (ctx: MapContext): Promise<void> => {
        let timer: NodeJS.Timeout | undefined;
        let onInterrupt: () => void = () => undefined;
        const interrupt = new Promise<void>((resolve) => (onInterrupt = resolve));

        const flush = (): void => {
          timer = undefined;
          const dialogs = this.sessions.pendingDialogs(threadId, true);
          if (finished || dialogs.length === 0) return;
          this.sessions.markDialogsReported(threadId, dialogs.map((d) => d.id));
          interrupted = true;
          this.options.carry.set(threadId, ctx);
          emit([...closeOpenBlocks(ctx), interruptFinished(threadId, runId, dialogs)]);
          onInterrupt();
        };
        const schedule = (): void => {
          timer ??= setTimeout(flush, INTERRUPT_BATCH_MS);
        };

        unsubscribers.push(
          this.sessions.subscribe(threadId, (event) => {
            // pi turns an exception thrown by a subscriber into a failed run, so never let one escape.
            try {
              emit(subagentEnvelope(event, mapEvent(event, ctx)));
              // pi hands a message to its listeners before it writes the entry, so the new leaf is read a moment later.
              if (event.type === 'message_end' || (event.type === 'compaction_end' && event['aborted'] !== true)) {
                queueMicrotask(() => this.emitTree(threadId, emit));
              }
            } catch (error) {
              fail(error instanceof Error ? error.message : String(error));
            }
          }),
          this.sessions.onUiEvent(threadId, (event) => emit(mapUiEvent(event))),
          this.sessions.onDialogRequested(threadId, schedule),
          () => timer && clearTimeout(timer),
        );
        this.activeThreadId = threadId;
        // Dialogs that opened before this run was listening (and were not reported) count too.
        if (this.sessions.pendingDialogs(threadId, true).length > 0) schedule();
        return interrupt;
      };

      /** Waits for the prompt to end or for an extension to ask something; ends the run in the first case. */
      const settle = async (ctx: MapContext, prompt: Promise<void> | undefined, interrupt: Promise<void>): Promise<void> => {
        if (!prompt) {
          if (!interrupted) await Promise.race([interrupt, nextTick()]);
          if (interrupted) return;
          return emit([finishedEvent(threadId, runId, this.sessions.takeAbortedWhileWaiting(threadId))]);
        }
        // If the run ends in an interrupt first, the prompt's own outcome belongs to the run that resumes it.
        prompt.catch(() => undefined);
        const result = await Promise.race([prompt.then(() => 'done' as const), interrupt.then(() => 'interrupted' as const)]);
        if (result === 'interrupted' || finished) return;
        // A prompt an extension handled itself starts no run, so pi never settles.
        if (!ctx.state.finished) emit(mapEvent({ type: 'agent_settled', aborted: false }, ctx));
      };

      emit([{ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent]);

      if (isProxiedMcpRun(input.forwardedProps)) {
        const request = proxiedMcpRequestOf(input.forwardedProps);
        // A failure is a result, not a failed run: the transcript shows a failed run as an error of its own, and the
        // app's host turns `result.error` into the JSON-RPC error the app expects (the CopilotKit middleware does the same).
        const answer = (result: unknown): void =>
          emit([{ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' }, result } as BaseEvent]);
        if (!request) {
          answer({ error: 'The MCP App sent a request this host does not understand.' });
        } else {
          const aborter = new AbortController();
          unsubscribers.push(() => aborter.abort());
          this.options.relayMcp(threadId, request, aborter.signal).then(answer, (error: unknown) =>
            answer({ error: error instanceof Error ? error.message : String(error) }),
          );
        }
        return () => {
          for (const unsubscribe of unsubscribers) unsubscribe();
        };
      }

      void (async () => {
        try {
          const behavior = streamingBehavior(input);
          // A turn pi started by itself: attach to it as a resume does, before anything is awaited, so the turn's
          // first events are not missed; `whenPromptDone` is the promise the session keeps for such a turn.
          if (isFollowRun(input.forwardedProps)) {
            if (!this.sessions.has(threadId)) return fail('The session is not open.', 'expired');
            const stats = this.sessions.stats(threadId);
            const mcpApp = this.sessions.mcpAppLookup(threadId);
            const ctx = createMapContext({ threadId, runId, skipUserMessages: 0, thinkingLevel: stats.thinkingLevel,
              ...(stats.model ? { model: { provider: stats.model.provider, modelId: stats.model.id } } : {}), ...(mcpApp ? { mcpApp } : {}) });
            const interrupt = attach(ctx);
            return await settle(ctx, this.sessions.whenPromptDone(threadId), interrupt);
          }
          if (input.resume?.length) {
            // A background agent's question is answered through the agents, not pi: the run is its receipt. Such answers never mix with pi's dialogs.
            if (input.resume.every((entry) => parseAgentQuestionId((entry as { interruptId?: string }).interruptId))) {
              for (const raw of input.resume) {
                const entry = ResumeEntrySchema.parse(raw);
                const answered = await this.sessions.answerAgentQuestion(entry.interruptId, entry.status === 'cancelled' ? 'cancelled' : (entry.payload as PiDialogAnswer));
                if (!answered) return refuse(`${entry.interruptId} is not a question of a background agent of this thread.`);
              }
              // pi may be waiting on a dialog of its own at the same time: the thread stays suspended at it, with the context it resumes from.
              if (stillWaiting()) return;
              return emit([{ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } } as BaseEvent]);
            }
            const ctx = this.options.carry.get(threadId) ?? createMapContext({ threadId, runId, skipUserMessages: 0 });
            ctx.runId = runId;
            if (!this.sessions.has(threadId)) {
              return fail('The question can no longer be answered: the session was closed.', 'expired');
            }
            // Validate the whole batch before resolving any promise. A malformed or stale answer must leave pi waiting (see `refuse`).
            // A stale id while nothing is pending goes through: that is the answer to a dialog Stop dismissed, which ends as a stopped run.
            const pending = this.sessions.pendingDialogs(threadId);
            let answers: { id: string; answer: DialogAnswer }[];
            try {
              const seen = new Set<string>();
              answers = input.resume.map((raw) => {
                const entry = ResumeEntrySchema.parse(raw);
                if (seen.has(entry.interruptId)) throw new Error('An interrupt can only be answered once per resume.');
                seen.add(entry.interruptId);
                const dialog = pending.find((dialog) => dialog.id === entry.interruptId);
                if (!dialog && pending.length) throw new Error('The interrupt is no longer pending.');
                return { id: entry.interruptId, answer: entry.status === 'cancelled' ? { status: 'cancelled' } : toAnswer(entry.payload, dialog?.request) };
              });
            } catch (error) {
              return refuse(error instanceof Error ? error.message : 'Invalid interrupt answer.');
            }
            const interrupt = attach(ctx);
            for (const { id, answer } of answers) {
              if (!this.sessions.answerDialog(threadId, id, answer)) {
                logger.warn(`Interrupt ${id} of thread ${threadId} was already gone.`);
              }
            }
            // A partial resume still advertises unanswered dialogs, including ones a previous run already reported.
            const remaining = this.sessions.pendingDialogs(threadId);
            if (remaining.length) {
              interrupted = true;
              this.options.carry.set(threadId, ctx);
              emit([...closeOpenBlocks(ctx), interruptFinished(threadId, runId, remaining)]);
              return;
            }
            return await settle(ctx, this.sessions.whenPromptDone(threadId), interrupt);
          }

          const typed = newestUserPrompt(input.messages);
          const chips = typed ? skillChipsOf(input.forwardedProps) : [];
          const prompt = typed ?? a2uiEventPrompt(input.messages);
          if (!prompt) return emit([finishedEvent(threadId, runId)]);

          const target = await this.options.threads.prepareRun(threadId, resolveCwd(input, this.options.defaultCwd));
          const info = await this.sessions.open(threadId, {
            cwd: target.cwd,
            sessionPath: target.sessionPath,
            title: target.title,
            leafId: target.leafId,
            ...(target.inWorktree ? { forceCwd: true } : {}),
          });
          this.options.threads.sessionOpened(threadId, info);

          if (this.sessions.isStreaming(threadId)) {
            if (!behavior) return fail('This thread is already running.', 'busy');
            const queue = behavior === 'steer' ? this.sessions.steer : this.sessions.followUp;
            // Chips are expanded here too: pi expands only a leading `/skill:`, and the message is queued as text. A queued message
            // is not recorded as a `pi-kit.skills` entry (it would sit before the wrong prompt), so it reads as `/skill:name …` after a reload.
            const queued = chips.length > 0 ? expandChips(chips, prompt.text, await this.sessions.chipResources(threadId)) : prompt.text;
            await queue.call(this.sessions, threadId, expandFileRefs(info.cwd, fileRefsOf(input)) + queued, prompt.images);
            return emit([finishedEvent(threadId, runId)]);
          }

          // Review comments: the structured batch goes into the session first, as a `custom` entry that pi
          // never sends to the model; the prompt carries the same comments as text. The transcript shows the batch as a chip.
          const review = reviewBatchOf(input.forwardedProps);
          if (review) {
            try {
              const entryId = this.sessions.appendReview(threadId, review);
              emit([reviewActivity(entryId, review.comments)]);
              this.options.reviewRecorded?.(threadId);
            } catch (error) {
              logger.warn(`Could not record the review batch of thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          // Skill and prompt-template chips: pi gets one `<skill>` block per chip and then the sentence; the session records the chips
          // and the sentence as a `custom` entry, so the transcript draws the chips over the sentence instead of the instructions.
          let body = prompt.text;
          if (chips.length > 0) {
            const expanded = expandChips(chips, prompt.text, await this.sessions.chipResources(threadId));
            if (expanded !== prompt.text) {
              body = expanded;
              try {
                const entryId = this.sessions.appendSkills(threadId, { chips, text: prompt.text.trim() });
                emit([skillsActivity(entryId, chips)]);
              } catch (error) {
                logger.warn(`Could not record the chips of thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }

          const text = expandFileRefs(info.cwd, fileRefsOf(input)) + body;
          const mcpApp = this.sessions.mcpAppLookup(threadId);
          // The client already has what the user typed; a click on a surface made a prompt it has not seen, so pi's echo of it is shown.
          const ctx = createMapContext({ threadId, runId, model: info.model, thinkingLevel: info.thinkingLevel, skipUserMessages: typed ? 1 : 0, ...(mcpApp ? { mcpApp } : {}) });
          const interrupt = attach(ctx);
          await settle(ctx, this.sessions.prompt(threadId, text, { images: prompt.images }), interrupt);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
      })();

      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
        if (!finished) this.abortRun();
        if (!interrupted) this.options.carry.delete(threadId);
        this.activeThreadId = undefined;
      };
    });
  }
}

/**
 * What concerns a background agent in the main thread is attributed to it: `agent_spawn`'s finished tool call and the agent's
 * messages (a report, a question, the receipt of an answer: `pikit.agent-*` custom messages) are wrapped in `SUBAGENT_STARTED` /
 * `SUBAGENT_FINISHED`. The verifier allows an id once per run, so each envelope has its own: `<agentId>/spawn` and `<agentId>/<ref>`
 * (`sessionToMessages` gives a stored message the same id).
 */
export function subagentEnvelope(event: PiEvent, events: BaseEvent[]): BaseEvent[] {
  const wrap = (subagentRunId: string, name: string, description: string, attributed: BaseEvent[], extra: Record<string, unknown> = {}): BaseEvent[] => [
    { type: EventType.SUBAGENT_STARTED, subagentRunId, name, description, ...extra } as BaseEvent,
    ...attributed,
    { type: EventType.SUBAGENT_FINISHED, subagentRunId, outcome: { type: 'success' } } as BaseEvent,
  ];
  if (event.type === 'tool_execution_end' && event['toolName'] === 'agent_spawn' && event['isError'] !== true) {
    const details = (event['result'] as { details?: { agentId?: string; name?: string; role?: string } } | undefined)?.details;
    if (details?.agentId && details.name) return wrap(`${details.agentId}/spawn`, details.name, details.role ?? '', events, { parentToolCallId: String(event['toolCallId']) });
  }
  if (event.type === 'message_end') {
    const message = event['message'] as { role?: string; customType?: string; details?: { name?: string } } | undefined;
    const subagentRunId = message?.role === 'custom' ? subagentRunIdOf(message.customType, message.details) : undefined;
    if (subagentRunId && message?.details?.name) return wrap(subagentRunId, message.details.name, message.customType?.slice('pikit.agent-'.length) ?? '', events.map((e) => ({ ...e, subagentRunId })));
  }
  return events;
}

/** The message a run prompts pi with: the newest one, if the user wrote it. */
export function newestUserMessage(messages: Message[]): Extract<Message, { role: 'user' }> | undefined {
  const last = messages.at(-1);
  return last?.role === 'user' ? last : undefined;
}

/** `forwardedProps.followTurn`: the run attaches to a turn pi started by itself instead of prompting. */
export function isFollowRun(props: unknown): boolean {
  return (props as { followTurn?: unknown } | undefined)?.followTurn === true;
}

/** `forwardedProps.streamingBehavior`: how an input that arrives while pi is running is queued. */
export function streamingBehavior(input: Pick<RunAgentInput, 'forwardedProps'>): 'steer' | 'followUp' | undefined {
  const value = (input.forwardedProps as { streamingBehavior?: unknown } | undefined)?.streamingBehavior;
  return value === 'steer' || value === 'followUp' ? value : undefined;
}

const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, INTERRUPT_BATCH_MS * 2));

const finishedEvent = (threadId: string, runId: string, aborted = false): BaseEvent =>
  ({
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    outcome: { type: aborted ? 'cancelled' : 'success' },
    ...(aborted ? { result: { aborted: true } } : {}),
  }) as BaseEvent;

/** A resume payload as the renderer sends it: `{ confirmed }` for confirm, `{ value }` for the others. */
function toAnswer(payload: unknown, request?: PiDialogRequest): DialogAnswer {
  const p = (payload ?? {}) as { confirmed?: unknown; value?: unknown };
  const confirmed = typeof payload === 'boolean' ? payload : p.confirmed;
  const value = typeof payload === 'string' ? payload : p.value;
  if ((!request || request.method === 'confirm') && typeof confirmed === 'boolean') return { status: 'resolved', confirmed };
  if ((!request || request.method !== 'confirm') && typeof value === 'string') {
    if (request?.method === 'select' && !request.options?.includes(value)) throw new Error('Select an available option.');
    return { status: 'resolved', value };
  }
  throw new Error('The resume payload does not answer this dialog.');
}

/** `forwardedProps.cwd` if it names an existing absolute folder, else the default. */
function resolveCwd(input: RunAgentInput, fallback: string): string {
  const cwd = (input.forwardedProps as { cwd?: unknown } | undefined)?.cwd;
  if (typeof cwd === 'string' && isAbsolute(cwd) && existsSync(cwd) && statSync(cwd).isDirectory()) return cwd;
  return fallback;
}

interface UserPrompt {
  text: string;
  images: PiImage[];
}

/**
 * The prompt for a click on an A2UI surface. The runtime's A2UI middleware turns
 * `forwardedProps.a2uiAction` into an assistant `log_a2ui_event` tool call followed by a tool message that says what
 * the user did; pi has no such tool, so the run prompts with that text instead.
 */
export function a2uiEventPrompt(messages: Message[]): UserPrompt | undefined {
  const last = messages.at(-1);
  if (last?.role !== 'tool') return undefined;
  const call = messages.find((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === last.toolCallId && c.function.name === A2UI_EVENT_TOOL_NAME));
  if (!call || typeof last.content !== 'string' || !last.content.trim()) return undefined;
  return { text: `The user used the interface you showed them. ${last.content.trim()}`, images: [] };
}

/** The text and inline images of the last message, if that message is from the user. */
function newestUserPrompt(messages: Message[]): UserPrompt | undefined {
  const last = messages.at(-1);
  if (last?.role !== 'user') return undefined;
  if (typeof last.content === 'string') return { text: last.content, images: [] };
  const text: string[] = [];
  const images: UserPrompt['images'] = [];
  for (const part of last.content) {
    if (part.type === 'text') text.push(part.text);
    else if (part.type === 'image' && part.source.type === 'data') {
      images.push({ data: part.source.value, mimeType: part.source.mimeType });
    }
  }
  return { text: text.join('\n'), images };
}
