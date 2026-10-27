import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySecretStore } from '@pi-kit/secret-store';
import { beforeEach, describe, expect, it } from 'vitest';
import type { McpOverview, McpServerBody } from '@pi-kit/protocol';
import { SecretsService } from '../secrets/secrets.service';
import { McpEditService } from './mcp-edit.service';

const overview = (): McpOverview => ({ servers: [], errors: [], projectTrusted: true, live: true, userConfig: 'u' });

interface World {
  user: string;
  project: string;
  calls: string[];
  trusted: boolean;
  streaming: boolean;
  store: MemorySecretStore;
  service: McpEditService;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), 'pk-mcp-edit-'));
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'work');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const store = new MemorySecretStore();
  const cli = join(root, 'pi-kit-secret.cjs');
  writeFileSync(cli, '// helper');
  process.env['PI_KIT_SECRET_CLI'] = cli;
  const w = { user: join(agentDir, 'mcp.json'), project: join(cwd, '.pi', 'mcp.json'), calls: [] as string[], trusted: true, streaming: false, store } as World;
  const sessions = { agentDir: async () => agentDir, stats: () => ({ streaming: w.streaming }), reload: async () => void w.calls.push('reload') };
  const threads = { openSession: async () => undefined, cwdOf: () => cwd };
  const mcp = {
    filePath: async (scope: string) => (scope === 'user' ? w.user : w.project),
    overview: async () => overview(),
    forgetSignIn: (_t: string, name: string) => void w.calls.push(`forget ${name}`),
    login: async (_t: string, name: string) => {
      w.calls.push(`login ${name}`);
      return { message: `Sign in to ${name}.`, url: 'https://auth.example/x', overview: overview() };
    },
  };
  const secrets = new SecretsService(store, { dataDir: root } as never, {} as never, { getSetting: () => undefined } as never);
  const trust = { folderTrusted: async () => w.trusted };
  w.service = new McpEditService(sessions as never, threads as never, mcp as never, secrets, trust as never);
  return w;
}

let w: World;
beforeEach(() => {
  w = world();
});
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, Record<string, unknown>> };

const command = (over: Partial<McpServerBody> = {}): McpServerBody => ({ name: 'files', kind: 'command', command: 'npx', args: ['-y', 'server-files', '.'], env: [{ key: 'COLOR', value: 'blue' }], exposure: 'codemode', description: '', enabled: true, ...over });
const url = (over: Partial<McpServerBody> = {}): McpServerBody => ({ name: 'docs', kind: 'url', url: 'https://docs.example/mcp', headers: [], exposure: 'codemode', description: '', enabled: true, ...over });

describe('create', () => {
  it('writes a command server with arguments and environment, and reloads the session', async () => {
    const result = await w.service.create('t1', { ...command(), scope: 'user' });
    expect(read(w.user).mcpServers['files']).toEqual({ command: 'npx', args: ['-y', 'server-files', '.'], env: { COLOR: 'blue' } });
    expect(w.calls).toEqual(['reload']);
    expect(result.message).toContain('Added files to');
  });

  it('puts an environment secret in the store and writes the command that prints it, never the value', async () => {
    await w.service.create('t1', { ...command({ env: [{ key: 'API_KEY', value: 'sk-test-0123456789abcdef0123456789abcdef' }] }), scope: 'user' });
    const env = read(w.user).mcpServers['files']['env'] as Record<string, string>;
    expect(env['API_KEY']).toMatch(/^!pi-kit-secret get mcp-files-env-API_KEY$/);
    expect(readFileSync(w.user, 'utf8')).not.toContain('sk-test-0123456789');
    expect(w.store.get('mcp-files-env-API_KEY')).toBe('sk-test-0123456789abcdef0123456789abcdef');
  });

  it('a header marked as a secret is kept even when it does not look like one', async () => {
    await w.service.create('t1', { ...url({ headers: [{ key: 'X-Team', value: 'core-team', secret: true }] }), scope: 'user' });
    expect((read(w.user).mcpServers['docs']['headers'] as Record<string, string>)['X-Team']).toMatch(/^!pi-kit-secret get /);
    expect(w.store.get('mcp-docs-header-X-Team')).toBe('core-team');
  });

  it('a URL server without a token starts pi’s sign-in; one with an Authorization header does not', async () => {
    const first = await w.service.create('t1', { ...url(), scope: 'user' });
    expect(w.calls).toEqual(['reload', 'login docs']);
    expect(first.url).toBe('https://auth.example/x');
    w.calls.length = 0;
    await w.service.create('t1', { ...url({ name: 'docs2', headers: [{ key: 'Authorization', value: 'Bearer ${DOCS_TOKEN}' }] }), scope: 'user' });
    expect(w.calls).toEqual(['reload']);
  });

  it('refuses a taken name and leaves the file as it was', async () => {
    await w.service.create(undefined, { ...command(), scope: 'user' });
    const before = readFileSync(w.user, 'utf8');
    await expect(w.service.create(undefined, { ...command(), scope: 'user' })).rejects.toThrow(/named “files” already/);
    expect(readFileSync(w.user, 'utf8')).toBe(before);
  });

  it('without a thread it writes the entry and says a thread connects it', async () => {
    const result = await w.service.create(undefined, { ...command(), scope: 'user' });
    expect(result.message).toContain('Open a thread to connect it');
    expect(w.calls).toEqual([]);
  });

  it('project: the folder’s file, only for a trusted folder and a thread, and never with a secret', async () => {
    await w.service.create('t1', { ...command(), scope: 'project' });
    expect(read(w.project).mcpServers['files']).toBeDefined();
    expect(existsSync(w.user)).toBe(false);
    await expect(w.service.create('t1', { ...command({ name: 'b', env: [{ key: 'API_KEY', value: 'plain-value' }] }), scope: 'project' })).rejects.toThrow(/stays in your user file/);
    expect(w.store.get('mcp-b-env-API_KEY')).toBeUndefined();
    await expect(w.service.create(undefined, { ...command({ name: 'c' }), scope: 'project' })).rejects.toThrow(/Open a thread/);
    w.trusted = false;
    await expect(w.service.create('t1', { ...command({ name: 'd' }), scope: 'project' })).rejects.toThrow(/not trusted/);
  });

  it('stops while a run holds the thread, before anything is written', async () => {
    w.streaming = true;
    await expect(w.service.create('t1', { ...command(), scope: 'user' })).rejects.toThrow(/Stop the run/);
    expect(existsSync(w.user)).toBe(false);
  });
});

describe('detail and update', () => {
  it('reads the form back; a stored secret has no value', async () => {
    await w.service.create(undefined, { ...url({ headers: [{ key: 'Authorization', value: 'Bearer abcdefghijklmnop1234' }], description: 'Docs' }), scope: 'user' });
    const detail = await w.service.detail(undefined, 'docs', undefined);
    expect(detail).toMatchObject({ name: 'docs', scope: 'user', kind: 'url', url: 'https://docs.example/mcp', description: 'Docs', headers: [{ key: 'Authorization', stored: true }] });
    expect(JSON.stringify(detail)).not.toContain('abcdefghijklmnop1234');
    await expect(w.service.detail(undefined, 'nope', undefined)).rejects.toThrow(/No MCP server/);
  });

  it('a row without a value keeps the stored secret, a typed value replaces it in the store', async () => {
    await w.service.create(undefined, { ...url({ headers: [{ key: 'X-Api-Key', value: 'first-secret-value' }] }), scope: 'user' });
    const stored = (read(w.user).mcpServers['docs']['headers'] as Record<string, string>)['X-Api-Key'];
    await w.service.update('t1', 'docs', 'user', url({ description: 'changed', headers: [{ key: 'X-Api-Key' }] }));
    expect((read(w.user).mcpServers['docs']['headers'] as Record<string, string>)['X-Api-Key']).toBe(stored);
    expect(read(w.user).mcpServers['docs']['description']).toBe('changed');
    await w.service.update('t1', 'docs', 'user', url({ headers: [{ key: 'X-Api-Key', value: 'second-secret-value' }] }));
    expect(w.store.get('mcp-docs-header-X-Api-Key')).toBe('second-secret-value');
    expect(readFileSync(w.user, 'utf8')).not.toContain('second-secret-value');
  });

  it('keeps keys the form does not know and the other servers, and the file’s order', async () => {
    writeFileSync(w.user, JSON.stringify({ autoEnableCodemode: false, mcpServers: { a: { url: 'https://a.example/mcp', oauth: { clientName: 'Claude Code' }, timeout: 90 }, b: { command: 'b' } } }, null, 2));
    await w.service.update('t1', 'a', 'user', url({ name: 'a', url: 'https://a2.example/mcp', exposure: 'direct' }));
    const file = read(w.user) as unknown as Record<string, unknown>;
    expect(file['autoEnableCodemode']).toBe(false);
    expect(Object.keys(read(w.user).mcpServers)).toEqual(['a', 'b']);
    expect(read(w.user).mcpServers['a']).toEqual({ url: 'https://a2.example/mcp', oauth: { clientName: 'Claude Code' }, timeout: 90, exposure: 'direct' });
  });

  it('a rename moves the entry; a taken name is refused', async () => {
    await w.service.create(undefined, { ...command(), scope: 'user' });
    await w.service.create(undefined, { ...command({ name: 'other' }), scope: 'user' });
    await expect(w.service.update('t1', 'files', 'user', command({ name: 'other' }))).rejects.toThrow(/named “other” already/);
    await w.service.update('t1', 'files', 'user', command({ name: 'renamed' }));
    expect(Object.keys(read(w.user).mcpServers)).toEqual(['other', 'renamed']);
    expect(w.calls).toContain('forget files');
  });

  it('a secret that is not read from the store any more is forgotten', async () => {
    await w.service.create(undefined, { ...command({ env: [{ key: 'API_KEY', value: 'a-secret-value-1' }] }), scope: 'user' });
    expect(w.store.get('mcp-files-env-API_KEY')).toBe('a-secret-value-1');
    await w.service.update(undefined, 'files', 'user', command({ env: [] }));
    expect(w.store.get('mcp-files-env-API_KEY')).toBeUndefined();
  });

  it('a missing entry is a 404, not a new server', async () => {
    await expect(w.service.update('t1', 'ghost', 'user', command({ name: 'ghost' }))).rejects.toThrow(/does not define/);
  });
});

describe('the file editor', () => {
  it('reads a file that is not there yet as empty, with mtime 0', async () => {
    expect(await w.service.readFile(undefined, 'user')).toMatchObject({ scope: 'user', text: '', mtime: 0, exists: false });
  });

  it('saves valid text and reloads; refuses invalid text with the line of the first problem', async () => {
    const empty = await w.service.readFile('t1', 'user');
    const text = JSON.stringify({ mcpServers: { a: { url: 'https://a.example/mcp' } } }, null, 2);
    const saved = await w.service.writeFile('t1', 'user', { text, mtime: empty.mtime });
    expect(saved.file.text).toBe(text);
    expect(saved.file.exists).toBe(true);
    expect(saved.message).toContain('connect again');
    expect(w.calls).toEqual(['reload']);
    const bad = text.replace('"url"', '"exposure": "codemod",\n    "url"');
    await expect(w.service.writeFile('t1', 'user', { text: bad, mtime: saved.file.mtime })).rejects.toThrow(/Line 4: exposure must be one of/);
    expect(readFileSync(w.user, 'utf8')).toBe(text);
  });

  it('refuses a save over a file that changed since it was opened', async () => {
    writeFileSync(w.user, '{}');
    const opened = await w.service.readFile(undefined, 'user');
    writeFileSync(w.user, '{"mcpServers":{}}');
    utimesSync(w.user, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    await expect(w.service.writeFile(undefined, 'user', { text: '{}', mtime: opened.mtime })).rejects.toThrow(/Reload and try again/);
  });

  it('keeps the mode of an existing file and makes a new one private', async () => {
    const opened = await w.service.readFile(undefined, 'user');
    await w.service.writeFile(undefined, 'user', { text: '{}', mtime: opened.mtime });
    expect(statSync(w.user).mode & 0o777).toBe(0o600);
  });

  it('while a run holds the thread it saves and says to reload afterwards', async () => {
    w.streaming = true;
    const opened = await w.service.readFile('t1', 'user');
    const saved = await w.service.writeFile('t1', 'user', { text: '{}', mtime: opened.mtime });
    expect(saved.message).toContain('The thread is running');
    expect(w.calls).toEqual([]);
  });

  it('the project’s file needs a thread', async () => {
    const mcpAsk = world();
    expect(await mcpAsk.service.readFile('t1', 'project')).toMatchObject({ scope: 'project', exists: false });
  });
});
