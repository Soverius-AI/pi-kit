import { AgentCard } from '@a2a-js/sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { A2aAgentsRepository } from '../db/a2a-agents.repository';
import type { SecretsService } from '../secrets/secrets.service';
import { RoomA2aAgents } from './room-a2a-agents';
let directory: string, db: DatabaseService, rows: A2aAgentsRepository, agents: RoomA2aAgents;
let enabled: boolean;
let vault: Map<string, string>;
const token = 'private-bearer-value';
const card = (origin = 'https://agent.example') =>
  AgentCard.toJSON(
    AgentCard.fromJSON({
      name: 'Researcher',
      description: 'Research',
      version: '1',
      supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: {},
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    }),
  );
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'room-agent-creds-'));
  db = await DatabaseService.create({ dataDir: directory });
  rows = new A2aAgentsRepository(db);
  enabled = true;
  vault = new Map();
  agents = new RoomA2aAgents(rows, {
    credentialsEnabled: async () => enabled,
    store: {
      kind: 'keychain',
      available: () => true,
      set: async (key: string, value: string) => {
        vault.set(key, value);
      },
      get: async (key: string) => vault.get(key),
      delete: async (key: string) => {
        vault.delete(key);
      },
    },
  } as unknown as SecretsService);
  fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(card()), { headers: { 'content-type': 'application/json' } }),
  );
  agents.fetchImpl = fetcher;
});
afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(directory, { recursive: true, force: true });
});
describe('external agent credential boundary', () => {
  it('requires enabled OS storage before using or saving a new bearer token', async () => {
    enabled = false;
    await expect(agents.add({ url: 'https://agent.example', token })).rejects.toThrow(
      'operating system credential store',
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(await rows.list()).toEqual([]);
    expect(vault.size).toBe(0);
  });
  it('stores new tokens only in the OS vault and returns nonsecret registration metadata', async () => {
    const visible = await agents.add({ url: 'https://agent.example', token });
    expect(visible.tokenStorage).toBe('keychain');
    expect(JSON.stringify(visible)).not.toContain(token);
    expect((await rows.get(visible.id))?.token).toBeNull();
    expect([...vault.values()]).toEqual([token]);
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(`Bearer ${token}`);
    await agents.remove(visible.id);
    expect(vault.size).toBe(0);
    expect(await rows.list()).toEqual([]);
  });
  it('rejects credential-bearing URLs before calling or persisting the agent', async () => {
    for (const url of [
      'https://name:password@agent.example',
      'https://agent.example?token=secret',
      'https://agent.example#secret',
    ])
      await expect(agents.add({ url })).rejects.toThrow('without embedded credentials');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await rows.list()).toEqual([]);
  });
  it('redacts provider errors and refuses to forward a stored bearer to a different card origin', async () => {
    fetcher.mockRejectedValueOnce(new Error(`Provider echoed ${token}`));
    await expect(agents.add({ url: 'https://agent.example', token })).rejects.toThrow(
      'Check the address and credentials',
    );
    fetcher.mockImplementation(
      async () =>
        new Response(JSON.stringify(card('https://other.example')), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const registered = await agents.add({ url: 'https://agent.example', token });
    await expect(agents.getTask(registered.id, { tenant: '', id: 'task' })).rejects.toThrow();
    expect(fetcher.mock.calls.every(([input]) => String(input).startsWith('https://agent.example/'))).toBe(true);
  });
  it('retains read compatibility for a legacy database credential without exposing it in lists', async () => {
    await rows.insert({
      id: 'legacy',
      name: 'Legacy',
      url: 'https://agent.example',
      tokenStorage: 'database',
      token,
      createdAt: 1,
    });
    enabled = false;
    expect(JSON.stringify(await agents.list())).not.toContain(token);
    await agents.card('legacy');
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(vault.size).toBe(0);
  });
});
