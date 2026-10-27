import { english } from '@pi-kit/i18n/testing';
import { CONNECTOR_CATALOG, type McpServer } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import {
  appToolCount,
  attentionText,
  connectorCards,
  connectorMenuGroups,
  connectorState,
  toolCountText,
} from './connectors';

const server = (over: Partial<McpServer> & { name: string }): McpServer => ({
  scope: 'global',
  source: '/agent/mcp.json',
  transport: 'http',
  target: 'https://mcp.linear.app/mcp',
  exposure: 'direct',
  enabled: true,
  state: 'connected',
  oauth: true,
  ...over,
});

describe('connector states', () => {
  it('reads the six states off the server', () => {
    expect(connectorState(undefined)).toBe('available');
    expect(connectorState(server({ name: 'linear', state: 'connected' }))).toBe('connected');
    expect(connectorState(server({ name: 'linear', state: 'connecting' }))).toBe('connecting');
    expect(connectorState(server({ name: 'linear', state: 'needs-auth' }))).toBe('needs-signin');
    expect(
      connectorState(server({ name: 'linear', state: 'needs-auth', signIn: { phase: 'waiting', url: 'https://a' } })),
    ).toBe('signing-in');
    expect(
      connectorState(server({ name: 'linear', state: 'needs-auth', signIn: { phase: 'failed', message: 'denied' } })),
    ).toBe('error');
    expect(connectorState(server({ name: 'linear', state: 'needs-auth', signIn: { phase: 'cancelled' } }))).toBe(
      'needs-signin',
    );
    expect(connectorState(server({ name: 'linear', state: 'failed', error: 'boom' }))).toBe('error');
    expect(connectorState(server({ name: 'linear', state: 'disabled', enabled: false }))).toBe('off');
    // configured but not up: a sign-in is the next move for OAuth, patience for a token
    expect(connectorState(server({ name: 'linear', state: 'unknown' }))).toBe('needs-signin');
    expect(connectorState(server({ name: 'github', state: 'unknown', oauth: false }))).toBe('connecting');
  });
});

describe('the cards', () => {
  it('one per catalog entry, connected and attention-needing first, the rest in the catalog’s order', () => {
    const cards = connectorCards(CONNECTOR_CATALOG, [
      server({ name: 'sentry', target: 'https://mcp.sentry.dev/mcp', state: 'needs-auth' }),
      server({ name: 'notion', target: 'https://mcp.notion.com/mcp' }),
    ]);
    expect(cards.map((c) => [c.connector.id, c.state])).toEqual([
      ['notion', 'connected'],
      ['sentry', 'needs-signin'],
      ['linear', 'available'],
      ['github', 'available'],
      ['slack', 'available'],
      ['atlassian', 'available'],
      ['figma', 'available'],
    ]);
  });

  it('finds a server added by hand under another name by its URL, and names its variant', () => {
    const cards = connectorCards(CONNECTOR_CATALOG, [
      server({ name: 'work', target: 'https://mcp.linear.app/mcp/readonly' }),
    ]);
    expect(cards[0]).toMatchObject({
      connector: { id: 'linear' },
      variant: 'readonly',
      state: 'connected',
      server: { name: 'work' },
    });
  });

  it('the server with the connector’s own name wins over one added by hand with the same URL', () => {
    const cards = connectorCards(CONNECTOR_CATALOG, [
      server({ name: 'other', state: 'failed' }),
      server({ name: 'linear', state: 'connected' }),
    ]);
    expect(cards.find((c) => c.connector.id === 'linear')?.server?.name).toBe('linear');
  });

  it('counts tools and MCP Apps', () => {
    const s = server({ name: 'linear', tools: 2, toolList: [{ name: 'a' }, { name: 'b', app: 'ui://b' }] });
    expect(toolCountText(s)).toBe('2 tools');
    expect(toolCountText(server({ name: 'linear', tools: 1 }))).toBe('1 tool');
    expect(toolCountText(server({ name: 'linear' }))).toBeUndefined();
    expect(appToolCount(s)).toBe(1);
  });
});

describe('the / menu groups', () => {
  it('a connected direct connector is a group: "Linear: create issue, search issues…"', () => {
    const groups = connectorMenuGroups(
      english,
      [
        server({
          name: 'linear',
          toolList: [
            { name: 'create_issue' },
            { name: 'search_issues' },
            { name: 'list_projects' },
            { name: 'get_issue' },
          ],
        }),
        server({
          name: 'sentry',
          target: 'https://mcp.sentry.dev/mcp',
          exposure: 'codemode',
          toolList: [{ name: 'x' }],
        }),
        server({
          name: 'notion',
          target: 'https://mcp.notion.com/mcp',
          state: 'needs-auth',
          toolList: [{ name: 'search' }],
        }),
        server({ name: 'off', target: 'https://example.com/mcp', enabled: false }),
      ],
      CONNECTOR_CATALOG,
    );
    expect(groups).toEqual([
      {
        server: 'linear',
        title: 'Linear',
        line: 'Linear: create issue, search issues, list projects…',
        insert: 'Use Linear to ',
      },
    ]);
  });

  it('falls back to the catalog’s highlights before the server has listed its tools, and to the name for a server of the person’s own', () => {
    const groups = connectorMenuGroups(
      english,
      [
        server({ name: 'linear' }),
        server({ name: 'mine', target: 'https://example.com/mcp', toolList: [{ name: 'do_thing' }] }),
      ],
      CONNECTOR_CATALOG,
    );
    expect(groups.map((g) => g.line)).toEqual(['Linear: create issue, search issues, list projects', 'mine: do thing']);
  });
});

describe('what the sidebar says', () => {
  it('names the connector that needs the person, or counts them', () => {
    expect(attentionText(english, [server({ name: 'linear', state: 'needs-auth' })], CONNECTOR_CATALOG)).toBe(
      'Linear needs you',
    );
    expect(
      attentionText(
        english,
        [
          server({ name: 'linear', state: 'needs-auth' }),
          server({ name: 'x', target: 'https://x.example/mcp', state: 'failed' }),
        ],
        CONNECTOR_CATALOG,
      ),
    ).toBe('2 servers need you');
    expect(attentionText(english, [server({ name: 'linear' })], CONNECTOR_CATALOG)).toBeUndefined();
  });
});
