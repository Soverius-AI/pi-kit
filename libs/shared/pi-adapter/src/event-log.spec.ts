import { EventType, type BaseEvent } from '@ag-ui/core';
import { verifyEvents } from '@ag-ui/client';
import { firstValueFrom, from, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { closeRun, compactableIndices, isAborted, messagesSnapshot } from './event-log';

const ev = (type: EventType, extra: Record<string, unknown> = {}) => ({ type, ...extra }) as unknown as BaseEvent;
const types = (events: BaseEvent[]) => events.map((e) => e.type);

const started = ev(EventType.RUN_STARTED, { threadId: 't', runId: 'r' });

describe('closeRun', () => {
  it('closes open text, reasoning and tool blocks, answers open tool calls and ends the run', async () => {
    const killed = [
      started,
      ev(EventType.REASONING_START, { messageId: 'r1' }),
      ev(EventType.REASONING_MESSAGE_START, { messageId: 'r1', role: 'reasoning' }),
      ev(EventType.REASONING_MESSAGE_CONTENT, { messageId: 'r1', delta: 'hmm' }),
      ev(EventType.TEXT_MESSAGE_START, { messageId: 'm1', role: 'assistant' }),
      ev(EventType.TEXT_MESSAGE_CONTENT, { messageId: 'm1', delta: 'par' }),
      ev(EventType.TOOL_CALL_START, { toolCallId: 'c1', toolCallName: 'bash', parentMessageId: 'm1' }),
      ev(EventType.TOOL_CALL_ARGS, { toolCallId: 'c1', delta: '{"command":"sl' }),
    ];
    const closing = closeRun(killed, { message: 'The app quit during this run.', code: 'aborted' });
    expect(types(closing)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_ERROR,
    ]);
    expect(isAborted(closing.at(-1) as BaseEvent)).toBe(true);
    await expect(firstValueFrom(from([...killed, ...closing]).pipe(verifyEvents(false), toArray()))).resolves.toBeTruthy();
  });

  it('adds nothing but the terminal event to a clean run, and nothing to a finished one', () => {
    const clean = [started, ev(EventType.TEXT_MESSAGE_START, { messageId: 'm', role: 'assistant' }), ev(EventType.TEXT_MESSAGE_END, { messageId: 'm' })];
    expect(types(closeRun(clean, { message: 'x', code: 'aborted' }))).toEqual([EventType.RUN_ERROR]);
    expect(closeRun([...clean, ev(EventType.RUN_FINISHED)], { message: 'x', code: 'aborted' })).toEqual([]);
  });
});

describe('compactableIndices', () => {
  const run1 = [
    started,
    ev(EventType.TEXT_MESSAGE_START, { messageId: 'm1', role: 'assistant' }), // 1
    ev(EventType.TEXT_MESSAGE_CONTENT, { messageId: 'm1', delta: 'a' }), // 2
    ev(EventType.TEXT_MESSAGE_END, { messageId: 'm1' }),
    ev(EventType.TOOL_CALL_START, { toolCallId: 'c1', toolCallName: 'bash' }),
    ev(EventType.TOOL_CALL_ARGS, { toolCallId: 'c1', delta: '{}' }), // 5
    ev(EventType.TOOL_CALL_END, { toolCallId: 'c1' }),
    ev(EventType.CUSTOM, { name: 'pi.usage', value: {} }),
    messagesSnapshot([]), // 8
    ev(EventType.RUN_FINISHED),
  ];

  it('drops the deltas of ended blocks before the last snapshot and keeps everything else', () => {
    expect(compactableIndices(run1)).toEqual([2, 5]);
  });

  it('also drops snapshots that a later snapshot supersedes', () => {
    const second = [...run1, ev(EventType.RUN_STARTED), ev(EventType.TEXT_MESSAGE_START, { messageId: 'm2', role: 'assistant' }), ev(EventType.TEXT_MESSAGE_CONTENT, { messageId: 'm2', delta: 'b' }), ev(EventType.TEXT_MESSAGE_END, { messageId: 'm2' }), messagesSnapshot([]), ev(EventType.RUN_FINISHED)];
    expect(compactableIndices(second)).toEqual([2, 5, 8, 12]);
  });

  it('keeps deltas of blocks without an END, and everything after the last snapshot', () => {
    const open = [
      ...run1,
      ev(EventType.RUN_STARTED),
      ev(EventType.TEXT_MESSAGE_START, { messageId: 'm2', role: 'assistant' }),
      ev(EventType.TEXT_MESSAGE_CONTENT, { messageId: 'm2', delta: 'tail' }),
    ];
    expect(compactableIndices(open)).toEqual([2, 5]);
    const unended = [started, ev(EventType.TEXT_MESSAGE_START, { messageId: 'x', role: 'assistant' }), ev(EventType.TEXT_MESSAGE_CONTENT, { messageId: 'x', delta: '.' }), messagesSnapshot([])];
    expect(compactableIndices(unended)).toEqual([]);
  });

  it('does nothing without a snapshot', () => {
    expect(compactableIndices(run1.filter((e) => e.type !== EventType.MESSAGES_SNAPSHOT))).toEqual([]);
  });

  it('drops generated UI snapshots and patches superseded by persisted messages, preserving widgets', () => {
    const events = [started,
      ev(EventType.ACTIVITY_SNAPSHOT, { messageId: 'c1-activity', activityType: 'open-generative-ui', content: {} }),
      ev(EventType.ACTIVITY_DELTA, { messageId: 'c1-activity', activityType: 'open-generative-ui', patch: [] }),
      ev(EventType.ACTIVITY_SNAPSHOT, { messageId: 'widget:w', activityType: 'pi.widget', content: {} }),
      messagesSnapshot([]), ev(EventType.RUN_FINISHED)];
    expect(compactableIndices(events)).toEqual([1, 2]);
  });
});
