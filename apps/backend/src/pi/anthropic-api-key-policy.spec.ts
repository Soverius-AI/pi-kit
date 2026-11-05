import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiKeyOnlyRuntime, ANTHROPIC_API_KEY_ONLY } from './anthropic-api-key-policy';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
async function world(credential: unknown, envKey = '') {
  const dir = mkdtempSync(join(tmpdir(), 'pk-anthropic-policy-'));
  dirs.push(dir);
  vi.stubEnv('PI_OFFLINE', '1');
  vi.stubEnv('ANTHROPIC_API_KEY', envKey);
  vi.stubEnv('ANTHROPIC_OAUTH_TOKEN', 'sk-ant-oat-ignored');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'sk-ant-oat-ignored');
  const fetcher = vi.fn(() => {
    throw new Error('Unexpected network request');
  });
  vi.stubGlobal('fetch', fetcher);
  const authPath = join(dir, 'auth.json');
  writeFileSync(authPath, JSON.stringify({ anthropic: credential }));
  const original = readFileSync(authPath, 'utf8');
  const pi = await import('@earendil-works/pi-coding-agent');
  const runtime = await createApiKeyOnlyRuntime(pi, { authPath, modelsPath: null });
  return { pi, runtime, fetcher, authPath, original };
}

describe('Anthropic API-key-only runtime policy', () => {
  it.each([Date.now() - 1000, Date.now() + 3600000])(
    'never resolves or refreshes saved OAuth (%s)',
    async (expires) => {
      const { runtime, fetcher, authPath, original } = await world({
        type: 'oauth',
        access: 'sk-ant-oat-secret',
        refresh: 'sk-ant-ort-secret',
        expires,
      });
      expect(await runtime.getAuth('anthropic')).toBeUndefined();
      expect(await runtime.getAvailable('anthropic')).toEqual([]);
      expect(runtime.isUsingSubscription('anthropic')).toBe(false);
      expect(await runtime.listCredentials()).toContainEqual({ providerId: 'anthropic', type: 'oauth' });
      expect(runtime.getProviderAuthStatus('anthropic')).toEqual({ configured: false });
      expect(runtime.getProvider('anthropic')?.auth.oauth).toBeUndefined();
      await expect(runtime.login('anthropic', 'oauth', { prompt: vi.fn(), notify: vi.fn() })).rejects.toThrow(
        ANTHROPIC_API_KEY_ONLY,
      );
      await runtime.refresh({ allowNetwork: false });
      expect(await runtime.getAuth('anthropic')).toBeUndefined();
      expect(fetcher).not.toHaveBeenCalled();
      expect(readFileSync(authPath, 'utf8')).toBe(original);
    },
  );

  it('allows an API key to override saved OAuth without changing it', async () => {
    const { runtime, authPath, original } = await world(
      { type: 'oauth', access: 'saved', refresh: 'saved', expires: 0 },
      'sk-ant-api-valid',
    );
    expect((await runtime.getAuth('anthropic'))?.auth.apiKey).toBe('sk-ant-api-valid');
    await runtime.setRuntimeApiKey('anthropic', 'runtime-key');
    expect((await runtime.getAuth('anthropic'))?.auth.apiKey).toBe('runtime-key');
    await runtime.removeRuntimeApiKey('anthropic');
    expect((await runtime.getAuth('anthropic'))?.auth.apiKey).toBe('sk-ant-api-valid');
    expect(readFileSync(authPath, 'utf8')).toBe(original);
  });

  it.each(['sk-ant-oat01-secret', 'sk-ant-ort01-secret'])(
    'rejects subscription tokens at request, runtime and login boundaries',
    async (key) => {
      const { runtime } = await world({ type: 'api_key', key: 'valid-key' });
      await expect(runtime.getAuth('anthropic', { apiKey: key })).rejects.toThrow(ANTHROPIC_API_KEY_ONLY);
      await expect(runtime.setRuntimeApiKey('anthropic', key)).rejects.toThrow(ANTHROPIC_API_KEY_ONLY);
      await expect(runtime.login('anthropic', 'api_key', { prompt: async () => key, notify: vi.fn() })).rejects.toThrow(
        ANTHROPIC_API_KEY_ONLY,
      );
      expect((await runtime.getAuth('anthropic'))?.auth.apiKey).toBe('valid-key');
    },
  );

  it.each(['sk-ant-oat01-secret', 'sk-ant-ort01-secret'])(
    'ignores subscription tokens pasted into saved or environment API-key slots (%s)',
    async (key) => {
      for (const source of ['stored', 'environment']) {
        const { runtime, authPath, original } = await world(
          source === 'stored' ? { type: 'api_key', key } : undefined,
          source === 'environment' ? key : '',
        );
        await runtime.setRuntimeApiKey('openai', 'valid-openai-key');
        expect(await runtime.getAuth('anthropic')).toBeUndefined();
        expect(await runtime.getAvailable('anthropic')).toEqual([]);
        expect(runtime.getProviderAuthStatus('anthropic')).toEqual({ configured: false });
        expect((await runtime.getAvailable()).some((model) => model.provider === 'openai')).toBe(true);
        await runtime.refresh({ allowNetwork: false });
        expect((await runtime.getAvailable()).some((model) => model.provider === 'openai')).toBe(true);
        expect(readFileSync(authPath, 'utf8')).toBe(original);
        await expect(runtime.getAuth('anthropic', { apiKey: key })).rejects.toThrow(ANTHROPIC_API_KEY_ONLY);
      }
    },
  );

  it('keeps the policy after extension registration and virtual model recomposition', async () => {
    const { runtime } = await world({ type: 'api_key', key: 'valid-key' });
    const provider = runtime.getProvider('anthropic');
    if (!provider) throw new Error('Missing Anthropic provider');
    runtime.registerNativeProvider({
      ...provider,
      auth: { ...provider.auth, oauth: { name: 'forbidden', login: vi.fn(), refresh: vi.fn(), toAuth: vi.fn() } },
    });
    await runtime.refresh({ allowNetwork: false });
    expect(runtime.getProvider('anthropic')?.auth.oauth).toBeUndefined();
    expect((await runtime.getAuth('anthropic'))?.auth.apiKey).toBe('valid-key');
  });
});
