import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelRuntime } from './model-runtime';
import { chatGptModels } from './chatgpt-model-catalog';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const visible = ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol'];
const response = (ids = visible) => ({
  models: ids.map((slug) => ({ slug, display_name: `Live ${slug}`, visibility: 'list' })),
});

async function world(subscription = true, fetcher = vi.fn(async () => Response.json(response()))) {
  const dir = mkdtempSync(join(tmpdir(), 'pk-model-runtime-'));
  dirs.push(dir);
  vi.stubEnv('PI_CODING_AGENT_DIR', dir);
  vi.stubEnv('PI_OFFLINE', undefined);
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubGlobal('fetch', fetcher);
  const token = `test-access-${randomUUID()}`;
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      openai: subscription
        ? { type: 'oauth', access: token, refresh: 'test-refresh', expires: Date.now() + 3_600_000 }
        : { type: 'api_key', key: 'test-key' },
      'openai-codex': {
        type: 'oauth',
        access: token,
        refresh: 'test-refresh',
        expires: Date.now() + 3_600_000,
      },
    }),
  );
  const pi = await import('@earendil-works/pi-coding-agent');
  return {
    pi,
    dir,
    token,
    fetcher,
    runtime: await createModelRuntime(pi, { authPath: join(dir, 'auth.json'), modelsPath: null }),
  };
}

describe('ChatGPT subscription model catalog', () => {
  it('lets one cancelled waiter leave a shared catalog request running for the other caller', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const token = `cancellation-${randomUUID()}`;
    const first = new AbortController();
    const cancelled = chatGptModels(token, first.signal);
    const waiting = chatGptModels(token, new AbortController().signal);
    first.abort(new Error('Picker closed'));
    await expect(cancelled).rejects.toThrow('Picker closed');
    finish(Response.json(response()));
    expect((await waiting).map((m) => m.slug)).toEqual(visible);
    expect(fetcher).toHaveBeenCalledOnce();
    const aborted = new AbortController();
    aborted.abort(new Error('Already closed'));
    await expect(chatGptModels(`never-fetch-${randomUUID()}`, aborted.signal)).rejects.toThrow('Already closed');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not overwrite a newer account catalog when an older request finishes later', async () => {
    const { runtime, fetcher } = await world();
    let finish!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.spyOn(runtime, 'getAuth')
      .mockResolvedValueOnce({ auth: { apiKey: `old-request-${randomUUID()}` } })
      .mockResolvedValue({ auth: { apiKey: `new-request-${randomUUID()}` } });
    const older = runtime.getAvailable('openai');
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    fetcher.mockResolvedValueOnce(Response.json(response(['gpt-6-luna'])));
    await runtime.getAvailable('openai');
    finish(Response.json(response(['gpt-6.1-sol'])));
    await older;
    expect(runtime.getModel('openai', 'gpt-6.1-sol')).toBeUndefined();
    expect(runtime.getModel('openai', 'gpt-6-luna')).toBeDefined();
  });

  it('uses server ordering, display names and visibility, and shares concurrent requests for the same credential', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        models: [
          { slug: 'gpt-6-luna', display_name: 'Account Luna', visibility: 'list' },
          { slug: 'gpt-5.5', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'gpt-6.1-sol', display_name: 'Account Sol', visibility: 'list' },
        ],
      }),
    );
    const { runtime, token } = await world(true, fetcher);
    expect((await runtime.getAvailable('openai')).map((m) => [m.id, m.name])).toEqual([
      ['gpt-6-luna', 'Account Luna'],
      ['gpt-6.1-sol', 'Account Sol'],
    ]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('accepts a new account model absent from the SDK catalog, with live limits and reasoning levels', async () => {
    const { runtime } = await world(
      true,
      vi.fn(async () =>
        Response.json({
          models: [
            {
              slug: 'future-account-model',
              display_name: 'New account model',
              visibility: 'list',
              context_window: 64000,
              input_modalities: ['text', 'image'],
              supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
            },
          ],
        }),
      ),
    );
    const model = runtime.getModel('openai', 'future-account-model');
    expect(model).toMatchObject({
      name: 'New account model',
      contextWindow: 64000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: { low: 'low', high: 'high', off: null, medium: null },
    });
    expect(runtime.getPhysicalModel('openai', 'future-account-model')).toEqual(model);
    expect(await runtime.getAvailable('openai')).toEqual([model]);
  });

  it('refreshes account choices after the short cache expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { runtime, fetcher } = await world();
    fetcher.mockResolvedValueOnce(Response.json(response(['gpt-6-luna'])));
    vi.setSystemTime(Date.now() + 31_000);
    expect((await runtime.getAvailable('openai')).map((m) => m.id)).toEqual(['gpt-6-luna']);
    expect(runtime.getModel('openai', 'gpt-6.1-sol')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fetches separately for a different account and never shows the previous account on failure', async () => {
    const { runtime, fetcher } = await world();
    vi.spyOn(runtime, 'getAuth').mockResolvedValue({ auth: { apiKey: `different-account-${randomUUID()}` } });
    fetcher.mockResolvedValueOnce(Response.json(response(['gpt-6-luna'])));
    expect((await runtime.getAvailable('openai')).map((m) => m.id)).toEqual(['gpt-6-luna']);
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.spyOn(runtime, 'getAuth').mockResolvedValue({ auth: { apiKey: `third-account-${randomUUID()}` } });
    fetcher.mockResolvedValueOnce(new Response('', { status: 401 }));
    expect(await runtime.getAvailable('openai')).toEqual([]);
    expect(runtime.getModel('openai', 'gpt-6-luna')).toBeUndefined();
    expect(runtime.getError()).toContain('Could not load live models for openai');
  });

  it('retains a recent successful response on a transient failure, but expires it after five minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { runtime, fetcher } = await world();
    fetcher.mockImplementation(async () => new Response('', { status: 503 }));
    vi.setSystemTime(Date.now() + 31_000);
    expect((await runtime.getAvailable('openai')).map((m) => m.id)).toEqual(visible);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(await runtime.getAvailable('openai')).toEqual([]);
    expect(runtime.getModel('openai', 'gpt-5.5')).toBeUndefined();
  });

  it.each([{}, { models: [{ slug: 'malformed', visibility: 'list' }] }])(
    'rejects malformed responses instead of exposing the API catalog: %j',
    async (body) => {
      const { runtime } = await world(
        true,
        vi.fn(async () => Response.json(body)),
      );
      expect(await runtime.getAvailable()).toEqual([]);
      expect(runtime.getModel('openai', 'gpt-5.5')).toBeUndefined();
    },
  );

  it('makes no catalog request with PI_OFFLINE and does not substitute the API catalog', async () => {
    const { pi, dir, fetcher } = await world();
    fetcher.mockClear();
    vi.stubEnv('PI_OFFLINE', '1');
    const runtime = await createModelRuntime(pi, { authPath: join(dir, 'auth.json'), modelsPath: null });
    expect(await runtime.getAvailable()).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('filters API-only and retired models from both providers, including cycling snapshots and direct selection', async () => {
    const { runtime } = await world();
    for (const provider of ['openai', 'openai-codex']) {
      const ids = (await runtime.getAvailable(provider)).map((m) => m.id);
      expect(ids).toEqual(expect.arrayContaining(['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol']));
      for (const id of [
        'gpt-4o',
        'gpt-5.2',
        'gpt-5.3-codex',
        'gpt-5.3-codex-spark',
        'gpt-5.4',
        'gpt-5.4-mini',
        'gpt-5.5',
        'gpt-5.5-2026-04-23',
        'o3',
      ]) {
        expect(ids).not.toContain(id);
        expect(runtime.getModel(provider, id)).toBeUndefined();
        expect(runtime.getModels(provider).some((m) => m.id === id)).toBe(false);
        expect(runtime.getAvailableSnapshot().some((m) => m.provider === provider && m.id === id)).toBe(false);
      }
    }
    expect((await runtime.getAvailable()).some((m) => m.id === 'gpt-5.5')).toBe(false);
  });

  it('preserves the OpenAI API-key catalog while filtering the legacy Codex subscription', async () => {
    const { runtime } = await world(false);
    for (const id of ['gpt-4o', 'gpt-5.5']) {
      expect(runtime.getModel('openai', id)?.id).toBe(id);
      expect((await runtime.getAvailable('openai')).some((m) => m.id === id)).toBe(true);
      expect(runtime.getAvailableSnapshot().some((m) => m.provider === 'openai' && m.id === id)).toBe(true);
    }
    expect(runtime.getModel('openai-codex', 'gpt-5.5')).toBeUndefined();
  });

  it('rechecks auth after switching a subscription to an API key', async () => {
    const { runtime } = await world();
    expect(runtime.getModel('openai', 'gpt-5.5')).toBeUndefined();
    await runtime.setRuntimeApiKey('openai', 'test-runtime-key');
    expect(runtime.isUsingSubscription('openai')).toBe(false);
    expect((await runtime.getAvailable()).some((m) => m.provider === 'openai' && m.id === 'gpt-5.5')).toBe(true);
    expect(runtime.getModel('openai', 'gpt-5.5')).toBeDefined();
    await runtime.removeRuntimeApiKey('openai');
    expect(runtime.isUsingSubscription('openai')).toBe(true);
    expect((await runtime.getAvailable()).some((m) => m.provider === 'openai' && m.id === 'gpt-5.5')).toBe(false);
  });

  it('keeps other providers and extension virtual models available', async () => {
    const { runtime } = await world();
    runtime.registerProvider('local', {
      name: 'Local',
      baseUrl: 'http://localhost:1234/v1',
      api: 'openai-completions',
      apiKey: 'test-key',
      models: [
        {
          id: 'gpt-5.5',
          name: 'Local model',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8000,
          maxTokens: 1000,
        },
      ],
    });
    const target = runtime.getModel('openai', 'gpt-6-luna');
    if (!target) throw new Error('Expected GPT-6 Luna in the subscription fixture.');
    runtime.registerVirtualModel({
      provider: 'openai',
      id: 'my-router',
      name: 'My router',
      route: () => ({ model: target, thinkingLevel: 'low' }),
    });
    const available = await runtime.getAvailable();
    expect(available.some((m) => m.provider === 'local' && m.id === 'gpt-5.5')).toBe(true);
    expect(available.some((m) => m.provider === 'openai' && m.id === 'my-router')).toBe(true);
    expect(runtime.getModel('openai', 'my-router')?.api).toBe('pi-virtual');
  });

  it('lets the SDK recover from a retired default and cycle past retired pinned models', async () => {
    const { pi, dir, runtime } = await world();
    const { session } = await pi.createAgentSession({
      cwd: dir,
      modelRuntime: runtime,
      sessionManager: pi.SessionManager.inMemory(dir),
      settingsManager: pi.SettingsManager.inMemory({ defaultProvider: 'openai', defaultModel: 'gpt-5.5' }),
      noTools: 'all',
    });
    try {
      expect(session.model).toBeDefined();
      expect(session.model?.id).not.toBe('gpt-5.5');
      const available = await runtime.getAvailable();
      expect(available).toContainEqual(session.model);
      const { scopedModels } = await pi.resolveModelScopeWithDiagnostics(
        ['openai/gpt-5.5', 'openai/gpt-6.1-sol', 'openai/gpt-6-luna'],
        runtime,
      );
      expect(scopedModels.map((m) => m.model.id)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
      session.setScopedModels(scopedModels);
      const sol = runtime.getModel('openai', 'gpt-6.1-sol');
      if (!sol) throw new Error('Expected GPT-6.1 Sol in the subscription fixture.');
      await session.setModel(sol);
      await session.cycleModel();
      expect(session.model?.id).toBe('gpt-6-luna');
      session.setScopedModels([]);
      for (let i = 0; i < available.length; i++) {
        await session.cycleModel();
        expect(available).toContainEqual(session.model);
      }
    } finally {
      session.dispose();
    }
  });

  it('resumes an existing conversation with an available replacement for its retired model', async () => {
    const { pi, dir, runtime } = await world();
    const sessionManager = pi.SessionManager.inMemory(dir);
    sessionManager.appendModelChange('openai', 'gpt-5.5');
    sessionManager.appendMessage({ role: 'user', content: 'Previous request', timestamp: Date.now() });
    const { session } = await pi.createAgentSession({
      cwd: dir,
      modelRuntime: runtime,
      sessionManager,
      settingsManager: pi.SettingsManager.inMemory({}),
      noTools: 'all',
    });
    try {
      expect(session.model).toBeDefined();
      expect(session.model?.id).not.toBe('gpt-5.5');
      expect(await runtime.getAvailable()).toContainEqual(session.model);
    } finally {
      session.dispose();
    }
  });
});
