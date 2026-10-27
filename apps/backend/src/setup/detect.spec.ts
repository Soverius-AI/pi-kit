import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentDirFacts, countSessions, findPathPi, normalizeBaseUrl, probeLocalServers, proxyHost, readAuthEntries, testEndpoint, type Fetch } from './detect';
import { saveLocalProvider, refreshExistingLocalProviders, removeLegacyLocalProvider } from './local-models';

const scratch = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'pk-setup-')));

/** A fetch that answers from a table of url → body (or an error), so no test touches a socket. */
function fakeFetch(table: Record<string, unknown>): Fetch {
  return async (url) => {
    if (!(url in table)) throw new TypeError('fetch failed (ECONNREFUSED)');
    const body = table[url];
    return { ok: body !== null, status: body === null ? 404 : 200, json: async () => body };
  };
}

describe('the agent folder facts', () => {
  it('says where each stored credential lives and never returns the credential', () => {
    const agent = scratch();
    const secret = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    writeFileSync(
      join(agent, 'auth.json'),
      JSON.stringify({
        openrouter: { type: 'api_key', key: secret },
        anthropic: { type: 'api_key', key: '!security find-generic-password -s pi-kit -a anthropic -w' },
        openai: { type: 'api_key', key: '!op read op://vault/openai/key' },
        google: { type: 'api_key', key: 'GEMINI_API_KEY' },
        'github-copilot': { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
        broken: 'nonsense',
      }),
    );
    const entries = readAuthEntries(agent);
    expect(entries).toEqual([
      { provider: 'anthropic', type: 'api_key', store: 'keychain' },
      { provider: 'github-copilot', type: 'oauth', store: 'auth.json' },
      { provider: 'google', type: 'api_key', store: 'environment' },
      { provider: 'openai', type: 'api_key', store: 'command' },
      { provider: 'openrouter', type: 'api_key', store: 'auth.json' },
    ]);
    expect(JSON.stringify(entries)).not.toContain(secret);
  });

  it('reads a missing or unreadable auth.json as no credentials', () => {
    const agent = scratch();
    expect(readAuthEntries(agent)).toEqual([]);
    writeFileSync(join(agent, 'auth.json'), '{ not json');
    expect(readAuthEntries(agent)).toEqual([]);
  });

  it('counts session files two levels down and reports the files that exist', () => {
    const agent = scratch();
    expect(agentDirFacts(join(agent, 'nowhere'))).toMatchObject({ exists: false, auth: [], sessionCount: 0, hasModelsJson: false, hasSettings: false });
    mkdirSync(join(agent, 'sessions', '--proj-a--'), { recursive: true });
    mkdirSync(join(agent, 'sessions', '--proj-b--'), { recursive: true });
    writeFileSync(join(agent, 'sessions', '--proj-a--', '1.jsonl'), '{}\n');
    writeFileSync(join(agent, 'sessions', '--proj-a--', '2.jsonl'), '{}\n');
    writeFileSync(join(agent, 'sessions', '--proj-b--', '3.jsonl'), '{}\n');
    writeFileSync(join(agent, 'sessions', '--proj-b--', 'notes.txt'), 'x');
    writeFileSync(join(agent, 'models.json'), '{}');
    expect(countSessions(agent)).toBe(3);
    expect(agentDirFacts(agent)).toMatchObject({ exists: true, sessionCount: 3, hasModelsJson: true, hasSettings: false });
  });
});

describe('local servers', () => {
  it('writes the base URL pi would use', () => {
    expect(normalizeBaseUrl('localhost:8080')).toBe('http://localhost:8080/v1');
    expect(normalizeBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1');
    expect(normalizeBaseUrl('https://models.example.com/openai/v1?x=1#y')).toBe('https://models.example.com/openai/v1');
    expect(() => normalizeBaseUrl('ftp://host/v1')).toThrow(/http/);
  });

  it('lists the models of an OpenAI-compatible server, and knows llama-swap and Ollama by their ports', async () => {
    const fetchFn = fakeFetch({ 'http://127.0.0.1:8080/v1/models': { data: [{ id: 'gemma-4-26b' }, { id: 'llama3.2' }] } });
    expect(await testEndpoint('http://127.0.0.1:8080', fetchFn)).toEqual({ ok: true, kind: 'llama-swap', baseUrl: 'http://127.0.0.1:8080/v1', models: ['gemma-4-26b', 'llama3.2'] });
    const other = fakeFetch({ 'http://box.lan:9000/v1/models': { data: [{ id: 'm' }] } });
    expect(await testEndpoint('box.lan:9000', other)).toMatchObject({ ok: true, kind: 'openai', models: ['m'] });
  });

  it('falls back to Ollama’s own listing and says plainly when nothing answers', async () => {
    const ollama = fakeFetch({ 'http://127.0.0.1:11434/v1/models': null, 'http://127.0.0.1:11434/api/tags': { models: [{ name: 'llama3.2:latest' }] } });
    expect(await testEndpoint('http://127.0.0.1:11434/v1', ollama)).toMatchObject({ ok: true, kind: 'ollama', models: ['llama3.2:latest'] });
    const refused = await testEndpoint('http://127.0.0.1:1/v1', fakeFetch({}));
    expect(refused).toMatchObject({ ok: false, models: [], error: 'Nothing is listening there.' });
    expect((await testEndpoint('not a url at all', fakeFetch({}))).ok).toBe(false);
  });

  it('keeps only the probes that answered', async () => {
    const fetchFn = fakeFetch({ 'http://127.0.0.1:8080/v1/models': { data: [{ id: 'gemma-4-26b' }] } });
    const found = await probeLocalServers(
      [
        { kind: 'llama-swap', name: 'llama-swap or llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
        { kind: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
      ],
      fetchFn,
    );
    expect(found).toEqual([{ kind: 'llama-swap', name: 'llama-swap or llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1', models: ['gemma-4-26b'] }]);
  });
});

describe('models.json', () => {
  it('refreshes matching existing providers without replacing credentials, options or creating private providers', () => {
    const agent = scratch(), path = join(agent, 'models.json');
    const provider = { baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai-completions', apiKey: 'my-key', headers: { 'X-Local': 'keep' }, models: [{ id: 'manual', contextWindow: 8192 }] };
    writeFileSync(path, JSON.stringify({ providers: { existing: provider, unrelated: { baseUrl: 'https://remote.example/v1' } } }));
    refreshExistingLocalProviders(agent, [{ baseUrl: provider.baseUrl, models: ['manual', 'downloaded'] }]);
    const result = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(result.providers)).toEqual(['existing', 'unrelated']);
    expect(result.providers.existing).toEqual({ ...provider, models: [...provider.models, { id: 'downloaded' }] });
  });
  it('adds a downloaded model once instead of copying the server catalog into every sibling connection', () => {
    const agent = scratch(), path = join(agent, 'models.json');
    const connection = { baseUrl: 'http://127.0.0.1:8080/v1', apiKey: 'local' };
    const providers = {
      ds4: { ...connection, models: [{ id: 'deepseek', contextWindow: 393216 }] },
      mlx: { ...connection, baseUrl: 'http://localhost:8080/v1/', models: [{ id: 'gemma', contextWindow: 256000 }] },
      'llama-swap': { ...connection, models: [{ id: 'existing-download' }] },
      other: { ...connection, baseUrl: 'http://127.0.0.1:8081/v1', models: [{ id: 'other-server' }] },
    };
    writeFileSync(path, JSON.stringify({ providers }));
    const servers = [
      { baseUrl: connection.baseUrl, models: ['deepseek', 'gemma', 'existing-download', 'new-download', 'new-download'] },
      { baseUrl: 'http://localhost:8080/v1/', models: ['existing-download', 'second-download'] },
    ];
    refreshExistingLocalProviders(agent, servers);
    const result = JSON.parse(readFileSync(path, 'utf8')).providers;
    expect(result.ds4).toEqual(providers.ds4);
    expect(result.mlx).toEqual(providers.mlx);
    expect(result.other).toEqual(providers.other);
    expect(result['llama-swap'].models).toEqual([{ id: 'existing-download' }, { id: 'new-download' }, { id: 'second-download' }]);
    const once = readFileSync(path, 'utf8');
    refreshExistingLocalProviders(agent, servers);
    expect(readFileSync(path, 'utf8')).toBe(once);
  });
  it('cleans up only the unchanged legacy private provider and preserves user-defined providers', () => {
    const agent = scratch(), path = join(agent, 'models.json');
    const ours = { baseUrl: 'http://127.0.0.1:9876/v1', api: 'openai-completions', apiKey: 'local', models: [{ id: 'legacy' }] };
    const user = { ...ours, apiKey: 'my-key' };
    writeFileSync(path, JSON.stringify({ providers: { 'pi-kit-local': user, 'pi-kit-local-1': ours } }));
    removeLegacyLocalProvider(agent, { provider: 'pi-kit-local', baseUrl: ours.baseUrl });
    expect(JSON.parse(readFileSync(path, 'utf8')).providers['pi-kit-local']).toEqual(user);
    removeLegacyLocalProvider(agent, { provider: 'pi-kit-local-1', baseUrl: ours.baseUrl });
    expect(JSON.parse(readFileSync(path, 'utf8')).providers).toEqual({ 'pi-kit-local': user });
  });
  it('adds a provider and keeps everything else in the file, including the mode', () => {
    const agent = scratch();
    const path = join(agent, 'models.json');
    writeFileSync(path, JSON.stringify({ providers: { openrouter: { baseUrl: 'https://us.openrouter.ai/api/v1' } }, extra: true }), { mode: 0o640 });
    chmodSync(path, 0o640);
    const result = saveLocalProvider(agent, { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['llama3.2:latest', 'llama3.2:latest', 'qwen2.5-coder:7b'] });
    expect(result).toEqual({ path, models: 2 });
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(file.extra).toBe(true);
    expect(file.providers.openrouter).toEqual({ baseUrl: 'https://us.openrouter.ai/api/v1' });
    expect(file.providers.ollama).toEqual({ baseUrl: 'http://127.0.0.1:11434/v1', api: 'openai-completions', apiKey: 'local', models: [{ id: 'llama3.2:latest' }, { id: 'qwen2.5-coder:7b' }] });
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it('keeps what the user wrote for a model and a key of the same provider, and makes a new file private', () => {
    const agent = scratch();
    const path = join(agent, 'models.json');
    writeFileSync(path, JSON.stringify({ providers: { local: { baseUrl: 'http://old/v1', apiKey: '!op read x', models: [{ id: 'a', contextWindow: 32000 }] } } }));
    saveLocalProvider(agent, { provider: 'local', baseUrl: 'http://new:1/v1', models: ['a', 'b'] });
    const local = JSON.parse(readFileSync(path, 'utf8')).providers.local;
    expect(local).toMatchObject({ baseUrl: 'http://new:1/v1', apiKey: '!op read x', models: [{ id: 'a', contextWindow: 32000 }, { id: 'b' }] });

    const fresh = scratch();
    saveLocalProvider(fresh, { provider: 'llama-swap', baseUrl: 'http://127.0.0.1:8080/v1', models: ['m'] });
    expect(statSync(join(fresh, 'models.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite a file it cannot read', () => {
    const agent = scratch();
    writeFileSync(join(agent, 'models.json'), '{ "providers": ');
    expect(() => saveLocalProvider(agent, { provider: 'x', baseUrl: 'http://h/v1', models: ['m'] })).toThrow(/not valid JSON/);
    expect(readFileSync(join(agent, 'models.json'), 'utf8')).toBe('{ "providers": ');
  });
});

describe('the pi command line and the proxy', () => {
  it('finds a pi on PATH, skips node_modules/.bin, and reads its version', async () => {
    if (process.platform === 'win32') return;
    const base = scratch();
    const user = join(base, 'bin');
    const npm = join(base, 'repo', 'node_modules', '.bin');
    mkdirSync(user, { recursive: true });
    mkdirSync(npm, { recursive: true });
    writeFileSync(join(user, 'pi'), '#!/bin/sh\necho "pi 1.2.9"\n', { mode: 0o755 });
    writeFileSync(join(npm, 'pi'), '#!/bin/sh\necho "pi 0.0.1"\n', { mode: 0o755 });
    expect(await findPathPi({ PATH: [npm, user].join(':') })).toEqual({ found: true, path: join(user, 'pi'), version: '1.2.9' });
    expect(await findPathPi({ PATH: npm })).toEqual({ found: false });
  });

  it('shows the proxy host and no credentials', () => {
    expect(proxyHost({ HTTPS_PROXY: 'http://user:hunter2@proxy.corp:3128' })).toBe('proxy.corp:3128');
    expect(proxyHost({ http_proxy: 'proxy.corp:8080' })).toBe('proxy.corp:8080');
    expect(proxyHost({})).toBeUndefined();
  });
});
