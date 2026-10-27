import {
  type ActivityMessage, type AssistantMessage, type BaseEvent, type Message,
  type MessagesSnapshotEvent, type RunStartedEvent, type ToolCallStartEvent,
  type ToolCallArgsEvent, type ToolCallResultEvent, type TextMessageStartEvent,
  type TextMessageContentEvent, type ReasoningMessageStartEvent, type ReasoningStartEvent,
  type ActivitySnapshotEvent, type CustomEvent, type RunFinishedEvent, type RunErrorEvent,
  type StateSnapshotEvent, EventType,
  type ActivityDeltaEvent, type StateDeltaEvent,
} from '@ag-ui/client';
import { parsePiCustomEvent, type ComposerRegistration, type ThreadHydration } from '@pi-kit/protocol';
import { applyPatch } from 'fast-json-patch';

/**
 * Build current pi state on the server. The log is read once; text/argument buffers and message indexes
 * are updated in place. Never run historical events through the browser's per-event cloning reducer.
 * All emitted message objects belong to this projection, never to the stored log.
 */
export function hydrateThread(events: readonly BaseEvent[]): ThreadHydration<Message> {
  const result: ThreadHydration<Message> = {
    messages: [], state: {}, composers: [],
    view: { thinkTimes: {}, queue: { steering: [], followUp: [] }, compacting: false,
      retry: undefined, runError: undefined, lastAborted: false, statuses: {}, liveContextTokens: undefined },
  };
  let messages = new Map<string, Message>();
  const calls = new Map<string, NonNullable<AssistantMessage['toolCalls']>[number]>();
  const composers = new Map<string, ComposerRegistration>();
  const index = () => {
    messages = new Map(result.messages.map((message) => [message.id, message]));
    calls.clear();
    for (const message of result.messages) if (message.role === 'assistant')
      for (const call of message.toolCalls ?? []) calls.set(call.id, call);
  };
  const put = (message: Message): Message => {
    const existing = messages.get(message.id);
    if (existing) return existing;
    messages.set(message.id, message);
    result.messages.push(message);
    return message;
  };
  const metadata = (target: { metadata?: Record<string, unknown> } | undefined, event: BaseEvent) => {
    if (target && event.metadata) target.metadata = { ...target.metadata, ...event.metadata };
  };
  for (const raw of events) {
    switch (raw.type) {
      case EventType.RUN_STARTED: {
        const event = raw as RunStartedEvent;
        for (const message of event.input?.messages ?? []) put(structuredClone(message));
        result.view.runError = undefined;
        result.view.retry = undefined;
        result.view.lastAborted = false;
        break;
      }
      case EventType.MESSAGES_SNAPSHOT: {
        const next = structuredClone((raw as MessagesSnapshotEvent).messages);
        // The final snapshot renames streamed reasoning to session-entry ids. Carry durations by text/order.
        const timed = result.messages.filter((m) => m.role === 'reasoning' && result.view.thinkTimes[m.id]?.end !== undefined);
        const reasoning = next.filter((m) => m.role === 'reasoning');
        const byText = new Map(timed.filter((m) => m.content).map((m) => [m.content, m.id]));
        reasoning.forEach((m, i) => {
          const from = byText.get(m.content) ?? (timed.length === reasoning.length ? timed[i]?.id : undefined);
          if (from) result.view.thinkTimes[m.id] = result.view.thinkTimes[from];
        });
        result.messages = next;
        index();
        break;
      }
      case EventType.TEXT_MESSAGE_START:
      case EventType.REASONING_MESSAGE_START: {
        const event = raw as TextMessageStartEvent | ReasoningMessageStartEvent;
        const role = raw.type === EventType.REASONING_MESSAGE_START ? 'reasoning' : (event as TextMessageStartEvent).role ?? 'assistant';
        metadata(put({ id: event.messageId, role, content: '', ...(event.subagentRunId ? { subagentRunId: event.subagentRunId } : {}) } as Message), raw);
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_CONTENT: {
        const event = raw as TextMessageContentEvent;
        const message = messages.get(event.messageId);
        if (message && message.role !== 'activity' && typeof message.content === 'string') {
          message.content += event.delta;
          metadata(message, raw);
        }
        break;
      }
      case EventType.TOOL_CALL_START: {
        const event = raw as ToolCallStartEvent;
        const existing = calls.get(event.toolCallId);
        if (existing) {
          existing.function.name = event.toolCallName;
          metadata(existing, raw);
          break;
        }
        const parent = event.parentMessageId && messages.get(event.parentMessageId);
        const id = parent && parent.role !== 'assistant' ? event.toolCallId : event.parentMessageId ?? event.toolCallId;
        const message = put({ id, role: 'assistant', toolCalls: [],
          ...(event.subagentRunId ? { subagentRunId: event.subagentRunId } : {}) }) as AssistantMessage;
        if (message.role !== 'assistant') break;
        message.toolCalls ??= [];
        let call = calls.get(event.toolCallId);
        if (!call) {
          call = { id: event.toolCallId, type: 'function', function: { name: event.toolCallName, arguments: '' } };
          message.toolCalls.push(call);
          calls.set(call.id, call);
        }
        metadata(call, raw);
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const event = raw as ToolCallArgsEvent;
        const call = calls.get(event.toolCallId);
        if (call) { call.function.arguments += event.delta; metadata(call, raw); }
        break;
      }
      case EventType.TOOL_CALL_END:
        metadata(calls.get((raw as ToolCallArgsEvent).toolCallId), raw);
        break;
      case EventType.TOOL_CALL_RESULT: {
        const event = raw as ToolCallResultEvent;
        if (messages.has(event.messageId)) break;
        const message: Message = { id: event.messageId, role: 'tool', toolCallId: event.toolCallId, content: event.content,
          ...(event.subagentRunId ? { subagentRunId: event.subagentRunId } : {}) };
        metadata(message, raw);
        // Keep provider-valid assistant -> tool-result ordering even when follow-up text arrived first.
        const owner = result.messages.findIndex((m) => m.role === 'assistant' && m.toolCalls?.some((c) => c.id === event.toolCallId));
        let at = owner < 0 ? result.messages.length : owner + 1;
        while (at < result.messages.length && result.messages[at].role === 'tool') at++;
        result.messages.splice(at, 0, message);
        messages.set(message.id, message);
        break;
      }
      case EventType.ACTIVITY_SNAPSHOT: {
        const event = raw as ActivitySnapshotEvent;
        const previous = messages.get(event.messageId);
        if (previous && event.replace === false) { metadata(previous, raw); break; }
        const message: ActivityMessage = { id: event.messageId, role: 'activity', activityType: event.activityType,
          content: structuredClone(event.content), ...(previous?.metadata ? { metadata: previous.metadata } : {}),
          ...(event.subagentRunId ? { subagentRunId: event.subagentRunId } : {}) };
        metadata(message, raw);
        if (previous) result.messages[result.messages.indexOf(previous)] = message;
        else result.messages.push(message);
        messages.set(message.id, message);
        break;
      }
      case EventType.STATE_SNAPSHOT:
        result.state = structuredClone((raw as StateSnapshotEvent).snapshot);
        break;
      case EventType.STATE_DELTA:
        result.state = applyPatch(result.state, structuredClone((raw as StateDeltaEvent).delta)).newDocument;
        break;
      case EventType.ACTIVITY_DELTA: {
        const event = raw as ActivityDeltaEvent;
        const message = messages.get(event.messageId);
        if (message?.role === 'activity') {
          message.content = applyPatch(message.content, structuredClone(event.patch)).newDocument;
          metadata(message, raw);
        }
        break;
      }
      case EventType.REASONING_START:
      case EventType.REASONING_END: {
        const id = (raw as ReasoningStartEvent).messageId;
        const timing = result.view.thinkTimes[id] ??= {};
        timing[raw.type === EventType.REASONING_START ? 'start' : 'end'] = raw.timestamp ?? 0;
        break;
      }
      case EventType.RUN_FINISHED:
        result.view.lastAborted = (raw as RunFinishedEvent).result?.aborted === true;
        break;
      case EventType.RUN_ERROR: {
        const event = raw as RunErrorEvent;
        result.view.runError = { message: event.message, code: event.code };
        break;
      }
      case EventType.CUSTOM: {
        const event = raw as CustomEvent;
        const parsed = parsePiCustomEvent({ name: event.name, value: event.value });
        if (!parsed) break;
        switch (parsed.name) {
          case 'pi.queue': result.view.queue = {
            steering: parsed.value.steerTexts ?? Array.from({ length: parsed.value.steer }, () => 'Queued message'),
            followUp: parsed.value.followUpTexts ?? Array.from({ length: parsed.value.followUp }, () => 'Queued message'),
          }; break;
          case 'pi.compaction': result.view.compacting = parsed.value.phase === 'start'; break;
          case 'pi.retry': result.view.retry = parsed.value; break;
          case 'pi.usage': if (parsed.value.contextTokens !== undefined) result.view.liveContextTokens = parsed.value.contextTokens; break;
          case 'pi.status': {
            const { key = 'status', text } = parsed.value;
            if (text) result.view.statuses[key] = text; else delete result.view.statuses[key];
            break;
          }
          case 'pi.composer':
            if (parsed.value.op === 'remove') composers.delete(parsed.value.id); else composers.set(parsed.value.id, parsed.value);
            break;
          case 'pi.title': result.title = parsed.value.title; break;
        }
        break;
      }
      case EventType.TEXT_MESSAGE_END:
      case EventType.REASONING_MESSAGE_END:
        metadata(messages.get((raw as TextMessageContentEvent).messageId), raw);
        break;
    }
  }
  result.composers = [...composers.values()];
  return result;
}
