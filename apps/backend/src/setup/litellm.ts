import type { LiteLlmModel } from '@pi-kit/protocol';
import { normalizeBaseUrl } from './detect';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const cost = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value * 1_000_000 : undefined;

export function liteLlmBaseUrl(input: string): string {
  const baseUrl = normalizeBaseUrl(input);
  const url = new URL(baseUrl);
  if (url.username || url.password) throw new Error('Use the API key field instead of credentials in the proxy URL.');
  return baseUrl;
}

/** Only key-visible aliases enter the catalog; management metadata is optional and never returned wholesale. */
export async function discoverLiteLlm(baseUrl: string, apiKey?: string, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<{ baseUrl: string; models: LiteLlmModel[] }> {
  const base = liteLlmBaseUrl(baseUrl);
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const ask = async (url: string): Promise<unknown> => {
    const res = await fetchFn(url, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000), redirect: 'error' });
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'LiteLLM refused this API key. Check its permissions.' : `LiteLLM returned HTTP ${res.status}.`);
    return res.json();
  };
  let body: RecordValue;
  try { body = record(await ask(`${base}/models`)); }
  catch (error) {
    // Never include response bodies or transport error text: either can contain credentials.
    if (error instanceof Error && /^LiteLLM /.test(error.message)) throw error;
    // eslint-disable-next-line preserve-caught-error -- Transport errors may contain credentials.
    throw new Error('Could not reach LiteLLM. Check the proxy URL and connection.');
  }
  if (!Array.isArray(body['data'])) throw new Error('LiteLLM did not return a valid model list.');
  let info: RecordValue[] = [];
  try {
    const metadata = record(await ask(`${base.replace(/\/v1$/, '')}/model/info`));
    if (Array.isArray(metadata['data'])) info = metadata['data'].map(record);
  } catch { /* Virtual keys may only have access to /models. */ }
  const seen = new Set<string>();
  const models: LiteLlmModel[] = [];
  for (const value of body['data']) {
    const entry = record(value);
    const id = entry['id'];
    if (typeof id !== 'string' || !id.trim() || seen.has(id)) continue;
    seen.add(id);
    const extra = info.find((m) => m['model_name'] === id);
    const details = { ...record(extra?.['model_info']), ...record(entry['model_info']), ...entry };
    const mode = details['mode'];
    if (typeof mode === 'string' && !['chat', 'completion', 'responses'].includes(mode)) continue;
    models.push({
      id, name: typeof details['display_name'] === 'string' ? details['display_name'] : id,
      contextWindow: positive(details['max_input_tokens']) ?? positive(details['max_tokens']),
      maxTokens: positive(details['max_output_tokens']),
      reasoning: typeof details['supports_reasoning'] === 'boolean' ? details['supports_reasoning'] : undefined,
      vision: typeof details['supports_vision'] === 'boolean' ? details['supports_vision'] : undefined,
      costInput: cost(details['input_cost_per_token']), costOutput: cost(details['output_cost_per_token']),
    });
  }
  return { baseUrl: base, models };
}

export function liteLlmModelDetails(models: LiteLlmModel[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(models.map((m) => [m.id, {
    name: m.name,
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
    ...(m.vision !== undefined ? { input: m.vision ? ['text', 'image'] : ['text'] } : {}),
    ...(m.costInput !== undefined || m.costOutput !== undefined ? { cost: { input: m.costInput ?? 0, output: m.costOutput ?? 0, cacheRead: 0, cacheWrite: 0 } } : {}),
  }]));
}
