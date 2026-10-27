import { type BaseEvent, EventType, type Message } from '@ag-ui/core';

/**
 * Pure helpers for the AG-UI replay log the backend keeps per thread. The log
 * is a cache of richer events than pi's session file holds; it is rebuilt from the file whenever the
 * file moved on without us.
 */

type Loose = BaseEvent & { messageId?: string; toolCallId?: string; code?: string };
const loose = (event: BaseEvent): Loose => event as Loose;

export const isTerminal = (event: BaseEvent): boolean =>
  event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;

/**
 * A run that did not run to its end: the user stopped it (`RUN_FINISHED` with `result.aborted`) or
 * the app was closed under it (`RUN_ERROR` code `aborted`, written by crash recovery).
 */
export const isAborted = (event: BaseEvent): boolean =>
  (event.type === EventType.RUN_ERROR && loose(event).code === 'aborted') ||
  (event.type === EventType.RUN_FINISHED && ((event as { outcome?: { type?: string } }).outcome?.type === 'cancelled' || (event as { result?: { aborted?: boolean } }).result?.aborted === true));

/** `RUN_FINISHED` that ends the run for an extension dialog: pi is waiting, the next run resumes it. */
export const isInterrupt = (event: BaseEvent): boolean =>
  event.type === EventType.RUN_FINISHED &&
  (event as { outcome?: { type?: string } }).outcome?.type === 'interrupt';

export const messagesSnapshot = (messages: Message[]): BaseEvent =>
  ({ type: EventType.MESSAGES_SNAPSHOT, messages }) as BaseEvent;

/**
 * The closing events for text, reasoning and tool-call blocks a stream left open, followed by a
 * terminal `RUN_ERROR` unless the events already end the run. Used when the process died mid-run
 * (`aborted`) and when a run's observable ends or fails without a terminal event.
 */
export function closeRun(
  events: readonly BaseEvent[],
  terminal: { message: string; code: string },
): BaseEvent[] {
  const openText = new Set<string>();
  const openReasoningMessage = new Set<string>();
  const openReasoning = new Set<string>();
  const openTools = new Map<string, { ended: boolean; resulted: boolean }>();

  for (const event of events) {
    const e = loose(event);
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START:
        openText.add(e.messageId as string);
        break;
      case EventType.TEXT_MESSAGE_END:
        openText.delete(e.messageId as string);
        break;
      case EventType.REASONING_START:
        openReasoning.add(e.messageId as string);
        break;
      case EventType.REASONING_MESSAGE_START:
        openReasoningMessage.add(e.messageId as string);
        break;
      case EventType.REASONING_MESSAGE_END:
        openReasoningMessage.delete(e.messageId as string);
        break;
      case EventType.REASONING_END:
        openReasoning.delete(e.messageId as string);
        break;
      case EventType.TOOL_CALL_START:
        openTools.set(e.toolCallId as string, { ended: false, resulted: false });
        break;
      case EventType.TOOL_CALL_END: {
        const tool = openTools.get(e.toolCallId as string);
        if (tool) tool.ended = true;
        break;
      }
      case EventType.TOOL_CALL_RESULT: {
        const tool = openTools.get(e.toolCallId as string);
        if (tool) tool.resulted = true;
        break;
      }
    }
  }

  const out: BaseEvent[] = [];
  for (const messageId of openText) out.push({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent);
  for (const messageId of openReasoningMessage) {
    out.push({ type: EventType.REASONING_MESSAGE_END, messageId } as BaseEvent);
  }
  for (const messageId of openReasoning) out.push({ type: EventType.REASONING_END, messageId } as BaseEvent);
  for (const [toolCallId, tool] of openTools) {
    if (!tool.ended) out.push({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
    if (!tool.resulted) {
      out.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${toolCallId}-result`,
        toolCallId,
        role: 'tool',
        content: JSON.stringify({ status: 'aborted', message: terminal.message }),
      } as BaseEvent);
    }
  }
  if (!events.some(isTerminal)) {
    out.push({ type: EventType.RUN_ERROR, message: terminal.message, code: terminal.code } as BaseEvent);
  }
  return out;
}

const TEXT_DELTA = new Set<string>([
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.TOOL_CALL_ARGS,
]);

/**
 * Post-run compaction. Everything before the last `MESSAGES_SNAPSHOT` is covered
 * by that snapshot, so the content deltas of blocks that have their matching END are dropped, and so
 * are the earlier snapshots it supersedes and the streamed activities it repeats; the structure (starts, ends, tool results, custom events,
 * run boundaries) stays. Events after the last snapshot (a run in progress, or one that was killed
 * before it could write a snapshot) are untouched.
 *
 * Returns the indices of `events` to delete, so the caller can run one `DELETE`.
 */
export function compactableIndices(events: readonly BaseEvent[]): number[] {
  let lastSnapshot = -1;
  events.forEach((event, index) => {
    if (event.type === EventType.MESSAGES_SNAPSHOT) lastSnapshot = index;
  });
  if (lastSnapshot < 0) return [];

  const ended = new Set<string>();
  for (let i = 0; i < lastSnapshot; i++) {
    const e = loose(events[i]);
    if (events[i].type === EventType.TEXT_MESSAGE_END || events[i].type === EventType.REASONING_MESSAGE_END) {
      ended.add(`m:${e.messageId}`);
    } else if (events[i].type === EventType.TOOL_CALL_END) {
      ended.add(`t:${e.toolCallId}`);
    }
  }

  const drop: number[] = [];
  for (let i = 0; i < lastSnapshot; i++) {
    const type = events[i].type;
    if (type === EventType.MESSAGES_SNAPSHOT) {
      drop.push(i);
      continue;
    }
    // `sessionToMessages()` carries the tool, bash, diff, compaction, A2UI, Open UI and MCP App activities, so the streamed
    // ones (one snapshot per streamed output chunk) are covered too. Widgets only exist in the stream.
    if ((type === EventType.ACTIVITY_SNAPSHOT || type === EventType.ACTIVITY_DELTA) && (events[i] as { activityType?: string }).activityType !== 'pi.widget') {
      drop.push(i);
      continue;
    }
    if (!TEXT_DELTA.has(type)) continue;
    const e = loose(events[i]);
    const key = type === EventType.TOOL_CALL_ARGS ? `t:${e.toolCallId}` : `m:${e.messageId}`;
    if (ended.has(key)) drop.push(i);
  }
  return drop;
}
