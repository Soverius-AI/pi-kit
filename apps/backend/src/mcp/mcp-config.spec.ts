import { chmodSync, statSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indentOf, readMcpConfig, setMcpServerEnabled, writeMcpServer, writeTextAtomically } from './mcp-config';

function setup(user: unknown, project?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'pk-mcp-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'work');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  if (user !== undefined) writeFileSync(join(agentDir, 'mcp.json'), typeof user === 'string' ? user : JSON.stringify(user, null, 2));
  if (project !== undefined) writeFileSync(join(cwd, '.pi', 'mcp.json'), JSON.stringify(project, null, 2));
  return { agentDir, cwd };
}

describe('readMcpConfig', () => {
  const user = {
    mcpServers: {
      files: { command: 'npx', args: ['-y', 'server-files', '.'], description: 'Files' },
      docs: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${T}' } },
      sentry: { url: 'https://mcp.sentry.dev/mcp', exposure: 'deferred' },
      off: { command: 'x', enabled: false },
      'bad name': { command: 'x' },
      empty: {},
    },
  };

  it('lists the user servers with transport, exposure and whether they can sign in', () => {
    const { agentDir } = setup(user);
    const config = readMcpConfig({ agentDir, projectTrusted: false });
    expect(config.servers.map((s) => s.name)).toEqual(['docs', 'files', 'off', 'sentry']);
    expect(config.servers.find((s) => s.name === 'files')).toMatchObject({ transport: 'stdio', target: 'npx -y server-files .', description: 'Files', exposure: 'codemode', oauth: false, enabled: true, scope: 'global' });
    expect(config.servers.find((s) => s.name === 'docs')).toMatchObject({ transport: 'http', oauth: false });
    expect(config.servers.find((s) => s.name === 'sentry')).toMatchObject({ oauth: true, exposure: 'deferred' });
    expect(config.servers.find((s) => s.name === 'off')?.enabled).toBe(false);
    expect(config.errors).toHaveLength(2);
  });

  it('reads the project file only for a trusted project; an entry with the same name replaces the global one', () => {
    const { agentDir, cwd } = setup(user, { mcpServers: { files: { command: 'node', args: ['mine.js'] }, local: { command: 'node' } } });
    expect(readMcpConfig({ agentDir, cwd, projectTrusted: false }).servers.find((s) => s.name === 'local')).toBeUndefined();
    const trusted = readMcpConfig({ agentDir, cwd, projectTrusted: true });
    expect(trusted.servers.find((s) => s.name === 'local')).toMatchObject({ scope: 'project' });
    expect(trusted.servers.find((s) => s.name === 'files')).toMatchObject({ scope: 'project', target: 'node mine.js' });
    expect(trusted.projectConfig).toBe(join(cwd, '.pi', 'mcp.json'));
  });

  it('treats a project entry without command, url or type as an override of enabled and exposure', () => {
    const { agentDir, cwd } = setup(user, { mcpServers: { files: { enabled: false }, sentry: { exposure: 'direct' } } });
    const config = readMcpConfig({ agentDir, cwd, projectTrusted: true });
    expect(config.servers.find((s) => s.name === 'files')).toMatchObject({ scope: 'global', enabled: false, override: join(cwd, '.pi', 'mcp.json'), target: 'npx -y server-files .' });
    expect(config.servers.find((s) => s.name === 'sentry')).toMatchObject({ exposure: 'direct', enabled: true });
  });

  it('reports a file that is not JSON instead of throwing', () => {
    const { agentDir } = setup('{ nope');
    const config = readMcpConfig({ agentDir, projectTrusted: false });
    expect(config.servers).toEqual([]);
    expect(config.errors[0]).toContain('mcp.json');
  });

  it('has no servers and no errors when there is no file', () => {
    const { agentDir } = setup(undefined);
    expect(readMcpConfig({ agentDir, projectTrusted: false })).toMatchObject({ servers: [], errors: [] });
  });
});

describe('setMcpServerEnabled', () => {
  it('writes enabled:false, removes the key to enable, keeps the rest of the file and its indentation', () => {
    const { agentDir } = setup('{\n\t"other": 1,\n\t"mcpServers": {\n\t\t"files": { "command": "npx" },\n\t\t"b": { "command": "y", "enabled": false }\n\t}\n}\n');
    const config = readMcpConfig({ agentDir, projectTrusted: false });
    const files = config.servers.find((s) => s.name === 'files') as never;
    setMcpServerEnabled(files, false);
    const path = join(agentDir, 'mcp.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ other: 1, mcpServers: { files: { command: 'npx', enabled: false }, b: { command: 'y', enabled: false } } });
    expect(readFileSync(path, 'utf8')).toContain('\t"other": 1');
    setMcpServerEnabled(files, true);
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.files).toEqual({ command: 'npx' });
  });

  it('writes into the project override when a global server is overridden there', () => {
    const { agentDir, cwd } = setup({ mcpServers: { files: { command: 'x' } } }, { mcpServers: { files: { enabled: false } } });
    const entry = readMcpConfig({ agentDir, cwd, projectTrusted: true }).servers[0];
    setMcpServerEnabled(entry, true);
    expect(JSON.parse(readFileSync(join(cwd, '.pi', 'mcp.json'), 'utf8')).mcpServers.files).toEqual({});
    expect(JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers.files).toEqual({ command: 'x' });
  });

  it('says which server or file is wrong', () => {
    const { agentDir } = setup({ mcpServers: { files: { command: 'x' } } });
    expect(() => setMcpServerEnabled({ name: 'nope', source: join(agentDir, 'mcp.json') }, false)).toThrow('does not define "nope"');
  });
});

describe('indentOf', () => {
  it('finds tabs, spaces, or defaults to two spaces', () => {
    expect(indentOf('{\n\t"a": 1\n}')).toBe('\t');
    expect(indentOf('{\n    "a": 1\n}')).toBe('    ');
    expect(indentOf('{}')).toBe(2);
  });
});

describe('private user MCP writes', () => {
  it('makes an existing public user file private when adding plaintext bearer and OAuth secrets', () => {
    const { agentDir } = setup({ mcpServers: {} });
    const path = join(agentDir, 'mcp.json');
    chmodSync(path, 0o644);
    writeMcpServer(path, 'docs', {
      url: 'https://docs.example/mcp',
      headers: { Authorization: 'Bearer private-token' },
      oauth: { clientSecret: 'private-secret' },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.docs.headers.Authorization).toBe('Bearer private-token');
  });

  it('also secures raw user editor writes and newly created files', () => {
    const { agentDir } = setup({ mcpServers: {} });
    const path = join(agentDir, 'mcp.json');
    chmodSync(path, 0o644);
    writeTextAtomically(path, '{"mcpServers":{"docs":{"command":"docs","env":{"TOKEN":"private-token"}}}}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const fresh = join(agentDir, 'new-agent', 'mcp.json');
    writeMcpServer(fresh, 'docs', { command: 'docs' });
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  it('preserves existing project file permissions for structured and raw writes', () => {
    const { cwd } = setup(undefined, { mcpServers: {} });
    const path = join(cwd, '.pi', 'mcp.json');
    chmodSync(path, 0o644);
    writeMcpServer(path, 'files', { command: 'files' });
    expect(statSync(path).mode & 0o777).toBe(0o644);
    writeTextAtomically(path, '{"mcpServers":{}}');
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });
});
