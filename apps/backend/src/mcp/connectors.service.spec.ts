import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore, type SecretStore } from '@pi-kit/secret-store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { McpOverview } from '@pi-kit/protocol';
import { ConnectorsService } from './connectors.service';
import { SecretsService } from '../secrets/secrets.service';

const overview = (): McpOverview => ({ servers: [], errors: [], projectTrusted: true, live: true, userConfig: 'u' });

interface World {
  agentDir: string;
  cwd: string;
  user: string;
  project: string;
  calls: string[];
  trusted: boolean;
  streaming: boolean;
  store: SecretStore;
  service: ConnectorsService;
  secrets: Pick<SecretsService, 'keepBearer' | 'keep' | 'forget'>;
  oauthEntry: boolean;
}

function world(options: { store?: SecretStore } = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'pk-connectors-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'work');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const store = options.store ?? new MemorySecretStore();
  // A scratch store is read through the `pi-kit-secret` helper, so a resolver exists only when the helper's bundle does.
  const cli = join(root, 'pi-kit-secret.cjs');
  writeFileSync(cli, '// helper');
  process.env['PI_KIT_SECRET_CLI'] = cli;
  const w = { agentDir, cwd, user: join(agentDir, 'mcp.json'), project: join(cwd, '.pi', 'mcp.json'), calls: [] as string[], trusted: true, streaming: false, store, oauthEntry: true } as World;
  const sessions = {
    agentDir: async () => agentDir,
    isProjectTrusted: () => w.trusted,
    stats: () => ({ streaming: w.streaming }),
    reload: async () => void w.calls.push('reload'),
    mcpCommand: async (_thread: string, args: string) => {
      w.calls.push(`/mcp ${args}`);
      return { messages: [{ text: `Signed out of MCP server "x".`, level: 'info' }], finished: true };
    },
  };
  const threads = { openSession: async () => undefined, cwdOf: () => cwd };
  const mcp = {
    login: async (_thread: string, name: string) => {
      w.calls.push(`login ${name}`);
      return { message: `Sign in to MCP server "${name}" in your browser.`, url: 'https://auth.example/authorize?x=1', overview: overview() };
    },
    overview: async () => overview(),
    forgetSignIn: (_thread: string, name: string) => void w.calls.push(`forget ${name}`),
  };
  // The real policy over the in-memory store: what goes into a file is decided there.
  const secrets = new SecretsService(store, { dataDir: root } as never, {} as never, { getSetting: () => undefined } as never);
  w.secrets = secrets;
  const trust = { folderTrusted: async () => w.trusted };
  w.service = new ConnectorsService(sessions as never, threads as never, mcp as never, secrets, trust as never);
  return w;
}

let w: World;
beforeEach(() => {
  w = world();
});
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };
const request = (extra: Record<string, unknown>) => ({ scope: 'user' as const, ...extra }) as never;

describe('connect', () => {
  it('OAuth: writes the user file, reloads the session, starts pi’s sign-in and hands back the link', async () => {
    const result = await w.service.connect('t1', request({ id: 'linear' }));
    expect(read(w.user).mcpServers['linear']).toMatchObject({ url: 'https://mcp.linear.app/mcp', exposure: 'direct' });
    expect(w.calls).toEqual(['reload', 'login linear']);
    expect(result.url).toBe('https://auth.example/authorize?x=1');
    expect(result.message).toContain('Added linear to');
    expect(existsSync(w.project)).toBe(false);
  });

  it('the exposure and the read-only variant the person chose are what is written', async () => {
    await w.service.connect('t1', request({ id: 'linear', variant: 'readonly', exposure: 'deferred' }));
    expect(read(w.user).mcpServers['linear']).toMatchObject({ url: 'https://mcp.linear.app/mcp/readonly', exposure: 'deferred' });
  });

  it('does not clobber what the file already holds', async () => {
    writeFileSync(w.user, JSON.stringify({ autoEnableCodemode: false, mcpServers: { files: { command: 'npx', args: ['x'] } } }, null, 2));
    await w.service.connect('t1', request({ id: 'notion' }));
    const file = read(w.user) as unknown as Record<string, unknown>;
    expect(file['autoEnableCodemode']).toBe(false);
    expect(Object.keys(read(w.user).mcpServers)).toEqual(['files', 'notion']);
  });

  it('project only: .pi/mcp.json of the folder, and not the user file', async () => {
    await w.service.connect('t1', request({ id: 'linear', scope: 'project' }));
    expect(read(w.project).mcpServers['linear']).toBeDefined();
    expect(existsSync(w.user)).toBe(false);
  });

  it('project only waits for trust: nothing is written for a folder pi would not read', async () => {
    w.trusted = false;
    await expect(w.service.connect('t1', request({ id: 'linear', scope: 'project' }))).rejects.toThrow(/not trusted/);
    expect(existsSync(w.project)).toBe(false);
    expect(w.calls).toEqual([]);
  });

  it('project only needs a thread (which folder?), and never carries a credential', async () => {
    await expect(w.service.connect(undefined, request({ id: 'linear', scope: 'project' }))).rejects.toThrow(/Open a thread/);
    await expect(w.service.connect('t1', request({ id: 'github', scope: 'project', token: 'ghp_x' }))).rejects.toThrow(/stays in your user file/);
    expect(existsSync(w.project)).toBe(false);
  });

  it('bearer: the token goes to the credential store and mcp.json holds only the command that prints it', async () => {
    const token = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const result = await w.service.connect('t1', request({ id: 'github', token }));
    const text = readFileSync(w.user, 'utf8');
    expect(text).not.toContain(token);
    expect(read(w.user).mcpServers['github']['headers']).toEqual({ Authorization: expect.stringMatching(/^!(echo Bearer \$\(|pi-kit-secret get connector-github)/) });
    expect(w.store.get('connector-github')).toBe(token);
    expect(JSON.stringify(result)).not.toContain(token);
    // no browser sign-in for a token
    expect(w.calls).toEqual(['reload']);
  });

  it('bearer without a credential store: the token is in the user file, with a message that says so', async () => {
    const none = world({ store: { kind: 'none', label: 'none', available: () => false, get: () => undefined, set: () => undefined, delete: () => false, list: () => [] } });
    const result = await none.service.connect('t1', request({ id: 'github', token: 'ghp_plain' }));
    expect(read(none.user).mcpServers['github']['headers']).toEqual({ Authorization: 'Bearer ghp_plain' });
    expect(result.message).toMatch(/credential storage is disabled or unavailable.*plain text/);
  });

  it('a bearer connector needs its token, a registered-app connector its client id', async () => {
    await expect(w.service.connect('t1', request({ id: 'github' }))).rejects.toThrow(/token/);
    await expect(w.service.connect('t1', request({ id: 'slack' }))).rejects.toThrow(/clientId/);
    expect(existsSync(w.user)).toBe(false);
  });

  it('a registered app: the client secret is kept in the store and written as a command', async () => {
    await w.service.connect('t1', request({ id: 'slack', clientId: '1.2', clientSecret: 'shhh-secret' }));
    const oauth = read(w.user).mcpServers['slack']['oauth'] as Record<string, unknown>;
    expect(oauth['clientId']).toBe('1.2');
    expect(oauth['callbackPort']).toBe(8765);
    expect(String(oauth['clientSecret'])).toMatch(/^!/);
    expect(readFileSync(w.user, 'utf8')).not.toContain('shhh-secret');
    expect(w.store.get('connector-slack-secret')).toBe('shhh-secret');
  });

  it('a custom server: a command needs no sign-in, a URL does', async () => {
    await w.service.connect('t1', request({ id: 'custom', custom: { name: 'files', command: 'npx', args: ['-y', 'srv'] } }));
    expect(read(w.user).mcpServers['files']).toEqual({ command: 'npx', args: ['-y', 'srv'] });
    expect(w.calls).toEqual(['reload']);
    w.calls.length = 0;
    await w.service.connect('t1', request({ id: 'custom', custom: { name: 'docs', url: 'https://example.com/mcp' } }));
    expect(w.calls).toEqual(['reload', 'login docs']);
  });

  it('without a thread an entry is still written, and the answer says a session has to connect it', async () => {
    const result = await w.service.connect(undefined, request({ id: 'linear' }));
    expect(read(w.user).mcpServers['linear']).toBeDefined();
    expect(w.calls).toEqual([]);
    expect(result.message).toMatch(/Open a thread/);
  });

  it('stops for a run in progress, and refuses an unknown connector or a damaged file without writing', async () => {
    w.streaming = true;
    await expect(w.service.connect('t1', request({ id: 'linear' }))).rejects.toThrow(/Stop the run/);
    w.streaming = false;
    await expect(w.service.connect('t1', request({ id: 'nope' }))).rejects.toThrow(/No connector/);
    writeFileSync(w.user, '{ broken');
    await expect(w.service.connect('t1', request({ id: 'linear' }))).rejects.toThrow(/will not overwrite/);
    expect(readFileSync(w.user, 'utf8')).toBe('{ broken');
  });
});

describe('disconnect', () => {
  it('signs out in pi, removes the entry, forgets the stored secrets and reloads', async () => {
    await w.service.connect('t1', request({ id: 'github', token: 'ghp_x' }));
    w.store.set('connector-github-secret', 'extra');
    w.calls.length = 0;
    await w.service.disconnect('t1', 'github');
    expect(read(w.user).mcpServers).toEqual({});
    expect(w.store.get('connector-github')).toBeUndefined();
    expect(w.store.get('connector-github-secret')).toBeUndefined();
    expect(w.calls).toEqual(['forget github', 'reload']);
  });

  it('forgets what a header or variable of the details form kept in the store, and only that', async () => {
    writeFileSync(
      w.user,
      JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example/mcp', headers: { 'X-Api-Key': '!pi-kit-secret get mcp-docs-header-X-Api-Key', 'X-Team': 'core' }, env: { A: '!pi-kit-secret get connector-github' } } } }),
    );
    w.store.set('mcp-docs-header-X-Api-Key', 'secret');
    w.store.set('connector-github', 'not this one: it is not an mcp- account');
    await w.service.disconnect('t1', 'docs');
    expect(w.store.get('mcp-docs-header-X-Api-Key')).toBeUndefined();
    expect(w.store.get('connector-github')).toBe('not this one: it is not an mcp- account');
  });

  it('an OAuth connector is signed out by pi first (it deletes the token), then the entry goes', async () => {
    await w.service.connect('t1', request({ id: 'linear' }));
    w.calls.length = 0;
    const result = await w.service.disconnect('t1', 'linear');
    expect(w.calls[0]).toBe('/mcp logout linear');
    expect(read(w.user).mcpServers).toEqual({});
    expect(result.message).toContain('Removed linear');
  });

  it('removes a project-only connector from the project file and leaves the user file alone', async () => {
    await w.service.connect('t1', request({ id: 'notion' }));
    await w.service.connect('t1', request({ id: 'linear', scope: 'project' }));
    await w.service.disconnect('t1', 'linear');
    expect(read(w.project).mcpServers).toEqual({});
    expect(Object.keys(read(w.user).mcpServers)).toEqual(['notion']);
  });

  it('an OAuth sign-out is pi’s job and needs a session; a token connector does not', async () => {
    await w.service.connect('t1', request({ id: 'linear' }));
    await w.service.connect('t1', request({ id: 'github', token: 't' }));
    await expect(w.service.disconnect(undefined, 'linear')).rejects.toThrow(/Open a thread/);
    expect(read(w.user).mcpServers['linear']).toBeDefined();
    await w.service.disconnect(undefined, 'github');
    expect(read(w.user).mcpServers['github']).toBeUndefined();
  });

  it('says so for a server that is not configured', async () => {
    await expect(w.service.disconnect('t1', 'nothing')).rejects.toThrow(/No MCP server "nothing"/);
  });
});

describe('exposure', () => {
  it('is saved to the file that defines the server and the session reloads', async () => {
    await w.service.connect('t1', request({ id: 'linear' }));
    w.calls.length = 0;
    await w.service.setExposure('t1', 'linear', 'deferred');
    expect(read(w.user).mcpServers['linear']['exposure']).toBe('deferred');
    expect(w.calls).toEqual(['reload']);
  });
});

describe('the catalog the backend serves', () => {
  it('is the one built into this release', () => {
    expect(w.service.catalog().connectors.length).toBeGreaterThan(5);
  });
});
