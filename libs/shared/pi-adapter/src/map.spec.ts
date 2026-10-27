import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { EventSchemas } from '@ag-ui/core/schemas';
import { verifyEvents } from '@ag-ui/client';
import { PI_ACTIVITY_TYPES, parsePiCustomEvent } from '@pi-kit/protocol';
import { firstValueFrom, from, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { createMapContext, mapEvent } from './map';
import type { PiEvent } from './pi-events';

const fixture = (name: string): PiEvent[] =>
  JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', `${name}.json`), 'utf8'));

function counter(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

/** A clock that advances a second per reading, so nothing is throttled and timestamps are deterministic. */
function ticking(): () => number {
  let t = 1_000_000;
  return () => (t += 1000);
}

function run(events: PiEvent[], options: Partial<Parameters<typeof createMapContext>[0]> = {}) {
  const ctx = createMapContext({ threadId: 't1', runId: 'r1', newId: counter(), now: ticking(), ...options });
  return { ctx, out: events.flatMap((e) => mapEvent(e, ctx)) };
}

const types = (events: BaseEvent[]) => events.map((e) => e.type);
const only = (events: BaseEvent[], type: EventType) => events.filter((e) => e.type === type);
const custom = (events: BaseEvent[], name: string) =>
  only(events, EventType.CUSTOM).filter((e) => (e as unknown as { name: string }).name === name);

/** Run the events through AG-UI's own stream verifier, behind a RUN_STARTED. */
async function verify(events: BaseEvent[]) {
  const started = { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1' } as BaseEvent;
  return firstValueFrom(from([started, ...events]).pipe(verifyEvents(false), toArray()));
}

describe.each(['tool-run', 'abort', 'queue'])('recorded pi run: %s', (name) => {
  const events = fixture(name);

  it('maps to events AG-UI accepts and its stream verifier passes', async () => {
    const { out } = run(events);
    for (const e of out) expect(() => EventSchemas.parse(e)).not.toThrow();
    await expect(verify(out)).resolves.toBeTruthy();
  });

  it('ends with exactly one terminal event', () => {
    const { out } = run(events);
    const terminal = out.filter((e) => e.type === EventType.RUN_FINISHED || e.type === EventType.RUN_ERROR);
    expect(terminal).toHaveLength(1);
    expect(out.at(-1)).toBe(terminal[0]);
  });

  it('emits only valid pi.* custom events', () => {
    const { out } = run(events);
    for (const e of only(out, EventType.CUSTOM)) {
      expect(parsePiCustomEvent(e as unknown as { name: string; value: unknown })).toBeDefined();
    }
  });
});

describe('tool run (text, thinking, tool call)', () => {
  const { out } = run(fixture('tool-run'));

  it('streams the tool call with args and result in order', () => {
    const seq = types(out).filter((t) => t.startsWith('TOOL_CALL'));
    expect(seq.slice(0, 2)).toEqual([EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS]);
    expect(seq.at(-2)).toBe(EventType.TOOL_CALL_END);
    expect(seq.at(-1)).toBe(EventType.TOOL_CALL_RESULT);
    const start = only(out, EventType.TOOL_CALL_START)[0] as unknown as Record<string, string>;
    expect(start['toolCallName']).toBe('bash');
    const args = only(out, EventType.TOOL_CALL_ARGS)
      .map((e) => (e as unknown as { delta: string }).delta)
      .join('');
    expect(JSON.parse(args)).toEqual({ command: 'cat note.txt' });
    const result = only(out, EventType.TOOL_CALL_RESULT)[0] as unknown as Record<string, string>;
    expect(result['content']).toBe('hello pi-kit\n');
    expect(result['toolCallId']).toBe(start['toolCallId']);
  });

  it('attaches the tool call to the assistant message of its turn', () => {
    const start = only(out, EventType.TOOL_CALL_START)[0] as unknown as Record<string, string>;
    expect(start['parentMessageId']).toMatch(/^id-\d+$/);
  });

  it('maps thinking to reasoning events and text to text events', () => {
    expect(only(out, EventType.REASONING_START).length).toBe(2);
    expect(only(out, EventType.REASONING_MESSAGE_START).length).toBe(2);
    expect(only(out, EventType.REASONING_MESSAGE_END).length).toBe(2);
    expect(only(out, EventType.REASONING_END).length).toBe(2);
    const text = only(out, EventType.TEXT_MESSAGE_CONTENT)
      .map((e) => (e as unknown as { delta: string }).delta)
      .join('');
    const final = fixture('tool-run')
      .filter((e) => e.type === 'message_end' && (e['message'] as { stopReason: string }).stopReason === 'stop')
      .map((e) => (e['message'] as { content: { type: string; text?: string }[] }).content.find((c) => c.type === 'text')?.text);
    expect(text).toBe(final[0]);
    expect(only(out, EventType.TEXT_MESSAGE_START)).toHaveLength(1);
    expect(only(out, EventType.TEXT_MESSAGE_END)).toHaveLength(1);
  });

  it('finishes the run successfully with the thread and run ids', () => {
    expect(out.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      threadId: 't1',
      runId: 'r1',
      outcome: { type: 'success' },
    });
  });

  it('reports usage once per completed assistant message and the model once', () => {
    expect(custom(out, 'pi.usage')).toHaveLength(2);
    expect(custom(out, 'pi.model')).toHaveLength(1);
    expect(custom(out, 'pi.model')[0]).toMatchObject({ value: { provider: 'llama-swap' } });
  });

  it('puts each completed request in the transcript as a pi.turn_usage activity next to its assistant message', () => {
    const usage = (only(out, EventType.ACTIVITY_SNAPSHOT) as unknown as { activityType: string; messageId: string; content: unknown }[]).filter((a) => a.activityType === 'pi.turn_usage');
    expect(usage).toHaveLength(2);
    for (const a of usage) {
      expect(() => PI_ACTIVITY_TYPES['pi.turn_usage'].parse(a.content)).not.toThrow();
      expect(a.messageId).toMatch(/^usage:/);
      expect(a.content).toMatchObject({ provider: 'llama-swap', elapsedMs: expect.any(Number) });
    }
    const starts = only(out, EventType.TEXT_MESSAGE_START).map((e) => (e as unknown as { messageId: string }).messageId);
    expect(starts.some((id) => usage[1].messageId === `usage:${id}`)).toBe(true);
  });

  it('does not emit pi.model again when the run starts on the same model', () => {
    const { out: again } = run(fixture('tool-run'), { model: { provider: 'llama-swap', modelId: 'qwen3.8-27b' } });
    expect(custom(again, 'pi.model')).toHaveLength(0);
  });

  it('gives the SDK and the JSON-mode shape of toolcall_start the same result', () => {
    const asJson = fixture('tool-run').map((e) => {
      const update = e['assistantMessageEvent'] as { type: string; contentIndex: number; partial?: { content: { id: string; name: string }[] } };
      if (e.type !== 'message_update' || update.type !== 'toolcall_start') return e;
      const call = update.partial?.content[update.contentIndex];
      return { ...e, assistantMessageEvent: { type: 'toolcall_start', contentIndex: update.contentIndex, id: call?.id, toolName: call?.name } };
    });
    expect(run(asJson).out).toEqual(out);
  });
});

describe('aborted run', () => {
  const { out } = run(fixture('abort'));
  it('closes the open reasoning block and ends with RUN_FINISHED carrying result.aborted', () => {
    expect(only(out, EventType.REASONING_END)).toHaveLength(1);
    expect(out.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, outcome: { type: 'cancelled' }, result: { aborted: true } });
    expect(only(out, EventType.RUN_ERROR)).toHaveLength(0);
  });
});

describe('queue run', () => {
  const { out } = run(fixture('queue'));
  it('maps queue_update to pi.queue with the queue lengths and the queued texts', () => {
    expect(custom(out, 'pi.queue').map((e) => (e as unknown as { value: unknown }).value)).toEqual([
      { steer: 0, followUp: 1, steerTexts: [], followUpTexts: ['Now say the word two.'] },
      { steer: 0, followUp: 0, steerTexts: [], followUpTexts: [] },
    ]);
  });
  it('produces two assistant text messages, the follow-up as a user message, and one run', () => {
    const roles = only(out, EventType.TEXT_MESSAGE_START).map((e) => (e as unknown as { role: string }).role);
    expect(roles.filter((r) => r === 'assistant')).toHaveLength(2);
    expect(roles.filter((r) => r === 'user')).toHaveLength(1);
    expect(only(out, EventType.RUN_FINISHED)).toHaveLength(1);
  });
});

describe('events without a recording (shapes from pi docs/json.md)', () => {
  const map = (e: PiEvent) => {
    const ctx = createMapContext({ threadId: 't', runId: 'r', newId: counter(), model: { provider: 'p', modelId: 'm' } });
    return mapEvent(e, ctx);
  };

  it('compaction_start / compaction_end', () => {
    expect(map({ type: 'compaction_start', reason: 'threshold' })).toEqual([
      { type: EventType.CUSTOM, name: 'pi.compaction', value: { phase: 'start' } },
    ]);
    expect(
      map({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, result: { summary: 's', tokensBefore: 150000, estimatedTokensAfter: 32000 } }),
    ).toEqual([{ type: EventType.CUSTOM, name: 'pi.compaction', value: { phase: 'end', tokensBefore: 150000, tokensAfter: 32000 } }]);
    expect(map({ type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false })).toEqual([
      { type: EventType.CUSTOM, name: 'pi.compaction', value: { phase: 'end' } },
    ]);
  });

  it('auto_retry_start', () => {
    expect(map({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '529 overloaded' })).toEqual([
      { type: EventType.CUSTOM, name: 'pi.retry', value: { attempt: 1, maxAttempts: 3, reason: '529 overloaded' } },
    ]);
  });

  it('session_info_changed, thinking_level_changed, entry_appended', () => {
    expect(map({ type: 'session_info_changed', name: 'My thread' })).toEqual([
      { type: EventType.CUSTOM, name: 'pi.session_info', value: { name: 'My thread' } },
    ]);
    expect(map({ type: 'thinking_level_changed', level: 'high' })).toEqual([
      { type: EventType.CUSTOM, name: 'pi.model', value: { provider: 'p', modelId: 'm', thinkingLevel: 'high' } },
    ]);
    expect(map({ type: 'entry_appended', entry: { id: 'e1', type: 'custom' } })).toEqual([
      { type: EventType.CUSTOM, name: 'pi.tree', value: { leafId: 'e1', changed: ['e1'] } },
    ]);
  });

  it('a failed assistant message ends the run with RUN_ERROR, unless pi retried successfully', () => {
    const failed: PiEvent[] = [
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom', usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } },
      { type: 'agent_settled', aborted: false },
    ];
    expect(run(failed).out.at(-1)).toMatchObject({ type: EventType.RUN_ERROR, message: 'boom', code: 'error' });

    const retried: PiEvent[] = [
      failed[0],
      failed[1],
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: 'boom' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'stop' } },
      failed[2],
    ];
    expect(run(retried).out.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED });
  });

  it('a tool call a tool made itself (no toolcall_start) is announced whole', () => {
    const out = map({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', args: { path: 'a' }, result: { content: [{ type: 'text', text: 'x' }, { type: 'image' }] }, isError: false, parentToolCallId: 'p' });
    expect(types(out)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TOOL_CALL_RESULT,
    ]);
    expect(out.at(-1)).toMatchObject({ content: 'x[image]', role: 'tool' });
  });

  it('text and thinking blocks without deltas take their content from the end event', () => {
    const ctx = createMapContext({ threadId: 't', runId: 'r', newId: counter() });
    const out = [
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'whole' } },
    ].flatMap((e) => mapEvent(e, ctx));
    expect(out).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: 'id-1', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'id-1', delta: 'whole' },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'id-1' },
    ]);
  });

  it('tool arguments without deltas are sent whole from toolcall_end', () => {
    const ctx = createMapContext({ threadId: 't', runId: 'r', newId: counter() });
    const out = [
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'c', toolName: 'read' } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'c', name: 'read', arguments: { path: 'a' } } } },
    ].flatMap((e) => mapEvent(e, ctx));
    expect(types(out)).toEqual([EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END]);
    expect(out[1]).toMatchObject({ delta: '{"path":"a"}' });
  });

  it('ignores events it does not map and everything after the run settled', () => {
    for (const type of ['agent_start', 'turn_start', 'turn_end', 'agent_end', 'summarization_retry_finished', 'bash_execution_update']) {
      expect(map({ type })).toEqual([]);
    }
    for (const role of ['user', 'system', 'toolResult']) {
      // The first user message is the run's own prompt, which the client already has.
      expect(map({ type: 'message_start', message: { role } })).toEqual([]);
      expect(map({ type: 'message_end', message: { role } })).toEqual([]);
    }
    const ctx = createMapContext({ threadId: 't', runId: 'r', newId: counter() });
    expect(mapEvent({ type: 'agent_settled', aborted: false }, ctx)).toHaveLength(1);
    expect(mapEvent({ type: 'agent_settled', aborted: false }, ctx)).toEqual([]);
  });
});

describe('tool activities', () => {
  const activities = (events: BaseEvent[]) =>
    only(events, EventType.ACTIVITY_SNAPSHOT) as unknown as { messageId: string; activityType: string; content: Record<string, unknown> }[];
  const byId = (events: BaseEvent[], id: string) => activities(events).filter((a) => a.messageId === id);

  it('gives every tool call a pi.tool activity that runs, streams a sub-line and ends with its duration', () => {
    const { out } = run(fixture('tool-run'));
    const tool = byId(out, 'tool:' + (only(out, EventType.TOOL_CALL_START)[0] as unknown as { toolCallId: string }).toolCallId);
    expect(tool.map((a) => (a.content as { status: string }).status)).toEqual(['running', 'running', 'done']);
    expect(tool.at(-1)?.content).toMatchObject({ toolName: 'bash', progress: 'hello pi-kit', durationMs: 12 });
    // The activities come before the tool result, so a row that shows "complete" already has them.
    const kinds = out
      .filter((e) => e.type === EventType.TOOL_CALL_RESULT || (e.type === EventType.ACTIVITY_SNAPSHOT && (e as unknown as { activityType: string }).activityType !== 'pi.turn_usage'))
      .map((e) => e.type);
    expect(kinds.at(-1)).toBe(EventType.TOOL_CALL_RESULT);
  });

  it('streams bash output as a pi.bash activity and finishes it with the exit code', () => {
    const { out } = run(fixture('tool-run'));
    const bash = activities(out).filter((a) => a.activityType === 'pi.bash');
    expect(bash[0].content).toEqual({ command: 'cat note.txt', output: '', running: true });
    expect(bash.at(-1)?.content).toEqual({ command: 'cat note.txt', output: 'hello pi-kit\n', running: false, exitCode: 0 });
  });

  it('throttles streamed updates but always sends the final result', () => {
    const ctx = createMapContext({ threadId: 't', runId: 'r', newId: counter(), now: () => clock });
    let clock = 0;
    const send = (e: PiEvent) => mapEvent(e, ctx);
    send({ type: 'tool_execution_start', toolCallId: 'c', toolName: 'bash', args: { command: 'x' } });
    const update = (text: string) => send({ type: 'tool_execution_update', toolCallId: 'c', toolName: 'bash', partialResult: { content: [{ type: 'text', text }] } });
    clock = 50;
    expect(update('a')).toEqual([]);
    clock = 130;
    expect(update('a\nb').map((e) => e.type)).toEqual([EventType.ACTIVITY_SNAPSHOT, EventType.ACTIVITY_SNAPSHOT]);
    clock = 140;
    expect(update('a\nb\nc')).toEqual([]);
    clock = 150;
    const end = send({ type: 'tool_execution_end', toolCallId: 'c', toolName: 'bash', result: { content: [{ type: 'text', text: 'a\nb\nc' }] }, isError: false });
    expect(activities(end).find((a) => a.activityType === 'pi.bash')?.content).toMatchObject({ output: 'a\nb\nc', running: false });
  });

  it('marks a failing bash call with its exit code and the error status', () => {
    const { out } = run([
      { type: 'tool_execution_start', toolCallId: 'c', toolName: 'bash', args: { command: 'false' } },
      { type: 'tool_execution_end', toolCallId: 'c', toolName: 'bash', result: { content: [{ type: 'text', text: 'oops\n\nCommand exited with code 2' }] }, isError: true, durationMs: 5 },
    ]);
    expect(byId(out, 'tool:c').at(-1)?.content).toMatchObject({ status: 'error', durationMs: 5 });
    expect(byId(out, 'bash:c').at(-1)?.content).toMatchObject({ exitCode: 2, running: false });
  });

  it('builds a pi.diff from the edit tool patch and from the content of a write call', () => {
    const patch = '--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const { out } = run([
      { type: 'tool_execution_start', toolCallId: 'e', toolName: 'edit', args: { path: 'a.ts', edits: [] } },
      { type: 'tool_execution_end', toolCallId: 'e', toolName: 'edit', result: { content: [{ type: 'text', text: 'ok' }], details: { patch } }, isError: false },
      { type: 'tool_execution_start', toolCallId: 'w', toolName: 'write', args: { path: 'b.ts', content: 'one\ntwo\n' } },
      { type: 'tool_execution_end', toolCallId: 'w', toolName: 'write', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false },
      { type: 'tool_execution_start', toolCallId: 'f', toolName: 'edit', args: { path: 'c.ts' } },
      { type: 'tool_execution_end', toolCallId: 'f', toolName: 'edit', result: { content: [{ type: 'text', text: 'no match' }] }, isError: true },
    ]);
    expect(byId(out, 'diff:e')[0].content).toEqual({
      path: 'a.ts',
      toolCallId: 'e',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
    });
    expect(byId(out, 'diff:w')[0].content).toMatchObject({ path: 'b.ts', written: true, hunks: [{ newLines: 2, lines: ['+one', '+two'] }] });
    expect(byId(out, 'diff:f')).toHaveLength(0);
  });

  it('every activity validates against the protocol schemas and the whole run against AG-UI', async () => {
    const { out } = run(fixture('tool-run'));
    for (const a of activities(out)) {
      expect(() => PI_ACTIVITY_TYPES[a.activityType as keyof typeof PI_ACTIVITY_TYPES].parse(a.content)).not.toThrow();
    }
    await expect(verify(out)).resolves.toBeTruthy();
  });
});

describe('steering, compaction marker and usage', () => {
  it('replays a user message that arrives mid-run, but not the prompt the run started with', () => {
    const user = (text: string) => ({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } });
    const { out } = run([user('the prompt') as PiEvent, user('also do this') as PiEvent]);
    expect(types(out)).toEqual([EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END]);
    expect(out[0]).toMatchObject({ role: 'user' });
    expect(out[1]).toMatchObject({ delta: 'also do this' });
  });

  it('attached to a run in progress (skipUserMessages 0) the first user message is replayed', () => {
    const { out } = run([{ type: 'message_end', message: { role: 'user', content: 'steer' } }], { skipUserMessages: 0 });
    expect(out).toHaveLength(3);
  });

  it('shows a custom message an extension displays as a user message, and does not count it as the prompt', () => {
    const custom = (display: boolean) => ({ type: 'message_end', message: { role: 'custom', customType: 'x', display, content: [{ type: 'text', text: 'From the extension' }] } });
    const { out } = run([custom(true), custom(false), { type: 'message_end', message: { role: 'user', content: 'the prompt' } }]);
    expect(types(out)).toEqual([EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END]);
    expect(out[0]).toMatchObject({ role: 'user' });
    expect(out[1]).toMatchObject({ delta: 'From the extension' });
  });

  it('puts a compaction marker in the transcript, with the id sessionToMessages uses', () => {
    const { out } = run([
      { type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, result: { summary: 's', firstKeptEntryId: 'k1', tokensBefore: 90, estimatedTokensAfter: 30 } },
    ]);
    expect(out[1]).toMatchObject({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: 'compaction:k1',
      activityType: 'pi.compaction',
      content: { tokensBefore: 90, tokensAfter: 30, summary: 's' },
    });
  });

  it('reports the tokens in context with usage', () => {
    const { out } = run(fixture('tool-run'));
    for (const e of custom(out, 'pi.usage')) {
      expect((e as unknown as { value: { contextTokens: number } }).value.contextTokens).toBeGreaterThan(0);
    }
  });

  it('puts a timestamp on reasoning start and end so the UI can say how long pi thought', () => {
    const { out } = run(fixture('tool-run'));
    const starts = only(out, EventType.REASONING_START) as unknown as { timestamp: number }[];
    const ends = only(out, EventType.REASONING_END) as unknown as { timestamp: number }[];
    expect(starts.every((e) => typeof e.timestamp === 'number')).toBe(true);
    expect(ends[0].timestamp).toBeGreaterThan(starts[0].timestamp);
  });
});

describe('generative UI', () => {
  const ops = [
    { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'c' } },
    { version: 'v0.9', updateComponents: { surfaceId: 's1', components: [{ id: 'root', component: 'Text', text: 'hi' }] } },
  ];
  const end = (extra: Record<string, unknown>) =>
    ({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'show', args: { q: 1 }, isError: false, ...extra }) as PiEvent;
  const activitiesOf = (out: BaseEvent[], activityType: string) =>
    only(out, EventType.ACTIVITY_SNAPSHOT).filter((e) => (e as unknown as { activityType: string }).activityType === activityType);

  it('turns details.a2ui_operations into an a2ui-surface activity before the result, and keeps the result text short', () => {
    const { out } = run([end({ result: { content: [{ type: 'text', text: 'Showed the table.' }], details: { a2ui_operations: ops } } })]);
    const [surface] = activitiesOf(out, 'a2ui-surface');
    expect(surface).toMatchObject({ messageId: 'a2ui-surface-c1', content: { a2ui_operations: ops }, replace: true });
    const result = only(out, EventType.TOOL_CALL_RESULT)[0] as unknown as { content: string };
    expect(result.content).toBe('Showed the table.');
    expect(out.indexOf(surface)).toBeLessThan(out.indexOf(only(out, EventType.TOOL_CALL_RESULT)[0]));
  });

  it('writes a surface\'s data as an object: the old payload (an array at /specs) and the new one (an object at /) reach the renderer the same way', () => {
    const specs = [{ spec: 'export.spec.ts:41' }];
    const model = (path: string, value: unknown) => ({ version: 'v0.9', updateDataModel: { surfaceId: 's1', path, value } });
    const drawn = (operation: unknown) => {
      const { out } = run([end({ result: { content: [{ type: 'text', text: 'Showed.' }], details: { a2ui_operations: [...ops, operation] } } })]);
      return (activitiesOf(out, 'a2ui-surface')[0] as unknown as { content: { a2ui_operations: unknown[] } }).content.a2ui_operations.at(-1);
    };
    expect(drawn(model('/specs', specs))).toEqual(model('/', { specs }));
    expect(drawn(model('/', { specs }))).toEqual(model('/', { specs }));
  });

  it('leaves a result whose text is the JSON container to the runtime middleware', () => {
    const text = JSON.stringify({ a2ui_operations: ops });
    const { out } = run([end({ result: { content: [{ type: 'text', text }] } })]);
    expect(activitiesOf(out, 'a2ui-surface')).toHaveLength(0);
    expect((only(out, EventType.TOOL_CALL_RESULT)[0] as unknown as { content: string }).content).toBe(text);
  });

  it('emits an mcp-apps activity for a call of an MCP tool that links a ui:// resource', () => {
    const lookup = (server: string, tool: string) => (server === 'issues' && tool === 'open_form' ? 'ui://issues/form' : undefined);
    const result = {
      content: [{ type: 'text', text: 'Form opened' }],
      structuredContent: { content: [{ type: 'text', text: 'Form opened' }], structuredContent: { draft: 'x' } },
      details: { server: 'issues', tool: 'open_form' },
    };
    const { out } = run([end({ toolName: 'mcp__issues__open_form', result })], { mcpApp: lookup });
    expect(activitiesOf(out, 'mcp-apps')[0]).toMatchObject({
      messageId: 'mcp-app:c1',
      content: {
        serverHash: 'pi-mcp:issues',
        serverId: 'issues',
        tool: 'open_form',
        resourceUri: 'ui://issues/form',
        toolInput: { q: 1 },
        result: { content: [{ type: 'text', text: 'Form opened' }], structuredContent: { draft: 'x' } },
      },
    });
    // another tool of the same server, a failed call and a context without the lookup draw nothing
    expect(activitiesOf(run([end({ result: { ...result, details: { server: 'issues', tool: 'other' } } })], { mcpApp: lookup }).out, 'mcp-apps')).toHaveLength(0);
    expect(activitiesOf(run([end({ isError: true, result })], { mcpApp: lookup }).out, 'mcp-apps')).toHaveLength(0);
    expect(activitiesOf(run([end({ result })]).out, 'mcp-apps')).toHaveLength(0);
  });

  it('falls back to the text pi gave the model when the MCP result was not kept whole', () => {
    const { out } = run([end({ result: { content: [{ type: 'text', text: 'plain' }], details: { server: 's', tool: 't' } } })], { mcpApp: () => 'ui://s/t' });
    expect(activitiesOf(out, 'mcp-apps')[0]).toMatchObject({ content: { result: { content: [{ type: 'text', text: 'plain' }] } } });
  });
});
