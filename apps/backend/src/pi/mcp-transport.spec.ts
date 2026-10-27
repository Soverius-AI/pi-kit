import { describe, expect, it } from 'vitest';
import { createMcpTransport, expandHome, resolveConfigValue } from './mcp-transport';

describe('resolveConfigValue', () => {
  it('substitutes environment variables and fails clearly on a missing one', () => {
    expect(resolveConfigValue('Bearer ${TOKEN}', 'h', { TOKEN: 'abc' })).toBe('Bearer abc');
    expect(() => resolveConfigValue('${NOPE}', 'MCP server "x" env "K"', {})).toThrow('MCP server "x" env "K": the environment variable NOPE is not set.');
  });

  it('runs a command only when it makes up the whole value', () => {
    expect(resolveConfigValue('!echo hi', 'h', {}, (c) => `ran ${c}\n`)).toBe('ran echo hi');
    expect(resolveConfigValue('a !echo hi', 'h', {}, () => 'x')).toBe('a !echo hi');
    expect(() => resolveConfigValue('!boom', 'h', {}, () => { throw new Error('exit 1'); })).toThrow('the command boom failed: exit 1');
  });
});

describe('expandHome', () => {
  it('expands ~ and ~/ only', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/bin/x', '/h')).toBe('/h/bin/x');
    expect(expandHome('~x', '/h')).toBe('~x');
  });
});

describe('createMcpTransport', () => {
  const classes = {
    StdioTransport: class { constructor(public options: unknown) {} },
    StreamableHttpTransport: class { constructor(public options: unknown) {} },
  };

  it('builds a stdio transport relative to the session folder', () => {
    const t = createMcpTransport(classes, { name: 's', config: { command: 'node', args: ['a.js'], cwd: 'srv', env: { A: 'b' } } }, '/work', undefined) as { options: Record<string, unknown> };
    expect(t).toBeInstanceOf(classes.StdioTransport);
    expect(t.options).toMatchObject({ command: 'node', args: ['a.js'], cwd: '/work/srv', env: { A: 'b' }, stderr: 'pipe' });
  });

  it('builds a streamable HTTP transport with the auth provider', () => {
    const auth = { token: () => 'x' };
    const t = createMcpTransport(classes, { name: 'h', config: { url: 'https://x/mcp', headers: { 'X-Y': 'z' } } }, '/work', auth) as { options: Record<string, unknown> };
    expect(t).toBeInstanceOf(classes.StreamableHttpTransport);
    expect(t.options).toMatchObject({ url: 'https://x/mcp', headers: { 'X-Y': 'z' }, authProvider: auth });
  });
});
