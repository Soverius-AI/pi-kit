import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaRepository } from '../../db/meta.repository';
import type { PiSessionService } from '../../pi/pi-session.service';
import { ComposioConnectService } from './composio-connect.service';
import type { McpCallService } from '../mcp-call.service';

// Shapes of COMPOSIO_MANAGE_CONNECTIONS answers as Composio Connect sent them on 2026-11-20.
const answer = (results: Record<string, unknown>) =>
  JSON.stringify({ successful: true, data: { results }, error: null });
const LISTED = answer({
  gmail: { toolkit: 'gmail', status: 'initiated', accounts: [{ id: 'gmail_a', status: 'ACTIVE' }] },
  notion: { toolkit: 'notion', status: 'initiated', accounts: [] },
});
const ADDED = answer({
  notion: {
    toolkit: 'notion',
    status: 'initiated',
    redirect_url: 'https://connect.composio.dev/link/lk_1',
    accounts: [{ id: 'notion_a', status: 'initiated' }],
  },
});

let agentDir: string;
let settings: Map<string, unknown>;
let call: ReturnType<typeof vi.fn>;
let service: ComposioConnectService;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pk-composio-'));
  writeFileSync(
    join(agentDir, 'mcp.json'),
    JSON.stringify({ mcpServers: { composio: { url: 'https://connect.composio.dev/mcp' } } }),
  );
  settings = new Map();
  call = vi.fn(async (_cwd: string, _server: string, _tool: string, args: { toolkits: { action: string }[] }) => ({
    ok: true,
    output: args.toolkits[0]?.action === 'add' ? ADDED : LISTED,
  }));
  service = new ComposioConnectService(
    {
      getSetting: async (key: string) => settings.get(key),
      setSetting: async (key: string, value: unknown) => void settings.set(key, value),
    } as unknown as MetaRepository,
    { agentDir: async () => agentDir } as unknown as PiSessionService,
    { problem: async () => undefined, call } as unknown as McpCallService,
  );
});

afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

describe('ComposioConnectService', () => {
  it('checks the chosen apps with list, which starts no sign-in in Composio, and counts only an active account', async () => {
    await service.wire({ toolkit: 'gmail', name: 'Gmail' });
    const state = await service.wire({ toolkit: 'notion', name: 'Notion' });
    expect(call).toHaveBeenLastCalledWith(expect.any(String), 'composio', 'COMPOSIO_MANAGE_CONNECTIONS', {
      toolkits: [
        { name: 'gmail', action: 'list' },
        { name: 'notion', action: 'list' },
      ],
    });
    expect(state.apps.map((app) => [app.toolkit, app.connected, app.signInUrl])).toEqual([
      ['gmail', true, null],
      ['notion', false, null],
    ]);
    expect(await service.forRooms()).toEqual({ server: 'composio', apps: ['Gmail', 'Notion'] });
  });

  it('makes a page to connect an app only when asked', async () => {
    await service.wire({ toolkit: 'notion', name: 'Notion' });
    const app = await service.link('notion');
    expect(call).toHaveBeenLastCalledWith(expect.any(String), 'composio', 'COMPOSIO_MANAGE_CONNECTIONS', {
      toolkits: [{ name: 'notion', action: 'add' }],
    });
    expect(app).toMatchObject({ connected: false, signInUrl: 'https://connect.composio.dev/link/lk_1', error: null });
  });

  it('turns Composio’s tool search into apps with their descriptions', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      output: JSON.stringify({
        successful: true,
        data: {
          results: [{ toolkits: ['zendesk'], primary_tool_slugs: ['ZENDESK_LIST_ZENDESK_TICKETS'] }],
          toolkit_connection_statuses: [
            { toolkit: 'zendesk', description: 'Customer support software', has_active_connection: false },
          ],
        },
      }),
    });
    expect(await service.search('zendesk tickets')).toEqual([
      { toolkit: 'zendesk', name: 'Zendesk', description: 'Customer support software' },
    ]);
    expect(call).toHaveBeenLastCalledWith(expect.any(String), 'composio', 'COMPOSIO_SEARCH_TOOLS', {
      queries: [{ use_case: 'zendesk tickets' }],
      session: { generate_id: true },
    });
  });
});
