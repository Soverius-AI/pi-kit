import { english } from '@pi-kit/i18n/testing';
import type { Message } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import { AgentLiveState } from './agent-live';

const NOW = 1_800_000_000_000;

class Transcript {
  static live(
    agentId: string,
    live: unknown,
    timing?: Record<string, { startedAt?: number; endedAt?: number }>,
  ): Message {
    return {
      id: `agent-live:${agentId}`,
      role: 'activity',
      activityType: 'pi.agent_live',
      content: { docs: { 'pi.live': live }, ...(timing ? { timing } : {}) },
    } as Message;
  }

  static message(id: string, role: 'user' | 'assistant' = 'assistant', calls: string[] = []): Message {
    return {
      id,
      role,
      content: id,
      ...(calls.length
        ? {
            toolCalls: calls.map((call) => ({
              id: call,
              type: 'function',
              function: { name: 'bash', arguments: '{}' },
            })),
          }
        : {}),
    } as Message;
  }
}

describe('AgentLiveState.pin', () => {
  it('takes the live activity out of the rows wherever it was inserted, so it stays after every committed message', () => {
    const messages = [
      Transcript.message('u1', 'user'),
      Transcript.live('a1', { run: { turns: 1 } }),
      Transcript.message('m1'),
      Transcript.message('m2'),
    ];
    const pinned = AgentLiveState.pin(messages, 'a1');
    expect(pinned.messages.map((m) => m.id)).toEqual(['u1', 'm1', 'm2']);
    expect(pinned.live).toEqual({ run: { turns: 1 } });
  });

  it.each([
    ['an idle state', {}],
    ['finished tools and compactions only', { tools: [], compactions: [] }],
    ['a malformed state', { tools: [{ name: 'bash' }] }],
    ['no state document', undefined],
  ])('draws nothing for %s', (_case, live) => {
    const pinned = AgentLiveState.pin([Transcript.message('u1', 'user'), Transcript.live('a1', live)], 'a1');
    expect(pinned.live).toBeUndefined();
    expect(pinned.messages.map((m) => m.id)).toEqual(['u1']);
  });

  it('hands tools that are already transcript rows to their rows, with the timing and nested calls by parent', () => {
    const pinned = AgentLiveState.pin(
      [
        Transcript.message('m1', 'assistant', ['c1']),
        Transcript.live(
          'a1',
          {
            run: { turns: 1 },
            tools: [
              { callId: 'c1', name: 'bash', status: 'running', output: 'a\nb\n\n', droppedBytes: 10 },
              { callId: 'c2', name: 'grep', status: 'pending' },
            ],
            nestedTools: [
              { callId: 'n1', parentCallId: 'c1', name: 'ls', status: 'running' },
              { callId: 'n2', parentCallId: 'c1', name: 'cat', status: 'done' },
            ],
          },
          { c1: { startedAt: NOW - 5_000 } },
        ),
      ],
      'a1',
    );
    expect(pinned.live?.tools?.map((tool) => tool.callId)).toEqual(['c2']);
    expect([...pinned.tools.keys()]).toEqual(['c1']);
    expect(pinned.nested.get('c1')?.map((tool) => tool.callId)).toEqual(['n1', 'n2']);
    expect(pinned.timing.get('c1')).toEqual({ startedAt: NOW - 5_000 });
    const row = pinned.tools.get('c1')!;
    expect(AgentLiveState.running(row)).toBe(true);
    expect(AgentLiveState.progress(row)).toBe('b');
    expect(AgentLiveState.note(english, row)).toBe('… 10 earlier bytes not shown');
    expect(AgentLiveState.note(english, { ...row, droppedLines: 3 })).toBe('… 3 earlier lines not shown');
  });

  it('draws nothing when every live tool is already a row, but still hands them to the rows', () => {
    const pinned = AgentLiveState.pin(
      [
        Transcript.message('m1', 'assistant', ['c1']),
        Transcript.live('a1', { tools: [{ callId: 'c1', name: 'bash', status: 'running' }] }),
      ],
      'a1',
    );
    expect(pinned.live).toBeUndefined();
    expect(pinned.tools.get('c1')?.status).toBe('running');
  });

  it('shows only the live state of the agent the transcript belongs to', () => {
    const messages = [Transcript.live('other', { run: { turns: 1 } })];
    expect(AgentLiveState.pin(messages, 'a1').live).toBeUndefined();
    expect(AgentLiveState.pin(messages, undefined).live).toBeUndefined();
    expect(AgentLiveState.pin(messages, 'a1').messages).toEqual([]);
  });
});

describe('AgentLiveState.items', () => {
  it('times running and finished calls from the task records and nests calls under their parent', () => {
    const timing = new Map([
      ['c1', { startedAt: NOW - 12_000 }],
      ['n1', { startedAt: NOW - 9_000, endedAt: NOW - 6_000 }],
    ]);
    const nested = new Map([
      [
        'c1',
        [
          {
            callId: 'n1',
            parentCallId: 'c1',
            name: 'bash',
            status: 'done' as const,
            arguments: { command: 'npm  test' },
            output: 'PASS',
          },
          {
            callId: 'n2',
            parentCallId: 'c1',
            name: 'read',
            status: 'done' as const,
            summary: { isError: true, durationMs: 2_000, error: 'ENOENT: no such file' },
          },
          {
            callId: 'n3',
            parentCallId: 'c1',
            name: 'grep',
            status: 'done' as const,
            summary: { isError: true },
          },
        ],
      ],
    ]);
    const [item] = AgentLiveState.items(
      english,
      [{ callId: 'c1', name: 'agent', status: 'running' }],
      { nested, timing },
      NOW,
    );
    expect(item).toMatchObject({ id: 'c1', state: 'running', sub: 'Running, 12s' });
    expect(item.stat).toBeUndefined();
    expect(item.children).toEqual([
      {
        id: 'n1',
        name: 'bash',
        state: 'done',
        target: 'npm test',
        stat: '3s',
        output: 'PASS',
        sub: undefined,
        note: undefined,
      },
      expect.objectContaining({ id: 'n2', state: 'error', sub: 'ENOENT: no such file', stat: '2s' }),
      expect.objectContaining({ id: 'n3', state: 'error', sub: 'Failed', stat: undefined }),
    ]);
    expect(
      AgentLiveState.items(english, [{ callId: 'c9', name: 'bash', status: 'pending' }], { nested, timing }, NOW)[0],
    ).toMatchObject({ sub: 'Waiting', state: 'running' });
  });
});
