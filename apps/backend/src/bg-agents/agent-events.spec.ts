import { type BaseEvent, EventType, verifyEvents } from '@ag-ui/client';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Op } from '@earendil-works/chord/delta';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  defineExtension,
  defineTool,
  type EntryRecord,
  Harness,
  type LiveState,
  MemoryStorage,
  type TranscriptView,
} from '@earendil-works/pi-durable';
import { num, obj } from '@earendil-works/pi-schema';
import { AGENT_LIVE_SYNC_RUN } from '@pi-kit/protocol';
import { applyPatch, type Operation } from 'fast-json-patch';
import { firstValueFrom, from, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { AgentEventMapper, AgentViews, entriesToMessages, type ToolTiming } from './agent-events';
import { DocsPatch } from './docs-patch';

const ctx = BACKGROUND_CONTEXT;

type Call = { view: TranscriptView; ops: readonly Op[]; timing: ToolTiming };

/**
 * A real pi-durable run on memory storage, its answer streamed in small pieces (thinking, text, a tool call), its views
 * recorded as `AgentViews` delivers them: the fixture the mapper is checked against.
 */
async function record(): Promise<{ snapshot: TranscriptView; calls: Call[]; final: TranscriptView }> {
  const models = createModels();
  const provider = fauxProvider({ tokensPerSecond: 200, tokenSize: { min: 2, max: 4 } });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(
      [fauxThinking('Two numbers, one at a time.'), fauxText('Counting now.'), fauxToolCall('count', { n: 2 })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('Counted to two, one number after the other.'),
  ]);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'probe',
      tools: [
        defineTool({
          name: 'count',
          description: 'count',
          parameters: obj({ n: num() }),
          execute: async (args, api) => {
            api.output(`1\n2\n`.slice(0, args.n * 2));
            await new Promise((resolve) => setTimeout(resolve, 30));
            return {};
          },
        }),
      ],
    }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { progress: { partialIntervalMs: 5, outputIntervalMs: 5 } } },
    ctx,
  );
  const root = await harness.root(ctx, {
    agent: { model: { provider: provider.getModel().provider, modelId: provider.getModel().id } },
  });
  const stream = await AgentViews.open(root, harness, ctx);
  const calls: Call[] = [];
  stream.start(async (view, ops, timing) => void calls.push({ view, ops, timing }));
  await (await root.submit({ type: 'input', content: 'Count to two.' }, ctx)).wait(ctx);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await stream.stop();
  const after = await AgentViews.open(root, harness, ctx);
  await after.stop();
  await harness.close(ctx);
  return { snapshot: stream.view, calls, final: after.view };
}

/** A view as `AgentViews` hands it on: the whole transcript, and `pi.live`. */
const view = (entries: EntryRecord[], live: LiveState = {}, docs: Record<string, unknown> = {}): TranscriptView =>
  ({
    conversation: {} as never,
    items: entries.map((entry) => ({ kind: 'entry', entry })),
    docs: { ...docs, 'pi.live': live },
  }) as TranscriptView;
const entriesOf = (view: TranscriptView): EntryRecord[] =>
  view.items.flatMap((item) => (item.kind === 'entry' ? [item.entry] : []));
const running = { run: { taskId: 1, inputs: [1], turns: 0 } } as unknown as LiveState;
const message = ['docs', 'pi.live', 'generation', 'message'] as const;
/** The operation that replaces `pi.live` as a whole, for hand-made views. */
const setLive = (live: LiveState): Op[] => [['s', ['docs', 'pi.live'], live as never]];
/** The `pi.agent_live` content a client holds after `events`, as they come over the wire: a snapshot replaces it, a delta patches it. */
const activityAfter = (events: BaseEvent[]): unknown =>
  (
    JSON.parse(JSON.stringify(events)) as {
      type: EventType;
      activityType?: string;
      content?: unknown;
      patch?: Operation[];
    }[]
  )
    .filter((event) => event.activityType === 'pi.agent_live')
    .reduce<unknown>(
      (content, event) =>
        event.type === EventType.ACTIVITY_SNAPSHOT ? event.content : applyPatch(content, event.patch ?? []).newDocument,
      undefined,
    );
type Loose = { type: EventType; messageId?: string; delta?: string; patch?: Operation[]; runId?: string };
const of = (events: BaseEvent[], type: EventType): Loose[] =>
  (events as unknown as Loose[]).filter((event) => event.type === type);
const verified = (events: BaseEvent[]) => firstValueFrom(from(events).pipe(verifyEvents(false), toArray()));

describe('AgentEventMapper (pi-durable views as AG-UI)', () => {
  it('maps a recorded run to a stream the verifier accepts: the user message, the streamed answer ended by its entry, the tool call and its result, the live state with its timing, a snapshot at the end', async () => {
    const { snapshot, calls, final } = await record();
    const mapper = new AgentEventMapper('7', () => 'run-1');
    const events = [
      ...mapper.snapshot(snapshot, {}),
      ...calls.flatMap(({ view, ops, timing }) => mapper.map(view, ops, timing)),
    ];
    await expect(verified(events)).resolves.toHaveLength(events.length);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === EventType.RUN_STARTED)).toHaveLength(2); // the empty transcript at attachment, then the run
    expect(types.filter((t) => t === EventType.RUN_FINISHED)).toHaveLength(2);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
    expect(types).toContain(EventType.ACTIVITY_DELTA);
    const users = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_START && (e as unknown as { role: string }).role === 'user',
    );
    expect(users).toHaveLength(1);
    // Each answer streams as one message, from pi's appends, and its entry ends it: the texts add up to the committed ones.
    const answers = of(events, EventType.TEXT_MESSAGE_START).filter(
      (e) => (e as { role?: string }).role === 'assistant',
    );
    expect(answers).toHaveLength(2);
    const said = answers.map(({ messageId }) =>
      of(events, EventType.TEXT_MESSAGE_CONTENT)
        .filter((e) => e.messageId === messageId)
        .map((e) => e.delta)
        .join(''),
    );
    expect(said).toEqual(['Counting now.', 'Counted to two, one number after the other.']);
    expect(of(events, EventType.TEXT_MESSAGE_CONTENT).length).toBeGreaterThan(3);
    expect(
      of(events, EventType.REASONING_MESSAGE_CONTENT)
        .map((e) => e.delta)
        .join(''),
    ).toBe('Two numbers, one at a time.');
    expect(of(events, EventType.TOOL_CALL_ARGS).map((e) => e.delta)).toEqual(['{"n":2}']);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    const snapshots = events.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT) as unknown as {
      messages: { role: string }[];
    }[];
    expect(snapshots.at(-1)?.messages.map((m) => m.role)).toEqual([
      'user',
      'reasoning',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(mapper.live).toEqual({ activity: 'idle', tool: null, contextTokens: expect.anything() });
    expect(entriesToMessages(entriesOf(final)).map((m) => m.role)).toEqual([
      'user',
      'reasoning',
      'assistant',
      'tool',
      'assistant',
    ]);
    const tool = entriesToMessages(entriesOf(final)).find((m) => m.role === 'tool') as { content: string } | undefined;
    expect(tool?.content).toContain('1');
    // The live state: the snapshot and the deltas add up to pi's documents without the answer, and the call was timed.
    expect(activityAfter(events)).toEqual({
      docs: JSON.parse(JSON.stringify(DocsPatch.strip(final.docs))),
      timing: {},
    });
    const timed = of(events, EventType.ACTIVITY_DELTA)
      .flatMap((e) => e.patch ?? [])
      .filter((op) => op.path.startsWith('/timing/'));
    expect(timed.map((op) => op.op)).toEqual(['add', 'replace', 'remove']);
    expect(timed[1]).toMatchObject({ value: { startedAt: expect.any(Number), endedAt: expect.any(Number) } });
    expect(JSON.stringify(of(events, EventType.ACTIVITY_DELTA))).not.toContain('/generation/message');
    expect(types.slice(-3)).toEqual([EventType.MESSAGES_SNAPSHOT, EventType.ACTIVITY_SNAPSHOT, EventType.RUN_FINISHED]);
    types.forEach(
      (type, i) => type === EventType.MESSAGES_SNAPSHOT && expect(types[i + 1]).toBe(EventType.ACTIVITY_SNAPSHOT),
    );
  }, 20_000);

  it('attributes a message from another agent to it, in the snapshot and live', () => {
    const entry = {
      id: 42 as never,
      kind: 'pi.user',
      model: [{ role: 'user', content: 'Message from agent "reviewer" (agent 12): Cover greet too.' }],
    } as never;
    expect(entriesToMessages([entry])[0]).toMatchObject({ role: 'user', subagentRunId: '12/42' });
    const mapper = new AgentEventMapper('7', () => 'bg-1');
    mapper.snapshot(view([]), {});
    mapper.map(view([], running), setLive(running), {});
    const events = mapper.map(view([entry], running), [], {});
    expect(events.map((event) => event.type)).toEqual([
      EventType.SUBAGENT_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.SUBAGENT_FINISHED,
    ]);
    expect(events[0]).toMatchObject({ subagentRunId: '12/42', name: 'reviewer' });
    expect(events[1]).toMatchObject({ subagentRunId: '12/42' });
    const plain = { id: 43 as never, kind: 'pi.user', model: [{ role: 'user', content: 'Plain.' }] } as never;
    expect(mapper.map(view([entry, plain], running), [], {}).map((event) => event.type)).not.toContain(
      EventType.SUBAGENT_STARTED,
    );
    // A snapshot announces the senders of the messages it carries, before the messages.
    const fresh = new AgentEventMapper('7', () => 'bg-2');
    const snapshot = fresh.snapshot(view([entry]), {});
    expect(snapshot.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.SUBAGENT_STARTED,
      EventType.SUBAGENT_FINISHED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    expect(snapshot[1]).toMatchObject({ subagentRunId: '12/42', name: 'reviewer' });
  });

  it('streams the answer from pi’s own appends, and its entry ends that message instead of repeating it', async () => {
    const mapper = new AgentEventMapper('7', () => 'run-1');
    const call = { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} };
    const partial = (content: unknown[]) =>
      ({ ...running, generation: { attempt: 1, message: { role: 'assistant', content } } }) as never;
    const answer = {
      id: 2,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Hmm.' },
            { type: 'text', text: 'List it.' },
            { ...call, arguments: { command: 'ls' } },
          ],
        },
      ],
    } as never;
    const tools = [{ callId: 'c1', name: 'bash', status: 'pending' }];
    const events = [
      ...mapper.snapshot(view([]), {}),
      ...mapper.map(view([], running), [['s', ['docs', 'pi.live', 'run'], running.run as never]], {}),
      ...mapper.map(
        view([], partial([{ type: 'thinking', thinking: 'Hm' }])),
        [
          ['s', ['docs', 'pi.live', 'generation'], { attempt: 1 }],
          ['s', [...message], { role: 'assistant', content: [{ type: 'thinking', thinking: 'Hm' }] }],
        ],
        {},
      ),
      ...mapper.map(
        view(
          [],
          partial([
            { type: 'thinking', thinking: 'Hmm.' },
            { type: 'text', text: 'List' },
          ]),
        ),
        [
          ['a', [...message, 'content', 0, 'thinking'], 'm.'],
          ['p', [...message, 'content'], 1, 0, [{ type: 'text', text: 'Li' }]],
          ['a', [...message, 'content', 1, 'text'], 'st'],
        ],
        {},
      ),
      ...mapper.map(
        view([], partial([{ type: 'thinking', thinking: 'Hmm.' }, { type: 'text', text: 'List' }, call])),
        [['p', [...message, 'content'], 2, 0, [call]]],
        {},
      ),
      ...mapper.map(
        view([answer], { ...running, tools } as never),
        [
          ['d', ['docs', 'pi.live', 'generation']],
          ['s', ['docs', 'pi.live', 'tools'], tools],
          ['p', ['entries'], 0, 0, [answer]],
        ],
        {},
      ),
    ];
    await verified(events);
    expect(of(events, EventType.REASONING_MESSAGE_CONTENT).map((e) => e.delta)).toEqual(['Hm', 'm.']);
    expect(of(events, EventType.TEXT_MESSAGE_CONTENT).map((e) => e.delta)).toEqual(['Li', 'st', ' it.']);
    const [start] = of(events, EventType.TEXT_MESSAGE_START);
    expect(of(events, EventType.TEXT_MESSAGE_START)).toHaveLength(1);
    expect(of(events, EventType.TEXT_MESSAGE_END)).toEqual([expect.objectContaining({ messageId: start.messageId })]);
    expect(of(events, EventType.TOOL_CALL_START)).toHaveLength(1);
    expect(of(events, EventType.TOOL_CALL_ARGS).map((e) => e.delta)).toEqual(['{"command":"ls"}']);
    expect(of(events, EventType.MESSAGES_SNAPSHOT)).toHaveLength(1); // the one at attachment
    expect(JSON.stringify(of(events, EventType.ACTIVITY_DELTA))).not.toContain('/generation/message');
    expect(activityAfter(events)).toEqual({ docs: { 'pi.live': { ...running, tools } }, timing: {} });
  });

  it('attaches mid-stream: the answer opens with what it holds so far, then streams on', () => {
    const mapper = new AgentEventMapper('7', () => 'run-1');
    const input = { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'Go.' }] } as never;
    const live = {
      ...running,
      generation: { attempt: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Half way' }] } },
    } as never;
    const attached = mapper.snapshot(view([input], live), {});
    expect(attached.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
    expect(attached[4]).toMatchObject({ delta: 'Half way' });
    expect(attached[2]).toMatchObject({ content: { docs: { 'pi.live': { generation: { attempt: 1 } } }, timing: {} } });
    expect(JSON.stringify(attached[2])).not.toContain('Half way');
    const more = mapper.map(view([input], live), [['a', [...message, 'content', 0, 'text'], ' there']], {});
    expect(more).toEqual([expect.objectContaining({ type: EventType.TEXT_MESSAGE_CONTENT, delta: ' there' })]);
  });

  it('starts the answer over when pi rewrites what was streamed of it, or a new attempt replaces it', async () => {
    const mapper = new AgentEventMapper('7', () => 'run-1');
    const live = (attempt: number, text: string) =>
      ({
        ...running,
        generation: { attempt, message: { role: 'assistant', content: [{ type: 'text', text }] } },
      }) as never;
    const events = [...mapper.snapshot(view([], live(1, 'Hello')), {})];
    const first = of(events, EventType.TEXT_MESSAGE_START)[0].messageId;
    const rewritten = mapper.map(view([], live(1, 'ello')), [['t', [...message, 'content', 0, 'text'], 1]], {});
    expect(rewritten.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.MESSAGES_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
    expect(rewritten[0]).toMatchObject({ messageId: first });
    expect(rewritten[3]).not.toMatchObject({ messageId: first });
    expect(rewritten[4]).toMatchObject({ delta: 'ello' });
    const retried = mapper.map(
      view([], live(2, 'Again')),
      [
        [
          's',
          ['docs', 'pi.live', 'generation'],
          { attempt: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'Again' }] } },
        ],
      ],
      {},
    );
    expect(retried.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_END,
      EventType.MESSAGES_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
    expect(retried[2]).toMatchObject({ content: { docs: { 'pi.live': { generation: { attempt: 2 } } } } });
    await verified([...events, ...rewritten, ...retried]);
  });

  it('times the tool calls, nested ones too: a patch of `timing` as they start and end, a remove once they are gone', () => {
    const mapper = new AgentEventMapper('7', () => 'run-1');
    const tools = [{ callId: 'c1', name: 'codemode', taskId: 2, status: 'running' }];
    const nested = [
      {
        callId: 'c1/0',
        name: 'read',
        taskId: 3,
        parentCallId: 'c1',
        parentTaskId: 2,
        status: 'running',
        arguments: { path: 'a' },
      },
    ];
    const live = { ...running, tools, nestedTools: nested } as never;
    const attached = mapper.snapshot(view([], live), { c1: { startedAt: 10 } });
    expect(attached.find((e) => e.type === EventType.ACTIVITY_SNAPSHOT)).toMatchObject({
      content: { docs: { 'pi.live': { nestedTools: nested } }, timing: { c1: { startedAt: 10 } } },
    });
    const patches = [
      mapper.map(view([], live), [], { c1: { startedAt: 10 }, 'c1/0': { startedAt: 11 } }),
      mapper.map(view([], live), [], { c1: { startedAt: 10 }, 'c1/0': { startedAt: 11, endedAt: 12 } }),
      mapper.map(
        view([], running),
        [
          ['d', ['docs', 'pi.live', 'tools']],
          ['d', ['docs', 'pi.live', 'nestedTools']],
        ],
        {},
      ),
    ].map((events) => of(events, EventType.ACTIVITY_DELTA).flatMap((e) => e.patch ?? []));
    expect(patches).toEqual([
      [{ op: 'add', path: '/timing/c1~10', value: { startedAt: 11 } }],
      [{ op: 'replace', path: '/timing/c1~10', value: { startedAt: 11, endedAt: 12 } }],
      [
        { op: 'remove', path: '/docs/pi.live/tools' },
        { op: 'remove', path: '/docs/pi.live/nestedTools' },
        { op: 'remove', path: '/timing/c1' },
        { op: 'remove', path: '/timing/c1~10' },
      ],
    ]);
  });

  it('sends a change made while no run is open in a run of its own, and ends a run with the state its end left', async () => {
    let runs = 0;
    const mapper = new AgentEventMapper('7', () => `run-${++runs}`);
    const inbox = { items: [{ id: 5, mode: 'followUp' }] };
    const failure = { taskId: 2, inputs: [1], reason: 'model_error', detail: '401' };
    const events = [
      ...mapper.snapshot(view([]), {}),
      ...mapper.map(view([], {}, { 'pi.inbox': inbox }), [['s', ['docs', 'pi.inbox'], inbox]], {}),
      ...mapper.map(
        view([], running, { 'pi.inbox': inbox }),
        [['s', ['docs', 'pi.live', 'run'], running.run as never]],
        {},
      ),
      ...mapper.map(
        view([], { runFailure: failure } as never, { 'pi.inbox': inbox }),
        [
          ['d', ['docs', 'pi.live', 'run']],
          ['s', ['docs', 'pi.live', 'runFailure'], failure],
        ],
        {},
      ),
    ];
    await verified(events);
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.MESSAGES_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
      EventType.RUN_STARTED,
      EventType.ACTIVITY_DELTA,
      EventType.RUN_FINISHED,
      EventType.RUN_STARTED,
      EventType.ACTIVITY_DELTA,
      EventType.MESSAGES_SNAPSHOT,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);
    const [, sync, real] = of(events, EventType.RUN_STARTED);
    expect(sync.runId?.startsWith(AGENT_LIVE_SYNC_RUN)).toBe(true);
    expect(real.runId?.startsWith(AGENT_LIVE_SYNC_RUN)).toBe(false);
    expect(of(events, EventType.ACTIVITY_DELTA)[0].patch).toEqual([
      { op: 'add', path: '/docs/pi.inbox', value: inbox },
    ]);
    expect(activityAfter(events)).toEqual({
      docs: { 'pi.inbox': inbox, 'pi.live': { runFailure: failure } },
      timing: {},
    });
  });

  it('reads the timing of model-issued and nested calls from their tasks as they change, and drops a call gone from both lists', async () => {
    const tools = [{ callId: 'c1', name: 'codemode', taskId: 2, status: 'running' }];
    const nested = [
      { callId: 'c1/0', name: 'read', taskId: 3, parentCallId: 'c1', parentTaskId: 2, status: 'running' },
    ];
    const value = (live: object) => ({ conversation: {}, entries: [], docs: { 'pi.live': live } });
    let listener: ((call: unknown) => Promise<void>) | undefined;
    const conversation = {
      watch: async () => ({
        value: value({ tools }),
        start: (fn: (call: unknown) => Promise<void>) => void (listener = fn),
        stop: async () => ({ kind: 'stopped' }),
      }),
      entries: async () => ({ items: [] }),
    };
    const records: Record<number, { startedAt?: number; endedAt?: number }> = {
      2: { startedAt: 10 },
      3: { startedAt: 11 },
    };
    const read: number[] = [];
    const tasks = {
      getTask: async (id: number) => (read.push(id), records[id]),
    };
    const views = await AgentViews.open(conversation as never, tasks as never, ctx);
    expect(views.timing).toEqual({ c1: { startedAt: 10 } });
    const timings: ToolTiming[] = [];
    views.start(async (_view, _ops, timing) => void timings.push(timing));
    const send = (live: object) => listener?.({ kind: 'value', value: value(live), ops: [], retired: false });
    await send({ tools, nestedTools: nested });
    await send({ tools, nestedTools: nested });
    records[3] = { startedAt: 11, endedAt: 12 };
    await send({ tools, nestedTools: [{ ...nested[0], status: 'done' }] });
    await send({});
    expect(timings).toEqual([
      { c1: { startedAt: 10 }, 'c1/0': { startedAt: 11 } },
      { c1: { startedAt: 10 }, 'c1/0': { startedAt: 11 } },
      { c1: { startedAt: 10 }, 'c1/0': { startedAt: 11, endedAt: 12 } },
      {},
    ]);
    expect(read).toEqual([2, 3, 3]); // a task is read when its call appears or changes status, not on every view
  });

  it('reports what the agent does while a run is in flight', () => {
    const mapper = new AgentEventMapper('7', () => 'run-1');
    mapper.snapshot(view([]), {});
    mapper.map(view([], running), setLive(running), {});
    expect(mapper.live).toMatchObject({ activity: 'running', tool: null });
    const slot = { callId: 'c1', name: 'bash', taskId: 2 };
    const tool = { ...running, tools: [{ ...slot, status: 'running' }] } as LiveState;
    mapper.map(view([], tool), setLive(tool), {});
    expect(mapper.live).toMatchObject({ activity: 'tool', tool: 'bash' });
    const done = { ...running, tools: [{ ...slot, status: 'done' }] } as LiveState;
    mapper.map(view([], done), setLive(done), {});
    expect(mapper.live).toMatchObject({ activity: 'running', tool: null });
    const end = mapper.map(view([]), setLive({}), {});
    expect(end.map((e) => e.type)).toEqual(
      expect.arrayContaining([EventType.MESSAGES_SNAPSHOT, EventType.RUN_FINISHED]),
    );
    expect(mapper.live.activity).toBe('idle');
  });
});
