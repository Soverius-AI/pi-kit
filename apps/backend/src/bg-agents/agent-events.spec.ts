import { EventType, verifyEvents } from '@ag-ui/client';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { type AgentEvent, createRegistry, defineExtension, defineTool, Harness, MemoryStorage, watchEvents } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { firstValueFrom, from, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AgentEventMapper, entriesToMessages } from './agent-events';

const ctx = BACKGROUND_CONTEXT;

/** A real pi-durable run on memory storage, its events recorded as `watchEvents` delivers them: the fixture the mapper is checked against. */
async function record(): Promise<{ snapshot: Parameters<AgentEventMapper['snapshot']>[0]; batches: (readonly AgentEvent[])[]; final: Parameters<AgentEventMapper['snapshot']>[0] }> {
  const models = createModels();
  const provider = fauxProvider();
  models.setProvider(provider.provider);
  provider.setResponses([fauxAssistantMessage([fauxToolCall('count', { n: 2 })], { stopReason: 'toolUse' }), fauxAssistantMessage('Counted to two.')]);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'probe',
      tools: [defineTool({ name: 'count', description: 'count', parameters: Type.Object({ n: Type.Number() }), execute: async (args, api) => (api.output(`1\n2\n`.slice(0, args.n * 2)), {}) })],
    }),
  );
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: provider.getModel().provider, modelId: provider.getModel().id } } });
  const stream = await watchEvents(harness, root.id, ctx);
  const batches: (readonly AgentEvent[])[] = [];
  stream.start(async (events) => void batches.push(events));
  await (await root.submit({ type: 'input', content: 'Count to two.' }, ctx)).wait(ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await stream.stop();
  const final = (await watchEvents(harness, root.id, ctx)).snapshot;
  await harness.close(ctx);
  return { snapshot: stream.snapshot, batches, final };
}

describe('AgentEventMapper (pi-durable events as AG-UI)', () => {
  it('maps a recorded run to a stream the verifier accepts: one run, the user message, the streamed answer, the tool call and its result, a snapshot at the end', async () => {
    const { snapshot, batches, final } = await record();
    const mapper = new AgentEventMapper('7', () => 'run-1');
    const events = [...mapper.snapshot(snapshot), ...batches.flat().flatMap((event) => mapper.map(event))];
    await expect(firstValueFrom(from(events).pipe(verifyEvents(false), toArray()))).resolves.toHaveLength(events.length);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === EventType.RUN_STARTED)).toHaveLength(2); // the empty transcript at attachment, then the run
    expect(types.filter((t) => t === EventType.RUN_FINISHED)).toHaveLength(2);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    const users = events.filter((e) => e.type === EventType.TEXT_MESSAGE_START && (e as unknown as { role: string }).role === 'user');
    expect(users).toHaveLength(1);
    const last = events.at(-1);
    expect(last?.type).toBe(EventType.RUN_FINISHED);
    const snapshots = events.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT) as unknown as { messages: { role: string }[] }[];
    expect(snapshots.at(-1)?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(mapper.live).toEqual({ activity: 'idle', tool: null, contextTokens: expect.anything() });
    // The entries at the end render the same as the snapshot the mapper built.
    expect(entriesToMessages(final.entries).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    const tool = entriesToMessages(final.entries).find((m) => m.role === 'tool') as { content: string } | undefined;
    expect(tool?.content).toContain('1');
  }, 20_000);

  it('attributes a message from another agent to it, in the snapshot and live', () => {
    const entry = { id: 42 as never, kind: 'pi.user', model: [{ role: 'user', content: 'Message from agent "reviewer" (agent 12): Cover greet too.' }] } as never;
    expect(entriesToMessages([entry])[0]).toMatchObject({ role: 'user', subagentRunId: '12/42' });
    const mapper = new AgentEventMapper('7', () => 'bg-1');
    mapper.map({ type: 'run_start' } as never);
    const events = mapper.map({ type: 'entry_appended', entry } as never);
    expect(events.map((event) => event.type)).toEqual([EventType.SUBAGENT_STARTED, EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END, EventType.SUBAGENT_FINISHED]);
    expect(events[0]).toMatchObject({ subagentRunId: '12/42', name: 'reviewer' });
    expect(events[1]).toMatchObject({ subagentRunId: '12/42' });
    expect(mapper.map({ type: 'entry_appended', entry: { id: 43 as never, kind: 'pi.user', model: [{ role: 'user', content: 'Plain.' }] } as never }).map((event) => event.type)).not.toContain(EventType.SUBAGENT_STARTED);
    // A snapshot announces the senders of the messages it carries, before the messages.
    const fresh = new AgentEventMapper('7', () => 'bg-2');
    const snapshot = fresh.snapshot({ entries: [entry], tools: [], run: undefined } as never);
    expect(snapshot.map((event) => event.type)).toEqual([EventType.RUN_STARTED, EventType.SUBAGENT_STARTED, EventType.SUBAGENT_FINISHED, EventType.MESSAGES_SNAPSHOT, EventType.RUN_FINISHED]);
    expect(snapshot[1]).toMatchObject({ subagentRunId: '12/42', name: 'reviewer' });
  });

  it('reports what the agent does while a run is in flight', () => {
    const mapper = new AgentEventMapper('7', () => 'run-1');
    mapper.map({ type: 'run_start', inputs: [] });
    expect(mapper.live).toMatchObject({ activity: 'running', tool: null });
    mapper.map({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } });
    expect(mapper.live).toMatchObject({ activity: 'tool', tool: 'bash' });
    mapper.map({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash' });
    expect(mapper.live).toMatchObject({ activity: 'running', tool: null });
    const end = mapper.map({ type: 'run_end', inputs: [] });
    expect(end.map((e) => e.type)).toEqual(expect.arrayContaining([EventType.MESSAGES_SNAPSHOT, EventType.RUN_FINISHED]));
    expect(mapper.live.activity).toBe('idle');
  });
});
