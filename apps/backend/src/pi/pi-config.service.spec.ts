import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoginEvent } from '@pi-kit/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileSecretStore, NoSecretStore, type SecretStore } from '@pi-kit/secret-store';
import { PiConfigService, plainError } from './pi-config.service';
import { SecretsService } from '../secrets/secrets.service';
import type { PiSessionService } from './pi-session.service';

// The backend loads pi through a native `import()` that a test runner's sandbox does not offer; the test loads the same package its own way.
vi.mock('./load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

const scratch = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'pk-config-')));
const service = (): PiConfigService => new PiConfigService({} as PiSessionService);

describe('provider status', () => {
  const agent = scratch();
  const previous = process.env['PI_CODING_AGENT_DIR'];
  const keys = { PI_OFFLINE: process.env['PI_OFFLINE'], OPENROUTER_API_KEY: process.env['OPENROUTER_API_KEY'] };
  beforeAll(() => {
    process.env['PI_CODING_AGENT_DIR'] = agent;
    process.env['PI_OFFLINE'] = '1';
    delete process.env['OPENROUTER_API_KEY'];
    writeFileSync(
      join(agent, 'auth.json'),
      JSON.stringify({
        openrouter: { type: 'api_key', key: 'sk-or-v1-0123456789abcdef0123456789abcdefa1b2' },
        anthropic: { type: 'api_key', key: '!security find-generic-password -s pi-kit -a anthropic -w' },
        openai: { type: 'api_key', key: '!op read op://vault/openai/key' },
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { 'llama-swap': { baseUrl: 'http://127.0.0.1:8080/v1', api: 'openai-completions', apiKey: 'local', models: [{ id: 'gemma-4-26b' }, { id: 'llama3.2' }] } } }));
  });
  afterAll(() => {
    if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previous;
    for (const [name, value] of Object.entries(keys)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('describes each stored credential by provider, store and last four characters, and never carries the key', async () => {
    const overview = await service().overview(agent);
    const byId = new Map(overview.providers.map((p) => [p.id, p]));
    expect(byId.get('openrouter')?.credential).toEqual({ type: 'api_key', store: 'auth.json', lastFour: 'a1b2' });
    expect(byId.get('anthropic')?.credential).toEqual({ type: 'api_key', store: 'keychain' });
    expect(byId.get('openai')?.credential).toEqual({ type: 'api_key', store: 'command' });
    expect(JSON.stringify(overview)).not.toContain('0123456789abcdef');
    expect(JSON.stringify(overview)).not.toContain('op://vault');
  });

  it('counts a provider with a usable model: the keyed local server from models.json, and every provider that has a stored credential', async () => {
    const usable = await service().usableProviders();
    const local = usable.find((p) => p.id === 'llama-swap');
    expect(local).toMatchObject({ models: 2 });
    expect(usable.find((p) => p.id === 'openrouter')?.models).toBeGreaterThan(0);
    // pi counts a provider as usable from its stored credential; a bare catalog entry without one is not.
    expect(usable.find((p) => p.id === 'groq')).toBeUndefined();
  });

  it('reports no usable provider for an empty agent folder', async () => {
    const empty = scratch();
    process.env['PI_CODING_AGENT_DIR'] = empty;
    try {
      expect(await service().usableProviders()).toEqual([]);
    } finally {
      process.env['PI_CODING_AGENT_DIR'] = agent;
    }
  });
});

/** A device-flow and authorization-code server: the sign-in state machine runs against it, not against a provider (no network, no real account). */
function mockOAuthServer(): Promise<{ server: Server; base: string; polls: { count: number }; close: () => void }> {
  const polls = { count: 0 };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/device/code') return void res.end(JSON.stringify({ device_code: 'dev-123', user_code: 'WDJB-MJHT', verification_uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/activate`, interval: 0.05 }));
        if (req.url === '/token') {
          const form = new URLSearchParams(body);
          if (form.get('grant_type') === 'authorization_code') {
            return void res.end(form.get('code') === 'pasted-code-42' ? JSON.stringify({ access_token: 'at-code', refresh_token: 'rt-code', expires_in: 3600 }) : JSON.stringify({ error: 'invalid_grant' }));
          }
          polls.count += 1;
          // The user approves on the third poll.
          return void res.end(polls.count < 3 ? JSON.stringify({ error: 'authorization_pending' }) : JSON.stringify({ access_token: 'at-device', refresh_token: 'rt-device', expires_in: 3600 }));
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, polls, close: () => server.close() }));
  });
}

describe('the sign-in state machine against a mocked OAuth server', () => {
  const agent = scratch();
  const previous = process.env['PI_CODING_AGENT_DIR'];
  beforeAll(() => {
    process.env['PI_CODING_AGENT_DIR'] = agent;
    process.env['PI_OFFLINE'] = '1';
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, 'auth.json'), '{}', { mode: 0o600 });
  });
  afterAll(() => {
    if (previous === undefined) delete process.env['PI_CODING_AGENT_DIR'];
    else process.env['PI_CODING_AGENT_DIR'] = previous;
    delete process.env['PI_OFFLINE'];
  });

  /** A runtime on the scratch agent folder with one extra provider whose OAuth is the flow under test. */
  async function runtimeWith(flow: 'device' | 'code', base: string) {
    const pi = await import('@earendil-works/pi-coding-agent');
    const runtime = await pi.ModelRuntime.create({ authPath: join(agent, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    const post = async (path: string, form: Record<string, string>): Promise<{ [k: string]: unknown }> => (await fetch(`${base}${path}`, { method: 'POST', body: new URLSearchParams(form) })).json() as Promise<{ [k: string]: unknown }>;
    const credentials = (r: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }) => ({ access: String(r.access_token), refresh: String(r.refresh_token), expires: Date.now() + Number(r.expires_in) * 1000 });
    runtime.registerProvider('mock-sso', {
      name: 'Mock SSO',
      baseUrl: 'http://127.0.0.1:9/v1',
      api: 'openai-completions',
      models: [{ id: 'mock-1', name: 'Mock 1', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 8000, maxTokens: 1000 }],
      oauth: {
        name: 'Mock SSO',
        async login(callbacks) {
          if (flow === 'device') {
            const code = await post('/device/code', {});
            callbacks.onDeviceCode({ userCode: String(code['user_code']), verificationUri: String(code['verification_uri']) });
            for (;;) {
              callbacks.signal?.throwIfAborted();
              const r = await post('/token', { grant_type: 'device_code', device_code: String(code['device_code']) });
              if (r['access_token']) return credentials(r);
              callbacks.onProgress?.('Waiting for you to approve the sign-in…');
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          }
          // The browser cannot reach this machine (headless): the user pastes the code the provider showed.
          callbacks.onAuth({ url: `${base}/authorize?state=abc`, instructions: 'Open this page, sign in and paste the code it shows.' });
          const pasted = await callbacks.onPrompt({ message: 'Paste the authorization code' });
          const r = await post('/token', { grant_type: 'authorization_code', code: pasted });
          if (!r['access_token']) throw new Error(`The provider refused the code (${String(r['error'])}).`);
          return credentials(r);
        },
        async refreshToken(c) {
          return c;
        },
        getApiKey: (c) => c.access,
      },
    });
    return runtime;
  }

  const eventsOf = (run: { events: LoginEvent[] }, type: LoginEvent['type']) => run.events.filter((e) => e.type === type);
  const finished = (run: { done: boolean }) => vi.waitFor(() => expect(run.done).toBe(true), { timeout: 5000 });

  it('device flow: shows the code and the page, waits while the user approves, then stores the token (0600) and ends with done', async () => {
    const mock = await mockOAuthServer();
    try {
      const signedIn = vi.fn();
      const run = await service().startLogin('mock-sso', 'oauth', signedIn, await runtimeWith('device', mock.base));
      await finished(run);
      expect(eventsOf(run, 'device_code')).toEqual([{ type: 'device_code', userCode: 'WDJB-MJHT', verificationUri: `${mock.base}/activate` }]);
      expect(run.events.at(-1)).toEqual({ type: 'done' });
      expect(mock.polls.count).toBe(3);
      expect(signedIn).toHaveBeenCalledOnce();
      const auth = JSON.parse(readFileSync(join(agent, 'auth.json'), 'utf8'));
      expect(auth['mock-sso']).toMatchObject({ type: 'oauth', access: 'at-device', refresh: 'rt-device' });
      expect(statSync(join(agent, 'auth.json')).mode & 0o777).toBe(0o600);
      // The stream never carries a token.
      expect(JSON.stringify(run.events)).not.toContain('at-device');
    } finally {
      mock.close();
    }
  });

  it('paste-the-code fallback: offers the page, asks for the code, exchanges what the user pasted', async () => {
    const mock = await mockOAuthServer();
    try {
      const run = await service().startLogin('mock-sso', 'oauth', undefined, await runtimeWith('code', mock.base));
      await vi.waitFor(() => expect(eventsOf(run, 'prompt')).toHaveLength(1), { timeout: 5000 });
      expect(eventsOf(run, 'auth_url')).toEqual([{ type: 'auth_url', url: `${mock.base}/authorize?state=abc`, instructions: 'Open this page, sign in and paste the code it shows.' }]);
      const prompt = eventsOf(run, 'prompt')[0] as Extract<LoginEvent, { type: 'prompt' }>;
      expect(run.answer(prompt.promptId, 'pasted-code-42')).toBe(true);
      expect(run.answer(prompt.promptId, 'again')).toBe(false);
      await finished(run);
      expect(run.events.at(-1)).toEqual({ type: 'done' });
      expect(eventsOf(run, 'prompt_end')).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(agent, 'auth.json'), 'utf8'))['mock-sso']).toMatchObject({ access: 'at-code' });
    } finally {
      mock.close();
    }
  });

  it('a code the provider refuses ends the flow with the provider’s message, and nothing is stored', async () => {
    const mock = await mockOAuthServer();
    writeFileSync(join(agent, 'auth.json'), '{}', { mode: 0o600 });
    try {
      const run = await service().startLogin('mock-sso', 'oauth', undefined, await runtimeWith('code', mock.base));
      await vi.waitFor(() => expect(eventsOf(run, 'prompt')).toHaveLength(1), { timeout: 5000 });
      run.answer((eventsOf(run, 'prompt')[0] as Extract<LoginEvent, { type: 'prompt' }>).promptId, 'wrong');
      await finished(run);
      expect(run.events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('invalid_grant') });
      expect(JSON.parse(readFileSync(join(agent, 'auth.json'), 'utf8'))).toEqual({});
    } finally {
      mock.close();
    }
  });

  it('cancelling while the user is still deciding ends the flow as cancelled and stores nothing', async () => {
    const mock = await mockOAuthServer();
    writeFileSync(join(agent, 'auth.json'), '{}', { mode: 0o600 });
    try {
      const run = await service().startLogin('mock-sso', 'oauth', undefined, await runtimeWith('code', mock.base));
      await vi.waitFor(() => expect(eventsOf(run, 'prompt')).toHaveLength(1), { timeout: 5000 });
      run.cancel();
      await finished(run);
      expect(run.events.at(-1)).toEqual({ type: 'error', message: 'Sign-in cancelled.' });
      expect(JSON.parse(readFileSync(join(agent, 'auth.json'), 'utf8'))).toEqual({});
    } finally {
      mock.close();
    }
  });
});

describe('provider errors as sentences', () => {
  it('turns an HTTP error body into its status and message, and cuts anything else short', () => {
    expect(plainError('401 {"type":"error","error":{"type":"authentication_error","message":"User not found.","error_type":"x"}}')).toBe('401: User not found.');
    expect(plainError('{"error":{"message":"Rate \\"limit\\" hit"}}')).toBe('Rate "limit" hit');
    expect(plainError('fetch failed')).toBe('fetch failed');
    expect(plainError('x'.repeat(500))).toHaveLength(300);
  });
});

describe('an API key through the sign-in, with a credential store', () => {
  const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef7e57';
  const previous = { agent: process.env['PI_CODING_AGENT_DIR'], cli: process.env['PI_KIT_SECRET_CLI'], offline: process.env['PI_OFFLINE'], path: process.env['PATH'] };

  function world(store: SecretStore) {
    const agent = scratch();
    const cli = join(scratch(), 'pi-kit-secret.cjs');
    writeFileSync(cli, '// bundle\n');
    process.env['PI_CODING_AGENT_DIR'] = agent;
    process.env['PI_KIT_SECRET_CLI'] = cli;
    process.env['PI_OFFLINE'] = '1';
    writeFileSync(join(agent, 'auth.json'), '{}', { mode: 0o600 });
    const settings = new Map<string, unknown>();
    const secrets = new SecretsService(store, { dataDir: scratch() }, { protection: {}, recoveryKey: () => undefined } as never, { getSetting: (k: string) => settings.get(k), setSetting: (k: string, v: unknown) => void settings.set(k, v) } as never);
    // Keep SDK resolver execution inside this fixture, even when a machine helper is on PATH.
    secrets.ensureLauncher();
    return { agent, service: new PiConfigService({} as PiSessionService, secrets), secrets };
  }
  afterAll(() => {
    for (const [name, value] of [['PI_CODING_AGENT_DIR', previous.agent], ['PI_KIT_SECRET_CLI', previous.cli], ['PI_OFFLINE', previous.offline], ['PATH', previous.path]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function signInWithKey(service: PiConfigService, key: string) {
    const run = await service.startLogin('openrouter', 'api_key');
    await vi.waitFor(() => expect(run.events.some((e) => e.type === 'prompt')).toBe(true), { timeout: 5000 });
    const prompt = run.events.find((e) => e.type === 'prompt') as Extract<LoginEvent, { type: 'prompt' }>;
    expect(prompt.kind).toBe('secret');
    run.answer(prompt.promptId, key);
    await vi.waitFor(() => expect(run.done).toBe(true), { timeout: 5000 });
    return run;
  }

  it('stores the key in the store, writes the command into auth.json (never the key), and shows provider and the store', async () => {
    const dir = scratch();
    const store = new FileSecretStore(join(dir, 'secrets.json'));
    const { agent, service } = world(store);
    const run = await signInWithKey(service, KEY);
    expect(run.events.at(-1)).toEqual({ type: 'done' });
    const authText = readFileSync(join(agent, 'auth.json'), 'utf8');
    expect(JSON.parse(authText).openrouter).toEqual({ type: 'api_key', key: '!pi-kit-secret get openrouter' });
    expect(authText).not.toContain(KEY.slice(8));
    expect(statSync(join(agent, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(store.get('openrouter')).toBe(KEY);
    // Nothing the sign-in said to the page carries the key.
    expect(JSON.stringify(run.events)).not.toContain(KEY.slice(8));

    const overview = await service.overview(agent);
    const provider = overview.providers.find((p) => p.id === 'openrouter');
    expect(provider?.credential).toEqual({ type: 'api_key', store: 'keychain' });
    expect(JSON.stringify(overview)).not.toContain(KEY.slice(8));
  });

  it('repeated Settings overviews never read the credential store', async () => {
    const store = new FileSecretStore(join(scratch(), 'secrets.json'));
    const { agent, service } = world(store);
    writeFileSync(join(agent, 'auth.json'), JSON.stringify({
      openrouter: { type: 'api_key', key: '!pi-kit-secret get openrouter' },
      anthropic: { type: 'api_key', key: '!security find-generic-password -s pi-kit -a anthropic -w' },
    }), { mode: 0o600 });
    const read = vi.spyOn(store, 'get').mockImplementation(() => {
      throw new Error('Settings must not read credentials');
    });
    try {
      for (let refresh = 0; refresh < 2; refresh++) {
        const overview = await service.overview(agent);
        for (const id of ['openrouter', 'anthropic']) {
          expect(overview.providers.find((p) => p.id === id)?.credential).toEqual({ type: 'api_key', store: 'keychain' });
        }
      }
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('removes a LiteLLM connection and its models.json secret while preserving other providers', async () => {
    const store = new FileSecretStore(join(scratch(), 'secrets.json'));
    const { agent, service } = world(store);
    store.set('litellm', KEY);
    store.set('openrouter', 'keep-me');
    const other = { baseUrl: 'http://localhost:9999/v1', apiKey: 'local', models: [{ id: 'keep' }] };
    writeFileSync(join(agent, 'models.json'), JSON.stringify({ $schema: 'keep-schema', providers: {
      litellm: { api: 'openai-completions', baseUrl: 'http://localhost:4000/v1', apiKey: '!pi-kit-secret get litellm', models: [{ id: 'remove' }] },
      other,
    } }), { mode: 0o600 });
    await service.removeProvider('litellm');
    expect(JSON.parse(readFileSync(join(agent, 'models.json'), 'utf8'))).toEqual({ $schema: 'keep-schema', providers: { other } });
    expect(store.get('litellm')).toBeUndefined();
    expect(store.get('openrouter')).toBe('keep-me');
    await service.removeProvider('litellm'); // repeated removal is harmless
  });

  it('does not move plaintext keys into the store while credential storage is disabled', async () => {
    const store = new FileSecretStore(join(scratch(), 'secrets.json'));
    const { agent, service, secrets } = world(store);
    await secrets.setCredentialStorage(false);
    writeFileSync(join(agent, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key', key: KEY } }));
    await expect(service.moveKeys()).rejects.toThrow(/disabled/);
    expect(store.get('openrouter')).toBeUndefined();
    expect(JSON.parse(readFileSync(join(agent, 'auth.json'), 'utf8')).openrouter.key).toBe(KEY);
  });

  it('refuses malformed models.json without removing credentials', async () => {
    const store = new FileSecretStore(join(scratch(), 'secrets.json'));
    const { agent, service } = world(store);
    store.set('litellm', KEY);
    writeFileSync(join(agent, 'models.json'), '{broken');
    await expect(service.removeProvider('litellm')).rejects.toThrow();
    expect(readFileSync(join(agent, 'models.json'), 'utf8')).toBe('{broken');
    expect(store.get('litellm')).toBe(KEY);
  });

  it('signing out removes the command from auth.json and the entry from the store', async () => {
    const store = new FileSecretStore(join(scratch(), 'secrets.json'));
    const { agent, service } = world(store);
    await signInWithKey(service, KEY);
    await service.logout('openrouter');
    expect(JSON.parse(readFileSync(join(agent, 'auth.json'), 'utf8')).openrouter).toBeUndefined();
    expect(store.get('openrouter')).toBeUndefined();
  });

  it('keeps the key in pi’s own auth.json, and says so in the stream, when there is no credential store', async () => {
    const { agent, service } = world(new NoSecretStore());
    const run = await signInWithKey(service, KEY);
    expect(JSON.parse(readFileSync(join(agent, 'auth.json'), 'utf8')).openrouter).toEqual({ type: 'api_key', key: KEY });
    expect(run.events.find((e) => e.type === 'info')).toMatchObject({ message: expect.stringContaining('plain-text key') });
    expect(JSON.stringify(run.events)).not.toContain(KEY.slice(8));
    const provider = (await service.overview(agent)).providers.find((p) => p.id === 'openrouter');
    expect(provider?.credential).toEqual({ type: 'api_key', store: 'auth.json', lastFour: '7e57' });
  });

  it('"Move my existing keys" moves each literal key into the store and rewrites its entry; a key that cannot be stored stays as it was', async () => {
    const store = new FileSecretStore(join(scratch(), 'secrets.json'));
    const { agent, service } = world(store);
    writeFileSync(
      join(agent, 'auth.json'),
      JSON.stringify({
        openrouter: { type: 'api_key', key: KEY },
        groq: { type: 'api_key', key: 'gsk_abcdefghijklmnopqrstuvwx' },
        anthropic: { type: 'api_key', key: '!op read op://vault/anthropic/key' },
        'cloudflare-workers-ai': { type: 'api_key', key: 'cf-abcdefghijkl', env: { CLOUDFLARE_ACCOUNT_ID: 'x' } },
      }),
      { mode: 0o600 },
    );
    const result = await service.moveKeys();
    expect(result).toEqual({ moved: ['groq', 'openrouter'], failed: [] });
    const auth = JSON.parse(readFileSync(join(agent, 'auth.json'), 'utf8'));
    expect(auth.openrouter).toEqual({ type: 'api_key', key: '!pi-kit-secret get openrouter' });
    expect(auth.groq).toEqual({ type: 'api_key', key: '!pi-kit-secret get groq' });
    expect(auth.anthropic.key).toBe('!op read op://vault/anthropic/key');
    expect(auth['cloudflare-workers-ai'].key).toBe('cf-abcdefghijkl');
    expect(store.get('openrouter')).toBe(KEY);
    expect(store.get('groq')).toBe('gsk_abcdefghijklmnopqrstuvwx');
    // Moving again finds nothing to move.
    expect(await service.moveKeys()).toEqual({ moved: [], failed: [] });
    expect(readFileSync(join(agent, 'auth.json'), 'utf8')).not.toContain(KEY.slice(8));
  });

  it('refuses to move anything when there is no store, and leaves auth.json alone', async () => {
    const { agent, service } = world(new NoSecretStore());
    writeFileSync(join(agent, 'auth.json'), JSON.stringify({ openrouter: { type: 'api_key', key: KEY } }), { mode: 0o600 });
    await expect(service.moveKeys()).rejects.toThrow(/no credential store/);
    expect(JSON.parse(readFileSync(join(agent, 'auth.json'), 'utf8')).openrouter.key).toBe(KEY);
  });
});
