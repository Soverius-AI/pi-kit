import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type Fetcher,
  SEARCH_CACHE_MS,
  SearchCache,
  bringsOfManifest,
  getJson,
  kindsFromKeywords,
  matchesKind,
  packumentUrl,
  parsePackument,
  parseSearch,
  readmeUrlOfGit,
  registryOf,
  searchUrl,
} from './npm-registry';

const fixture: unknown = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'npm-search.json'), 'utf8'));

describe('the search address', () => {
  it('asks for the pi-package keyword and what was typed, twenty at a time', () => {
    expect(searchUrl('', 'https://registry.npmjs.org')).toBe('https://registry.npmjs.org/-/v1/search?text=keywords%3Api-package&size=20');
    expect(searchUrl(' subagent ', 'http://127.0.0.1:4555')).toBe('http://127.0.0.1:4555/-/v1/search?text=keywords%3Api-package%20subagent&size=20');
  });
  it('takes the registry from the environment', () => {
    expect(registryOf({})).toBe('https://registry.npmjs.org');
    expect(registryOf({ PI_KIT_NPM_REGISTRY: 'http://127.0.0.1:4555/' })).toBe('http://127.0.0.1:4555');
  });
  it('encodes a scoped name once', () => {
    expect(packumentUrl('@devops/skills-devops', 'https://r.example')).toBe('https://r.example/@devops%2Fskills-devops');
    expect(packumentUrl('pi-swarm', 'https://r.example')).toBe('https://r.example/pi-swarm');
  });
});

describe('parseSearch (a recorded answer of the registry)', () => {
  const { results, total } = parseSearch(fixture);

  it('lists the packages it can describe and counts them all', () => {
    expect(results.map((r) => r.name)).toEqual(['pi-subagents', 'pi-swarm', '@devops/skills-devops', 'pi-review-bot']);
    expect(total).toBe(6);
  });

  it('reads name, version, description, downloads, date, license and repository', () => {
    expect(results[0]).toMatchObject({
      name: 'pi-subagents',
      source: 'npm:pi-subagents',
      version: '0.5.0',
      description: 'Run pi in sub-threads with their own tools and budget.',
      downloads: 12034,
      updated: '2026-10-13T08:14:02.114Z',
      license: 'MIT',
      repository: 'https://github.com/nicolo/pi-subagents',
      author: 'nicolo',
    });
  });

  it('cleans a repository address: git+, .git and ssh become https', () => {
    expect(results[1].repository).toBe('https://github.com/someone/pi-swarm');
    expect(results[3].repository).toBe('https://github.com/team/pi-review-bot');
    expect(results[2].repository).toBe('https://devops.example/skills');
  });

  it('reads what a package contains from the pi key when the registry has it', () => {
    expect(results[0]).toMatchObject({ exact: true, contains: ['extensions', 'skills'], brings: { extensions: 2, skills: 1, prompts: 0, themes: 0 } });
    expect(results[3]).toMatchObject({ exact: true, contains: ['extensions', 'prompts'], brings: { extensions: 1, skills: 0, prompts: 1, themes: 0 } });
  });

  it('guesses from the keywords when it does not, and says it is a guess', () => {
    expect(results[1]).toMatchObject({ exact: false, contains: ['extensions'] });
    expect(results[2]).toMatchObject({ exact: false, contains: ['skills'] });
    expect(results[2].brings).toBeUndefined();
  });

  it('leaves out what the registry did not say instead of inventing it', () => {
    expect(results[3].description).toBeUndefined();
    expect(results[2].license).toBeUndefined();
    expect(results[3].downloads).toBe(2400);
  });

  it('refuses an answer that is not a search result', () => {
    expect(() => parseSearch({ error: 'nope' })).toThrow(/not with a search result/);
    expect(() => parseSearch(null)).toThrow();
  });
});

describe('the kind filter', () => {
  const { results } = parseSearch(fixture);
  it('keeps what contains the kind, and what might', () => {
    const names = (kind: Parameters<typeof matchesKind>[1]) => results.filter((r) => matchesKind(r, kind)).map((r) => r.name);
    expect(names('all')).toHaveLength(4);
    expect(names('skills')).toEqual(['pi-subagents', '@devops/skills-devops']);
    expect(names('prompts')).toEqual(['pi-review-bot']);
    expect(names('themes')).toEqual([]);
    expect(names('extensions')).toEqual(['pi-subagents', 'pi-swarm', 'pi-review-bot']);
  });
  it('reads the keywords', () => {
    expect(kindsFromKeywords(['pi-package', 'pi-extension', 'themes'])).toEqual(['extensions', 'themes']);
    expect(kindsFromKeywords(['pi-package'])).toEqual([]);
  });
  it('counts a pi key: a string once, a list by its entries, an exclusion not at all', () => {
    expect(bringsOfManifest({ extensions: './a.ts', skills: ['./s', './t'], themes: ['!./x.json'] })).toEqual({ extensions: 1, skills: 2, prompts: 0, themes: 0 });
    expect(bringsOfManifest(undefined)).toBeUndefined();
  });
});

describe('the package document', () => {
  const doc = {
    name: 'pi-subagents',
    'dist-tags': { latest: '0.5.0' },
    time: { modified: '2026-10-14T00:00:00.000Z', '0.5.0': '2026-10-13T08:14:02.114Z' },
    readme: 'README OF THE DOCUMENT',
    versions: {
      '0.4.0': { name: 'pi-subagents', version: '0.4.0', description: 'old' },
      '0.5.0': { name: 'pi-subagents', version: '0.5.0', description: 'Run pi in sub-threads.', license: 'MIT', author: { name: 'nicolo' }, repository: { type: 'git', url: 'git+https://github.com/nicolo/pi-subagents.git' }, pi: { extensions: ['./a.ts'], skills: ['./skills'] } },
    },
  };
  it('reads the latest version, its README and what it adds', () => {
    expect(parsePackument(doc)).toMatchObject({
      name: 'pi-subagents',
      version: '0.5.0',
      description: 'Run pi in sub-threads.',
      license: 'MIT',
      author: 'nicolo',
      repository: 'https://github.com/nicolo/pi-subagents',
      readme: 'README OF THE DOCUMENT',
      updated: '2026-10-13T08:14:02.114Z',
      brings: { extensions: 1, skills: 1, prompts: 0, themes: 0 },
    });
  });
  it('reads the version that was asked for', () => {
    expect(parsePackument(doc, '0.4.0')).toMatchObject({ version: '0.4.0', description: 'old' });
  });
  it('cuts a very long README', () => {
    expect(parsePackument({ ...doc, readme: 'x'.repeat(100_000) }).readme).toHaveLength(40_000);
  });
  it('refuses what is not a package', () => {
    expect(() => parsePackument({ error: 'Not found' })).toThrow();
  });
});

describe('readmeUrlOfGit', () => {
  it('knows GitHub in its usual spellings and a ref', () => {
    const raw = 'https://raw.githubusercontent.com/x/y/HEAD/README.md';
    for (const source of ['git:github.com/x/y', 'https://github.com/x/y', 'https://github.com/x/y.git', 'git@github.com:x/y.git', 'github.com/x/y']) expect(readmeUrlOfGit(source), source).toBe(raw);
    expect(readmeUrlOfGit('git:github.com/x/y@v1.2')).toBe('https://raw.githubusercontent.com/x/y/v1.2/README.md');
    expect(readmeUrlOfGit('git:gitlab.com/x/y')).toBeUndefined();
  });
});

describe('getJson', () => {
  const answer = (status: number, body: unknown): Fetcher => async () => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  it('answers with the JSON', async () => {
    expect(await getJson('http://x', answer(200, { a: 1 }))).toEqual({ a: 1 });
  });
  it('says what the registry said, or that it did not answer', async () => {
    await expect(getJson('http://x', answer(503, {}))).rejects.toThrow('The registry answered 503.');
    await expect(
      getJson('http://x', async () => {
        throw new Error('ECONNREFUSED');
      }),
    ).rejects.toThrow('Could not reach the registry (ECONNREFUSED).');
  });
  it('gives up after the timeout', async () => {
    const slow: Fetcher = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(getJson('http://x', slow, 20)).rejects.toThrow('did not answer in time');
  });
});

describe('SearchCache', () => {
  it('asks once in five minutes per query, whatever the case of the query', async () => {
    let now = 0;
    const cache = new SearchCache(() => now);
    const load = vi.fn(async () => ({ results: [], total: 0 }));
    await cache.get('Agents', load);
    await cache.get(' agents ', load);
    expect(load).toHaveBeenCalledTimes(1);
    now = SEARCH_CACHE_MS + 1;
    await cache.get('agents', load);
    expect(load).toHaveBeenCalledTimes(2);
    await cache.get('other', load);
    expect(load).toHaveBeenCalledTimes(3);
  });
  it('does not keep a failure', async () => {
    const cache = new SearchCache();
    await expect(cache.get('x', async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    const load = vi.fn(async () => ({ results: [], total: 0 }));
    await cache.get('x', load);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
