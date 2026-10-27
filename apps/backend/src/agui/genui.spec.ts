import { type BaseEvent, EventType, type Message, type RunAgentInput } from '@ag-ui/client';
import { firstValueFrom, Observable, of, toArray } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { PiSessionService } from '../pi/pi-session.service';
import { a2uiEventPrompt, PiAgent } from './pi-agent';
import { runWithMiddleware } from './run-with-middleware';

const input = (forwardedProps: unknown, messages: Message[] = []): RunAgentInput =>
  ({ threadId: 't1', runId: 'r1', messages, tools: [], context: [], state: {}, forwardedProps }) as RunAgentInput;

function agent(relay: (threadId: string, request: unknown) => Promise<unknown>) {
  const sessions = { abort: vi.fn() } as unknown as PiSessionService;
  return new PiAgent(sessions, { defaultCwd: '/x', threads: {} as never, carry: new Map(), relayMcp: relay as never });
}

const collect = (events: Observable<BaseEvent>) => firstValueFrom(events.pipe(toArray()));

describe('PiAgent: an MCP App request', () => {
  it('relays it to the MCP server and ends with the server answer as the result, without touching pi', async () => {
    const relay = vi.fn().mockResolvedValue({ contents: [{ uri: 'ui://a/b', text: '<p/>' }] });
    const request = { serverHash: 'pi-mcp:issues', serverId: 'issues', method: 'resources/read', params: { uri: 'ui://a/b' } };
    const events = await collect(agent(relay).run(input({ __proxiedMCPRequest: request })));
    expect(relay).toHaveBeenCalledWith('t1', request, expect.any(AbortSignal));
    expect(events.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED]);
    expect(events[1]).toMatchObject({ result: { contents: [{ uri: 'ui://a/b', text: '<p/>' }] } });
  });

  it('answers a failure as a result with the error text, which the app host turns into an error for the app', async () => {
    const events = await collect(agent(() => Promise.reject(new Error('no such tool'))).run(input({ __proxiedMCPRequest: { serverHash: 'h', method: 'tools/call' } })));
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, result: { error: 'no such tool' } });
  });

  it('never turns a malformed request into a prompt', async () => {
    const relay = vi.fn();
    const events = await collect(agent(relay).run(input({ __proxiedMCPRequest: { method: 1 } }, [{ id: 'u', role: 'user', content: 'hi' }])));
    expect(relay).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: EventType.RUN_FINISHED, result: { error: expect.stringContaining('does not understand') } });
  });
});

describe('a2uiEventPrompt', () => {
  const messages = (name: string): Message[] => [
    { id: 'u', role: 'user', content: 'show specs' },
    { id: 'a', role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name, arguments: '{}' } }] },
    { id: 't', role: 'tool', toolCallId: 'c1', content: 'User performed action "rerun" on surface "s" (component: b1). Context: {"spec":"a"}' },
  ];

  it('prompts with what the middleware wrote down about the click', () => {
    expect(a2uiEventPrompt(messages('log_a2ui_event'))?.text).toContain('User performed action "rerun" on surface "s"');
  });

  it('ignores any other tool message', () => {
    expect(a2uiEventPrompt(messages('bash'))).toBeUndefined();
    expect(a2uiEventPrompt([{ id: 'u', role: 'user', content: 'hi' }])).toBeUndefined();
  });
});

describe('runWithMiddleware', () => {
  it('runs the agent as it is when there is no middleware', async () => {
    const run = vi.fn().mockReturnValue(of({ type: EventType.RUN_STARTED }));
    expect(await collect(runWithMiddleware({ run } as never, input({})))).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('chains the middleware the way AbstractAgent.runAgent does: the first registered is outermost', async () => {
    const order: string[] = [];
    const mw = (name: string) => ({
      run: (i: RunAgentInput, next: { run(i: RunAgentInput): Observable<BaseEvent> }) => {
        order.push(name);
        return next.run({ ...i, forwardedProps: { ...(i.forwardedProps as object), [name]: true } });
      },
    });
    const seen: unknown[] = [];
    const agentLike = { middlewares: [mw('first'), mw('second')], run: (i: RunAgentInput) => (seen.push(i.forwardedProps), of({ type: EventType.RUN_FINISHED } as BaseEvent)) };
    await collect(runWithMiddleware(agentLike as never, input({})));
    expect(order).toEqual(['first', 'second']);
    expect(seen).toEqual([{ first: true, second: true }]);
  });
});
