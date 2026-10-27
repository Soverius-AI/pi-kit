import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMcpConfig, removeMcpServer, setMcpServerExposure, writeMcpServer } from './mcp-config';

function folders() {
  const root = mkdtempSync(join(tmpdir(), 'pk-mcp-write-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'work');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { agentDir, cwd, user: join(agentDir, 'mcp.json'), project: join(cwd, '.pi', 'mcp.json') };
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

const LINEAR = { url: 'https://mcp.linear.app/mcp', description: 'Linear', exposure: 'direct' };

describe('writeMcpServer', () => {
  it('creates the user file (and the folder) for a clean config, readable by its owner only', () => {
    const { user } = folders();
    expect(writeMcpServer(user, 'linear', LINEAR)).toBe(false);
    expect(read(user)).toEqual({ mcpServers: { linear: LINEAR } });
    expect(statSync(user).mode & 0o777).toBe(0o600);
  });

  it('creates .pi/mcp.json in the project, and the user file is not touched', () => {
    const { project, user } = folders();
    writeMcpServer(project, 'linear', LINEAR);
    expect(read(project)).toEqual({ mcpServers: { linear: LINEAR } });
    expect(existsSync(user)).toBe(false);
  });

  it('keeps every other server, every other top-level key and the indentation of the file', () => {
    const { user } = folders();
    writeFileSync(user, '{\n\t"autoEnableCodemode": false,\n\t"mcpServers": {\n\t\t"files": { "command": "npx", "args": ["-y", "server-files", "."], "env": { "A": "${B}" } },\n\t\t"off": { "url": "https://example.com/mcp", "enabled": false }\n\t},\n\t"extra": { "nested": [1, 2, 3] }\n}\n', { mode: 0o644 });
    writeMcpServer(user, 'linear', LINEAR);
    const after = read(user);
    expect(after['autoEnableCodemode']).toBe(false);
    expect(after['extra']).toEqual({ nested: [1, 2, 3] });
    expect(after['mcpServers']).toEqual({
      files: { command: 'npx', args: ['-y', 'server-files', '.'], env: { A: '${B}' } },
      off: { url: 'https://example.com/mcp', enabled: false },
      linear: LINEAR,
    });
    expect(readFileSync(user, 'utf8')).toContain('\t"autoEnableCodemode"');
    // User configuration is private even if it was previously shared-readable.
    expect(statSync(user).mode & 0o777).toBe(0o600);
  });

  it('replaces an entry of the same name and says so, leaving the neighbours', () => {
    const { user } = folders();
    writeMcpServer(user, 'a', { url: 'https://a.example/mcp' });
    writeMcpServer(user, 'b', { url: 'https://b.example/mcp' });
    expect(writeMcpServer(user, 'a', { url: 'https://a2.example/mcp' })).toBe(true);
    expect(read(user)['mcpServers']).toEqual({ a: { url: 'https://a2.example/mcp' }, b: { url: 'https://b.example/mcp' } });
  });

  it('never overwrites a file it cannot read as a configuration', () => {
    const { user } = folders();
    for (const text of ['{ not json', '[1, 2]', '{"mcpServers": []}']) {
      writeFileSync(user, text);
      expect(() => writeMcpServer(user, 'linear', LINEAR), text).toThrow(/will not overwrite/);
      expect(readFileSync(user, 'utf8')).toBe(text);
    }
  });

  it('refuses a name pi would refuse, and leaves no temporary file behind', () => {
    const { user, agentDir } = folders();
    expect(() => writeMcpServer(user, 'bad name', LINEAR)).toThrow(/letters, digits/);
    writeMcpServer(user, 'ok', LINEAR);
    expect(readdirSync(agentDir)).toEqual(['mcp.json']);
  });

  it('what it writes is what the panel reads: user and project entries show where they came from', () => {
    const { agentDir, cwd, user, project } = folders();
    writeMcpServer(user, 'linear', LINEAR);
    writeMcpServer(project, 'local-tool', { url: 'https://example.com/mcp' });
    const config = readMcpConfig({ agentDir, cwd, projectTrusted: true });
    expect(config.errors).toEqual([]);
    expect(config.servers.map((s) => [s.name, s.scope, s.exposure, s.oauth])).toEqual([
      ['linear', 'global', 'direct', true],
      ['local-tool', 'project', 'codemode', true],
    ]);
    // an untrusted folder's file is not read at all, so a project-only connector exists only where it was trusted
    expect(readMcpConfig({ agentDir, cwd, projectTrusted: false }).servers.map((s) => s.name)).toEqual(['linear']);
    expect(readMcpConfig({ agentDir, cwd: join(cwd, '..', 'elsewhere'), projectTrusted: true }).servers.map((s) => s.name)).toEqual(['linear']);
  });

  it('a bearer entry is recognised as not needing OAuth', () => {
    const { agentDir, user } = folders();
    writeMcpServer(user, 'github', { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: '!echo Bearer $(security find-generic-password -s pi-kit -a connector-github -w)' } });
    expect(readMcpConfig({ agentDir, projectTrusted: false }).servers[0]).toMatchObject({ name: 'github', oauth: false });
  });
});

describe('removeMcpServer', () => {
  it('removes one entry and nothing else', () => {
    const { user } = folders();
    writeFileSync(user, JSON.stringify({ keep: true, mcpServers: { a: { command: 'x' }, b: { command: 'y' } } }, null, 2));
    expect(removeMcpServer(user, 'a')).toBe(true);
    expect(read(user)).toEqual({ keep: true, mcpServers: { b: { command: 'y' } } });
  });

  it('does not touch a file that has no such entry, or does not exist', () => {
    const { user, project } = folders();
    expect(removeMcpServer(user, 'a')).toBe(false);
    expect(existsSync(user)).toBe(false);
    writeFileSync(user, '{"mcpServers":{"b":{"command":"y"}}}');
    expect(removeMcpServer(user, 'a')).toBe(false);
    expect(readFileSync(user, 'utf8')).toBe('{"mcpServers":{"b":{"command":"y"}}}');
    expect(removeMcpServer(project, 'a')).toBe(false);
  });

  it('refuses a file that is not a configuration', () => {
    const { user } = folders();
    writeFileSync(user, '{ nope');
    expect(() => removeMcpServer(user, 'a')).toThrow(/will not overwrite/);
  });
});

describe('setMcpServerExposure', () => {
  it('writes the exposure into the file that defines the server, and codemode (pi’s default) removes the key', () => {
    const { user, agentDir } = folders();
    writeMcpServer(user, 'linear', { url: 'https://mcp.linear.app/mcp' });
    const entry = readMcpConfig({ agentDir, projectTrusted: false }).servers[0];
    setMcpServerExposure(entry, 'deferred');
    expect((read(user)['mcpServers'] as Record<string, unknown>)['linear']).toEqual({ url: 'https://mcp.linear.app/mcp', exposure: 'deferred' });
    setMcpServerExposure(entry, 'codemode');
    expect((read(user)['mcpServers'] as Record<string, unknown>)['linear']).toEqual({ url: 'https://mcp.linear.app/mcp' });
  });

  it('goes to the project override when the project overrides a user server', () => {
    const { user, project, agentDir, cwd } = folders();
    writeMcpServer(user, 'linear', { url: 'https://mcp.linear.app/mcp' });
    writeMcpServer(project, 'linear', { enabled: true });
    const entry = readMcpConfig({ agentDir, cwd, projectTrusted: true }).servers[0];
    setMcpServerExposure(entry, 'direct');
    expect((read(project)['mcpServers'] as Record<string, unknown>)['linear']).toEqual({ enabled: true, exposure: 'direct' });
    expect((read(user)['mcpServers'] as Record<string, unknown>)['linear']).toEqual({ url: 'https://mcp.linear.app/mcp' });
  });
});
