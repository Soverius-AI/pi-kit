import { TestBed } from '@angular/core/testing';
import { bgAgentsAnswer, bgAgentsList, bgAgentsMessage, bgAgentsRemove, bgAgentsStop, provideMockApi } from '@pi-kit/api';
import type { BgAgent, ThreadsEvent } from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';
import { AgentsStore } from './agents.store';

const agent = (over: Partial<BgAgent>): BgAgent => ({ id: '1', threadId: 't1', name: 'tester', role: 'tests', model: null, permission: 'edit', tokens: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0 }, context: null, brief: 'Test.', status: 'active', blocked: null, createdAt: 1, finishedAt: null, cost: 0, report: null, activity: 'running', tool: null, question: null, answered: null, turns: 0, worktree: null, ...over });

describe('AgentsStore', () => {
  const api = {
    list: vi.fn(async (id: string) => (void id, [agent({})])),
    message: vi.fn(async (id: string, agentId: string, body: unknown) => (void [id, agentId, body], agent({}))),
    stop: vi.fn(async (id: string, agentId: string) => (void [id, agentId], agent({ status: 'stopped' }))),
    remove: vi.fn(async (id: string, agentId: string) => void [id, agentId]),
    answer: vi.fn(async (id: string, agentId: string, body: unknown) => (void [id, agentId, body], agent({}))),
  };
  let listener: ((event: ThreadsEvent) => void) | undefined;
  const threads = { onStatusEvent: vi.fn((fn: (event: ThreadsEvent) => void) => ((listener = fn), () => (listener = undefined))) };

  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockClear();
    listener = undefined;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: ThreadsStore, useValue: threads },
        AgentsStore,
        ...provideMockApi([
          [bgAgentsList, api.list, (o) => [o.path?.['id']]],
          [bgAgentsMessage, api.message, (o) => [o.path?.['id'], o.path?.['agent'], o.body]],
          [bgAgentsStop, api.stop, (o) => [o.path?.['id'], o.path?.['agent']]],
          [bgAgentsRemove, api.remove, (o) => [o.path?.['id'], o.path?.['agent']]],
          [bgAgentsAnswer, api.answer, (o) => [o.path?.['id'], o.path?.['agent'], o.body]],
        ]),
      ],
    });
  });

  it('reads the thread’s agents once and takes every change from the status channel', async () => {
    const store = TestBed.inject(AgentsStore);
    store.watch('t1');
    await vi.waitFor(() => expect(store.agents()).toHaveLength(1));
    expect(api.list).toHaveBeenCalledWith('t1');
    listener?.({ type: 'agents', id: 'other', agents: [] });
    expect(store.agents()).toHaveLength(1);
    listener?.({ type: 'agents', id: 't1', agents: [agent({}), agent({ id: '2', name: 'reviewer', status: 'done' })] });
    expect(store.agents().map((a) => a.name)).toEqual(['tester', 'reviewer']);
    store.watch(undefined);
    expect(store.agents()).toEqual([]);
    expect(listener).toBeUndefined();
  });

  it('messages, stops and deletes through the SDK, and forgets a deleted agent at once', async () => {
    const store = TestBed.inject(AgentsStore);
    store.watch('t1');
    await vi.waitFor(() => expect(store.agents()).toHaveLength(1));
    await store.message('1', 'Cover greet too.', 'steer');
    expect(api.message).toHaveBeenCalledWith('t1', '1', { text: 'Cover greet too.', mode: 'steer' });
    await store.stop('1');
    expect(api.stop).toHaveBeenCalledWith('t1', '1');
    await store.answer('1', 'q1', 'Keep as is');
    expect(api.answer).toHaveBeenCalledWith('t1', '1', { question: 'q1', text: 'Keep as is' });
    await store.answer('1', 'q1', 'cancelled');
    expect(api.answer).toHaveBeenLastCalledWith('t1', '1', { question: 'q1', cancelled: true });
    store.openTranscript('1');
    await store.remove('1');
    expect(api.remove).toHaveBeenCalledWith('t1', '1');
    expect(store.agents()).toEqual([]);
    expect(store.open()).toBeUndefined();
    expect(store.error()).toBeUndefined();
  });

  it('keeps the agent and its open transcript when deletion is refused', async () => {
    const store = TestBed.inject(AgentsStore);
    store.watch('t1');
    await vi.waitFor(() => expect(store.agents()).toHaveLength(1));
    store.openTranscript('1');
    api.remove.mockRejectedValueOnce(new Error('Deletion refused.'));
    await store.remove('1');
    expect(store.agents().map((item) => item.id)).toEqual(['1']);
    expect(store.open()).toBe('1');
    expect(store.error()).toContain('Deletion refused.');
  });

  it('does not publish an old action failure into a newly watched thread', async () => {
    const store = TestBed.inject(AgentsStore);
    store.watch('t1');
    await vi.waitFor(() => expect(store.agents()).toHaveLength(1));
    let reject!: (error: Error) => void;
    api.message.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const sending = store.message('1', 'Continue.', 'followUp');
    await vi.waitFor(() => expect(api.message).toHaveBeenCalledOnce());
    api.list.mockResolvedValueOnce([agent({ id: '2', threadId: 't2' })]);
    store.watch('t2');
    await vi.waitFor(() => expect(store.agents()[0]?.id).toBe('2'));
    reject(new Error('The old thread refused the message.'));
    await sending;
    expect(store.error()).toBeUndefined();
    expect(store.agents().map((item) => item.id)).toEqual(['2']);
  });
});
