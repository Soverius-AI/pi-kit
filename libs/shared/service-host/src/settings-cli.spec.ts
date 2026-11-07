import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { RpcPeer } from './host-channel';
import { type CliContext, runCli } from './service-cli';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const openai = { id: 'openai', name: 'OpenAI', methods: ['api_key'], configured: false, stored: false };
const overview = (credential?: { type: 'api_key'; store: string }) => ({
  settings: { defaultProvider: 'ollama', defaultModel: 'llama3' },
  providers: [{ ...openai, ...(credential ? { credential } : {}) }],
  models: [{ provider: 'ollama', id: 'qwen3', name: 'Qwen 3', reasoning: false, available: true }],
  keybindings: [],
  piVersion: '1.4.0',
});

/** The backend's settings routes as `pi-kit` reaches them; the sign-in stream asks for a key and ends once it is answered. */
async function backend() {
  const asked: Array<{ method?: string; path?: string; body: unknown }> = [];
  let stream: ServerResponse | undefined;
  let answered = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    asked.push({ method: req.method, path: req.url, body });
    const json = (status: number, value: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.url?.startsWith('/api/pi-settings') && req.method === 'GET')
      return json(200, overview(answered ? { type: 'api_key', store: 'auth.json' } : undefined));
    if (req.url === '/api/auth/login') return json(201, { id: 'L1' });
    if (req.url === '/api/auth/login/L1/events') {
      stream = res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      stream.write(`${JSON.stringify({ type: 'prompt', promptId: 'p1', kind: 'secret', message: 'API key' })}\n`);
      return;
    }
    if (req.url === '/api/auth/login/L1/answer') {
      answered = true;
      stream?.end(`${JSON.stringify({ type: 'done' })}\n`);
      return json(200, {});
    }
    if (req.url === '/api/auth/login/L1/cancel') {
      stream?.end(`${JSON.stringify({ type: 'error', message: 'cancelled' })}\n`);
      return json(200, {});
    }
    if (req.url === '/api/setup/local/test')
      return json(200, { ok: true, kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen3', 'llama3'] });
    if (req.url === '/api/setup/local/save') return json(200, { provider: body.provider, models: 2, path: '/x' });
    if (req.url === '/api/pi-settings' && req.method === 'PATCH') return json(200, overview().settings);
    json(404, { message: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const peer = {
    call: async () => ({ url, port: 0, token: 'backend-token' }),
    close: () => undefined,
  } as unknown as RpcPeer;
  const ctx: CliContext = {
    version: '0.0.0',
    serviceName: 'test',
    dataDir: '/tmp',
    logDir: '/tmp',
    manager: undefined,
    discover: () => ({ pid: 1, version: '0.0.0', level: 'login', socket: 's', token: 't', startedAt: 'now' }),
    connect: async () => peer,
    tail: () => undefined,
    sleep: async () => undefined,
  };
  return { asked, ctx };
}

function terminal(interactive: boolean) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (text: string) => void out.push(text),
      err: (text: string) => void err.push(text),
      readLine: async () => 'typed in the clear',
      readSecret: async () => 'sk-test',
      interactive,
    },
  };
}

describe('pi-kit login, logout and model', () => {
  it('answers a key prompt from the masked reader and says where the key went', async () => {
    const { asked, ctx } = await backend();
    const { out, io } = terminal(true);
    expect(await runCli(['login', 'openai'], io, ctx)).toBe(0);
    expect(asked.find((call) => call.path === '/api/auth/login')?.body).toEqual({
      provider: 'openai',
      type: 'api_key',
    });
    expect(asked.find((call) => call.path === '/api/auth/login/L1/answer')?.body).toEqual({
      promptId: 'p1',
      value: 'sk-test',
    });
    expect(out.join('')).toContain('the credential is in auth.json');
  });

  it('cancels a sign-in that asks questions when no one is at a terminal', async () => {
    const { asked, ctx } = await backend();
    const { err, io } = terminal(false);
    expect(await runCli(['login', 'openai'], io, ctx)).toBe(1);
    expect(asked.some((call) => call.path === '/api/auth/login/L1/cancel')).toBe(true);
    expect(asked.some((call) => call.path === '/api/auth/login/L1/answer')).toBe(false);
    expect(err.join('')).toContain('run it in a terminal');
  });

  it('adds a local model server under the provider id its kind names', async () => {
    const { asked, ctx } = await backend();
    expect(await runCli(['login', '--local', 'http://127.0.0.1:11434'], terminal(false).io, ctx)).toBe(0);
    expect(asked.find((call) => call.path === '/api/setup/local/save')?.body).toEqual({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['qwen3', 'llama3'],
    });
  });

  it('sets only an available model as the default', async () => {
    const { asked, ctx } = await backend();
    expect(await runCli(['model', 'ollama/missing'], terminal(false).io, ctx)).toBe(2);
    expect(asked.some((call) => call.method === 'PATCH')).toBe(false);
    expect(await runCli(['model', 'ollama/qwen3'], terminal(false).io, ctx)).toBe(0);
    expect(asked.find((call) => call.method === 'PATCH')?.body).toEqual({
      defaultModel: { provider: 'ollama', modelId: 'qwen3' },
    });
  });
});
