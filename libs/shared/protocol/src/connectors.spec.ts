import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_CATALOG,
  ConnectRequestSchema,
  ConnectorCatalogSchema,
  ConnectorSchema,
  connectorById,
  connectorMenuLine,
  connectorOfServer,
  connectorUrl,
  humanToolName,
  normalizeEndpoint,
} from './connectors';
import { bearerFromResolver, resolverCommand } from './secrets';

const valid = () => structuredClone(CONNECTOR_CATALOG.connectors[0]);
const catalogOf = (...connectors: unknown[]) => ({ version: 1, updated: '2026-10-16', connectors });

describe('the connector catalog', () => {
  it('validates, with the connectors the plan names', () => {
    expect(ConnectorCatalogSchema.safeParse(CONNECTOR_CATALOG).success).toBe(true);
    expect(CONNECTOR_CATALOG.connectors.map((c) => c.id)).toEqual(['linear', 'github', 'slack', 'notion', 'sentry', 'atlassian', 'figma']);
  });

  it('every endpoint is https and every entry says what was checked and when', () => {
    for (const connector of CONNECTOR_CATALOG.connectors) {
      expect(connector.endpoint.url, connector.id).toMatch(/^https:\/\//);
      for (const variant of connector.endpoint.variants ?? []) expect(variant.url, `${connector.id}/${variant.id}`).toMatch(/^https:\/\//);
      expect(connector.docs, connector.id).toMatch(/^https:\/\//);
      expect(connector.verification.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(connector.verification.note.length).toBeGreaterThan(20);
      expect(connector.summary.length, connector.id).toBeLessThanOrEqual(140);
    }
  });

  it('the endpoints and sign-in modes are the ones the vendors document', () => {
    const url = (id: string) => connectorById(id, CONNECTOR_CATALOG)?.endpoint.url;
    expect(url('linear')).toBe('https://mcp.linear.app/mcp');
    expect(connectorUrl(connectorById('linear', CONNECTOR_CATALOG)!, 'readonly')).toBe('https://mcp.linear.app/mcp/readonly');
    expect(url('github')).toBe('https://api.githubcopilot.com/mcp/');
    expect(url('slack')).toBe('https://mcp.slack.com/mcp');
    expect(url('notion')).toBe('https://mcp.notion.com/mcp');
    expect(url('sentry')).toBe('https://mcp.sentry.dev/mcp');
    expect(url('atlassian')).toBe('https://mcp.atlassian.com/v2/mcp');
    expect(url('figma')).toBe('https://mcp.figma.com/mcp');
    expect(connectorById('linear', CONNECTOR_CATALOG)?.auth).toEqual({ type: 'oauth' });
    expect(connectorById('figma', CONNECTOR_CATALOG)?.auth).toEqual({ type: 'oauth', clientName: 'Claude Code' });
    expect(connectorById('github', CONNECTOR_CATALOG)?.auth.type).toBe('bearer');
    // Slack does not register clients dynamically: a registered app is the only way.
    expect(connectorById('slack', CONNECTOR_CATALOG)?.auth.type).toBe('oauth-client');
  });

  it('a logo is path data and nothing else', () => {
    for (const connector of CONNECTOR_CATALOG.connectors) expect(connector.logo.paths.length).toBeGreaterThan(0);
    const bad = { ...valid(), logo: { paths: ['M0 0h4"/><script>alert(1)</script>'] } };
    expect(ConnectorSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses an entry that could not be trusted', () => {
    expect(ConnectorSchema.safeParse({ ...valid(), endpoint: { url: 'http://mcp.example.com/mcp' } }).success).toBe(false);
    expect(ConnectorSchema.safeParse({ ...valid(), id: 'two words' }).success).toBe(false);
    expect(ConnectorSchema.safeParse({ ...valid(), auth: { type: 'bearer', envVar: 'lowercase', setup: 'x' } }).success).toBe(false);
    expect(ConnectorSchema.safeParse({ ...valid(), auth: { type: 'oauth-client', callbackPort: 80, setup: 'x' } }).success).toBe(false);
    expect(ConnectorSchema.safeParse({ ...valid(), verification: { status: 'maybe', checkedOn: 'today', note: 'x' } }).success).toBe(false);
    expect(ConnectorSchema.safeParse({ ...valid(), exposure: 'hidden' }).success).toBe(false);
    expect(ConnectorSchema.safeParse({ ...valid(), summary: 'x'.repeat(141) }).success).toBe(false);
  });

  it('an entry that could not be verified is allowed to say so', () => {
    const entry = { ...valid(), id: 'unknown-vendor', verification: { status: 'unverified', checkedOn: '2026-10-16', note: 'The vendor documents no endpoint; this one is a guess from a blog post.' } };
    expect(ConnectorCatalogSchema.safeParse(catalogOf(entry)).success).toBe(true);
  });

  it('ids that pi would treat as one server are refused, as is a wrong version and an empty catalog', () => {
    const a = valid();
    const clash = catalogOf(a, { ...a, id: 'my-server' }, { ...a, id: 'my_server' });
    expect(ConnectorCatalogSchema.safeParse(clash).success).toBe(false);
    expect(ConnectorCatalogSchema.safeParse({ ...catalogOf(a), version: 2 }).success).toBe(false);
    expect(ConnectorCatalogSchema.safeParse(catalogOf()).success).toBe(false);
  });

  it('carries the signature of a future signed update without needing it', () => {
    const signed = { ...catalogOf(valid()), signature: { keyId: 'pi-kit-2026', algorithm: 'ed25519', value: 'AAAA' } };
    expect(ConnectorCatalogSchema.safeParse(signed).success).toBe(true);
    expect(ConnectorCatalogSchema.safeParse({ ...signed, signature: { keyId: 'k', algorithm: 'rsa', value: 'x' } }).success).toBe(false);
  });
});

describe('matching a server with its connector', () => {
  const server = (name: string, target: string, transport = 'http') => ({ name, target, transport });

  it('by the name the connector writes, or by URL when the server was added by hand', () => {
    expect(connectorOfServer(server('linear', 'https://mcp.linear.app/mcp'), CONNECTOR_CATALOG)?.connector.id).toBe('linear');
    expect(connectorOfServer(server('work-tracker', 'https://MCP.linear.app/mcp/'), CONNECTOR_CATALOG)?.connector.id).toBe('linear');
    expect(connectorOfServer(server('ro', 'https://mcp.linear.app/mcp/readonly'), CONNECTOR_CATALOG)).toMatchObject({ connector: { id: 'linear' }, variant: 'readonly' });
    expect(connectorOfServer(server('mine', 'https://example.com/mcp'), CONNECTOR_CATALOG)).toBeUndefined();
    expect(connectorOfServer(server('files', 'npx server-files', 'stdio'), CONNECTOR_CATALOG)).toBeUndefined();
  });

  it('normalises a URL the way a comparison needs', () => {
    expect(normalizeEndpoint('https://Example.com/mcp/#top')).toBe('https://example.com/mcp');
    expect(normalizeEndpoint('not a url')).toBe('not a url');
  });
});

describe('the menu line of a connected connector', () => {
  it('names up to three tools in words and an ellipsis when there are more', () => {
    expect(humanToolName('save_issue')).toBe('save issue');
    expect(humanToolName('search-issues')).toBe('search issues');
    expect(connectorMenuLine('Linear', ['create_issue', 'search_issues'])).toBe('Linear: create issue, search issues');
    expect(connectorMenuLine('Linear', ['a', 'b', 'c', 'd'])).toBe('Linear: a, b, c…');
  });
});

describe('the connect request', () => {
  it('defaults to the user file, takes a token once and refuses what it does not know', () => {
    expect(ConnectRequestSchema.parse({ id: 'github', token: 'ghp_x' })).toMatchObject({ scope: 'user', token: 'ghp_x' });
    expect(ConnectRequestSchema.safeParse({ id: 'linear', scope: 'workspace' }).success).toBe(false);
    expect(ConnectRequestSchema.safeParse({ id: 'linear', extra: 1 }).success).toBe(false);
    expect(ConnectRequestSchema.safeParse({ id: 'custom', custom: { name: 'x', url: 'https://example.com/mcp', command: 'node' } }).success).toBe(false);
    expect(ConnectRequestSchema.safeParse({ id: 'custom', custom: { name: 'x', url: 'ftp://example.com/mcp' } }).success).toBe(false);
    expect(ConnectRequestSchema.safeParse({ id: 'custom', custom: { name: 'x', url: 'http://127.0.0.1:8080/mcp' } }).success).toBe(true);
    expect(ConnectRequestSchema.safeParse({ id: 'custom', custom: { name: 'x', command: 'npx', args: ['-y', 'srv'] } }).success).toBe(true);
    expect(ConnectRequestSchema.safeParse({ id: 'custom', custom: { name: 'has space', command: 'npx' } }).success).toBe(false);
  });
});

describe('the bearer header that mcp.json holds', () => {
  it('wraps a system tool in echo, and asks the helper for the header on Windows', () => {
    expect(bearerFromResolver(resolverCommand('darwin', 'connector-github'))).toBe('!echo Bearer $(security find-generic-password -s pi-kit -a connector-github -w)');
    expect(bearerFromResolver(resolverCommand('linux', 'connector-github', { secretTool: true }))).toBe('!echo Bearer $(secret-tool lookup service pi-kit username connector-github)');
    expect(bearerFromResolver(resolverCommand('win32', 'connector-github'))).toBe('!pi-kit-secret get connector-github --bearer');
    expect(bearerFromResolver(resolverCommand('linux', 'connector-github'))).toBe('!pi-kit-secret get connector-github --bearer');
  });
});
