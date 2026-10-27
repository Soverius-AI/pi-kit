import { describe, expect, it } from 'vitest';
import { parseMcpStatus } from './mcp-status';

describe('parseMcpStatus (pi 1.2.0 /mcp output)', () => {
  it('reads every state pi prints', () => {
    const report = parseMcpStatus(
      [
        'issues: connected, 3 tools (direct)',
        'sentry: needs sign-in, run /mcp login sentry (codemode)',
        'docs: failed (codemode)',
        '    MCP server "docs" failed to connect: spawn nope ENOENT',
        '    second line',
        'old: disabled (codemode)',
        'files: disconnected, reconnects on next call (deferred)',
        'slow: connecting (codemode)',
        'later: starting (hidden)',
        'config error: /x/mcp.json: server "a b" may contain only letters',
        'overridden: "x" registered by /e.ts is overridden by "x" in /f.json',
      ].join('\n'),
    );
    expect([...report.servers.entries()]).toEqual([
      ['issues', { state: 'connected', tools: 3, exposure: 'direct' }],
      ['sentry', { state: 'needs-auth', exposure: 'codemode' }],
      ['docs', { state: 'failed', exposure: 'codemode', error: 'MCP server "docs" failed to connect: spawn nope ENOENT\nsecond line' }],
      ['old', { state: 'disabled', exposure: 'codemode' }],
      ['files', { state: 'disconnected', exposure: 'deferred' }],
      ['slow', { state: 'connecting', exposure: 'codemode' }],
      ['later', { state: 'connecting', exposure: 'hidden' }],
    ]);
    expect(report.configErrors).toEqual(['/x/mcp.json: server "a b" may contain only letters']);
    expect(report.notes).toHaveLength(1);
  });

  it('ignores the empty-state line and anything it does not know', () => {
    const report = parseMcpStatus('No MCP servers configured. Add them to /home/me/.pi/agent/mcp.json or .pi/mcp.json.');
    expect(report.servers.size).toBe(0);
    expect(report.configErrors).toEqual([]);
  });

  it('handles a one-tool server', () => {
    expect(parseMcpStatus('one: connected, 1 tools (codemode)').servers.get('one')).toEqual({ state: 'connected', tools: 1, exposure: 'codemode' });
  });
});
