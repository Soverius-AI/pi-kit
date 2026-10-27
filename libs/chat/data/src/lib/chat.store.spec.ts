import { HttpAgent, type AgentSubscriber } from '@ag-ui/client';
import { EnvironmentInjector, createEnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CopilotKit, provideCopilotKit } from '@copilotkit/angular';
import {
  composerComplete,
  attendantAccept,
  attendantDismiss,
  composerComposer,
  provideMockApi,
  queueClear,
  queueMerge,
  queuePromote,
  queueQueue,
  queueRemove,
  sessionListCommands,
  sessionModels,
  sessionSetModel,
  sessionStats,
  settingsPatch,
  threadsListFeedback,
  threadsPutFeedback,
} from '@pi-kit/api';
import { CONTEXT_POLICY, HealthStore, ProviderUsageStore, ToastStore, UiStore } from '@pi-kit/data-access';
import type { Command, ModelList, SessionStats } from '@pi-kit/protocol';
import { THREAD_HYDRATION_EVENT } from '@pi-kit/protocol';
import { fakeThreads, thread } from '@pi-kit/testing';
import { ThreadsStore } from '@pi-kit/threads/api';
import { CHAT_AGENT } from './chat-policy';
import { ChatStore } from './chat.store';
import { ThreadReplayCacheStore } from './thread-replay-cache.store';
import { ComposerExtensions } from './composer-extensions';
import { ChatConnectors, ChatTree } from './ports';

const stats = (over: Partial<SessionStats> = {}): SessionStats =>
  ({
    sessionId: 's1',
    model: { provider: 'anthropic', id: 'opus' },
    thinkingLevel: 'off',
    cost: 0,
    tokens: { total: 0 },
    userMessages: 0,
    contextTokens: 1000,
    contextWindow: 10_000,
    ...over,
  }) as unknown as SessionStats;
const models = (): ModelList =>
  ({
    models: [
      { provider: 'anthropic', id: 'opus', levels: ['off', 'high'] },
      { provider: 'anthropic', id: 'sonnet', levels: ['off'] },
    ],
    scope: null,
  }) as unknown as ModelList;
const commands = (): Command[] => [
  { name: 'new', description: 'New thread', kind: 'action', source: 'builtin' } as unknown as Command,
  { name: 'compact', description: 'Compact', kind: 'action', source: 'builtin' } as unknown as Command,
];
const withSkills = (): Command[] => [
  ...commands(),
  {
    name: 'skill:alpha',
    description: 'Say alpha',
    kind: 'prompt',
    source: 'skill',
    origin: 'project',
  } as unknown as Command,
  {
    name: 'skill:beta',
    description: 'Say beta',
    kind: 'prompt',
    source: 'skill',
    origin: 'user',
  } as unknown as Command,
  { name: 'review', description: 'Review', kind: 'prompt', source: 'prompt', origin: 'user' } as unknown as Command,
];

describe('ChatStore', () => {
  const api = {
    stats: vi.fn(async (id: string) => (void id, stats())),
    models: vi.fn(async (id: string) => (void id, models())),
    commands: vi.fn(async (id: string) => (void id, commands())),
    feedback: vi.fn(async (id: string) => (void id, [])),
    rate: vi.fn(
      async (id: string, message: string, rating: string | null) => (
        void [id, message, rating],
        [{ messageId: message, rating }]
      ),
    ),
    setModel: vi.fn(async (id: string, change: unknown) => (void [id, change], stats({ thinkingLevel: 'high' }))),
    setPinnedModels: vi.fn(async (patterns: string[] | null) => void patterns),
    composer: vi.fn(async (id: string) => (void id, [])),
    complete: vi.fn(),
    acceptFollowUp: vi.fn(async (): Promise<void> => undefined),
    dismissFollowUp: vi.fn(async () => undefined),
    queue: vi.fn(async () => undefined),
    queueSnapshot: vi.fn(async (id: string) => (void id, { steering: ['a'], followUp: ['b'] })),
    promoteQueued: vi.fn(
      async (id: string, target: unknown) => (void [id, target], { steering: ['a', 'b'], followUp: [] }),
    ),
    removeQueued: vi.fn(async (id: string, target: unknown) => (void [id, target], { steering: ['a'], followUp: [] })),
    mergeQueued: vi.fn(async (id: string) => (void id, { steering: ['a\n\nb'], followUp: [] })),
    clearQueued: vi.fn(async (id: string) => (void id, { steering: [], followUp: [] })),
  };
  let threads: ReturnType<typeof fakeThreads>;

  const make = async () => {
    const chat = TestBed.inject(ChatStore);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    return chat;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    for (const fn of Object.values(api)) fn.mockClear();
    localStorage.clear();
    threads = fakeThreads({ selected: thread('t1') });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideCopilotKit({
          selfManagedAgents: {
            pi: new HttpAgent({ url: 'http://127.0.0.1:1/agent/pi/run' }),
            'pi-bg': new HttpAgent({ url: 'http://127.0.0.1:1/agent/pi-bg/run' }),
          },
        }),
        { provide: ThreadsStore, useValue: threads },
        { provide: HealthStore, useValue: { state: () => 'ok', epoch: () => 0 } },
        ...provideMockApi(
          [
            [attendantAccept, api.acceptFollowUp, (o) => [o.path?.['id']]],
            [attendantDismiss, api.dismissFollowUp, (o) => [o.path?.['id']]],
            [sessionStats, api.stats, (o) => [o.path?.['id'], o.signal]],
            [sessionModels, api.models, (o) => [o.query?.['thread'], o.signal]],
            [sessionListCommands, api.commands, (o) => [o.path?.['id'], o.signal]],
            [threadsListFeedback, api.feedback, (o) => [o.path?.['id'], o.signal]],
            [threadsPutFeedback, api.rate, (o) => [o.path?.['id'], o.body?.['messageId'], o.body?.['rating']]],
            [sessionSetModel, api.setModel, (o) => [o.path?.['id'], o.body]],
            [settingsPatch, api.setPinnedModels, (o) => [o.body?.['enabledModels']]],
            [composerComposer, api.composer, (o) => [o.path?.['id'], o.signal]],
            [composerComplete, api.complete, (o) => [o.path?.['id'], o.body?.['text'], o.body?.['cursor'], o.signal]],
            [queueQueue, api.queueSnapshot, (o) => [o.path?.['id']]],
            [queuePromote, api.promoteQueued, (o) => [o.path?.['id'], o.body]],
            [queueRemove, api.removeQueued, (o) => [o.path?.['id'], o.body]],
            [queueMerge, api.mergeQueued, (o) => [o.path?.['id']]],
            [queueClear, api.clearQueued, (o) => [o.path?.['id']]],
          ],
          [],
          [
            [
              /^\/api\/copilotkit\/agent\/pi\/run$/,
              api.queue,
              (_path, body) => {
                const forwarded = body['forwardedProps'] as Record<string, unknown>;
                return [
                  body['threadId'],
                  (body['messages'] as unknown[])[0],
                  forwarded['streamingBehavior'],
                  forwarded['fileRefs'] ?? [],
                  forwarded['skills'] ?? [],
                ];
              },
            ],
          ],
        ),
      ],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('loads the stats, the commands and the models of the selected thread', async () => {
    const chat = await make();
    expect(chat.threadId()).toBe('t1');
    expect(api.stats).toHaveBeenCalledWith('t1', expect.any(AbortSignal));
    expect(chat.commands().map((c) => c.name)).toEqual(['new', 'compact']);
    expect(chat.model()).toEqual({ provider: 'anthropic', id: 'opus' });
    expect(chat.contextPercent()).toBe(10);
    expect(chat.canThink()).toBe(true);
  });

  it('renders the cached signal-store transcript while the agent is reset for synchronization', async () => {
    const chat = await make();
    const cache = TestBed.inject(ThreadReplayCacheStore);
    const messages = [{ id: 'cached', role: 'assistant' as const, content: 'Already rendered' }];
    cache.record('t1', { cursor: 'g:1', messages, state: {}, interrupts: [] });
    chat.requestStarted();
    chat.agent().setMessages([]);
    TestBed.tick();
    expect(chat.messages()).toBe(messages);
    expect(chat.transcriptMessages()[0].content).toBe('Already rendered');
    chat.requestDone();
    chat.agent().setMessages([{ id: 'optimistic', role: 'user', content: 'My next message' }]);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(chat.messages()[0].content).toBe('My next message');
  });

  it('connects again when the status channel says the open thread runs and nothing here follows a run, even for a turn too short to show as an edge', async () => {
    const chat = await make();
    chat.requestDone(); // the replay of the thread is complete
    let turn = 0;
    const running = (id: string, activity: 'running' | 'idle', run = `turn-${++turn}`) =>
      threads.pushStatus({
        type: 'state',
        id,
        state: { ...thread(id).state, activity, ...(activity === 'running' ? { run } : {}) },
      });
    const before = chat.reconnects();
    running('t1', 'running');
    expect(chat.reconnects()).toBe(before + 1);
    TestBed.tick(); // the replay opened
    // A turn of a few milliseconds: "running" and "idle" in one tick, each push counts by itself.
    running('t1', 'idle');
    chat.requestDone();
    running('t1', 'running');
    running('t1', 'idle');
    expect(chat.reconnects()).toBe(before + 2);
    TestBed.tick();
    // Another thread's run is not this transcript's business, and a run this transcript saw start (its own, or one joined) is no news.
    chat.requestDone();
    running('t2', 'running');
    (chat as unknown as { _internal: { seenRuns: Set<string> } })._internal.seenRuns.add('turn-own');
    running('t1', 'running', 'turn-own');
    expect(chat.reconnects()).toBe(before + 2);
    // Announced while a replay is still going: joined once that replay is over, not twice.
    running('t1', 'running');
    expect(chat.reconnects()).toBe(before + 3);
    TestBed.tick();
    running('t1', 'running');
    expect(chat.reconnects()).toBe(before + 3);
    (chat as unknown as { _copilotKit: { core: { connectAgent: unknown } } })._copilotKit.core.connectAgent =
      async () => undefined;
    chat.reconnect();
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(chat.reconnects()).toBe(before + 5);
  });

  it('joins a run the status channel announces while another run is going here once that one is over, unless it was that one', async () => {
    const chat = await make();
    chat.requestDone();
    // A run's lifecycle as the agent reports it to its subscribers (CopilotKit's agent store among them).
    const agent = chat.agent() as unknown as { subscribers: Record<string, ((params: unknown) => void) | undefined>[] };
    const runningHere = (value: boolean): void => {
      for (const subscriber of agent.subscribers)
        subscriber[value ? 'onRunInitialized' : 'onRunFinalized']?.({ agent, messages: [], state: {}, input: {} });
      TestBed.tick();
    };
    const announce = (run: string) =>
      threads.pushStatus({ type: 'state', id: 't1', state: { ...thread('t1').state, activity: 'running', run } });
    const before = chat.reconnects();
    // The next turn starts before this transcript saw the last one end: not joined yet, but once the run here is over.
    runningHere(true);
    announce('turn-next');
    expect(chat.reconnects()).toBe(before);
    runningHere(false);
    expect(chat.reconnects()).toBe(before + 1);
    // Announced during a run that turns out to be that very run (its push came before its RUN_STARTED): nothing to join.
    chat.requestDone();
    runningHere(true);
    announce('turn-own');
    (chat as unknown as { _internal: { seenRuns: Set<string> } })._internal.seenRuns.add('turn-own');
    runningHere(false);
    expect(chat.reconnects()).toBe(before + 1);
  });

  it('remembers the names of the background agents the stream announces', async () => {
    const subscribe = vi.spyOn(HttpAgent.prototype, 'subscribe');
    try {
      const chat = await make();
      const subscriber = subscribe.mock.calls
        .map(([value]) => value)
        .find(
          (value): value is AgentSubscriber =>
            !!value && typeof value === 'object' && 'onSubagentStartedEvent' in value && 'onRunFinishedEvent' in value,
        );
      subscriber?.onSubagentStartedEvent?.({ event: { subagentRunId: '7/spawn', name: 'tester' } } as never);
      subscriber?.onSubagentStartedEvent?.({ event: { subagentRunId: '7/rep-1', name: 'tester' } } as never);
      subscriber?.onSubagentStartedEvent?.({ event: { subagentRunId: '8/spawn', name: 'reviewer' } } as never);
      expect(chat.agentNames()).toEqual({ t1: { '7': 'tester', '8': 'reviewer' } });
      threads.open(thread('t2'));
      TestBed.tick();
      subscriber?.onSubagentStartedEvent?.({ event: { subagentRunId: '9/spawn', name: 'docs' } } as never);
      expect(chat.agentNames()).toEqual({ t1: { '7': 'tester', '8': 'reviewer' }, t2: { '9': 'docs' } });
    } finally {
      subscribe.mockRestore();
    }
  });

  it('opens the shared browser panel when the agent starts a browser action', async () => {
    const subscribe = vi.spyOn(HttpAgent.prototype, 'subscribe');
    try {
      await make();
      const subscriber = subscribe.mock.calls
        .map(([value]) => value)
        .find(
          (value): value is AgentSubscriber =>
            !!value && typeof value === 'object' && 'onToolCallStartEvent' in value && 'onRunFinishedEvent' in value,
        );
      expect(subscriber?.onToolCallStartEvent).toBeDefined();
      const bus = TestBed.inject(UiStore);
      bus.setPanel('files');
      subscriber?.onToolCallStartEvent?.({ event: { toolCallName: 'bash' } } as never);
      expect(bus.panel()).toBe('files');
      subscriber?.onToolCallStartEvent?.({ event: { toolCallName: 'pi_browser' } } as never);
      expect(bus.panel()).toBe('artifacts');
    } finally {
      subscribe.mockRestore();
    }
  });

  it('refreshes Radius credits after a completed run without polling other providers after each run', async () => {
    const refresh = vi.fn(async () => undefined);
    TestBed.overrideProvider(ProviderUsageStore, { useValue: { refresh } });
    const subscribe = vi.spyOn(HttpAgent.prototype, 'subscribe');
    try {
      await make();
      const subscriber = subscribe.mock.calls
        .map(([value]) => value)
        .reverse()
        .find(
          (value): value is AgentSubscriber =>
            !!value &&
            typeof value === 'object' &&
            'onRunFinishedEvent' in value &&
            'onReasoningStartEvent' in value &&
            'onRunFailed' in value,
        );
      expect(subscriber?.onRunFinishedEvent).toBeDefined();
      subscriber?.onRunFinishedEvent?.({ event: { result: {} } } as never);
      expect(refresh).not.toHaveBeenCalled();
      api.stats.mockResolvedValueOnce(
        stats({ model: { provider: 'radius', id: 'balanced' } } as Partial<SessionStats>),
      );
      await TestBed.inject(ChatStore).refreshStats();
      expect(TestBed.inject(ChatStore).model()?.provider).toBe('radius');
      subscriber?.onRunStartedEvent?.({} as never);
      // Choosing a different provider for the next message must not lose the completed Radius run's credit update.
      api.stats.mockResolvedValueOnce(stats());
      await TestBed.inject(ChatStore).refreshStats();
      subscriber?.onRunFinishedEvent?.({ event: { result: {} } } as never);
      expect(refresh).toHaveBeenCalledWith(['radius'], true);
    } finally {
      subscribe.mockRestore();
    }
  });

  it('uses injected context thresholds throughout the composed features', async () => {
    TestBed.overrideProvider(CONTEXT_POLICY, { useValue: { warning: 5, error: 8 } });
    const chat = await make();
    expect(chat.contextLevel()).toBe('error');
    expect(chat.contextNearlyFull()).toBe(true);
  });

  it('the / menu has a group for a connected connector, before the commands, and picking it starts the prompt', async () => {
    TestBed.overrideProvider(ChatConnectors, {
      useValue: {
        menuGroups: () => [
          { server: 'linear', title: 'Linear', line: 'Linear: create issue, search issues…', insert: 'Use Linear to ' },
        ],
      },
    });
    const chat = await make();
    chat.setDraft('/', 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.menuGroups().map((g) => g.title)).toEqual(['Connectors', 'Built in']);
    const item = chat.menuGroups()[0].items[0] as unknown as {
      name: string;
      apply: () => { text: string; caret: number };
    };
    expect(item.name).toBe('Linear: create issue, search issues…');
    expect(item.apply()).toEqual({ text: 'Use Linear to ', caret: 14 });
    // typing narrows it by the vendor's name
    chat.setDraft('/lin', 4);
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.menuGroups().map((g) => g.title)).toEqual(['Connectors']);
  });

  it("regression: a background agent's transcript store leaves the thread's / menu to the thread", async () => {
    TestBed.overrideProvider(ChatConnectors, { useValue: { menuGroups: () => [] } });
    const chat = await make();
    // The Agents panel's transcript: a ChatStore of its own on `pi-bg`, with the agent as its "thread" (agent-transcript.ts).
    const agentScope = createEnvironmentInjector(
      [
        { provide: CHAT_AGENT, useValue: { agentId: 'pi-bg', session: false } },
        { provide: ThreadsStore, useValue: fakeThreads({ selected: thread('agent-1') }) },
        ComposerExtensions,
        ChatStore,
      ],
      TestBed.inject(EnvironmentInjector),
    );
    const agentChat = agentScope.get(ChatStore);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);

    expect(
      TestBed.inject(ComposerExtensions)
        .completionProviders()
        .filter((p) => p.id === 'slash'),
    ).toHaveLength(1);
    chat.setDraft('/', 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.menuGroups().flatMap((g) => g.items.map((i) => i.id))).toEqual(['new', 'compact']);
    // The agent's registry stays empty: its composer offers none of the thread's menus.
    expect(agentScope.get(ComposerExtensions).completionProviders()).toEqual([]);
    agentChat.setDraft('/', 1);
    expect(agentChat.menuOpen()).toBe(false);
    agentScope.destroy();
  });

  it('the draft, the caret and an inserted @path', async () => {
    const chat = await make();
    chat.setDraft('look at', 7);
    expect(chat.draft()).toBe('look at');
    chat.insertAt('@src/a.ts ');
    expect(chat.draft()).toBe('look at @src/a.ts ');
    expect(chat.fileChips()).toEqual(['src/a.ts']);
    chat.removeFileChip('src/a.ts');
    expect(chat.fileChips()).toEqual([]);
  });

  it('insertText puts a dictated sentence at the caret, with a space only where it touches a word', async () => {
    const chat = await make();
    chat.insertText('  please add a test ');
    expect(chat.draft()).toBe('please add a test');
    expect(chat.caret()).toBe(17);
    chat.insertText('and run it');
    expect(chat.draft()).toBe('please add a test and run it');
    chat.setDraft('fix the bug in ', 15);
    chat.insertText('the parser');
    expect(chat.draft()).toBe('fix the bug in the parser');
    // In the middle of a sentence: spaces on both sides, the caret after the inserted words.
    chat.setDraft('fix the bug', 7);
    chat.insertText('big');
    expect(chat.draft()).toBe('fix the big bug');
    expect(chat.caret()).toBe(11);
    // Nothing to insert is not an edit.
    chat.insertText('   ');
    expect(chat.draft()).toBe('fix the big bug');
  });

  it('commits prepared context to its originating draft only after navigation validation', async () => {
    const chat = await make();
    chat.setDraft('My feedback');
    expect(await chat.addImages([], { threadId: 't1', text: 'stale context', current: () => false })).toBe(false);
    expect(chat.draft()).toBe('My feedback');
    let validate!: (valid: boolean) => void;
    const pending = chat.addImages([], {
      threadId: 't1',
      text: 'old chat context',
      current: () =>
        new Promise<boolean>((resolve) => {
          validate = resolve;
        }),
    });
    threads.open(thread('t2'));
    TestBed.tick();
    chat.setDraft('Second draft');
    validate(true);
    expect(await pending).toBe(false);
    expect(chat.draft()).toBe('Second draft');
    expect(chat.images()).toEqual([]);
    expect(await chat.addImages([], { threadId: 't2', text: 'fresh context', current: () => true })).toBe(true);
    expect(chat.draft()).toContain('fresh context');
  });

  it('attaches a 24 MiB image without an application byte cap', async () => {
    const chat = await make();
    vi.useRealTimers();
    const file = new File([new Uint8Array(24 * 1024 * 1024)], 'large-screenshot.png', { type: 'image/png' });
    expect(await chat.addImages([file])).toBe(true);
    expect(chat.images()).toHaveLength(1);
    expect(chat.images()[0]).toMatchObject({ mimeType: 'image/png', name: 'large-screenshot.png' });
    expect(atob(chat.images()[0].data).length).toBe(file.size);
    TestBed.resetTestingModule();
  });

  it('does not attach a file to a different chat while FileReader is preparing it', async () => {
    const chat = await make();
    // FileReader uses real asynchronous file I/O; this assertion needs no polling-clock control.
    vi.useRealTimers();
    const pending = chat.addImages([new File(['image bytes'], 'preview.png', { type: 'image/png' })]);
    threads.open(thread('t2'));
    TestBed.tick();
    expect(await pending).toBe(false);
    expect(chat.images()).toEqual([]);
    TestBed.resetTestingModule();
  });

  it('say shows a notice that goes away by itself', async () => {
    const chat = await make();
    chat.say('info', 'Done');
    expect(chat.notices().map((n) => n.text)).toEqual(['Done']);
    await vi.advanceTimersByTimeAsync(9100);
    expect(chat.notices()).toEqual([]);
  });

  it('setEffort asks the backend and takes the stats it answers', async () => {
    const chat = await make();
    expect(await chat.setEffort('high')).toBe(true);
    expect(api.setModel).toHaveBeenCalledWith('t1', expect.objectContaining({ thinkingLevel: 'high' }));
    expect(chat.effort()).toBe('high');
  });

  it('the pin on a picker row writes the pinned set in order and reloads the models; a failure is a toast', async () => {
    const list = {
      models: [
        { provider: 'anthropic', id: 'opus' },
        { provider: 'anthropic', id: 'sonnet' },
      ],
      providers: [{ id: 'anthropic', name: 'Anthropic', kind: 'subscription' }],
      pinned: [{ provider: 'anthropic', id: 'opus' }],
    } as unknown as ModelList;
    api.models.mockImplementation(async () => list);
    const chat = await make();
    expect(chat.pinned()).toEqual([{ provider: 'anthropic', id: 'opus' }]);
    expect(chat.modelProviders().map((p) => p.kind)).toEqual(['subscription']);
    api.models.mockClear();
    expect(await chat.togglePinnedModel({ provider: 'anthropic', id: 'sonnet' })).toBe(true);
    expect(api.setPinnedModels).toHaveBeenLastCalledWith(['anthropic/opus', 'anthropic/sonnet']);
    expect(api.models).toHaveBeenCalledTimes(1);
    expect(await chat.togglePinnedModel({ provider: 'anthropic', id: 'opus' })).toBe(true);
    expect(api.setPinnedModels).toHaveBeenLastCalledWith(null);
    api.setPinnedModels.mockRejectedValueOnce(new Error('pi could not save its settings'));
    expect(await chat.togglePinnedModel({ provider: 'anthropic', id: 'sonnet' })).toBe(false);
    expect(TestBed.inject(ToastStore).items().at(-1)?.text).toBe('pi could not save its settings');
    api.models.mockImplementation(async (id: string) => (void id, models()));
  });

  it('a failed model change is a toast', async () => {
    const chat = await make();
    api.setModel.mockRejectedValueOnce(new Error('no key'));
    expect(await chat.chooseModel({ provider: 'anthropic', id: 'sonnet' })).toBe(false);
    expect(TestBed.inject(ToastStore).items().at(-1)?.text).toBe('no key');
  });

  it('rating a message keeps the thumb', async () => {
    const chat = await make();
    await chat.rate('m1', 'up');
    expect(chat.feedback()['m1']).toBe('up');
  });

  it('shows pi’s queue after the replay, steering first', async () => {
    const chat = await make();
    expect(api.queueSnapshot).toHaveBeenCalledWith('t1');
    expect(chat.queueRows()).toEqual([
      { kind: 'steer', index: 0, text: 'a' },
      { kind: 'followUp', index: 0, text: 'b' },
    ]);
  });

  it('queue actions answer with pi’s queue: Steer now, Remove, Merge, Clear all', async () => {
    const chat = await make();
    expect(await chat.steerQueued({ kind: 'followUp', index: 0, text: 'b' })).toBe(true);
    expect(api.promoteQueued).toHaveBeenCalledWith('t1', { kind: 'followUp', index: 0, text: 'b' });
    expect(chat.queue()).toEqual({ steering: ['a', 'b'], followUp: [] });
    await chat.removeQueued({ kind: 'steer', index: 1, text: 'b' });
    expect(chat.queue()).toEqual({ steering: ['a'], followUp: [] });
    await chat.mergeQueued();
    expect(chat.queue().steering).toEqual(['a\n\nb']);
    await chat.clearQueued();
    expect(chat.queueRows()).toEqual([]);
  });

  it('Edit takes the message out of the queue and puts it under what is typed in the composer', async () => {
    const chat = await make();
    chat.setDraft('already typed', 13);
    await chat.editQueued({ kind: 'steer', index: 0, text: 'a' });
    expect(api.removeQueued).toHaveBeenCalledWith('t1', { kind: 'steer', index: 0, text: 'a' });
    expect(chat.draft()).toBe('already typed\n\na');
  });

  it('a queue action that fails says so and reads pi’s queue again', async () => {
    const chat = await make();
    api.queueSnapshot.mockClear();
    api.removeQueued.mockRejectedValueOnce(new Error('The queue changed in the meantime.'));
    expect(await chat.removeQueued({ kind: 'steer', index: 0, text: 'a' })).toBe(false);
    expect(chat.notices().at(-1)?.text).toContain('The queue changed');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.queueSnapshot).toHaveBeenCalledWith('t1');
  });

  describe('skill and prompt-template chips', () => {
    const alpha = { kind: 'skill' as const, name: 'alpha', scope: 'project' };

    /** The chat store with the skills in its command list, streaming so that a send is queued and `api.queue` sees it. */
    const makeWithSkills = async (streaming = false) => {
      api.commands.mockResolvedValue(withSkills());
      TestBed.overrideProvider(ChatConnectors, { useValue: { menuGroups: () => [] } });
      TestBed.overrideProvider(ChatTree, {
        useValue: {
          branch: () => undefined,
          recallLast: async () => false,
          commitBranch: async () => undefined,
          refresh: async () => undefined,
        },
      });
      if (streaming) api.stats.mockResolvedValue(stats({ streaming: true } as never));
      const chat = await make();
      return chat;
    };
    afterEach(() => {
      api.commands.mockImplementation(async (id: string) => (void id, commands()));
      api.stats.mockImplementation(async (id: string) => (void id, stats()));
    });

    it('starts a normal run after idle hydration even if cached statistics still say streaming', async () => {
      const subscribe = vi.spyOn(HttpAgent.prototype, 'subscribe');
      try {
        const chat = await makeWithSkills(true);
        const subscriber = subscribe.mock.calls
          .map(([value]) => value)
          .find(
            (value): value is AgentSubscriber =>
              !!value && typeof value === 'object' && 'onToolCallStartEvent' in value && 'onRunFinishedEvent' in value,
          );
        subscriber?.onCustomEvent?.({
          event: {
            name: THREAD_HYDRATION_EVENT,
            value: {
              messages: [],
              state: {},
              composers: [],
              running: false,
              view: { promptActive: false },
            },
          },
        } as never);
        expect(chat.stats()?.streaming).toBe(true);
        expect(chat.promptActive()).toBe(false);
        api.queue.mockClear();
        const run = vi
          .spyOn(TestBed.inject(CopilotKit).core, 'runAgent')
          .mockResolvedValue({ result: undefined, newMessages: [] });
        try {
          chat.setDraft('Continue the new branch');
          await chat.submit();
          expect(run).toHaveBeenCalledOnce();
          expect(api.queue).not.toHaveBeenCalled();
        } finally {
          run.mockRestore();
        }
      } finally {
        subscribe.mockRestore();
      }
    });

    it.each([false, true])(
      'keeps rapid steering requests ordered when the first request fails (%s)',
      async (failFirst) => {
        const chat = await makeWithSkills(true);
        let finish!: () => void;
        api.queue.mockImplementationOnce(
          () =>
            new Promise<undefined>((resolve, reject) => {
              finish = () => (failFirst ? reject(new Error('first request failed')) : resolve(undefined));
            }),
        );
        chat.setDraft('alpha steer');
        const first = chat.submit();
        await vi.advanceTimersByTimeAsync(0);
        chat.setDraft('bravo steer');
        const second = chat.submit();
        await vi.advanceTimersByTimeAsync(0);
        expect(api.queue).toHaveBeenCalledTimes(1);
        finish();
        await Promise.all([first, second]);
        expect(
          api.queue.mock.calls.map((args) => (args as unknown as [string, { content: string }])[1].content),
        ).toEqual(['alpha steer', 'bravo steer']);
      },
    );

    it('preserves the next draft when an asynchronous input transform finishes', async () => {
      const chat = await makeWithSkills(true);
      let finish!: () => void;
      TestBed.inject(ComposerExtensions).addTransform({
        id: 'delayed',
        order: 100,
        transform: (input) =>
          new Promise((resolve) => {
            finish = () => resolve(input);
          }),
      });
      chat.setDraft('alpha steer');
      const sending = chat.submit();
      await vi.advanceTimersByTimeAsync(0);
      chat.setDraft('bravo steer');
      finish();
      await sending;
      expect(chat.draft()).toBe('bravo steer');
      expect((api.queue.mock.calls[0] as unknown as [string, { content: string }])[1].content).toBe('alpha steer');
    });

    it('adds a chip once, in order, and takes it away again', async () => {
      const chat = await makeWithSkills();
      expect(chat.addChip(alpha)).toBe(true);
      expect(chat.addChip(alpha)).toBe(false);
      expect(chat.addCommandChip('skill:beta')).toBe(true);
      expect(chat.addCommandChip('review')).toBe(true);
      expect(chat.addCommandChip('compact')).toBe(false);
      expect(chat.chips().map((c) => `${c.kind}:${c.name}`)).toEqual(['skill:alpha', 'skill:beta', 'prompt:review']);
      chat.removeChip({ kind: 'skill', name: 'beta' });
      expect(chat.chips().map((c) => c.name)).toEqual(['alpha', 'review']);
    });

    it('a chip alone makes a message; a pinned one alone does not', async () => {
      const chat = await makeWithSkills();
      expect(chat.canSend()).toBe(false);
      chat.addChip(alpha);
      expect(chat.canSend()).toBe(true);
      chat.togglePin(alpha);
      expect(chat.canSend()).toBe(false);
      chat.setDraft('go', 2);
      expect(chat.canSend()).toBe(true);
    });

    it('Backspace in an empty composer takes the last chip back; with text in it, Backspace is left alone', async () => {
      const chat = await makeWithSkills();
      chat.addChip(alpha);
      chat.addCommandChip('skill:beta');
      const backspace = () => {
        const event = new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true });
        chat.handleKey(event);
        return event.defaultPrevented;
      };
      chat.setDraft('x', 1);
      expect(backspace()).toBe(false);
      expect(chat.chips()).toHaveLength(2);
      chat.setDraft('', 0);
      expect(backspace()).toBe(true);
      expect(chat.chips().map((c) => c.name)).toEqual(['alpha']);
      backspace();
      expect(chat.chips()).toEqual([]);
      expect(backspace()).toBe(false);
    });

    it('sends the chips beside the text; what was sent leaves the composer and the pinned chip stays for the next message', async () => {
      const chat = await makeWithSkills(true);
      chat.addChip(alpha);
      chat.addCommandChip('skill:beta');
      chat.togglePin(alpha);
      chat.setDraft('check the parser', 16);
      await chat.submit();
      expect(api.queue).toHaveBeenCalledTimes(1);
      const [threadId, message, behavior, fileRefs, skills] = api.queue.mock.calls[0] as unknown as [
        string,
        { content: string },
        string,
        string[],
        unknown[],
      ];
      expect([threadId, message.content, behavior, fileRefs]).toEqual(['t1', 'check the parser', 'steer', []]);
      expect(skills).toEqual([
        { kind: 'skill', name: 'alpha', pinned: true, scope: 'project' },
        { kind: 'skill', name: 'beta', pinned: false, scope: 'user' },
      ]);
      expect(chat.chips().map((c) => [c.name, c.pinned])).toEqual([['alpha', true]]);
      expect(chat.draft()).toBe('');

      // The next message carries the pinned chip again, and the person can let it go.
      chat.setDraft('and again', 9);
      await chat.submit();
      expect((api.queue.mock.calls[1] as unknown[])[4]).toEqual([
        { kind: 'skill', name: 'alpha', pinned: true, scope: 'project' },
      ]);
      chat.togglePin(alpha);
      chat.setDraft('last one', 8);
      await chat.submit();
      expect((api.queue.mock.calls[2] as unknown[])[4]).toEqual([
        { kind: 'skill', name: 'alpha', pinned: false, scope: 'project' },
      ]);
      expect(chat.chips()).toEqual([]);
    });

    it('a run carries the chips in forwardedProps.skills', async () => {
      const chat = await makeWithSkills();
      const run = vi.fn(async () => undefined);
      (chat as unknown as { _copilotKit: { core: { runAgent: unknown } } })._copilotKit.core.runAgent = run;
      chat.addChip(alpha);
      chat.addCommandChip('review');
      await chat.submit();
      expect(run).toHaveBeenCalledTimes(1);
      const call = (run.mock.calls[0] as unknown as [{ forwardedProps: { skills?: unknown[] } }])[0];
      expect(call.forwardedProps.skills).toEqual([
        { kind: 'skill', name: 'alpha', pinned: false, scope: 'project' },
        { kind: 'prompt', name: 'review', pinned: false, scope: 'user' },
      ]);
    });

    it('chips belong to a thread: another thread has its own, and the first is still there', async () => {
      const chat = await makeWithSkills();
      chat.addChip(alpha);
      threads.open(thread('t2'));
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(chat.chips()).toEqual([]);
      chat.addCommandChip('skill:beta');
      threads.open(thread('t1'));
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      expect(chat.chips().map((c) => c.name)).toEqual(['alpha']);
    });

    it('remembers the pinned chips of a thread between launches, and only those', async () => {
      const chat = await makeWithSkills();
      chat.addChip(alpha);
      chat.addCommandChip('skill:beta');
      chat.togglePin(alpha);
      const saved = JSON.parse(localStorage.getItem('pi-kit.pinned-chips') ?? '{}') as Record<
        string,
        { name: string }[]
      >;
      expect(saved['t1'].map((c) => c.name)).toEqual(['alpha']);
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideCopilotKit({ selfManagedAgents: { pi: new HttpAgent({ url: 'http://127.0.0.1:1/agent/pi/run' }) } }),
          { provide: ThreadsStore, useValue: threads },
          { provide: HealthStore, useValue: { state: () => 'ok', epoch: () => 0 } },
          ...provideMockApi(
            [
              [sessionStats, api.stats, (o) => [o.path?.['id'], o.signal]],
              [sessionModels, api.models, (o) => [o.query?.['thread'], o.signal]],
              [sessionListCommands, api.commands, (o) => [o.path?.['id'], o.signal]],
              [threadsListFeedback, api.feedback, (o) => [o.path?.['id'], o.signal]],
              [threadsPutFeedback, api.rate, (o) => [o.path?.['id'], o.body?.['messageId'], o.body?.['rating']]],
              [sessionSetModel, api.setModel, (o) => [o.path?.['id'], o.body]],
              [settingsPatch, api.setPinnedModels, (o) => [o.body?.['enabledModels']]],
              [composerComposer, api.composer, (o) => [o.path?.['id'], o.signal]],
              [composerComplete, api.complete, (o) => [o.path?.['id'], o.body?.['text'], o.body?.['cursor'], o.signal]],
              [queueQueue, api.queueSnapshot, (o) => [o.path?.['id']]],
              [queuePromote, api.promoteQueued, (o) => [o.path?.['id'], o.body]],
              [queueRemove, api.removeQueued, (o) => [o.path?.['id'], o.body]],
              [queueMerge, api.mergeQueued, (o) => [o.path?.['id']]],
              [queueClear, api.clearQueued, (o) => [o.path?.['id']]],
            ],
            [],
            [
              [
                /^\/api\/copilotkit\/agent\/pi\/run$/,
                api.queue,
                (_path, body) => {
                  const forwarded = body['forwardedProps'] as Record<string, unknown>;
                  return [
                    body['threadId'],
                    (body['messages'] as unknown[])[0],
                    forwarded['streamingBehavior'],
                    forwarded['fileRefs'] ?? [],
                    forwarded['skills'] ?? [],
                  ];
                },
              ],
            ],
          ),
        ],
      });
      const again = await make();
      expect(again.chips().map((c) => [c.name, c.pinned])).toEqual([['alpha', true]]);
    });

    it('picking a skill from the / menu puts a chip in the row and takes the typed token out of the text', async () => {
      const chat = await makeWithSkills();
      chat.setDraft('/skill:al', 9);
      await vi.advanceTimersByTimeAsync(10);
      expect(chat.menuGroups().map((g) => g.title)).toEqual(['Skills']);
      chat.pickMenuItem('skill:alpha');
      expect(chat.chips().map((c) => c.name)).toEqual(['alpha']);
      expect(chat.draft()).toBe('');
      // The same skill again is shown as already there and cannot be picked.
      chat.setDraft('/skill:al', 9);
      await vi.advanceTimersByTimeAsync(10);
      expect(chat.menuGroups()[0].items[0].disabled).toBe(true);
      expect(chat.menuFlat()).toEqual([]);
    });

    it('a / after other words offers the skills and templates only, and the chip leaves the sentence whole', async () => {
      const chat = await makeWithSkills();
      chat.setDraft('use /re for the diff', 7);
      await vi.advanceTimersByTimeAsync(10);
      expect(chat.menuOpen()).toBe(true);
      expect(chat.menuGroups().map((g) => g.title)).toEqual(['Prompt templates']);
      chat.pickMenuItem('review');
      expect(chat.chips().map((c) => `${c.kind}:${c.name}`)).toEqual(['prompt:review']);
      expect(chat.draft()).toBe('use for the diff');
      expect(chat.caret()).toBe(4);
      // Built-ins are not offered after other words, and a path is not a command.
      chat.setDraft('then /comp', 10);
      await vi.advanceTimersByTimeAsync(10);
      expect(chat.menuOpen()).toBe(false);
      chat.setDraft('open /etc/hosts', 15);
      await vi.advanceTimersByTimeAsync(10);
      expect(chat.menuOpen()).toBe(false);
    });

    it('the ⊕ menu adds a chip for a skill and still types a built-in', async () => {
      const chat = await makeWithSkills();
      const skills = chat
        .toolsMenu()
        .find((item) => typeof item === 'object' && item.label === 'Skills') as unknown as {
        items: { label: string; action: () => void }[];
      };
      skills.items.find((i) => i.label === '/skill:beta')?.action();
      expect(chat.chips().map((c) => c.name)).toEqual(['beta']);
      expect(chat.draft()).toBe('');
    });
  });

  it('starts over when another thread opens', async () => {
    const chat = await make();
    chat.setRunError({ message: 'boom' });
    threads.open(thread('t2'));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(chat.threadId()).toBe('t2');
    expect(chat.runError()).toBeUndefined();
    expect(api.stats).toHaveBeenLastCalledWith('t2', expect.any(AbortSignal));
  });
  it('does not apply a model mutation after another thread becomes current', async () => {
    const chat = await make();
    let finish!: (value: SessionStats) => void;
    api.setModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const saving = chat.setEffort('high');
    await vi.advanceTimersByTimeAsync(0);
    threads.open(thread('t2'));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    chat.setStats(stats({ model: { provider: 'other', id: 'thread-b', name: 'B' } }));
    finish(stats({ model: { provider: 'anthropic', id: 'thread-a', name: 'A' }, thinkingLevel: 'high' }));
    expect(await saving).toBe(false);
    expect(chat.model()?.id).toBe('thread-b');
    expect(chat.modelError()).toBeUndefined();
  });

  it('ignores a model-list error from the previous thread', async () => {
    const chat = await make();
    let fail!: (error: Error) => void;
    api.models.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const loading = chat.loadModels();
    threads.open(thread('t2'));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    fail(new Error('thread-a failed'));
    await loading;
    expect(chat.modelError()).toBeUndefined();
  });

  it('rolls back only the failed rating, preserving another successful rating', async () => {
    const chat = await make();
    let fail!: (error: Error) => void;
    api.rate.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const first = chat.rate('a', 'up');
    await chat.rate('b', 'down');
    fail(new Error('offline'));
    await first;
    expect(chat.feedback()).toEqual({ b: 'down' });
  });

  it('does not roll back ratings into a different thread', async () => {
    const chat = await make();
    await chat.rate('old', 'up');
    let fail!: (error: Error) => void;
    api.rate.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const saving = chat.rate('a', 'up');
    threads.open(thread('t2'));
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    await chat.rate('b', 'down');
    fail(new Error('offline'));
    await saving;
    expect(chat.feedback()).toEqual({ b: 'down' });
  });

  it('keeps menu selection valid as completion results change', async () => {
    TestBed.configureTestingModule({ providers: [{ provide: ChatConnectors, useValue: { menuGroups: () => [] } }] });
    const chat = await make();
    chat.setDraft('/', 1);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(10);
    chat.selectMenuItem('compact');
    expect(chat.menuSelected()).toBe('compact');
    chat.setDraft('/new', 4);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.menuSelected()).toBe('new');
  });

  it('orders ratings of the same message and restores the confirmed rating when both saves fail', async () => {
    const chat = await make();
    let fail!: (error: Error) => void;
    api.rate.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    api.rate.mockRejectedValueOnce(new Error('second failed'));
    const first = chat.rate('a', 'up');
    const second = chat.rate('a', 'down');
    expect(chat.feedback()['a']).toBe('down');
    expect(api.rate).toHaveBeenCalledTimes(1);
    fail(new Error('first failed'));
    await Promise.all([first, second]);
    expect(chat.feedback()).toEqual({});
  });

  it('regression: reconnect restarts cancelled command hydration', async () => {
    let finish!: (value: Command[]) => void;
    api.commands.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const chat = await make();
    chat.reconnect();
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    finish(commands());
    await vi.advanceTimersByTimeAsync(0);
    expect(chat.commands().map((c) => c.name)).toEqual(['new', 'compact']);
  });

  it('regression: latest effort selection wins while an earlier save is pending', async () => {
    const chat = await make();
    let finish!: (value: SessionStats) => void;
    api.setModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = chat.setEffort('high');
    await vi.advanceTimersByTimeAsync(0);
    api.setModel.mockResolvedValueOnce(stats({ thinkingLevel: 'off' }));
    const second = chat.setEffort('off');
    finish(stats({ thinkingLevel: 'high' }));
    await Promise.all([first, second]);
    expect(chat.effort()).toBe('off');
  });

  it.each([false, true])(
    'regression: a delayed branch submission is invalid after navigation (return to original: %s)',
    async (returnToOriginal) => {
      let finish!: () => void;
      let started = false;
      const commitBranch = vi.fn(() => {
        started = true;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      TestBed.configureTestingModule({
        providers: [{ provide: ChatTree, useValue: { branch: () => ({}), commitBranch } }],
      });
      const chat = await make();
      const run = vi
        .spyOn(TestBed.inject(CopilotKit).core, 'runAgent')
        .mockResolvedValue({ newMessages: [], result: undefined });
      chat.setDraft('prompt for thread A');
      const sending = chat.submit();
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toBe(true);
      threads.open(thread('t2'));
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      if (returnToOriginal) {
        threads.open(thread('t1'));
        TestBed.tick();
        await vi.advanceTimersByTimeAsync(0);
      }
      chat.setDraft('a newer draft');
      finish();
      await sending;
      expect(run).not.toHaveBeenCalled();
      expect(chat.draft()).toBe('a newer draft');
    },
  );

  it('submits a branch after replaying the same thread', async () => {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ChatTree,
          useValue: {
            branch: () => ({}),
            commitBranch: async () => {
              TestBed.inject(ChatStore).reconnect();
              TestBed.tick();
              await vi.advanceTimersByTimeAsync(0);
            },
          },
        },
      ],
    });
    const chat = await make();
    const run = vi
      .spyOn(TestBed.inject(CopilotKit).core, 'runAgent')
      .mockResolvedValue({ newMessages: [], result: undefined });
    chat.setDraft('a valid branch prompt');
    await chat.submit();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        agent: expect.objectContaining({
          threadId: 't1',
          messages: expect.arrayContaining([expect.objectContaining({ content: 'a valid branch prompt' })]),
        }),
      }),
    );
    expect(chat.draft()).toBe('');
  });

  it('queues a return to the displayed model while another model is being saved', async () => {
    const chat = await make();
    let finish!: (value: SessionStats) => void;
    api.setModel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    api.setModel.mockResolvedValueOnce(stats());
    const first = chat.chooseModel({ provider: 'anthropic', id: 'sonnet' });
    const second = chat.chooseModel({ provider: 'anthropic', id: 'opus' });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.setModel).toHaveBeenCalledTimes(1);
    finish(stats({ model: { provider: 'anthropic', id: 'sonnet', name: 'Sonnet' } }));
    await Promise.all([first, second]);
    expect(api.setModel).toHaveBeenCalledTimes(2);
    expect(api.setModel).toHaveBeenLastCalledWith('t1', { provider: 'anthropic', modelId: 'opus' });
    expect(chat.model()?.id).toBe('opus');
  });
  describe('contextual follow-ups', () => {
    beforeEach(() => api.queueSnapshot.mockResolvedValue({ steering: [], followUp: [] }));
    afterEach(() => api.queueSnapshot.mockResolvedValue({ steering: ['a'], followUp: ['b'] }));
    const show = () => {
      const selected = threads.selected()!;
      threads.open({
        ...selected,
        state: {
          ...selected.state,
          lastRun: 'finished',
          suggestions: [{ id: 42, kind: 'prompt', target: 'opaque', text: 'Compare the reviewer reports' }],
        },
      });
    };

    it('Right Arrow inserts an editable draft and never sends it', async () => {
      const chat = await make();
      chat.requestDone();
      show();
      expect(chat.followUp()?.id).toBe(42);
      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
      expect(chat.handleKey(event)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(event.defaultPrevented).toBe(true);
      expect(api.acceptFollowUp).toHaveBeenCalledWith(42);
      expect(chat.draft()).toBe('Compare the reviewer reports');
      expect(api.queue).not.toHaveBeenCalled();
      expect(chat.followUp()).toBeUndefined();
    });

    it('Escape dismisses the prediction and typing hides it', async () => {
      const chat = await make();
      chat.requestDone();
      show();
      chat.setDraft('My own request');
      expect(chat.followUp()).toBeUndefined();
      chat.setDraft('');
      expect(chat.followUp()).toBeDefined();
      chat.handleKey(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(chat.followUp()).toBeUndefined();
      expect(api.dismissFollowUp).toHaveBeenCalledWith(42);
    });

    it('Enter on an empty editor does not accept or send ghost text', async () => {
      const chat = await make();
      chat.requestDone();
      show();
      chat.handleKey(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(chat.draft()).toBe('');
      expect(api.acceptFollowUp).not.toHaveBeenCalled();
      expect(api.queue).not.toHaveBeenCalled();
    });

    it('an acceptance roundtrip cannot replace a draft typed and cleared meanwhile', async () => {
      const chat = await make();
      chat.requestDone();
      show();
      let release!: () => void;
      api.acceptFollowUp.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const accepting = chat.acceptFollowUp();
      await vi.advanceTimersByTimeAsync(0);
      chat.setDraft('My own text');
      chat.setDraft('');
      release();
      await accepting;
      expect(chat.draft()).toBe('');
    });

    it('does not insert a suggestion after the user selects another thread', async () => {
      const chat = await make();
      chat.requestDone();
      show();
      let release!: () => void;
      api.acceptFollowUp.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const accepting = chat.acceptFollowUp();
      await vi.advanceTimersByTimeAsync(0);
      threads.open(thread('t2'));
      TestBed.tick();
      release();
      await accepting;
      expect(chat.draft()).toBe('');
    });
  });
});
