import { CONNECTOR_CATALOG, connectorById } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { buildConnectorEntry, buildCustomEntry, endpointFor, endpointOverrides, needsSignIn } from './connectors';

const connector = (id: string) => connectorById(id, CONNECTOR_CATALOG)!;

describe('the mcp.json entry of a connector', () => {
  it('OAuth with dynamic registration is the URL alone: no credentials in the file', () => {
    expect(buildConnectorEntry(connector('linear'), { exposure: 'direct' })).toEqual({ url: 'https://mcp.linear.app/mcp', description: connector('linear').summary, exposure: 'direct' });
    // codemode is pi's default, so it stays out of the file as pi's own manager writes it
    expect(buildConnectorEntry(connector('notion'), { exposure: 'codemode' })).toEqual({ url: 'https://mcp.notion.com/mcp', description: connector('notion').summary });
  });

  it('a variant is another URL; a vendor that only accepts known clients gets the client name', () => {
    expect(buildConnectorEntry(connector('linear'), { exposure: 'direct', variant: 'readonly' })['url']).toBe('https://mcp.linear.app/mcp/readonly');
    expect(buildConnectorEntry(connector('linear'), { exposure: 'direct', variant: 'nonsense' })['url']).toBe('https://mcp.linear.app/mcp');
    expect(buildConnectorEntry(connector('figma'), { exposure: 'codemode' })['oauth']).toEqual({ clientName: 'Claude Code' });
  });

  it('a registered client (Slack) carries the client id and the port, and the secret only as a command', () => {
    const entry = buildConnectorEntry(connector('slack'), { exposure: 'codemode', clientId: '123.456', clientSecretCommand: '!security find-generic-password -s pi-kit -a connector-slack-secret -w' });
    expect(entry['oauth']).toEqual({ clientId: '123.456', callbackPort: 8765, clientSecret: '!security find-generic-password -s pi-kit -a connector-slack-secret -w' });
    expect(JSON.stringify(entry)).not.toMatch(/xoxp|secret-value/);
    expect(() => buildConnectorEntry(connector('slack'), { exposure: 'codemode' })).toThrow(/client id/);
  });

  it('a bearer connector holds the Authorization command, never a token it was not given', () => {
    const header = '!echo Bearer $(security find-generic-password -s pi-kit -a connector-github -w)';
    const entry = buildConnectorEntry(connector('github'), { exposure: 'deferred', authorization: header });
    expect(entry).toEqual({ url: 'https://api.githubcopilot.com/mcp/', description: connector('github').summary, exposure: 'deferred', headers: { Authorization: header } });
    expect(() => buildConnectorEntry(connector('github'), { exposure: 'deferred' })).toThrow(/token/);
  });

  it('every catalog entry builds with what its sign-in needs', () => {
    for (const c of CONNECTOR_CATALOG.connectors) {
      const entry = buildConnectorEntry(c, { exposure: c.exposure, authorization: 'Bearer x', clientId: 'id' });
      expect(entry['url'], c.id).toMatch(/^https:\/\//);
    }
  });

  it('custom servers: a remote one with an optional token, a command with its arguments', () => {
    expect(buildCustomEntry({ name: 'docs', url: 'https://example.com/mcp' }, 'codemode')).toEqual({ url: 'https://example.com/mcp' });
    expect(buildCustomEntry({ name: 'docs', url: 'https://example.com/mcp', description: 'Docs' }, 'direct', 'Bearer t')).toEqual({ url: 'https://example.com/mcp', description: 'Docs', exposure: 'direct', headers: { Authorization: 'Bearer t' } });
    expect(buildCustomEntry({ name: 'files', command: 'npx', args: ['-y', 'server-files', '.'] }, 'codemode')).toEqual({ command: 'npx', args: ['-y', 'server-files', '.'] });
  });

  it('knows which connections end in a browser sign-in', () => {
    const req = (extra = {}) => ({ id: 'x', scope: 'user' as const, ...extra });
    expect(needsSignIn(req(), connector('linear'))).toBe(true);
    expect(needsSignIn(req(), connector('slack'))).toBe(true);
    expect(needsSignIn(req(), connector('github'))).toBe(false);
    expect(needsSignIn(req({ custom: { name: 'a', url: 'https://x.example/mcp' } }), undefined)).toBe(true);
    expect(needsSignIn(req({ custom: { name: 'a', url: 'https://x.example/mcp' }, token: 't' }), undefined)).toBe(false);
    expect(needsSignIn(req({ custom: { name: 'a', command: 'node' } }), undefined)).toBe(false);
  });
});

describe('endpoint overrides (tests only)', () => {
  const env = (value: string | undefined, node = 'development') => ({ NODE_ENV: node, ...(value ? { PI_KIT_CONNECTOR_URLS: value } : {}) }) as NodeJS.ProcessEnv;

  it('point an id and a variant at a local server, and are ignored in production and when malformed', () => {
    const overrides = endpointOverrides(env('{"linear":"http://127.0.0.1:9/mcp","linear/readonly":"http://127.0.0.1:9/ro","bad":1}'));
    expect(overrides).toEqual({ linear: 'http://127.0.0.1:9/mcp', 'linear/readonly': 'http://127.0.0.1:9/ro' });
    expect(endpointFor(connector('linear'), 'readonly', overrides)).toBe('http://127.0.0.1:9/ro');
    expect(endpointFor(connector('linear'), undefined, overrides)).toBe('http://127.0.0.1:9/mcp');
    expect(endpointFor(connector('notion'), undefined, overrides)).toBeUndefined();
    expect(endpointOverrides(env('{"linear":"http://127.0.0.1:9/mcp"}', 'production'))).toEqual({});
    expect(endpointOverrides(env('not json'))).toEqual({});
    expect(endpointOverrides(env('[1]'))).toEqual({});
    expect(endpointOverrides(env(undefined))).toEqual({});
  });
});
