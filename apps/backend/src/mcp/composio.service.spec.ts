import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaRepository } from '../db/meta.repository';
import type { PiSessionService } from '../pi/pi-session.service';
import type { SecretsService } from '../secrets/secrets.service';
import { ComposioService } from './composio.service';

vi.mock('../pi/load-pi', () => ({
  loadPiInternals: async () => ({
    config: { resolveConfigValueOrThrow: (value: string) => value },
  }),
}));

let base: string;
let server: Server;
let calls: { method: string; url: string; key: string; body: unknown }[];
let connected: boolean;
let service: ComposioService;
let settings: Map<string, unknown>;

const answer = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'pk-composio-'));
  calls = [];
  connected = false;
  settings = new Map();
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const key = String(req.headers['x-api-key'] ?? '');
      calls.push({ method: req.method ?? '', url: req.url ?? '', key, body: raw ? JSON.parse(raw) : undefined });
      if (key !== 'good-key-123') return answer(res, 401, { error: { message: 'bad key' } });
      const url = req.url ?? '';
      if (url.startsWith('/toolkits'))
        return answer(res, 200, {
          items: [
            {
              slug: 'sevdesk',
              name: 'sevDesk',
              meta: { description: 'Accounting', logo: 'https://l/s.png', tools_count: 40 },
            },
          ],
        });
      if (url === '/tool_router/session')
        return answer(res, 200, { session_id: 's1', mcp: { type: 'http', url: 'https://mcp.example/s1' } });
      if (url.startsWith('/tool_router/session/s1/toolkits'))
        return answer(res, 200, {
          items: [{ slug: 'sevdesk', is_no_auth: false, connected_account: connected ? { status: 'ACTIVE' } : null }],
        });
      if (url === '/tool_router/session/s1/link')
        return answer(res, 200, { redirect_url: 'https://connect.example/sevdesk' });
      answer(res, 404, { error: { message: 'no route' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env['PI_KIT_COMPOSIO_URL'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  service = new ComposioService(
    {
      instanceId: 'inst',
      getSetting: async (key: string) => settings.get(key),
      setSetting: async (key: string, value: unknown) => void settings.set(key, value),
    } as unknown as MetaRepository,
    {
      keep: async (_account: string, key: string) => ({ value: key, storage: 'auth.json' }),
      forget: vi.fn(),
    } as unknown as SecretsService,
    { agentDir: async () => base } as unknown as PiSessionService,
  );
});

afterEach(async () => {
  delete process.env['PI_KIT_COMPOSIO_URL'];
  await new Promise((resolve) => server.close(resolve));
  rmSync(base, { recursive: true, force: true });
});

describe('Composio', () => {
  it('keeps a key only when Composio accepts it', async () => {
    await expect(service.setKey('wrong-key-1')).rejects.toThrow('refused the API key');
    expect(await service.status()).toEqual({ configured: false, storage: null });
    expect(await service.setKey('good-key-123')).toEqual({ configured: true, storage: 'plain' });
  });

  it('lists apps and adds one as a read-only server of its own with its sign-in link', async () => {
    await service.setKey('good-key-123');
    expect(await service.toolkits('sev')).toEqual([
      {
        slug: 'sevdesk',
        name: 'sevDesk',
        description: 'Accounting',
        logo: 'https://l/s.png',
        tools: 40,
        noAuth: false,
      },
    ]);
    expect(calls.at(-1)?.url).toBe('/toolkits?limit=30&search=sev');
    const added = await service.add({ toolkit: 'sevdesk', name: 'sevDesk', readOnly: true });
    expect(added).toEqual({
      server: 'composio-sevdesk',
      toolkit: 'sevdesk',
      name: 'sevDesk',
      readOnly: true,
      connected: false,
      signInUrl: 'https://connect.example/sevdesk',
    });
    expect(calls.find((call) => call.url === '/tool_router/session')?.body).toMatchObject({
      user_id: 'pi-kit-inst',
      toolkits: { enable: ['sevdesk'] },
      tags: { disable: ['createHint', 'updateHint', 'destructiveHint'] },
      search: { enable: false },
      manage_connections: { enable: false },
    });
    const config = JSON.parse(readFileSync(join(base, 'mcp.json'), 'utf8'));
    expect(config.mcpServers['composio-sevdesk']).toMatchObject({
      url: 'https://mcp.example/s1',
      headers: { 'x-api-key': 'good-key-123' },
      exposure: 'deferred',
    });
    connected = true;
    expect(await service.connections()).toEqual([
      expect.objectContaining({ server: 'composio-sevdesk', connected: true, signInUrl: null }),
    ]);
    await expect(service.forgetKey()).rejects.toThrow('Remove the Composio apps');
  });

  it('names a server that may write apart from the read-only one', async () => {
    await service.setKey('good-key-123');
    expect((await service.add({ toolkit: 'sevdesk', name: 'sevDesk', readOnly: false })).server).toBe(
      'composio-sevdesk-write',
    );
    expect(calls.find((call) => call.url === '/tool_router/session')?.body).not.toHaveProperty('tags');
  });
});
