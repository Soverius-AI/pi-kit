import type { MetaRepository } from '../db/meta.repository';
import { describe, expect, it, vi } from 'vitest';
import type { ThreadsRepository } from '../db/threads.repository';
import type { PiSessionService } from '../pi/pi-session.service';
import type { ThreadsService } from '../threads/threads.service';
import { RoomAgents } from './room-agents';

const entries = [
  { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'yesterday' } },
  {
    id: 'a1',
    parentId: 'u1',
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall', id: 'old', name: 'mcp__cal__day', arguments: {} }] },
  },
  {
    id: 'r1',
    parentId: 'a1',
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId: 'old',
      toolName: 'mcp__cal__day',
      content: [],
      details: { server: 'cal', tool: 'day' },
    },
  },
  { id: 'u2', parentId: 'r1', type: 'message', message: { role: 'user', content: 'today' } },
  {
    id: 'a2',
    parentId: 'u2',
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'now', name: 'mcp__cal__day', arguments: { date: 'today' } }],
    },
  },
  {
    id: 'r2',
    parentId: 'a2',
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId: 'now',
      toolName: 'mcp__cal__day',
      content: [{ type: 'text', text: '2 meetings' }],
      details: { server: 'cal', tool: 'day' },
    },
  },
];

const agents = () =>
  new RoomAgents(
    {} as ThreadsRepository,
    { treeSource: async () => ({ entries, leafId: 'r2' }) } as unknown as ThreadsService,
    {
      mcpAppLookup: () => (server: string, tool: string) =>
        server === 'cal' && tool === 'day' ? 'ui://cal/day' : undefined,
    } as unknown as PiSessionService,
    {} as MetaRepository,
  );

describe('RoomAgents.apps', () => {
  it('returns the apps of the last turn only, with the whole MCP result when it was caught', async () => {
    const room = agents();
    const full = { content: [{ type: 'text', text: '2 meetings' }], structuredContent: { events: 2 } };
    room.keepMcpResult('lead', 'now', full);
    const apps = await room.apps('lead');
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ serverId: 'cal', tool: 'day', resourceUri: 'ui://cal/day', result: full });
    expect(apps[0]?.toolInput).toEqual({ date: 'today' });
  });

  it('falls back to the text the session kept', async () => {
    const [app] = await agents().apps('lead');
    expect(app?.result).toEqual({ content: [{ type: 'text', text: '2 meetings' }] });
  });
});

describe('RoomAgents.configure', () => {
  it('gives a thread the model and thinking effort a playbook asks for, once, and keeps the default when it cannot', async () => {
    const openSession = vi.fn(async () => undefined);
    const setModel = vi.fn(async (_thread: string, change: { modelId?: string }) => {
      if (change.modelId === 'gone') throw new Error('Unknown model x/gone.');
    });
    const room = new RoomAgents(
      {} as ThreadsRepository,
      { openSession } as unknown as ThreadsService,
      { setModel } as unknown as PiSessionService,
      {} as MetaRepository,
    );
    await room.configure('t1', undefined);
    await room.configure('t1', {});
    expect(setModel).not.toHaveBeenCalled();
    await room.configure('t1', { model: 'anthropic/claude-opus-5-5', thinking: 'high' });
    await room.configure('t1', { model: 'anthropic/claude-opus-5-5', thinking: 'high' });
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(setModel.mock.calls).toEqual([
      ['t1', { provider: 'anthropic', modelId: 'claude-opus-5-5', thinkingLevel: 'high' }],
    ]);
    await room.configure('t1', { thinking: 'low' });
    expect(setModel).toHaveBeenLastCalledWith('t1', { thinkingLevel: 'low' });
    await expect(room.configure('t2', { model: 'x/gone' })).resolves.toBeUndefined();
    await room.configure('t2', { model: 'x/gone' });
    expect(setModel).toHaveBeenCalledTimes(4);
  });
});
