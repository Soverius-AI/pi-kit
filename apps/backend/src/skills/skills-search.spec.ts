import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SKILLS_CONFIG, loadConfig } from '../app/config';
import { parseSkillSearch, SkillCatalog } from './skills-search';

const entry = {
  id: 'untrusted-id',
  source: 'angular/skills',
  name: 'angular-developer',
  installs: 42,
  url: 'https://evil.example',
};
const reply = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('skill catalog', () => {
  it('resolves catalog and offline environment settings through backend config', () => {
    const env = { PI_KIT_TOKEN: 'test-token-at-least-16', PI_KIT_PORT: '1234' };
    expect(loadConfig(env).skills).toEqual(DEFAULT_SKILLS_CONFIG);
    expect(
      loadConfig({ ...env, PI_OFFLINE: '1', PI_KIT_SKILLS_API_URL: 'http://localhost:8765' }).skills,
    ).toMatchObject({ offline: true, catalogUrl: 'http://localhost:8765' });
  });

  it('uses configured search timeout and cache policy', async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ skills: [] }));
    const catalog = new SkillCatalog({ searchCacheMs: 10, searchCacheEntries: 1 }, fetcher, () => now);
    await catalog.search('first');
    await catalog.search('first');
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 11;
    await catalog.search('first');
    await catalog.search('second');
    await catalog.search('first');
    expect(fetcher).toHaveBeenCalledTimes(4);
    const aborting = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    expect(await new SkillCatalog({ searchTimeoutMs: 1 }, aborting).search('timeout')).toMatchObject({
      error: expect.stringContaining('in time'),
    });
  });
  it('normalizes supported GitHub results and does not trust returned URLs', () => {
    expect(
      parseSkillSearch({
        skills: [entry, { ...entry, source: 'https://evil.example' }, { ...entry, name: '../escape' }, null],
      }),
    ).toEqual([
      {
        id: 'angular/skills/angular-developer',
        source: entry.source,
        name: entry.name,
        installs: 42,
        url: 'https://skills.sh/angular/skills/angular-developer',
      },
    ]);
    expect(() => parseSkillSearch({ results: [] })).toThrow(/invalid response/);
  });

  it('uses an override, encodes queries, caches briefly, and expires entries', async () => {
    let now = 1;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ skills: [entry] }));
    const catalog = new SkillCatalog({ catalogUrl: 'http://localhost:8765/' }, fetcher, () => now);
    expect((await catalog.search('Angular & forms')).results).toHaveLength(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://localhost:8765/api/search?q=Angular+%26+forms&limit=20');
    await catalog.search('angular & forms');
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 60_001;
    await catalog.search('angular & forms');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('distinguishes no results from network, malformed, rate-limit, and offline failures', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const catalog = new SkillCatalog({}, fetcher);
    fetcher.mockResolvedValueOnce(reply({ skills: [] }));
    expect(await catalog.search('empty')).toEqual({ results: [] });
    fetcher.mockRejectedValueOnce(new Error('private transport detail'));
    expect(await catalog.search('network')).toMatchObject({
      results: [],
      error: expect.stringContaining('Could not reach'),
    });
    fetcher.mockResolvedValueOnce(reply({ skills: [] }, 429));
    expect(await catalog.search('limited')).toMatchObject({ error: expect.stringContaining('rate limited') });
    fetcher.mockResolvedValueOnce(reply({ nope: [] }));
    expect(await catalog.search('malformed')).toMatchObject({ error: expect.stringContaining('invalid response') });
    fetcher.mockClear();
    expect(await new SkillCatalog({ offline: true }, fetcher).search('angular')).toMatchObject({
      error: expect.stringContaining('offline'),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds responses, cache entries, and query length', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply({ skills: [] }));
    const catalog = new SkillCatalog({}, fetcher);
    await catalog.search('a');
    expect(fetcher).not.toHaveBeenCalled();
    for (let i = 0; i < 101; i++) await catalog.search(`query-${i}`);
    await catalog.search('query-0');
    expect(fetcher).toHaveBeenCalledTimes(102);
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(256_001)));
    expect(await catalog.search('huge')).toMatchObject({ error: expect.stringContaining('too large') });
  });
});
