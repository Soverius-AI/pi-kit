import { english } from '@pi-kit/i18n/testing';
import { CONNECTOR_CATALOG, type McpServer } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { detailOf, fileOf, fileRows, mcpRows, onCount, primaryOf, summaryText } from './mcp-rows';

const server = (over: Partial<McpServer> & { name: string }): McpServer => ({
  scope: 'global',
  source: '/Users/me/.pi/agent/mcp.json',
  transport: 'http',
  target: 'https://mcp.linear.app/mcp',
  exposure: 'deferred',
  enabled: true,
  state: 'connected',
  oauth: true,
  tools: 14,
  ...over,
});

const linear = server({ name: 'linear' });
const github = server({ name: 'github', target: 'https://api.githubcopilot.com/mcp/', state: 'needs-auth' });
const playwright = server({
  name: 'playwright',
  scope: 'project',
  source: '/proj/.pi/mcp.json',
  transport: 'stdio',
  target: 'npx @playwright/mcp@latest --headless',
  exposure: 'direct',
  oauth: false,
  tools: 21,
});
const slack = server({
  name: 'slack',
  target: 'https://mcp.slack.com/mcp',
  enabled: false,
  state: 'disabled',
  tools: undefined,
});
const docs = server({
  name: 'docs-search',
  target: 'https://docs.internal.example/mcp',
  exposure: 'codemode',
  description: 'Internal docs search',
});

describe('the MCP servers list', () => {
  const rows = mcpRows(english, CONNECTOR_CATALOG, [slack, linear, github, playwright, docs]);

  it('has a row for every server, those that are off last', () => {
    expect(rows.map((r) => r.name)).toEqual(['linear', 'github', 'playwright', 'docs-search', 'slack']);
  });

  it('gives a catalog service its name, its logo letters and what it does; a server of your own its target and file', () => {
    const l = rows.find((r) => r.name === 'linear')!;
    expect(l.connector?.id).toBe('linear');
    expect(l.letters).toBe('Li');
    expect(l.detail).toContain(l.connector!.summary);
    expect(l.detail).toContain('deferred');
    expect(l.detail).toContain('mcp.linear.app');
    const p = rows.find((r) => r.name === 'playwright')!;
    expect(p.connector).toBeUndefined();
    expect(p.detail).toBe('npx @playwright/mcp@latest --headless · .pi/mcp.json');
    expect(rows.find((r) => r.name === 'docs-search')!.detail).toBe(
      'Internal docs search · https://docs.internal.example/mcp · ~/.pi/agent/mcp.json',
    );
  });

  it('says the state, the scope and the tool count', () => {
    expect(rows.map((r) => r.chip.text)).toEqual(['connected', 'needs sign-in', 'connected', 'connected', 'off']);
    expect(rows.map((r) => r.scope)).toEqual(['user', 'user', 'project', 'user', 'user']);
    expect(rows.find((r) => r.name === 'playwright')?.tools).toBe('21 tools');
    expect(rows.find((r) => r.name === 'slack')?.tools).toBeUndefined();
  });

  it('asks for one text button where the state needs one', () => {
    expect(rows.map((r) => r.primaryText)).toEqual([undefined, 'Sign in', undefined, undefined, 'Turn on']);
    expect(primaryOf(english, 'error', server({ name: 'a', oauth: true }))?.action).toBe('try-again');
    expect(primaryOf(english, 'error', server({ name: 'a', oauth: false }))?.action).toBe('reconnect');
    expect(primaryOf(english, 'off', server({ name: 'a', scope: 'extension' }))).toBeUndefined();
    expect(primaryOf(english, 'connected', linear)).toBeUndefined();
  });

  it('leaves a pi extension’s server alone', () => {
    const ext = mcpRows(english, CONNECTOR_CATALOG, [
      server({ name: 'x', scope: 'extension', source: 'my-extension', transport: 'stdio', target: 'x' }),
    ])[0];
    expect(ext.editable).toBe(false);
    expect(ext.scope).toBe('extension');
    expect(ext.detail).toContain('registered by my-extension');
  });

  it('counts the servers that are on and says what needs a look', () => {
    expect(onCount([slack, linear, github])).toBe(2);
    expect(summaryText(english, rows)).toBe(
      '4 servers on, 1 needs a sign-in or a look. Changes apply to open threads after Reload.',
    );
    expect(summaryText(english, [])).toBe('No servers yet.');
  });

  it('lists the two files with how many servers each holds', () => {
    const files = fileRows(
      { userConfig: '/Users/me/.pi/agent/mcp.json', projectConfig: '/proj/.pi/mcp.json', projectTrusted: true },
      [linear, playwright, docs],
    );
    expect(files).toEqual([
      { scope: 'user', path: '/Users/me/.pi/agent/mcp.json', count: 2 },
      { scope: 'project', path: '/proj/.pi/mcp.json', count: 1 },
    ]);
    expect(fileRows({ userConfig: '/u', projectConfig: '/p', projectTrusted: false }, [])).toHaveLength(1);
    expect(fileOf(playwright)).toBe('.pi/mcp.json');
    expect(detailOf(english, github, rows.find((r) => r.name === 'github')?.connector)).toBe(
      rows.find((r) => r.name === 'github')!.connector!.summary,
    );
  });
});
