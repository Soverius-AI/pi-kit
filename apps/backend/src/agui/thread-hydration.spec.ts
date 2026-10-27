import { type BaseEvent } from '@ag-ui/client';
import { describe, expect, it, vi } from 'vitest';
import { hydrateThread } from './thread-hydration';

const event = (type: string, fields: object = {}) => ({ type, ...fields }) as BaseEvent;

describe('current-state hydration', () => {
  it('hydrates without a cache, retains unfinished buffers and leaves every stored event unchanged', () => {
    const events = [
      event('MESSAGES_SNAPSHOT', { messages: [{ id: 'u1', role: 'user', content: 'Make a site' }] }),
      event('RUN_STARTED', { threadId: 't', runId: 'r' }),
      event('TOOL_CALL_START', { toolCallId: 'c', parentMessageId: 'a', toolCallName: 'write' }),
      ...Array.from({ length: 20_000 }, () => event('TOOL_CALL_ARGS', { toolCallId: 'c', delta: 'x' })),
    ];
    const before = JSON.stringify(events);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const snapshot = hydrateThread(events);
    const clones = clone.mock.calls.length;
    clone.mockRestore();
    expect(snapshot.messages[0]).toMatchObject({ id: 'u1', content: 'Make a site' });
    expect(snapshot.messages[1]).toMatchObject({ toolCalls: [{ function: { arguments: 'x'.repeat(20_000) } }] });
    expect(JSON.stringify(events)).toBe(before);
    // Work scales with messages/snapshots, not with cloning the transcript for each token.
    expect(clones).toBeLessThan(10);
  });

  it('preserves generated UI, tool results, metadata and state patches across a partial live run', () => {
    const snapshot = hydrateThread([
      event('TOOL_CALL_START', { toolCallId: 'c', parentMessageId: 'a', toolCallName: 'render_a2ui', metadata: { source: 'pi' } }),
      event('TOOL_CALL_ARGS', { toolCallId: 'c', delta: '{"surfaceId":"demo"}' }),
      event('TEXT_MESSAGE_START', { messageId: 'follow', role: 'assistant' }),
      event('TEXT_MESSAGE_CONTENT', { messageId: 'follow', delta: 'Done' }),
      event('TOOL_CALL_RESULT', { toolCallId: 'c', messageId: 'result', content: 'ok' }),
      event('ACTIVITY_SNAPSHOT', { messageId: 'ui', activityType: 'a2ui-surface', content: { rows: [1] }, subagentRunId: 'sub' }),
      event('ACTIVITY_DELTA', { messageId: 'ui', activityType: 'a2ui-surface', patch: [{ op: 'add', path: '/rows/-', value: 2 }] }),
      event('STATE_SNAPSHOT', { snapshot: { count: 1 } }),
      event('STATE_DELTA', { delta: [{ op: 'replace', path: '/count', value: 2 }] }),
    ]);
    expect(snapshot.messages.map((m) => m.id)).toEqual(['a', 'result', 'follow', 'ui']);
    expect(snapshot.messages[0]).toMatchObject({ toolCalls: [{ metadata: { source: 'pi' } }] });
    expect(snapshot.messages[3]).toMatchObject({ content: { rows: [1, 2] }, subagentRunId: 'sub' });
    expect(snapshot.state).toEqual({ count: 2 });
  });

  it('hydrates derived state once without turning historical notifications into fresh notifications', () => {
    const snapshot = hydrateThread([
      event('REASONING_START', { messageId: 'think', timestamp: 100 }),
      event('REASONING_MESSAGE_START', { messageId: 'think' }),
      event('REASONING_MESSAGE_CONTENT', { messageId: 'think', delta: 'Plan' }),
      event('REASONING_END', { messageId: 'think', timestamp: 300 }),
      event('MESSAGES_SNAPSHOT', { messages: [{ id: 'entry:think', role: 'reasoning', content: 'Plan' }] }),
      event('CUSTOM', { name: 'pi.status', value: { key: 'build', text: 'Building' } }),
      event('CUSTOM', { name: 'pi.queue', value: { steer: 1, followUp: 0, steerTexts: ['Next'] } }),
      event('CUSTOM', { name: 'pi.composer', value: { op: 'suggestion', id: 'old', title: 'Old', text: 'x' } }),
      event('CUSTOM', { name: 'pi.composer', value: { op: 'remove', id: 'old' } }),
      event('CUSTOM', { name: 'pi.composer', value: { op: 'suggestion', id: 'new', title: 'New', text: 'y' } }),
      event('CUSTOM', { name: 'pi.notify', value: { level: 'info', text: 'Already happened' } }),
      event('RUN_ERROR', { message: 'Stopped', code: 'aborted' }),
    ]);
    expect(snapshot.view.thinkTimes['entry:think']).toEqual({ start: 100, end: 300 });
    expect(snapshot.view.queue).toEqual({ steering: ['Next'], followUp: [] });
    expect(snapshot.view.statuses).toEqual({ build: 'Building' });
    expect(snapshot.view.runError).toEqual({ message: 'Stopped', code: 'aborted' });
    expect(snapshot.composers.map((c) => c.id)).toEqual(['new']);
    expect(JSON.stringify(snapshot)).not.toContain('Already happened');
  });
});
