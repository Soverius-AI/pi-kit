import { randomUUID } from 'node:crypto';
import { type BaseEvent, EventType } from '@ag-ui/client';
import type { Message } from '@ag-ui/core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import type { AgentEvent, AgentEventStream, EntryRecord, MessageChange, SnapshotEvent } from '@earendil-works/pi-durable';
import { createMapContext, type MapContext, mapEvent, messagesSnapshot, type PiEvent } from '@pi-kit/pi-adapter';
import { AGENT_MESSAGE } from './agent-extension';

/** pi-durable's event stream of one conversation, as the runner takes it (`watchEvents`); the service opens it. */
export type DurableEventStream = Pick<AgentEventStream, 'snapshot' | 'start' | 'stop'>;

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
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? (part.text ?? '') : '')).join('') : '';

/** The transcript of a background agent as AG-UI messages, from its durable entries (the `MESSAGES_SNAPSHOT` of a run). */
export function entriesToMessages(entries: readonly EntryRecord[]): Message[] {
  const out: Message[] = [];
  for (const entry of entries) {
    const id = String(entry.id);
    const model = entry.model?.[0] as UserMessage | AssistantMessage | ToolResultMessage | undefined;
    if (!model) continue;
    if (entry.kind === 'pi.user' || (model.role === 'user' && !entry.kind.startsWith('pi.'))) {
      const from = AGENT_MESSAGE.exec(text(model.content));
      out.push({ id, role: 'user', content: text(model.content), ...(from ? { subagentRunId: `${from[2]}/${id}` } : {}) } as Message);
    } else if (entry.kind === 'pi.assistant' && model.role === 'assistant') {
      const thinking = model.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join('\n');
      if (thinking) out.push({ id: `${id}:think`, role: 'reasoning', content: thinking } as Message);
      const calls = model.content.filter((block) => block.type === 'toolCall').map((block) => ({ id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) } }));
      out.push({ id, role: 'assistant', content: text(model.content), ...(calls.length ? { toolCalls: calls } : {}) } as Message);
    } else if (entry.kind === 'pi.tool-result' && model.role === 'toolResult') {
      out.push({ id, role: 'tool', toolCallId: model.toolCallId, content: text(model.content), ...(model.isError ? { error: 'error' } : {}) } as Message);
    }
  }
  return out;
}

/**
 * pi-durable's agent events (`watchEvents`, shaped like the coding agent's) as pi-kit's AG-UI events, one run of the log per
 * run of the agent: the events are translated into the session events `mapEvent` already maps, so the transcript of
 * an agent is drawn by the same code as a thread's. Every run ends with a `MESSAGES_SNAPSHOT` of the entries, as a thread's does,
 * so replay and compaction apply unchanged. Stateful per agent; nothing here touches pi-durable.
 */
export class AgentEventMapper {
  readonly live: AgentLive = { activity: 'idle', tool: null, contextTokens: null };
  private ctx: MapContext | undefined;
  private entries: EntryRecord[] = [];
  private readonly seen = new Set<string>();
  private readonly outputs = new Map<string, string>();
  /** The content indexes of the in-flight message that streamed a start; a block that arrives whole gets its start and end here. */
  private opened = new Set<number>();
  /** Whether the in-flight assistant message streamed at all: a provider that does not stream delivers it whole at `message_end`. */
  private streamed = false;

  constructor(
    private readonly agentId: string,
    private readonly newRunId: () => string = () => `bg-${randomUUID()}`,
  ) {}

  /** The state at attachment: the transcript so far as one run; a run in flight stays open for the events that follow. */
  snapshot(event: SnapshotEvent): BaseEvent[] {
    this.entries = [...event.entries];
    for (const entry of this.entries) this.seen.add(String(entry.id));
    const running = event.run !== undefined;
    // The senders of the messages in the snapshot are announced, so the client knows their names.
    const announced = this.entries.flatMap((entry) => {
      const from = AGENT_MESSAGE.exec(text((entry.model?.[0] as { content?: unknown } | undefined)?.content));
      return from ? envelope(`${from[2]}/${String(entry.id)}`, from[1], []) : [];
    });
    const out = [...this.start(), ...announced, messagesSnapshot(entriesToMessages(this.entries))];
    const tool = event.tools.find((slot) => slot.status === 'running');
    if (tool) this.live.tool = tool.name;
    const last = [...this.entries].reverse().find((entry) => entry.kind === 'pi.assistant');
    this.live.contextTokens = contextOf(last?.model?.[0] as AssistantMessage | undefined);
    this.live.activity = tool ? 'tool' : running ? 'running' : 'idle';
    if (!running) out.push(...this.end(false));
    return out;
  }

  map(event: AgentEvent): BaseEvent[] {
    switch (event.type) {
      case 'snapshot':
        return this.snapshot(event);
      case 'run_start':
        return this.start();
      case 'run_end':
        return this.end();
      case 'message_start':
        this.opened = new Set();
        this.streamed = false;
        // The placed input precedes `run_start` in the stream: it opens the run here.
        return event.message.role === 'assistant' ? this.pi({ type: 'message_start', message: event.message }) : this.start();
      case 'message_update':
        this.streamed = true;
        return event.changes.flatMap((change) => changeEvents(change, this.opened).flatMap((assistantMessageEvent) => this.pi({ type: 'message_update', assistantMessageEvent })));
      case 'message_end':
      case 'entry_appended':
        return this.entry(event.entry);
      case 'tool_execution_start':
        Object.assign(this.live, { activity: 'tool', tool: event.toolName });
        return this.pi({ type: 'tool_execution_start', toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
      case 'tool_execution_update': {
        const output = event.output;
        const before = this.outputs.get(event.toolCallId) ?? '';
        const next = !output ? before : 'set' in output ? output.set : before.slice(output.trimStart ?? 0) + (output.append ?? '');
        this.outputs.set(event.toolCallId, next);
        return this.pi({ type: 'tool_execution_update', toolCallId: event.toolCallId, toolName: event.toolName, partialResult: { content: [{ type: 'text', text: next }] } });
      }
      case 'tool_execution_end': {
        this.outputs.delete(event.toolCallId);
        Object.assign(this.live, { activity: 'running', tool: null });
        const result = event.entry?.model?.[0] as ToolResultMessage | undefined;
        if (event.entry) this.remember(event.entry);
        return this.pi({
          type: 'tool_execution_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: result ? result.isError === true : true,
          result: { content: result?.content ?? [{ type: 'text', text: 'No result: the call was interrupted.' }], details: event.entry?.data },
        });
      }
      case 'compaction_start':
        return this.pi({ type: 'compaction_start' });
      default:
        return [];
    }
  }

  private start(): BaseEvent[] {
    if (this.ctx) return [];
    const runId = this.newRunId();
    this.ctx = createMapContext({ threadId: this.agentId, runId, skipUserMessages: 0 });
    this.live.activity = 'running';
    return [{ type: EventType.RUN_STARTED, threadId: this.agentId, runId } as BaseEvent];
  }

  private end(snapshot = true): BaseEvent[] {
    if (!this.ctx) return [];
    const out = this.pi({ type: 'agent_settled', aborted: false });
    const terminal = out.pop();
    if (snapshot) out.push(messagesSnapshot(entriesToMessages(this.entries)));
    if (terminal) out.push(terminal);
    this.ctx = undefined;
    this.live.activity = 'idle';
    this.live.tool = null;
    return out;
  }

  /** An entry of the transcript: a user message is shown once, an assistant one closes the streamed message, the rest is remembered for the snapshot. */
  private entry(entry: EntryRecord): BaseEvent[] {
    const fresh = this.remember(entry);
    const model = entry.model?.[0] as UserMessage | AssistantMessage | undefined;
    if (!fresh || !model) return [];
    if (model.role === 'assistant') {
      this.live.contextTokens = contextOf(model) ?? this.live.contextTokens;
      // A message that never streamed is delivered whole: its blocks open and close here, as a streamed one's did.
      const whole = this.streamed ? [] : model.content.flatMap((block, contentIndex) => changeEvents({ type: 'block', contentIndex, block }, this.opened));
      return [...whole.flatMap((assistantMessageEvent) => this.pi({ type: 'message_update', assistantMessageEvent })), ...this.pi({ type: 'message_end', message: model })];
    }
    if (model.role === 'user' && !entry.kind.startsWith('pi.c')) {
      // A message from another agent is attributed to it, as a report is in the main thread: an envelope of its own.
      const from = AGENT_MESSAGE.exec(text(model.content));
      const message = this.pi({ type: 'message_end', message: { role: 'user', content: model.content } });
      if (!from) return [...this.start(), ...message];
      return [...this.start(), ...envelope(`${from[2]}/${String(entry.id)}`, from[1], message)];
    }
    return [];
  }

  private remember(entry: EntryRecord): boolean {
    const id = String(entry.id);
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.entries.push(entry);
    return true;
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

/**
 * A change of the in-flight assistant message as the coding agent's `message_update` reports it. A block that arrives whole without a
 * start (a provider that does not stream, the faux provider) gets its start and its content first, so the adapter opens and closes it.
 */
function changeEvents(change: MessageChange, opened: Set<number>): Record<string, unknown>[] {
  if (change.type === 'message') return []; // the whole message: `message_end` carries it
  const index = change.contentIndex;
  switch (change.type) {
    case 'text_start':
    case 'thinking_start':
      opened.add(index);
      return [{ type: change.type, contentIndex: index }];
    case 'toolcall_start':
      opened.add(index);
      return [{ type: 'toolcall_start', contentIndex: index, id: (change.block as { id?: string }).id, toolName: (change.block as { name?: string }).name }];
    case 'text_delta':
    case 'thinking_delta':
      return [{ type: change.type, contentIndex: index, delta: change.delta }];
    case 'toolcall_delta':
      return [{ type: 'toolcall_delta', contentIndex: index, delta: change.delta }];
    case 'block': {
      const block = change.block;
      const fresh = !opened.has(index);
      opened.add(index);
      if (block.type === 'text') return [...(fresh ? [{ type: 'text_start', contentIndex: index }, { type: 'text_delta', contentIndex: index, delta: block.text }] : []), { type: 'text_end', contentIndex: index, content: block.text }];
      if (block.type === 'thinking') return [...(fresh ? [{ type: 'thinking_start', contentIndex: index }, { type: 'thinking_delta', contentIndex: index, delta: block.thinking }] : []), { type: 'thinking_end', contentIndex: index, content: block.thinking }];
      return [...(fresh ? [{ type: 'toolcall_start', contentIndex: index, id: block.id, toolName: block.name }] : []), { type: 'toolcall_end', contentIndex: index, toolCall: block }];
    }
  }
}
