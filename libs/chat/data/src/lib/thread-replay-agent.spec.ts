import { type BaseEvent, type Message, EventType } from '@ag-ui/client';
import {
  REPLAY_CURSOR_HEADER,
  THREAD_HYDRATION_HEADER,
  THREAD_HYDRATION_EVENT,
  type ThreadHydration,
} from '@pi-kit/protocol';
import { InterruptController } from '@copilotkit/angular';
import { CopilotKitCore } from '@copilotkit/core';
import { type CachedThreadReplay } from './thread-replay-cache.store';
import { ThreadReplayAgent } from './thread-replay-agent';

describe('ThreadReplayAgent', () => {
  const response = (events: unknown[]) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  const setup = () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const entries = new Map<string, CachedThreadReplay>();
    const agent = new ThreadReplayAgent({
      agentId: 'pi',
      runtimeUrl: 'http://backend/api/copilotkit',
      runtimeMode: 'sse',
      transport: 'rest',
      fetch,
    });
    agent.cache = {
      get: (id) => entries.get(id),
      forget: (id) => {
        entries.delete(id);
      },
      record: (id, value) => {
        entries.set(id, { ...value, visitedAt: Date.now() });
      },
    };
    agent.threadId = 't1';
    return { agent, fetch, entries };
  };

  it('restores cached messages once and applies only the server delta with its matching cursor', async () => {
    const { agent, fetch, entries } = setup();
    fetch.mockResolvedValueOnce(
      response([
        { type: 'CUSTOM', name: 'pi.replay', value: { reset: true } },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [{ id: 'a1', role: 'assistant', content: 'hel' }],
          metadata: { piKitReplayCursor: 'g:1' },
        },
      ]),
    );
    await agent.connectAgent();
    expect(entries.get('t1')?.cursor).toBe('g:1');
    expect(entries.get('t1')?.messages[0].content).toBe('hel');
    agent.setMessages([]); // CopilotKit's normal navigation reset.
    fetch.mockResolvedValueOnce(
      response([
        { type: 'CUSTOM', name: 'pi.replay', value: { reset: false } },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a1', delta: 'lo', metadata: { piKitReplayCursor: 'g:2' } },
      ]),
    );
    await agent.connectAgent();
    expect(agent.messages[0].content).toBe('hello');
    expect(entries.get('t1')?.messages[0].content).toBe('hello');
    expect(entries.get('t1')?.cursor).toBe('g:2');
    const init = fetch.mock.calls[1][1] as RequestInit;
    expect(new Headers(init.headers).get(REPLAY_CURSOR_HEADER)).toBe('g:1');
    expect(JSON.parse(init.body as string).messages).toEqual([]);
  });

  it("a raw replay of a running thread, without a hydration snapshot, is ready at its first checkpoint (a background agent's transcript)", async () => {
    const { agent, fetch, entries } = setup();
    const ready = vi.fn();
    agent.cache = { get: (id) => entries.get(id), forget: () => undefined, record: () => undefined, ready };
    fetch.mockResolvedValueOnce(
      response([
        { type: 'CUSTOM', name: 'pi.replay', value: { reset: true, running: true } },
        { type: EventType.RUN_STARTED, threadId: 't1', runId: 'bg-1', metadata: { piKitReplayCursor: 'g:1' } },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [{ id: 'u1', role: 'user', content: 'Write the tests.' }],
          metadata: { piKitReplayCursor: 'g:2' },
        },
        { type: EventType.RUN_FINISHED, threadId: 't1', runId: 'bg-1', metadata: { piKitReplayCursor: 'g:3' } },
      ]),
    );
    await agent.connectAgent();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith('t1');
    // An idle one is not: its stream completes, which is what settles it.
    ready.mockClear();
    agent.setMessages([]);
    fetch.mockResolvedValueOnce(
      response([
        { type: 'CUSTOM', name: 'pi.replay', value: { reset: true, running: false } },
        { type: 'MESSAGES_SNAPSHOT', messages: [], metadata: { piKitReplayCursor: 'g:4' } },
      ]),
    );
    await agent.connectAgent();
    expect(ready).not.toHaveBeenCalled();
  });

  it('keeps the cached snapshot when the delta is empty and replaces it on a server reset', async () => {
    const { agent, fetch, entries } = setup();
    entries.set('t1', {
      cursor: 'g:5',
      messages: [{ id: 'old', role: 'user', content: 'old branch' }],
      state: {},
      interrupts: [],
      visitedAt: Date.now(),
    });
    fetch.mockResolvedValueOnce(response([{ type: 'CUSTOM', name: 'pi.replay', value: { reset: false } }]));
    await agent.connectAgent();
    expect(agent.messages[0].id).toBe('old');
    fetch.mockResolvedValueOnce(
      response([
        { type: 'CUSTOM', name: 'pi.replay', value: { reset: true } },
        {
          type: 'MESSAGES_SNAPSHOT',
          messages: [{ id: 'new', role: 'user', content: 'new branch' }],
          metadata: { piKitReplayCursor: 'h:1' },
        },
      ]),
    );
    await agent.connectAgent();
    expect(agent.messages.map((m) => m.id)).toEqual(['new']);
    expect(entries.get('t1')?.cursor).toBe('h:1');
  });

  it('checkpoints real run events after applying them, including the terminal event', async () => {
    const { agent, fetch, entries } = setup();
    const events = [
      { type: EventType.RUN_STARTED, threadId: 't1', runId: 'r1', metadata: { piKitReplayCursor: 'g:1' } },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'a1',
        role: 'assistant',
        metadata: { piKitReplayCursor: 'g:2' },
      },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a1', delta: 'done', metadata: { piKitReplayCursor: 'g:3' } },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'a1', metadata: { piKitReplayCursor: 'g:4' } },
      {
        type: EventType.RUN_FINISHED,
        threadId: 't1',
        runId: 'r1',
        outcome: { type: 'success' },
        metadata: { piKitReplayCursor: 'g:5' },
      },
    ] as BaseEvent[];
    fetch.mockResolvedValueOnce(response(events));
    await agent.runAgent();
    expect(entries.get('t1')?.cursor).toBe('g:5');
    expect((entries.get('t1')?.messages as Message[])[0].content).toBe('done');
  });

  it('restores pending questions when an accepted cursor has no new history events', async () => {
    const { agent, fetch, entries } = setup();
    const controller = new InterruptController(async () => ({ result: undefined, newMessages: [] }));
    controller.connect(agent);
    entries.set('t1', {
      cursor: 'g:5',
      messages: [],
      state: {},
      interrupts: [{ id: 'question', reason: 'pi.ui.confirm', message: 'Continue?' }],
      visitedAt: Date.now(),
    });
    fetch.mockResolvedValueOnce(response([{ type: 'CUSTOM', name: 'pi.replay', value: { reset: false } }]));
    try {
      await agent.connectAgent();
      expect(controller.interrupts().map((i) => i.id)).toEqual(['question']);
    } finally {
      controller.destroy();
    }
  });

  it('continues a partially received tool argument from the cached buffer exactly once', async () => {
    const { agent, fetch, entries } = setup();
    entries.set('t1', {
      cursor: 'g:2',
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"' } }],
        },
      ],
      state: {},
      interrupts: [],
      visitedAt: Date.now(),
    });
    fetch.mockResolvedValueOnce(
      response([
        { type: 'CUSTOM', name: 'pi.replay', value: { reset: false } },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '}', metadata: { piKitReplayCursor: 'g:3' } },
        { type: 'TOOL_CALL_END', toolCallId: 'c1', metadata: { piKitReplayCursor: 'g:4' } },
      ]),
    );
    await agent.connectAgent();
    expect(
      (agent.messages[0] as { toolCalls: { function: { arguments: string } }[] }).toolCalls[0].function.arguments,
    ).toBe('{"path":"a"}');
    expect(entries.get('t1')?.cursor).toBe('g:4');
  });

  it('hydrates a cold agent without replaying historical tool chunks, then applies only a new live delta', async () => {
    const { agent, fetch, entries } = setup();
    const toolArgs = vi.fn();
    let prepared = false;
    const prepare = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      prepared = true;
    });
    if (agent.cache) agent.cache.prepare = prepare;
    agent.subscribe({
      onToolCallArgsEvent: (event) => {
        expect(prepared).toBe(true);
        toolArgs(event);
      },
    });
    const snapshot: ThreadHydration<Message> = {
      messages: [
        {
          id: 'a1',
          role: 'assistant',
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: '{"path":"a"' } }],
        },
      ],
      state: { done: false },
      composers: [],
      view: {
        thinkTimes: {},
        queue: { steering: [], followUp: [] },
        compacting: false,
        retry: undefined,
        runError: undefined,
        lastAborted: false,
        statuses: {},
        liveContextTokens: undefined,
      },
    };
    fetch.mockResolvedValueOnce(
      response([
        { type: 'CUSTOM', name: 'pi.replay', value: { reset: true } },
        { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
        { type: 'CUSTOM', name: THREAD_HYDRATION_EVENT, value: snapshot, metadata: { piKitReplayCursor: 'g:20' } },
        { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '}', metadata: { piKitReplayCursor: 'g:21' } },
      ]),
    );
    await agent.connectAgent();
    expect(prepare).toHaveBeenCalledWith('t1', snapshot.messages);
    expect(toolArgs).toHaveBeenCalledTimes(1);
    expect(agent.messages[0]).toMatchObject({ toolCalls: [{ function: { arguments: '{"path":"a"}' } }] });
    expect(agent.state).toEqual({ done: false });
    expect(entries.get('t1')?.cursor).toBe('g:21');
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get(THREAD_HYDRATION_HEADER)).toBe('1');
  });

  it('restores a cold pending question through the normal AG-UI interrupt lifecycle', async () => {
    const { agent, fetch, entries } = setup();
    const controller = new InterruptController(async () => ({ result: undefined, newMessages: [] }));
    controller.connect(agent);
    fetch.mockResolvedValueOnce(
      response([
        { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
        {
          type: 'CUSTOM',
          name: THREAD_HYDRATION_EVENT,
          value: { messages: [], state: {} },
          metadata: { piKitReplayCursor: 'g:5' },
        },
        {
          type: 'RUN_FINISHED',
          threadId: 't1',
          runId: 'r1',
          outcome: { type: 'interrupt', interrupts: [{ id: 'ask', reason: 'pi.ui.confirm', message: 'Continue?' }] },
          metadata: { piKitReplayCursor: 'g:5' },
        },
      ]),
    );
    try {
      await agent.connectAgent();
      expect(controller.interrupts().map((i) => i.id)).toEqual(['ask']);
      expect(entries.get('t1')?.interrupts.map((i) => i.id)).toEqual(['ask']);
    } finally {
      controller.destroy();
    }
  });

  it('keeps the hydration agent after real runtime discovery and registry refresh', async () => {
    const { agent } = setup();
    const runtimeFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: '1',
          mode: 'sse',
          agents: { pi: { description: 'Pi' } },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', runtimeFetch);
    const core = new CopilotKitCore({
      runtimeUrl: 'http://backend/api/copilotkit',
      runtimeTransport: 'rest',
      agents__unsafe_dev_only: { pi: agent },
    });
    try {
      await vi.waitFor(() => expect(core.runtimeConnectionStatus).toBe('connected'));
      expect(core.getAgent('pi')).toBe(agent);
      core.setAgents__unsafe_dev_only({ pi: agent });
      expect(core.getAgent('pi')).toBe(agent);
    } finally {
      core.setRuntimeUrl(undefined);
      vi.unstubAllGlobals();
    }
  });
});
