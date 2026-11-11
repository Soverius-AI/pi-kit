import { randomUUID } from 'node:crypto';
import { type BaseEvent, EventType } from '@ag-ui/client';
import type { JsonPatchOperation, Message } from '@ag-ui/core';
import type { Context } from '@earendil-works/chord/context';
import type { Op } from '@earendil-works/chord/delta';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import {
  type Conversation,
  ConversationTranscript,
  type ConversationView,
  type ConversationWatch,
  type EntryId,
  type EntryRecord,
  type Harness,
  LiveDoc,
  type LiveState,
  type TranscriptView,
  type WatchEnd,
} from '@earendil-works/pi-durable';
import {
  closeOpenBlocks,
  createMapContext,
  type MapContext,
  mapEvent,
  messagesSnapshot,
  type PiEvent,
} from '@pi-kit/pi-adapter';
import { activityId, AGENT_LIVE_SYNC_RUN, type PiActivityType } from '@pi-kit/protocol';
import { AGENT_MESSAGE } from './agent-extension';
import { DocsPatch, type StreamChange } from './docs-patch';

/** The views of one conversation as the runner takes them (`AgentViews`); the service opens them. */
export type AgentViewStream = Pick<AgentViews, 'view' | 'timing' | 'start' | 'stop'>;

/** When each live tool call's task started and ended (wall-clock ms), by call id: the `timing` of the `pi.agent_live` content. */
export type ToolTiming = Readonly<Record<string, { readonly startedAt?: number; readonly endedAt?: number }>>;

/** What an agent does right now, for the panel. */
export interface AgentLive {
  activity: 'idle' | 'running' | 'tool';
  tool: string | null;
  /** The context after the last model response, as pi counts it (the prompt and the answer), or null before the first. */
  contextTokens: number | null;
}

/** What the next request will carry: the last response's prompt (input, cache reads and writes) and its answer. */
export function contextOf(message: AssistantMessage | undefined): number | null {
  const usage = message?.usage;
  return usage ? usage.input + usage.cacheRead + usage.cacheWrite + usage.output : null;
}

const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : ''))
          .join('')
      : '';

/** The transcript of a background agent as AG-UI messages, from its durable entries (the `MESSAGES_SNAPSHOT` of a run). */
export function entriesToMessages(entries: readonly EntryRecord[]): Message[] {
  const out: Message[] = [];
  for (const entry of entries) {
    const id = String(entry.id);
    const model = entry.model?.[0] as UserMessage | AssistantMessage | ToolResultMessage | undefined;
    if (!model) continue;
    if (entry.kind === 'pi.user' || (model.role === 'user' && !entry.kind.startsWith('pi.'))) {
      const from = AGENT_MESSAGE.exec(text(model.content));
      out.push({
        id,
        role: 'user',
        content: text(model.content),
        ...(from ? { subagentRunId: `${from[2]}/${id}` } : {}),
      } as Message);
    } else if (entry.kind === 'pi.assistant' && model.role === 'assistant') {
      const thinking = model.content
        .filter((block) => block.type === 'thinking')
        .map((block) => block.thinking)
        .join('\n');
      if (thinking) out.push({ id: `${id}:think`, role: 'reasoning', content: thinking } as Message);
      const calls = model.content
        .filter((block) => block.type === 'toolCall')
        .map((block) => ({
          id: block.id,
          type: 'function' as const,
          function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
        }));
      out.push({
        id,
        role: 'assistant',
        content: text(model.content),
        ...(calls.length ? { toolCalls: calls } : {}),
      } as Message);
    } else if (entry.kind === 'pi.tool-result' && model.role === 'toolResult') {
      out.push({
        id,
        role: 'tool',
        toolCallId: model.toolCallId,
        content: text(model.content),
        ...(model.isError ? { error: 'error' } : {}),
      } as Message);
    }
  }
  return out;
}

/**
 * The timing of the calls `pi.live` lists (`tools`, `nestedTools`), read from their task records when a slot appears or changes
 * status, and again while a done one's task has not ended; a call gone from both lists is dropped.
 */
class ToolTimes {
  private timing: ToolTiming = {};
  /** The status each listed call had when its task was last read. */
  private readonly read = new Map<string, string>();

  constructor(
    private readonly tasks: Pick<Harness, 'getTask'>,
    private readonly context: Context,
  ) {}

  async next(docs: ConversationView['docs']): Promise<ToolTiming> {
    const live = (docs[LiveDoc.definition.kind] ?? {}) as LiveState;
    const slots = [...(live.tools ?? []), ...(live.nestedTools ?? [])];
    const timing: Record<string, ToolTiming[string]> = {};
    for (const { callId } of slots) if (this.timing[callId]) timing[callId] = this.timing[callId];
    await Promise.all(
      slots.map(async ({ callId, status, taskId }) => {
        const stale = this.read.get(callId) !== status || (status === 'done' && timing[callId]?.endedAt === undefined);
        if (taskId === undefined || !stale) return;
        this.read.set(callId, status);
        const task = await this.tasks.getTask(taskId, this.context).catch(() => undefined);
        if (!task || (task.startedAt === undefined && task.endedAt === undefined)) return;
        timing[callId] = {
          ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
          ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
        };
      }),
    );
    for (const callId of this.read.keys()) if (!slots.some((slot) => slot.callId === callId)) this.read.delete(callId);
    this.timing = timing;
    return timing;
  }
}

/**
 * One conversation's state as the runner follows it: `Conversation.watch()` merged into a `ConversationTranscript`, so each
 * view holds the whole transcript, not the watch's window. What precedes the first window is loaded when the views open; a gap a
 * later window leaves (after an overflow) is filled before that view is handed on.
 */
export class AgentViews {
  private constructor(
    private readonly watch: ConversationWatch,
    private readonly transcript: ConversationTranscript,
    private readonly times: ToolTimes,
    private readonly context: Context,
    /** The state at attachment. */
    readonly view: TranscriptView,
    /** The timing of its tool calls at attachment. */
    readonly timing: ToolTiming,
  ) {}

  static async open(
    conversation: Conversation,
    tasks: Pick<Harness, 'getTask'>,
    context: Context,
  ): Promise<AgentViews> {
    const transcript = new ConversationTranscript((query, limit, loading) =>
      conversation.entries(query, limit, undefined, loading),
    );
    const times = new ToolTimes(tasks, context);
    const watch = await conversation.watch(context);
    try {
      const view = await AgentViews.whole(transcript, transcript.merge(watch.value), context);
      return new AgentViews(watch, transcript, times, context, view, await times.next(view.docs));
    } catch (error) {
      await watch.stop();
      throw error;
    }
  }

  /** The view with nothing missing: the entries before its window, or the ones a gap stands for, loaded page by page. */
  private static async whole(
    transcript: ConversationTranscript,
    view: TranscriptView,
    context: Context,
  ): Promise<TranscriptView> {
    for (;;) {
      const missing = view.items.find((item) => item.kind !== 'entry');
      if (!missing) return view;
      view =
        missing.kind === 'gap' ? await transcript.fillGap(missing, context) : await transcript.loadEarlier(context);
    }
  }

  /**
   * Hands each later view to `listener`, one call at a time, with pi's operations that turn the view before into it and the
   * timing of its tool calls; commits made meanwhile arrive folded into the next view.
   */
  start(listener: (view: TranscriptView, ops: readonly Op[], timing: ToolTiming) => Promise<void>): void {
    this.watch.start(async (call) => {
      if (call.kind !== 'value') return;
      const view = await AgentViews.whole(this.transcript, this.transcript.merge(call.value), this.context);
      await listener(view, call.ops, await this.times.next(view.docs));
    });
  }

  stop(): Promise<WatchEnd> {
    return this.watch.stop();
  }
}

/**
 * A background agent's conversation views (`AgentViews`) as pi-kit's AG-UI events, one run of the log per run of the agent
 * (`pi.live.run`). Committed entries and the answer being streamed become messages through the session events `mapEvent` already
 * maps, so the transcript of an agent is drawn by the same code as a thread's: the answer from pi's own appends, then ended by its
 * entry. What the agent does right now is the view's other documents as they are and the timing of its tool calls, the
 * `pi.agent_live` activity: a snapshot, then pi's own operations as JSON Patch (`DocsPatch`), in a run of its own while no run is
 * open. A `MESSAGES_SNAPSHOT` is always followed by an activity snapshot, and every run ends with both, which a compaction keeps,
 * so a replay ends in the agent's last state. Stateful per agent; nothing here touches pi-durable.
 */
export class AgentEventMapper {
  readonly live: AgentLive = { activity: 'idle', tool: null, contextTokens: null };
  private ctx: MapContext | undefined;
  /** The last view. */
  private view: Pick<TranscriptView, 'items' | 'docs'> = { items: [], docs: {} };
  /** The timing of the tool calls, as the client holds it. */
  private timing: ToolTiming = {};
  private readonly seen = new Set<EntryId>();
  /** pi's operations on the last view's documents, as patches of what the client holds. */
  private docsPatch = new DocsPatch({});
  /** The answer being streamed, by content index: the text sent of each block (`''` for a tool call); undefined while none streams. */
  private stream: Map<number, string> | undefined;

  constructor(
    private readonly agentId: string,
    private readonly newRunId: () => string = () => `bg-${randomUUID()}`,
  ) {}

  /**
   * The state at attachment: the transcript so far, the live state, and the answer being streamed with what it holds so far, as
   * one run, which stays open while the agent works.
   */
  snapshot(view: TranscriptView, timing: ToolTiming): BaseEvent[] {
    this.view = view;
    this.timing = timing;
    this.docsPatch = new DocsPatch(view.docs);
    this.stream = undefined;
    const entries = this.entries;
    for (const entry of entries) this.seen.add(entry.id);
    // The senders of the messages in the snapshot are announced, so the client knows their names.
    const announced = entries.flatMap((entry) => {
      const from = AGENT_MESSAGE.exec(text((entry.model?.[0] as { content?: unknown } | undefined)?.content));
      return from ? envelope(`${from[2]}/${String(entry.id)}`, from[1], []) : [];
    });
    const out = [...this.start(), ...announced, ...this.snapshots(), ...this.reopen()];
    this.track();
    if (!this.state.run) out.push(...this.end(false));
    return out;
  }

  /**
   * The next view, pi's operations since the one before, and the timing of its tool calls: the entries and the answer's stream in
   * commit order, the live state's patch, and the end of a run that ended.
   */
  map(view: TranscriptView, ops: readonly Op[], timing: ToolTiming): BaseEvent[] {
    const was = this.state.run;
    const next = this.docsPatch.next(ops, view.docs);
    const added = view.items !== this.view.items;
    this.view = view;
    const run = this.state.run;
    // The commit that ends a run places the input queued meanwhile and starts the next run with it.
    const replaced = run !== undefined && was !== undefined && run.inputs[0] !== was.inputs[0];
    const out = run ? this.start() : [];
    // What the client holds of the answer no longer holds (a rewrite, the whole view replaced): the snapshots send it again.
    let resync = next === null;
    const take = (entry: EntryRecord): void => {
      if (this.seen.has(entry.id)) return;
      this.seen.add(entry.id);
      const events = resync ? null : this.entry(entry);
      if (events) out.push(...events);
      else resync = true;
    };
    for (const change of next?.changes ?? []) {
      if (change.kind === 'entry') take(change.entry);
      else if (!resync) {
        const events = this.streamed(change);
        if (events) out.push(...events);
        else resync = true;
      }
    }
    if (added) for (const item of view.items) if (item.kind === 'entry') take(item.entry);
    // An answer that left without its entry (its run ended first) ends as it is.
    if (!resync && !this.state.generation?.message) out.push(...this.flush());
    const patch = [...(next?.patch ?? []), ...this.timed(timing)];
    const ends = !run || replaced;
    if (resync || patch.length > 0) {
      if (!this.ctx) out.push(...this.sync(resync ? null : patch));
      else if (resync && !ends) out.push(...this.flush(), ...this.snapshots(), ...this.reopen());
      else if (!ends) out.push(this.activity(patch));
    }
    if (ends) out.push(...this.end());
    if (replaced) out.push(...this.start());
    this.track();
    return out;
  }

  /** `pi.live` of the last view. */
  private get state(): LiveState {
    return (this.view.docs[LiveDoc.definition.kind] ?? {}) as LiveState;
  }

  /** The entries of the last view's transcript. */
  private get entries(): EntryRecord[] {
    return this.view.items.flatMap((item) => (item.kind === 'entry' ? [item.entry] : []));
  }

  /** What the panel shows the agent doing, from `pi.live`. */
  private track(): void {
    const { run, tools } = this.state;
    const tool = run ? tools?.find((slot) => slot.status === 'running') : undefined;
    this.live.activity = tool ? 'tool' : run ? 'running' : 'idle';
    this.live.tool = tool?.name ?? null;
  }

  private start(): BaseEvent[] {
    if (this.ctx) return [];
    const runId = this.newRunId();
    this.ctx = createMapContext({ threadId: this.agentId, runId, skipUserMessages: 0 });
    return [{ type: EventType.RUN_STARTED, threadId: this.agentId, runId } as BaseEvent];
  }

  private end(snapshot = true): BaseEvent[] {
    if (!this.ctx) return [];
    const out = this.pi({ type: 'agent_settled', aborted: false });
    const terminal = out.pop();
    if (snapshot) out.push(...this.snapshots());
    if (terminal) out.push(terminal);
    this.ctx = undefined;
    this.stream = undefined;
    return out;
  }

  /** A change of the live state made while no run is open, in a run of its own that the client does not show as busy. */
  private sync(patch: JsonPatchOperation[] | null): BaseEvent[] {
    const runId = `${AGENT_LIVE_SYNC_RUN}${this.newRunId()}`;
    return [
      { type: EventType.RUN_STARTED, threadId: this.agentId, runId } as BaseEvent,
      ...(patch ? [this.activity(patch)] : this.snapshots()),
      { type: EventType.RUN_FINISHED, threadId: this.agentId, runId, outcome: { type: 'success' } } as BaseEvent,
    ];
  }

  /** The transcript, then the live state: a compaction drops the activity events before the last messages snapshot. */
  private snapshots(): BaseEvent[] {
    const entries = this.entries;
    const last = [...entries].reverse().find((entry) => entry.kind === 'pi.assistant');
    this.live.contextTokens = contextOf(last?.model?.[0] as AssistantMessage | undefined) ?? this.live.contextTokens;
    return [messagesSnapshot(entriesToMessages(entries)), this.activity(null)];
  }

  /** The `pi.agent_live` activity: a snapshot of the live state, or a patch of the one the client holds. */
  private activity(patch: JsonPatchOperation[] | null): BaseEvent {
    const activityType: PiActivityType = 'pi.agent_live';
    const messageId = activityId.agentLive(this.agentId);
    return (
      patch
        ? { type: EventType.ACTIVITY_DELTA, messageId, activityType, patch }
        : {
            type: EventType.ACTIVITY_SNAPSHOT,
            messageId,
            activityType,
            content: { docs: DocsPatch.strip(this.view.docs), timing: this.timing },
            replace: true,
          }
    ) as BaseEvent;
  }

  /** The patch of the tool calls' timing from what the client holds to `timing`, which it then holds. */
  private timed(timing: ToolTiming): JsonPatchOperation[] {
    const patch: JsonPatchOperation[] = [];
    for (const [callId, times] of Object.entries(timing)) {
      const held = this.timing[callId];
      if (held?.startedAt !== times.startedAt || held?.endedAt !== times.endedAt)
        patch.push({ op: held ? 'replace' : 'add', path: DocsPatch.pointer(['timing', callId]), value: times });
    }
    for (const callId of Object.keys(this.timing))
      if (!(callId in timing)) patch.push({ op: 'remove', path: DocsPatch.pointer(['timing', callId]) });
    this.timing = timing;
    return patch;
  }

  /** A change of the answer being streamed as the coding agent's message events; null when what the client holds of it is void. */
  private streamed(change: Exclude<StreamChange, { kind: 'entry' }>): BaseEvent[] | null {
    switch (change.kind) {
      case 'message':
        return this.stream ? null : this.open(change.message);
      case 'block':
        return this.stream && !this.stream.has(change.index) ? this.block(change.index, change.block) : null;
      case 'append': {
        const sent = this.stream?.get(change.index);
        if (sent === undefined) return null;
        this.stream?.set(change.index, sent + change.text);
        return this.update({ type: `${change.field}_delta`, contentIndex: change.index, delta: change.text });
      }
      case 'gone':
        return [];
    }
  }

  /** The answer being streamed, if there is one, opened as a message with what it holds so far. */
  private reopen(): BaseEvent[] {
    const message = this.state.generation?.message as AssistantMessage | undefined;
    return message ? this.open(message) : [];
  }

  private open(message: AssistantMessage): BaseEvent[] {
    this.stream = new Map();
    return [
      ...this.pi({ type: 'message_start', message }),
      ...message.content.flatMap((block, index) => this.block(index, block)),
    ];
  }

  /** A block of the answer opened, with its text so far; a tool call's arguments wait for the answer's entry. */
  private block(index: number, block: AssistantMessage['content'][number]): BaseEvent[] {
    if (block.type === 'toolCall') {
      this.stream?.set(index, '');
      return this.update({ type: 'toolcall_start', contentIndex: index, id: block.id, toolName: block.name });
    }
    const content = block.type === 'text' ? block.text : block.thinking;
    this.stream?.set(index, content);
    return [
      ...this.update({ type: `${block.type}_start`, contentIndex: index }),
      ...(content ? this.update({ type: `${block.type}_delta`, contentIndex: index, delta: content }) : []),
    ];
  }

  /**
   * The answer's entry as the end of its message, which it does not repeat: what the stream did not carry of each block yet, a tool
   * call's arguments, the blocks' ends. A message that never streamed opens here. Null when the entry does not continue what was
   * streamed, as when a provider rewrote a block.
   */
  private finish(message: AssistantMessage): BaseEvent[] | null {
    const sent = this.stream;
    if (sent && [...sent.keys()].some((index) => index >= message.content.length)) return null;
    const out = sent ? [] : this.pi({ type: 'message_start', message });
    for (let index = 0; index < message.content.length; index++) {
      const block = message.content[index];
      const streamed = sent?.get(index);
      if (block.type === 'toolCall') {
        if (streamed === undefined)
          out.push(...this.update({ type: 'toolcall_start', contentIndex: index, id: block.id, toolName: block.name }));
        out.push(...this.update({ type: 'toolcall_end', contentIndex: index, toolCall: block }));
        continue;
      }
      const content = block.type === 'text' ? block.text : block.thinking;
      if (streamed === undefined) out.push(...this.update({ type: `${block.type}_start`, contentIndex: index }));
      else if (!content.startsWith(streamed)) return null;
      else if (content.length > streamed.length)
        out.push(
          ...this.update({ type: `${block.type}_delta`, contentIndex: index, delta: content.slice(streamed.length) }),
        );
      out.push(...this.update({ type: `${block.type}_end`, contentIndex: index, content }));
    }
    this.stream = undefined;
    out.push(...this.pi({ type: 'message_end', message }));
    return out;
  }

  /** Closes what is open of an answer that streams no more: it ended without its entry, or it is sent again. */
  private flush(): BaseEvent[] {
    if (!this.stream) return [];
    this.stream = undefined;
    return this.ctx ? closeOpenBlocks(this.ctx) : [];
  }

  /**
   * An entry of the transcript as messages: a user message, an assistant one (the end of the streamed answer, or a whole one), a
   * tool result; null when an assistant entry does not continue what was streamed.
   */
  private entry(entry: EntryRecord): BaseEvent[] | null {
    const model = entry.model?.[0] as UserMessage | AssistantMessage | ToolResultMessage | undefined;
    if (!model) return [];
    if (model.role === 'assistant') {
      this.live.contextTokens = contextOf(model) ?? this.live.contextTokens;
      return this.finish(model);
    }
    if (model.role === 'toolResult')
      return entry.kind === 'pi.tool-result' && this.ctx
        ? [
            {
              type: EventType.TOOL_CALL_RESULT,
              messageId: String(entry.id),
              toolCallId: model.toolCallId,
              content: text(model.content),
              role: 'tool',
            } as BaseEvent,
          ]
        : [];
    if (model.role !== 'user' || entry.kind.startsWith('pi.c')) return [];
    const started = this.start();
    // A message from another agent is attributed to it, as a report is in the main thread: an envelope of its own.
    const from = AGENT_MESSAGE.exec(text(model.content));
    const message = this.pi({ type: 'message_end', message: { role: 'user', content: model.content } });
    if (!from) return [...started, ...message];
    return [...started, ...envelope(`${from[2]}/${String(entry.id)}`, from[1], message)];
  }

  private update(assistantMessageEvent: Record<string, unknown>): BaseEvent[] {
    return this.pi({ type: 'message_update', assistantMessageEvent });
  }

  private pi(event: PiEvent): BaseEvent[] {
    return this.ctx ? mapEvent(event, this.ctx) : [];
  }
}

/** A message from another agent wrapped as that agent's: the verifier allows the id once per run, and the entry's id is unique. */
function envelope(subagentRunId: string, name: string, events: BaseEvent[]): BaseEvent[] {
  return [
    { type: EventType.SUBAGENT_STARTED, subagentRunId, name, description: 'message' } as BaseEvent,
    ...events.map((event) => ({ ...event, subagentRunId })),
    { type: EventType.SUBAGENT_FINISHED, subagentRunId, outcome: { type: 'success' } } as BaseEvent,
  ];
}
