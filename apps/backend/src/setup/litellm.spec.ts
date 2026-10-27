import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiteLlmConnectSchema } from '@pi-kit/protocol';
import type { SecretsService } from '../secrets/secrets.service';
import { loadPi } from '../pi/load-pi';

vi.mock('../pi/load-pi', async () => {
  const pi = await import('@earendil-works/pi-coding-agent');
  return { loadPi: async () => pi };
});
import { discoverLiteLlm, liteLlmBaseUrl } from './litellm';
import { LiteLlmService } from './litellm.service';

describe('LiteLLM proxy discovery', () => {
  it('discovers authorized aliases, imports capabilities and ignores non-chat or inaccessible models', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [{ id: 'team/fast' }, { id: 'team/fast' }, { id: 'embedding' }] }))
      .mockResolvedValueOnce(Response.json({ data: [
        { model_name: 'team/fast', litellm_params: { api_key: 'upstream-secret' }, model_info: { display_name: 'Fast', max_input_tokens: 200000, max_output_tokens: 8192, supports_vision: true, supports_reasoning: true, input_cost_per_token: 0.000003 } },
        { model_name: 'private' }, { model_name: 'embedding', model_info: { mode: 'embedding' } },
      ] }));
    const result = await discoverLiteLlm('https://proxy.example/gateway/v1/', 'virtual-key', fetchFn);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual(['https://proxy.example/gateway/v1/models', 'https://proxy.example/gateway/model/info']);
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer virtual-key' }, redirect: 'error' });
    expect(result.models).toEqual([{ id: 'team/fast', name: 'Fast', contextWindow: 200000, maxTokens: 8192, vision: true, reasoning: true, costInput: 3, costOutput: undefined }]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('works with a restricted virtual key that cannot access management metadata', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ data: [{ id: 'alias', max_input_tokens: 32768 }] })).mockResolvedValueOnce(new Response('', { status: 403 }));
    expect((await discoverLiteLlm('http://localhost:4000', undefined, fetchFn)).models).toMatchObject([{ id: 'alias', contextWindow: 32768 }]);
    expect(fetchFn.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it('rejects invalid lists, credentials in URLs, command keys and errors without reflecting secrets', async () => {
    expect(() => liteLlmBaseUrl('https://user:secret@proxy.example')).toThrow(/API key field/);
    expect(LiteLlmConnectSchema.safeParse({ baseUrl: 'http://host', apiKey: ' !echo injected' }).success).toBe(false);
    expect(LiteLlmConnectSchema.safeParse({ baseUrl: 'http://host', apiKey: 'key\r\nheader' }).success).toBe(false);
    await expect(discoverLiteLlm('http://host', 'secret', vi.fn().mockResolvedValue(Response.json({ error: 'secret' })))).rejects.toThrow('valid model list');
    await expect(discoverLiteLlm('http://host', 'secret', vi.fn().mockResolvedValue(new Response('secret', { status: 401 })))).rejects.toThrow('refused this API key');
    await expect(discoverLiteLlm('http://host', 'secret', vi.fn().mockRejectedValue(new Error('secret')))).rejects.toThrow('Could not reach LiteLLM');
  });
});

describe('persisted LiteLLM connection', () => {
  let dir: string, server: Server, baseUrl: string, service: LiteLlmService;
  let models: string[], requests: { url: string; auth: string | undefined; model?: string }[];
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pk-litellm-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', dir);
    vi.stubEnv('PI_OFFLINE', '1');
    models = ['team/fast']; requests = [];
    server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      requests.push({ url: req.url ?? '', auth: req.headers.authorization, ...(raw ? { model: JSON.parse(raw).model } : {}) });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') res.end(JSON.stringify({ data: models.map((id) => ({ id, max_input_tokens: 64000, max_output_tokens: 4000 })) }));
      else if (req.url === '/model/info') { res.statusCode = 403; res.end('{}'); }
      else if (req.url === '/v1/chat/completions') {
        res.setHeader('content-type', 'text/event-stream');
        res.end('data: {"id":"reply","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"reply","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      } else { res.statusCode = 404; res.end('{}'); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    service = new LiteLlmService({ keep: async (_provider: string, key: string) => ({ value: key, storage: 'auth.json' }) } as SecretsService);
    writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: { existing: { baseUrl: 'http://localhost:9999/v1', apiKey: 'local', models: [{ id: 'existing-model' }] } } }));
  });
  afterEach(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  it('saves once, restores credentials, refreshes removed aliases and routes chat through the proxy', async () => {
    const result = await service.save({ baseUrl, apiKey: 'sk-virtual-fixture' });
    expect(JSON.stringify(result)).not.toContain('sk-virtual-fixture');
    expect(statSync(join(dir, 'models.json')).mode & 0o777).toBe(0o600);
    expect(service.status()).toMatchObject({ configured: true, hasApiKey: true, models: [{ id: 'team/fast' }] });
    const pi = await loadPi();
    const runtime = await pi.ModelRuntime.create();
    const model = runtime.getModel('litellm', 'team/fast');
    if (!model) throw new Error('The saved LiteLLM model was not registered.');
    expect(runtime.getProvider('litellm')?.name).toBe('LiteLLM');
    expect(model).toMatchObject({ contextWindow: 64000, maxTokens: 4000 });
    const reply = await runtime.complete(model, { messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] });
    expect(reply.stopReason).toBe('stop');
    expect(requests.find((r) => r.url === '/v1/chat/completions')).toMatchObject({ auth: 'Bearer sk-virtual-fixture', model: 'team/fast' });
    models = ['new-alias'];
    await service.save({ baseUrl });
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getModel('litellm', 'new-alias')).toBeDefined();
    expect(runtime.getModel('litellm', 'team/fast')).toBeUndefined();
    const file = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    expect(file.providers.existing.models).toEqual([{ id: 'existing-model' }]);
    expect(file.providers.litellm.models.map((m: { id: string }) => m.id)).toEqual(['new-alias']);
    await expect(service.discover({ baseUrl: baseUrl.replace('127.0.0.1', 'localhost') })).rejects.toThrow('Enter the API key again');
  });

  it('automatically refreshes open runtimes with new aliases, coalesces concurrent opens and removes stale aliases', async () => {
    await service.save({ baseUrl, apiKey: 'sk-virtual-fixture' });
    const runtime = await (await loadPi()).ModelRuntime.create();
    const other = await (await loadPi()).ModelRuntime.create();
    models = ['automatic-alias'];
    const count = requests.filter((r) => r.url === '/v1/models').length;
    await Promise.all([service.refreshCatalog(runtime), service.refreshCatalog(other)]);
    expect(requests.filter((r) => r.url === '/v1/models')).toHaveLength(count + 1);
    for (const active of [runtime, other]) {
      expect(active.getModel('litellm', 'automatic-alias')).toMatchObject({ contextWindow: 64000 });
      expect(active.getModel('litellm', 'team/fast')).toBeUndefined();
    }
    expect(service.status().models.map((m) => m.id)).toEqual(['automatic-alias']);
    models = [];
    await service.refreshCatalog(runtime);
    expect(runtime.getModels('litellm')).toEqual([]);
    models = ['restored'];
    await service.refreshCatalog(runtime);
    expect(runtime.getModel('litellm', 'restored')).toBeDefined();
  });

  it('keeps the saved list on failed discovery and skips unconfigured connections', async () => {
    const runtime = await (await loadPi()).ModelRuntime.create();
    await service.refreshCatalog(runtime);
    expect(requests).toEqual([]);
    await service.save({ baseUrl, apiKey: '' });
    await runtime.refresh({ allowNetwork: false });
    const before = readFileSync(join(dir, 'models.json'), 'utf8');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Offline'));
    try {
      await service.refreshCatalog(runtime);
      expect(runtime.getModel('litellm', 'team/fast')).toBeDefined();
      expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe(before);
    } finally { vi.restoreAllMocks(); }
  });

  it('does not overwrite settings changed while automatic discovery was in progress', async () => {
    await service.save({ baseUrl, apiKey: '' });
    const runtime = await (await loadPi()).ModelRuntime.create();
    const fetchFn = globalThis.fetch;
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => { await gate; return fetchFn(...args); });
    try {
      models = ['stale-response'];
      const refreshing = service.refreshCatalog(runtime);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
      const path = join(dir, 'models.json');
      const file = JSON.parse(readFileSync(path, 'utf8'));
      file.providers.litellm.baseUrl = 'http://localhost:9998/v1';
      writeFileSync(path, JSON.stringify(file));
      finish?.();
      await refreshing;
      expect(service.status()).toMatchObject({ baseUrl: 'http://localhost:9998/v1', models: [{ id: 'team/fast' }] });
    } finally { finish?.(); vi.restoreAllMocks(); }
  });

  it('supports keyless proxies and leaves saved configuration intact when a refresh has no models', async () => {
    await service.save({ baseUrl, apiKey: '' });
    expect(service.status().hasApiKey).toBe(false);
    expect(requests[0].auth).toBeUndefined();
    const pi = await loadPi(); const runtime = await pi.ModelRuntime.create();
    const model = runtime.getModel('litellm', 'team/fast');
    if (!model) throw new Error('The keyless LiteLLM model was not registered.');
    await runtime.complete(model, { messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] });
    expect(requests.find((r) => r.url === '/v1/chat/completions')?.auth).toBe('Bearer litellm-no-key');
    models = [];
    const before = readFileSync(join(dir, 'models.json'), 'utf8');
    await expect(service.save({ baseUrl, apiKey: '' })).rejects.toThrow('no chat models');
    expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe(before);
  });
});
