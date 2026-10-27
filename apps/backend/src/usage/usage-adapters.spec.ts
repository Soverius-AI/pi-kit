import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Fetcher, anthropicUsage, openaiCodexUsage, parseOpenAICodexUsage, openrouterUsage, parseAnthropicUsage, parseOpenRouterCredits, parseOpenRouterKey, parseRadiusBilling, radiusUsage } from './usage-adapters';

/**
 * The bodies below are the shapes the providers answer with, written from their documentation and from the open-source clients that read the same endpoints: they are NOT
 * recordings of a live account (the suite never touches one). Anthropic's endpoint is the one Claude Code's `/usage` reads and is not a documented API, so the adapter
 * takes only what it recognises.
 */
const ANTHROPIC_BODY = {
  five_hour: { utilization: 38.0, resets_at: '2026-10-17T14:30:00.000000+00:00' },
  seven_day: { utilization: 12.0, resets_at: '2026-10-22T09:00:00.000000+00:00' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 4.0, resets_at: '2026-10-22T09:00:00.000000+00:00' },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
};
const OPENROUTER_CREDITS = { data: { total_credits: 100.5, total_usage: 59.3 } };
const OPENROUTER_KEY = { data: { label: 'pi-kit', limit: 50, limit_reset: 'monthly', limit_remaining: 41.2, usage: 8.8, is_free_tier: false } };

const answer = (status: number, body: unknown): Awaited<ReturnType<Fetcher>> => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
const signal = new AbortController().signal;
afterEach(() => vi.unstubAllEnvs());

describe('Radius credit', () => {
  const billing = { ok: true, currency: 'USD', balance: { credit_balance: 50, reserved: 8.8, available: 41.2 } };

  it('shows available USD after reservations, including zero and negative balances', () => {
    expect(parseRadiusBilling(billing)).toEqual({ windows: [], credit: '$41.20' });
    expect(parseRadiusBilling({ ...billing, balance: { available: 0 } })).toEqual({ windows: [], credit: '$0.00' });
    expect(parseRadiusBilling({ ...billing, balance: { available: -0.5 } })).toEqual({ windows: [], credit: '$-0.50' });
    for (const available of [undefined, null, '41.20', NaN, Infinity]) {
      expect(parseRadiusBilling({ ...billing, balance: { available } })).toBeNull();
    }
    expect(parseRadiusBilling({ ...billing, currency: 'EUR' })).toBeNull();
    expect(parseRadiusBilling({ ...billing, ok: false })).toBeNull();
  });

  it('reads the token-selected organization and live billing from the configured gateway', async () => {
    vi.stubEnv('PI_RADIUS_GATEWAY', 'radius.example/');
    const fetcher = vi.fn<Fetcher>().mockResolvedValueOnce(answer(200, { ok: true, organization: { id: 'org /1' } })).mockResolvedValueOnce(answer(200, billing));
    expect(await radiusUsage.fetch('radius-token', fetcher, signal)).toEqual({ windows: [], credit: '$41.20' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://radius.example/v1/context', 'https://radius.example/v1/organizations/org%20%2F1/billing']);
    for (const [, init] of fetcher.mock.calls) {
      expect(init.headers.authorization).toBe('Bearer radius-token');
      expect(init.signal).toBe(signal);
    }
  });

  it('shows no invented balance when context, permissions or billing are unavailable', async () => {
    for (const context of [answer(401, {}), answer(200, { ok: true, organization: {} }), answer(200, { ok: false, organization: { id: 'org' } })]) {
      const fetcher = vi.fn<Fetcher>().mockResolvedValue(context);
      expect(await radiusUsage.fetch('radius-token', fetcher, signal)).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const refused = vi.fn<Fetcher>().mockResolvedValueOnce(answer(200, { ok: true, organization: { id: 'org' } })).mockResolvedValueOnce(answer(403, {}));
    expect(await radiusUsage.fetch('radius-token', refused, signal)).toBeNull();
  });
});

describe('Anthropic subscription usage', () => {
  it('turns the 5 h and week windows into percentages with their reset times, leaving out windows that are null or unused', () => {
    expect(parseAnthropicUsage(ANTHROPIC_BODY)).toEqual({
      windows: [
        { name: '5 h', used: 38, resets: '2026-10-17T14:30:00.000000+00:00' },
        { name: 'week', used: 12, resets: '2026-10-22T09:00:00.000000+00:00' },
        { name: 'Sonnet week', used: 4, resets: '2026-10-22T09:00:00.000000+00:00' },
      ],
    });
    expect(parseAnthropicUsage({ ...ANTHROPIC_BODY, seven_day_sonnet: { utilization: 0, resets_at: null } })?.windows.map((w) => w.name)).toEqual(['5 h', 'week']);
  });

  it('clamps to 0..100 and answers null for a body it does not recognise', () => {
    expect(parseAnthropicUsage({ five_hour: { utilization: 140, resets_at: null } })).toEqual({ windows: [{ name: '5 h', used: 100 }] });
    expect(parseAnthropicUsage({ error: { type: 'authentication_error' } })).toBeNull();
    expect(parseAnthropicUsage('nope')).toBeNull();
    expect(parseAnthropicUsage(null)).toBeNull();
  });

  it('asks the OAuth usage endpoint with the bearer token and the OAuth beta header, and answers null when it refuses', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const ok: Fetcher = (url, init) => {
      calls.push({ url, headers: init.headers });
      return Promise.resolve(answer(200, ANTHROPIC_BODY));
    };
    expect((await anthropicUsage.fetch('tok-123', ok, signal))?.windows).toHaveLength(3);
    expect(calls[0].url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(calls[0].headers).toMatchObject({ authorization: 'Bearer tok-123', 'anthropic-beta': 'oauth-2025-04-20' });
    expect(await anthropicUsage.fetch('tok-123', () => Promise.resolve(answer(429, { error: 'rate_limit_error' })), signal)).toBeNull();
  });
});

describe('OpenRouter credit', () => {
  it('reads the account credit from /credits and the key limit from /key', () => {
    expect(parseOpenRouterCredits(OPENROUTER_CREDITS)).toEqual({ windows: [], credit: '$41.20' });
    expect(parseOpenRouterKey(OPENROUTER_KEY)).toEqual({ windows: [], credit: '$41.20' });
    expect(parseOpenRouterKey({ data: { limit: null, limit_remaining: null, usage: 3 } })).toBeNull();
    expect(parseOpenRouterCredits({ data: {} })).toBeNull();
    expect(parseOpenRouterCredits({ data: { total_credits: 1, total_usage: 3 } })).toEqual({ windows: [], credit: '$0.00' });
  });

  it('falls back to the key limit when the key is not a management key (403 from /credits)', async () => {
    const urls: string[] = [];
    const fetcher: Fetcher = (url) => {
      urls.push(url);
      return Promise.resolve(url.endsWith('/credits') ? answer(403, { error: { code: 403, message: 'management key required' } }) : answer(200, OPENROUTER_KEY));
    };
    expect(await openrouterUsage.fetch('sk-or-x', fetcher, signal)).toEqual({ windows: [], credit: '$41.20' });
    expect(urls).toEqual(['https://openrouter.ai/api/v1/credits', 'https://openrouter.ai/api/v1/key']);
  });

  it('prefers the account credit when /credits answers', async () => {
    const fetcher: Fetcher = () => Promise.resolve(answer(200, OPENROUTER_CREDITS));
    expect(await openrouterUsage.fetch('sk-or-x', fetcher, signal)).toEqual({ windows: [], credit: '$41.20' });
  });
});

describe('ChatGPT subscription usage', () => {
  const jwt = (claim: unknown) => `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': claim })).toString('base64url')}.signature`;
  const body = { rate_limit: {
    primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1800000000 },
    secondary_window: { used_percent: 62, limit_window_seconds: 604800, reset_at: null },
  } };

  it('reads real percentages and epoch-second resets, including unused windows', () => {
    expect(parseOpenAICodexUsage(body)).toEqual({ windows: [
      { name: '5 h', used: 0, resets: new Date(1800000000000).toISOString() },
      { name: 'week', used: 62 },
    ] });
    expect(parseOpenAICodexUsage({ rate_limit: { primary_window: body.rate_limit.secondary_window } })).toEqual({ windows: [{ name: 'week', used: 62 }] });
  });

  it('keeps valid partial windows and ignores malformed fields without inventing quotas', () => {
    for (const invalid of [null, [], 'bad', {}, { used_percent: '12', limit_window_seconds: 18000 }, { used_percent: NaN, limit_window_seconds: 18000 }, { used_percent: 10 }, { used_percent: 10, limit_window_seconds: -1 }]) {
      expect(parseOpenAICodexUsage({ rate_limit: { primary_window: invalid } })).toBeNull();
      expect(parseOpenAICodexUsage({ rate_limit: { primary_window: invalid, secondary_window: body.rate_limit.secondary_window } })).toEqual({ windows: [{ name: 'week', used: 62 }] });
    }
    for (const value of [undefined, null, [], 'bad', {}, { rate_limit: null }, { credits: { balance: '100' } }]) expect(parseOpenAICodexUsage(value)).toBeNull();
    expect(parseOpenAICodexUsage({ rate_limit: { primary_window: { used_percent: 120, limit_window_seconds: 3600, reset_at: Infinity } } })).toEqual({ windows: [{ name: '1 h', used: 100 }] });
  });

  it('uses the refreshed raw JWT account claim and forwards cancellation to the overridable endpoint', async () => {
    vi.stubEnv('PI_KIT_USAGE_OPENAI_CODEX_URL', 'http://localhost/usage');
    const token = jwt({ chatgpt_account_id: 'account-example' });
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(answer(200, body));
    expect(await openaiCodexUsage.fetch(token, fetcher, signal)).not.toBeNull();
    expect(fetcher).toHaveBeenCalledWith('http://localhost/usage', { headers: {
      authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': 'account-example', accept: 'application/json', 'user-agent': 'pi-kit',
    }, signal });
  });

  it('does not ask a default account for unknown tokens or read refused responses', async () => {
    const fetcher = vi.fn<Fetcher>();
    for (const token of ['not-a-jwt', 'a.!.c', jwt({}), jwt(null), jwt({ chatgpt_account_id: 'bad\r\nheader' })]) expect(await openaiCodexUsage.fetch(token, fetcher, signal)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    for (const status of [401, 403, 429, 500]) {
      fetcher.mockResolvedValueOnce(answer(status, body));
      expect(await openaiCodexUsage.fetch(jwt({ chatgpt_account_id: 'example' }), fetcher, signal)).toBeNull();
    }
  });
});
