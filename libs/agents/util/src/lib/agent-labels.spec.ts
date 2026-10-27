import type { BgAgent } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { agentAllowedTools, agentBadge, agentContextPercent, agentDurationMs, agentStateKey, agentTokens, splitAgents } from './agent-labels';

const agent = (over: Partial<BgAgent>): BgAgent => ({ id: '1', threadId: 't', name: 'a', role: 'r', model: null, permission: 'read-only', tokens: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0 }, context: null, brief: '', status: 'active', blocked: null, createdAt: 1000, finishedAt: null, cost: 0, report: null, activity: 'idle', tool: null, question: null, answered: null, turns: 0, worktree: null, ...over });

describe('agent labels', () => {
  it('says what an agent does or how it ended', () => {
    expect(agentStateKey(agent({ activity: 'running' }))).toEqual({ key: 'running' });
    expect(agentStateKey(agent({ activity: 'tool', tool: 'bash' }))).toEqual({ key: 'runningTool', value: 'bash' });
    expect(agentStateKey(agent({}))).toEqual({ key: 'waiting' });
    expect(agentStateKey(agent({ status: 'blocked', blocked: 'cleanup' }))).toEqual({ key: 'held', value: 'heldCleanup' });
    expect(agentStateKey(agent({ status: 'blocked', blocked: 'crash-loop' }))).toEqual({ key: 'held', value: 'heldCrashLoop' });
    expect(agentStateKey(agent({ status: 'done' }))).toEqual({ key: 'done' });
    const question = { id: 'q1', text: 'Change greet?', kind: 'user' as const, choices: null, note: null, forwarded: false, askedAt: 1, expiresAt: null };
    expect(agentStateKey(agent({ question }))).toEqual({ key: 'waitingForYou' });
    expect(agentStateKey(agent({ question: { ...question, kind: 'main' } }))).toEqual({ key: 'waitingForMain' });
    expect(agentBadge(agent({ question }))).toBe('badge-warning');
    expect(agentBadge(agent({ status: 'failed' }))).toBe('badge-error');
    expect(agentBadge(agent({ activity: 'running' }))).toBe('badge-info');
  });

  it('measures the duration until the end or now, and splits the lists with History newest first', () => {
    expect(agentDurationMs(agent({ finishedAt: 4000 }), 9000)).toBe(3000);
    expect(agentDurationMs(agent({}), 9000)).toBe(8000);
    const { active, history } = splitAgents([agent({ id: '1', status: 'done', finishedAt: 5 }), agent({ id: '2' }), agent({ id: '3', status: 'stopped', finishedAt: 9 }), agent({ id: '4', status: 'blocked' })]);
    expect(active.map((a) => a.id)).toEqual(['2', '4']);
    expect(history.map((a) => a.id)).toEqual(['3', '1']);
  });
});

describe('agent numbers and tools', () => {
  it('shows tokens compact, cache reads counted as input, and the tools a permission allows', () => {
    expect(agentTokens({ input: 18400, output: 950, cacheRead: 2000, cacheWrite: 0 })).toEqual({ input: '20.4k', output: '950', cached: '2k' });
    expect(agentTokens(undefined)).toEqual({ input: '0', output: '0', cached: '0' });
    expect(agentAllowedTools('read-only')).toEqual(['read', 'bash-read-only', 'ask', 'report']);
    expect(agentAllowedTools('edit')).toContain('edit');
  });
});

describe('agent context', () => {
  it('is a percentage only when the window is known', () => {
    expect(agentContextPercent({ context: { tokens: 23_000, window: 100_000 } })).toBe(23);
    expect(agentContextPercent({ context: { tokens: 23_000, window: null } })).toBeNull();
    expect(agentContextPercent({ context: null })).toBeNull();
  });
});
