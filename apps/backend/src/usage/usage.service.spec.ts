import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Fetcher, type UsageAdapter } from './usage-adapters';
import { USAGE_TTL_MS, UsageService } from './usage.service';

const SECRET = 'sk-ant-oat-SECRET-TOKEN';

function setup(options: { type?: 'oauth' | 'api_key'; fail?: boolean } = {}) {
  let clock = 1_000;
  const asked: string[] = [];
  const adapter: UsageAdapter = {
    providers: ['anthropic'],
    credential: 'oauth',
    fetch: (token) => {
      asked.push(token);
      if (options.fail) return Promise.reject(Object.assign(new Error(`connect refused for ${token}`), { name: 'FetchError' }));
      return Promise.resolve({ windows: [{ name: '5 h', used: 38 }] });
    },
  };
  const service = new UsageService({ usageCredential: () => Promise.resolve({ type: options.type ?? 'oauth', token: SECRET }) }, { now: () => clock, adapters: [adapter] });
  return { service, asked, advance: (ms: number) => (clock += ms) };
}

afterEach(() => vi.restoreAllMocks());

describe('UsageService', () => {
  it.each(['oauth', 'api_key'] as const)('reads Radius billing with a %s credential using the registered adapter', async (type) => {
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, organization: { id: 'org' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true, currency: 'USD', balance: { available: 12.34 } }) });
    const service = new UsageService({ usageCredential: async () => ({ type, token: SECRET }) }, { fetcher });
    expect(await service.usage('radius')).toEqual({ windows: [], credit: '$12.34' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bypasses a fresh cache on refresh and makes concurrent cached readers wait for the new balance', async () => {
    let complete!: (value: { windows: []; credit: string }) => void;
    const fetch = vi.fn().mockResolvedValueOnce({ windows: [], credit: '$10.00' })
      .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const service = new UsageService({ usageCredential: async () => ({ type: 'oauth', token: SECRET }) }, {
      adapters: [{ providers: ['radius'], credential: 'either', fetch }],
    });
    await service.usage('radius');
    const refreshed = service.usage('radius', true);
    const concurrent = service.usage('radius');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    complete({ windows: [], credit: '$7.00' });
    expect(await refreshed).toEqual({ windows: [], credit: '$7.00' });
    expect(await concurrent).toEqual({ windows: [], credit: '$7.00' });
    expect(await service.usage('radius')).toEqual({ windows: [], credit: '$7.00' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('asks the provider once a minute and serves the rest from the cache', async () => {
    const { service, asked, advance } = setup();
    expect(await service.usage('anthropic')).toEqual({ windows: [{ name: '5 h', used: 38 }] });
    advance(USAGE_TTL_MS - 1);
    await service.usage('anthropic');
    expect(asked).toHaveLength(1);
    advance(2);
    await service.usage('anthropic');
    expect(asked).toHaveLength(2);
  });

  it('shares one request between callers that ask at the same time', async () => {
    const { service, asked } = setup();
    await Promise.all([service.usage('anthropic'), service.usage('anthropic'), service.usage('anthropic')]);
    expect(asked).toHaveLength(1);
  });

  it('answers null for a provider with no source, without asking for a credential', async () => {
    const credentials = { usageCredential: vi.fn() };
    const service = new UsageService(credentials, { adapters: [] });
    expect(await service.usage('radius')).toBeNull();
    expect(credentials.usageCredential).not.toHaveBeenCalled();
  });

  it('answers null when the sign-in is not the kind the source needs (an API key for the subscription endpoint)', async () => {
    const { service, asked } = setup({ type: 'api_key' });
    expect(await service.usage('anthropic')).toBeNull();
    expect(asked).toHaveLength(0);
  });

  it('remembers a failure for the minute and never writes the token to the log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, asked } = setup({ fail: true });
    expect(await service.usage('anthropic')).toBeNull();
    expect(await service.usage('anthropic')).toBeNull();
    expect(asked).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(warn.mock.calls)).toContain('anthropic');
  });
});


it.each(['openai', 'openai-codex'])('never sends a Platform API key to %s subscription usage', async (provider) => {
  const fetcher = vi.fn<Fetcher>();
  const credentials = { usageCredential: async () => ({ type: 'api_key' as const, token: SECRET }) };
  const service = new UsageService(credentials, { fetcher });
  expect(await service.usage(provider)).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['openai', 'openai-codex'])('registers %s OAuth usage with the shared cache and timeout', async (provider) => {
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'example' } })).toString('base64url')}.signature`;
  const fetcher = vi.fn<Fetcher>().mockResolvedValue({ ok: true, status: 200, json: async () => ({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } }) });
  const service = new UsageService({ usageCredential: async () => ({ type: 'oauth', token }) }, { fetcher });
  expect(await service.usage(provider)).toEqual({ windows: [{ name: '5 h', used: 25 }] });
  await service.usage(provider);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  await service.usage(provider, true);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('hides malformed JSON and network/abort failures from ChatGPT usage without logging tokens', async () => {
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'example' } })).toString('base64url')}.signature`;
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  for (const name of ['SyntaxError', 'AbortError', 'TypeError']) {
    const fetcher = vi.fn<Fetcher>();
    const error = Object.assign(new Error(token), { name });
    if (name === 'SyntaxError') fetcher.mockResolvedValue({ ok: true, status: 200, json: async () => { throw error; } });
    else fetcher.mockRejectedValue(error);
    const service = new UsageService({ usageCredential: async () => ({ type: 'oauth', token }) }, { fetcher });
    expect(await service.usage('openai')).toBeNull();
    expect(await service.usage('openai')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
  expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
});
