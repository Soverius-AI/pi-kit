// The scratch world of the model picker: a machine signed in to an Anthropic subscription (an OAuth credential), OpenRouter (an API key) and a Google key from the
// environment, besides Radius and the local llama-swap every e2e world has, and a fake server for Anthropic usage, OpenRouter credits and Radius billing. The tokens are made up and go nowhere
// else: `PI_KIT_USAGE_ANTHROPIC_URL`, `PI_KIT_USAGE_OPENROUTER_BASE` and `PI_RADIUS_GATEWAY` point at that server; pi's own sign-in is never called. Used by e2e/a-picker.e2e.mjs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const FAR = 4_102_444_800_000; // 2100: an OAuth token that never needs refreshing
export const FAKE_TOKEN = 'at-picker-made-up-token';
export const FAKE_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef7e57';
export const FAKE_RADIUS_TOKEN = 'at-radius-picker-made-up-token';
const RADIUS_MODEL = { id: 'balanced', name: 'Balanced', reasoning: true, input: ['text'], contextWindow: 200_000, maxTokens: 8192, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
// Model metadata stays cloud-shaped so the picker does not mistake the fake billing gateway for a local inference server.
const RADIUS_MODEL_BASE = 'https://radius.example/v1';

/**
 * Fake provider endpoints. `requests` records what the backend asked (path and the headers that matter, never compared with a real token); the answers can change between requests.
 */
export async function startUsageServer() {
  const requests = [];
  const answer = {
    anthropic: {
      five_hour: { utilization: 38.0, resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() },
      seven_day: { utilization: 12.0, resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString() },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 0, resets_at: null },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    },
    openrouter: { data: { total_credits: 100.5, total_usage: 59.3 } },
    radius: { ok: true, currency: 'USD', balance: { credit_balance: 50, reserved: 8.8, available: 41.2 } },
  };
  const server = createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization, beta: req.headers['anthropic-beta'] });
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/anthropic/api/oauth/usage') return send(200, answer.anthropic);
    if (req.url === '/openrouter/credits') return send(200, answer.openrouter);
    if (req.url === '/v1/config') return send(200, { baseUrl: RADIUS_MODEL_BASE, models: [RADIUS_MODEL] });
    if (req.url === '/v1/context') return send(200, { ok: true, organization: { id: 'picker-org' } });
    if (req.url === '/v1/organizations/picker-org/billing') return send(200, answer.radius);
    return send(404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    answer,
    urls: { anthropic: `${base}/anthropic/api/oauth/usage`, openrouter: `${base}/openrouter`, radius: base },
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The `createWorld` options of the picker's machine (see above). */
export function pickerWorld(urls) {
  return {
    trusted: true,
    offline: true,
    setup: ({ agent }) => {
      mkdirSync(agent, { recursive: true });
      const auth = {
        anthropic: { type: 'oauth', access: FAKE_TOKEN, refresh: 'rt-picker-made-up', expires: FAR },
        openrouter: { type: 'api_key', key: FAKE_KEY },
        radius: { type: 'oauth', access: FAKE_RADIUS_TOKEN, refresh: 'rt-radius-made-up', expires: FAR, gatewayConfig: { baseUrl: RADIUS_MODEL_BASE, models: [RADIUS_MODEL] } },
      };
      writeFileSync(join(agent, 'auth.json'), JSON.stringify(auth, null, 2), { mode: 0o600 });
    },
    extraEnv: () => ({ PI_KIT_USAGE_ANTHROPIC_URL: urls.anthropic, PI_KIT_USAGE_OPENROUTER_BASE: urls.openrouter, PI_RADIUS_GATEWAY: urls.radius, GEMINI_API_KEY: 'env-demo-key-0000' }),
  };
}
