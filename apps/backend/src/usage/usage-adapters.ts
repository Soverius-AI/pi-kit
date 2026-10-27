import type { ProviderUsage } from '@pi-kit/protocol';

/**
 * The usage sources, one small adapter each. An adapter turns one provider's answer into `ProviderUsage`; it never logs, and it never sees more of the credential than the
 * token it is handed. Everything that is not a source (no endpoint, a refused token, an answer of another shape) is `null`: the picker shows nothing for that provider.
 */
export type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface UsageAdapter {
  /** Provider ids it serves. */
  readonly providers: readonly string[];
  /** Which sign-in the token comes from: an OAuth subscription token or an API key. */
  readonly credential: 'oauth' | 'api_key' | 'either';
  fetch(token: string, fetcher: Fetcher, signal: AbortSignal): Promise<ProviderUsage | null>;
}

/**
 * The endpoints, each overridable by an environment variable so that the end-to-end tests ask a fake server instead of the provider (the tests never touch a real account). Nothing else sets them.
 */
const ANTHROPIC_URL = (): string => process.env['PI_KIT_USAGE_ANTHROPIC_URL'] || 'https://api.anthropic.com/api/oauth/usage';
const OPENAI_CODEX_URL = (): string => process.env['PI_KIT_USAGE_OPENAI_CODEX_URL'] || 'https://chatgpt.com/backend-api/wham/usage';
const OPENROUTER_BASE = (): string => process.env['PI_KIT_USAGE_OPENROUTER_BASE'] || 'https://openrouter.ai/api/v1';
const RADIUS_GATEWAY = (): string => {
  const gateway = process.env['PI_RADIUS_GATEWAY'] || 'https://radius.pi.dev';
  return /^https?:\/\//iu.test(gateway) ? gateway : `https://${gateway}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const percent = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined);
const usd = (value: number): string => `$${(Math.round(value * 100) / 100).toFixed(2)}`;

/** The windows of the answer of `GET https://api.anthropic.com/api/oauth/usage`, in the order a person reads them. */
const ANTHROPIC_WINDOWS: ReadonlyArray<readonly [key: string, name: string]> = [
  ['five_hour', '5 h'],
  ['seven_day', 'week'],
  ['seven_day_opus', 'Opus week'],
  ['seven_day_sonnet', 'Sonnet week'],
];

/**
 * Anthropic subscriptions (Claude Pro and Max): the endpoint Claude Code's `/usage` reads, with the OAuth token pi stores. Not a documented API, so the parser takes only what it
 * recognises: a window is `{ utilization: 0..100, resets_at: ISO time | null }`, and a window that is `null` (a plan without an Opus limit) is left out.
 */
export const anthropicUsage: UsageAdapter = {
  providers: ['anthropic'],
  credential: 'oauth',
  async fetch(token, fetcher, signal) {
    const response = await fetcher(ANTHROPIC_URL(), {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json', 'user-agent': 'pi-kit' },
      signal,
    });
    if (!response.ok) return null;
    return parseAnthropicUsage(await response.json());
  },
};

export function parseAnthropicUsage(body: unknown): ProviderUsage | null {
  if (!isRecord(body)) return null;
  const windows: ProviderUsage['windows'] = [];
  for (const [key, name] of ANTHROPIC_WINDOWS) {
    const window = body[key];
    if (!isRecord(window)) continue;
    const used = percent(window['utilization']);
    if (used === undefined) continue;
    // The per-model windows only matter once they are used; an unused Opus window is noise next to "5 h" and "week".
    if (key !== 'five_hour' && key !== 'seven_day' && used === 0) continue;
    const resets = typeof window['resets_at'] === 'string' ? window['resets_at'] : undefined;
    windows.push({ name, used, ...(resets ? { resets } : {}) });
  }
  return windows.length > 0 ? { windows } : null;
}

/**
 * OpenRouter: the credit left. `GET /api/v1/credits` answers the account's total (it needs a management key and says 403 to an ordinary one); `GET /api/v1/key` answers what the key
 * itself may still spend (`limit_remaining`, `null` for a key without a limit). The first that gives a number wins.
 */
export const openrouterUsage: UsageAdapter = {
  providers: ['openrouter'],
  credential: 'api_key',
  async fetch(token, fetcher, signal) {
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'pi-kit' };
    const credits = await fetcher(`${OPENROUTER_BASE()}/credits`, { headers, signal });
    if (credits.ok) {
      const left = parseOpenRouterCredits(await credits.json());
      if (left) return left;
    }
    const key = await fetcher(`${OPENROUTER_BASE()}/key`, { headers, signal });
    return key.ok ? parseOpenRouterKey(await key.json()) : null;
  },
};

export function parseOpenRouterCredits(body: unknown): ProviderUsage | null {
  const data = isRecord(body) ? body['data'] : undefined;
  if (!isRecord(data)) return null;
  const total = data['total_credits'];
  const used = data['total_usage'];
  if (typeof total !== 'number' || typeof used !== 'number') return null;
  return { windows: [], credit: usd(Math.max(0, total - used)) };
}

export function parseOpenRouterKey(body: unknown): ProviderUsage | null {
  const data = isRecord(body) ? body['data'] : undefined;
  if (!isRecord(data)) return null;
  const left = data['limit_remaining'];
  return typeof left === 'number' ? { windows: [], credit: usd(Math.max(0, left)) } : null;
}

/** Radius's live accounting API: the token selects the organization; available credit already excludes reservations. */
export const radiusUsage: UsageAdapter = {
  providers: ['radius'],
  credential: 'either',
  async fetch(token, fetcher, signal) {
    const gateway = RADIUS_GATEWAY();
    const init = { headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'pi-kit' }, signal };
    const context = await fetcher(new URL('/v1/context', gateway).href, init);
    if (!context.ok) return null;
    const body = await context.json();
    const organization = isRecord(body) && body['ok'] === true ? body['organization'] : undefined;
    const id = isRecord(organization) ? organization['id'] : undefined;
    if (typeof id !== 'string' || !id) return null;
    const billing = await fetcher(new URL(`/v1/organizations/${encodeURIComponent(id)}/billing`, gateway).href, init);
    return billing.ok ? parseRadiusBilling(await billing.json()) : null;
  },
};

/** Amounts in Radius's billing response are USD, not cents; use the spendable amount, not the balance before reservations. */
export function parseRadiusBilling(body: unknown): ProviderUsage | null {
  if (!isRecord(body) || body['ok'] !== true || body['currency'] !== 'USD') return null;
  const balance = body['balance'];
  const available = isRecord(balance) ? balance['available'] : undefined;
  return typeof available === 'number' && Number.isFinite(available) ? { windows: [], credit: usd(available) } : null;
}

/**
 * ChatGPT subscription usage, not Platform API billing. Both current `openai` OAuth and legacy `openai-codex`
 * resolve to a raw access JWT in pi 1.x; pi derives the account id from this same claim for inference.
 * Decode only for routing (not authentication); the server validates the bearer token. Refuse an unknown
 * credential shape rather than silently requesting the default account. API keys never reach this adapter.
 * WHAM is an internal, undocumented endpoint and may stop working:
 * https://github.com/inouemoby/pi-codex-usage (fetchUsage).
 */
export const openaiCodexUsage: UsageAdapter = {
  providers: ['openai', 'openai-codex'],
  credential: 'oauth',
  async fetch(token, fetcher, signal) {
    const accountId = codexAccountId(token);
    if (!accountId) return null;
    const response = await fetcher(OPENAI_CODEX_URL(), {
      headers: { authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': accountId, accept: 'application/json', 'user-agent': 'pi-kit' },
      signal,
    });
    return response.ok ? parseOpenAICodexUsage(await response.json()) : null;
  },
};

function codexAccountId(token: string): string | undefined {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return undefined;
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const auth = isRecord(payload) ? payload['https://api.openai.com/auth'] : undefined;
    const id = isRecord(auth) ? auth['chatgpt_account_id'] : undefined;
    return typeof id === 'string' && /^[!-~]+$/u.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Window position varies by plan: label by duration, never assume primary means five hours. */
export function parseOpenAICodexUsage(body: unknown): ProviderUsage | null {
  const limits = isRecord(body) ? body['rate_limit'] : undefined;
  if (!isRecord(limits)) return null;
  const windows: ProviderUsage['windows'] = [];
  for (const key of ['primary_window', 'secondary_window']) {
    const window = limits[key];
    if (!isRecord(window)) continue;
    const used = percent(window['used_percent']);
    const seconds = window['limit_window_seconds'];
    if (used === undefined || typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) continue;
    const name = seconds === 604800 ? 'week' : seconds % 3600 === 0 ? `${seconds / 3600} h` : seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
    const reset = window['reset_at'];
    const resetMs = typeof reset === 'number' && Number.isFinite(reset) && reset > 0 ? reset * 1000 : NaN;
    const resets = Number.isFinite(resetMs) && resetMs <= 8.64e15 ? new Date(resetMs).toISOString() : undefined;
    windows.push({ name, used, ...(resets ? { resets } : {}) });
  }
  return windows.length ? { windows } : null;
}

export const USAGE_ADAPTERS: readonly UsageAdapter[] = [anthropicUsage, openrouterUsage, radiusUsage, openaiCodexUsage];
