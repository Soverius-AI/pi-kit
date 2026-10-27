import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { describe, expect, it, vi } from 'vitest';
import type { BgAgentRow } from './bg-agents.repository';
import { AGENTS_SECTION, type AgentsHook, createAgentTools } from './agent-tools';

const row = (over: Partial<BgAgentRow> = {}): BgAgentRow => ({ id: '7', threadId: 't1', name: 'tester', role: 'tests', model: null, permission: 'edit', brief: 'Write tests.', submissionId: '1', status: 'active', createdAt: 1, finishedAt: null, cost: 0, report: null, cleanup: null, failures: [], ownerEpoch: 1, ...over });

/** The pi extension API as far as the tools use it: what was registered, and the `before_agent_start` handler. */
function load(hook: AgentsHook | undefined) {
  const tools = new Map<string, ToolDefinition>();
  const handlers: Record<string, (event: { systemPromptOptions: { sections: Record<string, string> } }) => void> = {};
  const api = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), on: (name: string, handler: never) => (handlers[name] = handler), getActiveTools: () => [...tools.keys()] };
  createAgentTools({ threadId: 't1', host: () => hook })(api as unknown as ExtensionAPI);
  const run = (name: string, input: unknown, ctx: Record<string, unknown> = {}) => (tools.get(name) as ToolDefinition).execute('call-1', input, undefined, undefined, ctx as never);
  return { tools, handlers, run };
}

describe('the main agent\'s agent_* tools', () => {
  it('registers the seven tools and spawns through the hook with the thread and the session\'s model', async () => {
    const hook: AgentsHook = { available: () => true, spawn: vi.fn(async (input) => row({ name: input.name, role: input.role, model: input.model ?? null })), send: vi.fn(async () => undefined), list: () => [row(), row({ id: '8', name: 'reviewer', status: 'done', report: 'Fine.' })], wait: vi.fn(async () => 'done' as const), stop: vi.fn(async () => undefined), reply: vi.fn(async () => undefined), forward: vi.fn(async () => undefined), answerInterrupt: vi.fn(async () => true) };
    const { tools, run, handlers } = load(hook);
    expect([...tools.keys()]).toEqual(['agent_spawn', 'agent_send', 'agent_list', 'agent_wait', 'agent_stop', 'agent_reply', 'agent_forward']);
    const spawned = await run('agent_spawn', { name: 'tester', role: 'tests', brief: 'Write tests.', permission: 'edit' }, { model: { provider: 'p', id: 'm' } });
    expect(hook.spawn).toHaveBeenCalledWith({ threadId: 't1', name: 'tester', role: 'tests', brief: 'Write tests.', permission: 'edit', model: 'p/m' });
    expect(spawned.details).toMatchObject({ agentId: '7', name: 'tester', role: 'tests' });
    expect(JSON.parse((spawned.content[0] as { text: string }).text)).toMatchObject({ agentId: '7', status: 'active' });
    await run('agent_send', { agent: '7', text: 'Cover greet too.' });
    expect(hook.send).toHaveBeenCalledWith('7', 'Cover greet too.', 'followUp', 'send:call-1');
    expect(JSON.parse(((await run('agent_list', {})).content[0] as { text: string }).text)).toMatchObject([{ agentId: '7', status: 'active' }, { agentId: '8', report: 'Fine.' }]);
    expect(JSON.parse(((await run('agent_wait', { agent: '7' })).content[0] as { text: string }).text)).toEqual({ agentId: '7', status: 'done' });
    expect(hook.wait).toHaveBeenLastCalledWith('7', undefined);
    const signal = new AbortController().signal;
    await tools.get('agent_wait')!.execute('wait-call', { agent: '7' }, signal, undefined, {} as never);
    expect(hook.wait).toHaveBeenLastCalledWith('7', signal);
    await run('agent_stop', { agent: '7' });
    expect(hook.stop).toHaveBeenCalledWith('7');
    // the main agent answers a question, or hands it to the user.
    expect(((await run('agent_reply', { agent: '7', question: 'q1', text: 'No, numbers only.' })).content[0] as { text: string }).text).toContain('Answered question q1');
    expect(hook.reply).toHaveBeenCalledWith('7', 'q1', 'No, numbers only.');
    expect(((await run('agent_forward', { agent: '7', question: 'q2', note: 'Your call.' })).content[0] as { text: string }).text).toContain('receipt');
    expect(hook.forward).toHaveBeenCalledWith('7', 'q2', 'Your call.');
    await expect(run('agent_reply', { agent: '7', question: 'q1' })).rejects.toThrow();
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    handlers['before_agent_start'](event);
    expect(event.systemPromptOptions.sections[AGENTS_SECTION]).toContain('agent_spawn');
    expect(event.systemPromptOptions.sections[AGENTS_SECTION]).toContain('agent_forward');
  });

  it('agent_wait ends with the run when pi aborts it', async () => {
    const hook: AgentsHook = { available: () => true, spawn: vi.fn(), send: vi.fn(), list: () => [], wait: () => new Promise(() => undefined), stop: vi.fn(), reply: vi.fn(), forward: vi.fn(), answerInterrupt: vi.fn() };
    const { tools } = load(hook);
    const aborter = new AbortController();
    const waiting = (tools.get('agent_wait') as ToolDefinition).execute('call-2', { agent: '7' }, aborter.signal, undefined, {} as never);
    aborter.abort();
    await expect(waiting).rejects.toThrow('Stopped while waiting');
  });

  it('refuses with a clear error while agents are off, and says nothing in the prompt', async () => {
    const { run, handlers } = load(undefined);
    await expect(run('agent_spawn', { name: 'tester', role: 'tests', brief: 'x' })).rejects.toThrow('not available');
    await expect(run('agent_spawn', { name: 'Bad Name', role: 'tests', brief: 'x' })).rejects.toThrow();
    const event = { systemPromptOptions: { sections: { [AGENTS_SECTION]: 'old' } } };
    handlers['before_agent_start'](event);
    expect(event.systemPromptOptions.sections[AGENTS_SECTION]).toBeUndefined();
  });
});
