import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CHATGPT_MODELS_URL = 'https://api.openai.com/v1/models';
const CACHE_MS = 30_000;
const STALE_MS = 5 * 60_000;
const entrySchema = z.object({
  slug: z.string().min(1),
  display_name: z.string().min(1),
  visibility: z.string(),
  context_window: z.number().int().positive().optional(),
  input_modalities: z.array(z.string()).optional(),
  supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional(),
});
const catalogSchema = z.object({ models: z.array(entrySchema) });
export type ChatGptModel = z.infer<typeof entrySchema>;
type Entry = { models?: ChatGptModel[]; fetchedAt: number; pending?: Promise<ChatGptModel[]> };
// No credentials or account identifiers are persisted. Different tokens never share cached choices.
const cache = new Map<string, Entry>();

/** Account-specific catalog documented at developers.openai.com/siwc/token-sharing-open-source/models-and-inference. */
export async function chatGptModels(token: string, signal: AbortSignal): Promise<ChatGptModel[]> {
  signal.throwIfAborted();
  const key = createHash('sha256').update(token).digest('hex');
  const previous = cache.get(key);
  if (previous?.models && Date.now() - previous.fetchedAt < CACHE_MS) return previous.models;
  // Waiters honor their own cancellation without cancelling a shared request.
  const entry = previous ?? { fetchedAt: 0 };
  if (!entry.pending) {
    if (cache.size >= 32 && !cache.has(key)) cache.delete(cache.keys().next().value ?? '');
    cache.set(key, entry);
    entry.pending = (async () => {
      let transient = true;
      try {
        const response = await fetch(CHATGPT_MODELS_URL, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        transient = response.status >= 500 || response.status === 429;
        if (!response.ok) throw new Error(`ChatGPT model catalog returned HTTP ${response.status}.`);
        transient = false;
        const parsed = catalogSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error('ChatGPT model catalog returned an invalid response.');
        entry.models = parsed.data.models.filter((m) => m.visibility === 'list');
        entry.fetchedAt = Date.now();
        return entry.models;
      } catch (error) {
        if (transient && entry.models && Date.now() - entry.fetchedAt < STALE_MS) return entry.models;
        cache.delete(key);
        // Never include upstream response bodies, headers, tokens, or arbitrary fetch errors.
        // eslint-disable-next-line preserve-caught-error -- An upstream error cause may contain credential-bearing request details.
        throw new Error(
          error instanceof Error && error.message.startsWith('ChatGPT model catalog')
            ? error.message
            : 'Could not fetch the ChatGPT model catalog.',
        );
      } finally {
        entry.pending = undefined;
      }
    })();
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void entry.pending?.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
