import { isSkillName, type SkillSearchResponse, type SkillSearchResult } from '@pi-kit/protocol';

import { DEFAULT_SKILLS_CONFIG, type SkillsConfig } from '../app/config';
const MAX_RESPONSE_BYTES = 256_000;
const SOURCE = /^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i;

/** Normalize only GitHub results the skill-only installer supports; never trust remote links. */
export function parseSkillSearch(value: unknown): SkillSearchResult[] {
  if (!value || typeof value !== 'object' || !('skills' in value) || !Array.isArray(value.skills))
    throw new Error('The skill catalog returned an invalid response.');
  return value.skills.slice(0, 100).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const { source, name, installs } = row;
    if (typeof source !== 'string' || !SOURCE.test(source) || typeof name !== 'string' || !isSkillName(name)) return [];
    const id = `${source}/${name}`;
    return [
      {
        id,
        name,
        source,
        installs: typeof installs === 'number' && Number.isSafeInteger(installs) && installs >= 0 ? installs : 0,
        url: `https://skills.sh/${id}`,
      },
    ];
  });
}

export class SkillCatalog {
  private readonly cache = new Map<string, { at: number; results: SkillSearchResult[] }>();
  private readonly config: SkillsConfig;

  constructor(
    config: Partial<SkillsConfig> = {},
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.config = { ...DEFAULT_SKILLS_CONFIG, ...config };
  }

  async search(query: string): Promise<SkillSearchResponse> {
    if (this.config.offline) return { results: [], error: 'Skill search is unavailable in offline mode.' };
    const q = query.trim();
    if (q.length < 2 || q.length > 200) return { results: [], error: 'Enter between 2 and 200 characters.' };
    const base = this.config.catalogUrl.replace(/\/+$/, '');
    const key = `${base}:${q.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.config.searchCacheMs) return { results: hit.results };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.searchTimeoutMs);
    try {
      const response = await this.fetcher(`${base}/api/search?${new URLSearchParams({ q, limit: '20' })}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
        redirect: 'error',
      });
      if (response.status === 429) throw new Error('The skill catalog is rate limited. Please try again later.');
      if (!response.ok) throw new Error(`The skill catalog answered ${response.status}.`);
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES)
        throw new Error('The skill catalog response is too large.');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('The skill catalog returned an empty response.');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new Error('The skill catalog response is too large.');
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const results = parseSkillSearch(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (this.cache.size >= this.config.searchCacheEntries)
        this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, { at: this.now(), results });
      return { results };
    } catch (error) {
      return {
        results: [],
        error: controller.signal.aborted
          ? 'The skill catalog did not answer in time.'
          : error instanceof Error && error.message.startsWith('The skill catalog')
            ? error.message
            : 'Could not reach the skill catalog. Please try again later.',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
