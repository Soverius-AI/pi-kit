import { describe, expect, it, vi } from 'vitest';
import { type ReadOnlyMode, ReadOnlyTools } from './read-only-tools';

describe('ReadOnlyTools', () => {
  it('lets the readers through', () => {
    for (const tool of ['read', 'ls', 'find', 'grep']) expect(ReadOnlyTools.block(tool, {})).toBeUndefined();
  });

  it('allows shell commands that only read, without redirection or a second command', () => {
    expect(ReadOnlyTools.block('bash', { command: 'git diff HEAD~1' })).toBeUndefined();
    expect(ReadOnlyTools.block('bash', { command: 'pnpm test' })).toBeUndefined();
    expect(ReadOnlyTools.block('bash', { command: 'rm -rf src' })).toContain('read-only');
    expect(ReadOnlyTools.block('bash', { command: 'cat a > b' })).toContain('read-only');
    expect(ReadOnlyTools.block('bash', { command: 'ls; rm a' })).toContain('read-only');
    expect(ReadOnlyTools.block('bash', { command: 'echo $(rm a)' })).toContain('read-only');
  });

  it('refuses writing tools, questions nobody can answer and starting other agents', () => {
    for (const tool of ['write', 'edit', 'ask_user', 'agent_spawn', 'browser_navigate', 'mcp'])
      expect(ReadOnlyTools.block(tool, {})).toContain(`${tool} is not available`);
  });

  it('lets MCP tools through that only read: marked so by the server, or on a server added read only', () => {
    const tool = (name: string, readOnlyHint?: boolean) => ({
      name: `mcp__${name}`,
      namespace: { name: `mcp__${name.split('__')[0]}`, aliases: [name.split('__')[0]] },
      ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
    });
    const servers = new Set(['composio-googlecalendar']);
    expect(ReadOnlyTools.block('mcp__linear__get_issue', {}, tool('linear__get_issue', true))).toBeUndefined();
    expect(ReadOnlyTools.block('mcp__linear__save_issue', {}, tool('linear__save_issue', false))).toContain(
      'may change something',
    );
    const events = tool('composio-googlecalendar__EVENTS_LIST');
    expect(ReadOnlyTools.block(events.name, {}, events, servers)).toBeUndefined();
    expect(ReadOnlyTools.block(events.name, {}, events)).toContain('may change something');
    expect(ReadOnlyTools.outsideSandbox({ name: 'tool_search' })).toBe(true);
    expect(ReadOnlyTools.outsideSandbox({ name: 'mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL' })).toBe(true);
    expect(ReadOnlyTools.outsideSandbox({ name: 'write' })).toBe(false);
  });

  it('points the model from codemode to tool_search', () => {
    expect(ReadOnlyTools.block('codemode', {})).toContain('tool_search');
  });

  describe('an MCP tool that may change something', () => {
    const manage = {
      name: 'mcp__composio__COMPOSIO_MANAGE_CONNECTIONS',
      namespace: { name: 'mcp__composio', aliases: ['composio'] },
      annotations: { readOnlyHint: false },
    };
    const session = (mode: ReadOnlyMode, answers: (string | undefined)[]) => {
      const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
      const select = vi.fn(async (_title: string, _options: string[]) => answers.shift());
      ReadOnlyTools.factory(
        async () => new Set(),
        mode,
      )({
        on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(name, handler),
        getAllTools: () => [manage],
      } as never);
      const call = () =>
        handlers.get('tool_call')!(
          { toolName: manage.name, input: { toolkits: ['googlecalendar'] } },
          { ui: { select } },
        ) as Promise<{ block: boolean; reason: string } | undefined>;
      return { call, select };
    };

    it('asks the lead’s owner, and remembers “always” for the session', async () => {
      const { call, select } = session('ask-owner', [ReadOnlyTools.DECLINE, ReadOnlyTools.ALWAYS]);
      expect(await call()).toMatchObject({ block: true, reason: expect.stringContaining('did not allow') });
      expect(select.mock.calls[0]?.[0]).toContain('composio · COMPOSIO_MANAGE_CONNECTIONS');
      expect(select.mock.calls[0]?.[0]).toContain('googlecalendar');
      expect(await call()).toBeUndefined();
      expect(await call()).toBeUndefined();
      expect(select).toHaveBeenCalledTimes(2);
    });

    it('is refused without a question where nobody can answer', async () => {
      const { call, select } = session('refuse', []);
      expect(await call()).toMatchObject({ block: true, reason: expect.stringContaining('may change something') });
      expect(select).not.toHaveBeenCalled();
    });
  });
});
