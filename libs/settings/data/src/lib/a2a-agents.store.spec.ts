import { TestBed } from '@angular/core/testing';
import { provideMockApi, roomsAddAgent, roomsAgents, roomsRemoveAgent } from '@pi-kit/api';
import type { A2aAgent } from '@pi-kit/protocol';
import { A2aAgentsStore } from './a2a-agents.store';

const agent: A2aAgent = {
  id: '5f0c6a43-8f1e-4a7b-9d4e-2c1b0a9f8e7d',
  name: 'Outside coder',
  url: 'https://agent.example',
  tokenStorage: 'keychain',
  createdAt: 1,
};

describe('A2aAgentsStore', () => {
  const list = vi.fn(async (): Promise<A2aAgent[]> => [agent]);
  const add = vi.fn(async (): Promise<A2aAgent> => ({
    ...agent,
    id: 'a6f1d2c3-4b5e-4f6a-8b7c-9d0e1f2a3b4c',
    name: 'Second',
  }));
  const remove = vi.fn(async () => undefined);

  beforeEach(() => {
    list.mockClear();
    add.mockReset().mockResolvedValue({ ...agent, id: 'a6f1d2c3-4b5e-4f6a-8b7c-9d0e1f2a3b4c', name: 'Second' });
    remove.mockClear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ...provideMockApi([
          [roomsAgents, list, () => []],
          [roomsAddAgent, add, (options) => [options.body]],
          [roomsRemoveAgent, remove, (options) => [options.path]],
        ]),
      ],
    });
  });

  it('loads, adds with a trimmed address and token, and removes agents', async () => {
    const store = TestBed.inject(A2aAgentsStore);
    await store.load();
    expect(store.agents().map((value) => value.name)).toEqual(['Outside coder']);
    expect(await store.add('  https://second.example  ', '  t0k  ')).toBe(true);
    expect(add).toHaveBeenCalledWith({ url: 'https://second.example', token: 't0k' });
    await store.remove(agent.id);
    expect(remove).toHaveBeenCalledWith({ agentId: agent.id });
    expect(store.agents().map((value) => value.name)).toEqual(['Second']);
  });

  it('leaves out an empty token and keeps the error when the agent has no card', async () => {
    add.mockRejectedValue(new Error('No A2A agent card at https://nope.example'));
    const store = TestBed.inject(A2aAgentsStore);
    expect(await store.add('https://nope.example', ' ')).toBe(false);
    expect(add).toHaveBeenCalledWith({ url: 'https://nope.example' });
    expect(store.error()).toContain('No A2A agent card');
    expect(store.busy()).toBe(false);
  });
});
