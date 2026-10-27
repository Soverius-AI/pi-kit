import { type PackageDetail, type PackageKind, type PackageSearchKind, type PackageSearchResult, PACKAGE_KINDS } from '@pi-kit/protocol';

/**
 * The npm registry as the "Add a package" wizard uses it: a search for the `pi-package` keyword (docs/packages.md: the keyword that makes a package eligible for
 * pi's gallery), and the package's own document for the second step (its README and the `pi` key that lists what it adds). Pure parsers over JSON, a cache, and a fetch that gives up after
 * eight seconds; `PI_KIT_NPM_REGISTRY` points it at another registry (the end-to-end tests run a fake one and never the network).
 */

export const REGISTRY_TIMEOUT_MS = 8_000;
export const SEARCH_CACHE_MS = 5 * 60_000;
export const SEARCH_SIZE = 20;
/** The README is shown as plain text in a small box; more than this is never useful there. */
export const README_LIMIT = 40_000;

export const registryOf = (env: NodeJS.ProcessEnv = process.env): string => (env['PI_KIT_NPM_REGISTRY'] || 'https://registry.npmjs.org').replace(/\/+$/, '');

/** The URL of the search: the `pi-package` keyword and whatever the person typed. */
export function searchUrl(query: string, registry: string): string {
  const text = `keywords:pi-package${query.trim() ? ` ${query.trim()}` : ''}`;
  return `${registry}/-/v1/search?text=${encodeURIComponent(text)}&size=${SEARCH_SIZE}`;
}

/** The URL of a package's document: a scoped name keeps its scope with the slash encoded (`@a/b` -> `@a%2Fb`). */
export const packumentUrl = (name: string, registry: string): string => `${registry}/${name.startsWith('@') ? name.replace('/', '%2F') : encodeURIComponent(name)}`;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** What a `pi` key says a package adds: a count per kind (a string or a list of paths each count once; a missing kind is zero). */
export function bringsOfManifest(pi: unknown): Record<PackageKind, number> | undefined {
  if (!isObject(pi)) return undefined;
  const count = (value: unknown): number => (Array.isArray(value) ? value.filter((v) => typeof v === 'string' && !v.startsWith('!')).length : typeof value === 'string' ? 1 : 0);
  return { extensions: count(pi['extensions']), skills: count(pi['skills']), prompts: count(pi['prompts']), themes: count(pi['themes']) };
}

/** A guess from the keywords a package is published with, for a result whose registry entry has no `pi` key. */
export function kindsFromKeywords(keywords: readonly string[]): PackageKind[] {
  const words = keywords.map((k) => k.toLowerCase());
  const found = new Set<PackageKind>();
  for (const w of words) {
    if (/extension/.test(w)) found.add('extensions');
    if (/skill/.test(w)) found.add('skills');
    if (/prompt/.test(w)) found.add('prompts');
    if (/theme/.test(w)) found.add('themes');
  }
  return PACKAGE_KINDS.filter((k) => found.has(k));
}

function authorOf(pkg: Json): string | undefined {
  const author = pkg['author'];
  if (isObject(author)) return text(author['name']) ?? text(author['username']);
  const publisher = pkg['publisher'];
  return text(author) ?? (isObject(publisher) ? text(publisher['username']) : undefined);
}

function repositoryOf(value: unknown): string | undefined {
  const raw = isObject(value) ? text(value['url']) : text(value);
  return raw?.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://');
}

/** One `objects[]` entry of the registry's search answer. Returns undefined for one without a name and a version. */
export function parseSearchObject(object: unknown): PackageSearchResult | undefined {
  if (!isObject(object) || !isObject(object['package'])) return undefined;
  const pkg = object['package'];
  const name = text(pkg['name']);
  const version = text(pkg['version']);
  if (!name || !version) return undefined;
  const links = isObject(pkg['links']) ? pkg['links'] : {};
  const downloads = isObject(object['downloads']) ? num(object['downloads']['monthly']) : num(object['downloads']);
  const brings = bringsOfManifest(pkg['pi']);
  const keywords = Array.isArray(pkg['keywords']) ? pkg['keywords'].filter((k): k is string => typeof k === 'string') : [];
  const contains = brings ? PACKAGE_KINDS.filter((k) => brings[k] > 0) : kindsFromKeywords(keywords);
  const description = text(pkg['description']);
  const updated = text(pkg['date']) ?? text(object['updated']);
  const license = text(pkg['license']);
  const repository = repositoryOf(links['repository']) ?? repositoryOf(pkg['repository']) ?? text(links['homepage']);
  const author = authorOf(pkg);
  return {
    name,
    source: `npm:${name}`,
    version,
    ...(description ? { description } : {}),
    ...(downloads !== undefined ? { downloads } : {}),
    ...(updated ? { updated } : {}),
    ...(license ? { license } : {}),
    ...(repository ? { repository } : {}),
    ...(author ? { author } : {}),
    contains,
    exact: !!brings,
    ...(brings ? { brings } : {}),
  };
}

/** The registry's search answer: the packages it lists (those it describes completely) and how many it matched in all. */
export function parseSearch(json: unknown): { results: PackageSearchResult[]; total: number } {
  if (!isObject(json) || !Array.isArray(json['objects'])) throw new Error('The registry answered, but not with a search result.');
  const results = json['objects'].map(parseSearchObject).filter((r): r is PackageSearchResult => r !== undefined);
  return { results, total: num(json['total']) ?? results.length };
}

/** The kind filter of the Browse tab: a package whose contents are known must contain the kind; one that is only guessed from keywords passes when the guess says so or says nothing. */
export function matchesKind(result: Pick<PackageSearchResult, 'contains' | 'exact'>, kind: PackageSearchKind | undefined): boolean {
  if (!kind || kind === 'all') return true;
  if (result.contains.includes(kind)) return true;
  return !result.exact && result.contains.length === 0;
}

export type Fetcher = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** A GET that gives up after the timeout and answers with what the registry said, or an error with a sentence for the person. */
export async function getJson(url: string, fetcher: Fetcher = fetch as unknown as Fetcher, timeoutMs = REGISTRY_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`The registry answered ${response.status}.`);
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The registry did not answer in time.', { cause: error });
    throw new Error(error instanceof Error && /^The registry/.test(error.message) ? error.message : `Could not reach the registry (${error instanceof Error ? error.message : String(error)}).`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** Search results are asked for once in five minutes per query. */
export class SearchCache {
  private readonly entries = new Map<string, { at: number; value: { results: PackageSearchResult[]; total: number } }>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(query: string, load: () => Promise<{ results: PackageSearchResult[]; total: number }>): Promise<{ results: PackageSearchResult[]; total: number }> {
    const key = query.trim().toLowerCase();
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < SEARCH_CACHE_MS) return hit.value;
    const value = await load();
    this.entries.set(key, { at: this.now(), value });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** A package document's latest version: its manifest, README and publish time, as the wizard's detail shows them. */
export function parsePackument(json: unknown, wanted?: string): Pick<PackageDetail, 'name' | 'version' | 'description' | 'author' | 'license' | 'repository' | 'readme' | 'updated'> & { brings?: Record<PackageKind, number> } {
  if (!isObject(json)) throw new Error('The registry answered, but not with a package.');
  const name = text(json['name']);
  if (!name) throw new Error('The registry answered, but not with a package.');
  const tags = isObject(json['dist-tags']) ? json['dist-tags'] : {};
  const versions = isObject(json['versions']) ? json['versions'] : {};
  const version = (wanted && wanted in versions ? wanted : undefined) ?? text(tags['latest']) ?? Object.keys(versions).at(-1);
  const manifest = version && isObject(versions[version]) ? (versions[version] as Json) : {};
  const times = isObject(json['time']) ? json['time'] : {};
  const readme = text(manifest['readme']) ?? text(json['readme']);
  const brings = bringsOfManifest(manifest['pi']);
  const description = text(manifest['description']) ?? text(json['description']);
  const license = isObject(manifest['license']) ? text(manifest['license']['type']) : (text(manifest['license']) ?? text(json['license']));
  const repository = repositoryOf(manifest['repository']) ?? repositoryOf(json['repository']);
  const author = authorOf(manifest) ?? authorOf(json);
  const updated = (version ? text(times[version]) : undefined) ?? text(times['modified']);
  return {
    name,
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
    ...(license ? { license } : {}),
    ...(repository ? { repository } : {}),
    ...(readme ? { readme: readme.slice(0, README_LIMIT) } : {}),
    ...(updated ? { updated } : {}),
    ...(brings ? { brings } : {}),
  };
}

/** The raw README of a repository on GitHub, for a git source; other hosts have no such address we can rely on. */
export function readmeUrlOfGit(source: string): string | undefined {
  const cleaned = source.trim().replace(/^git:/, '').replace(/^git\+/, '').replace(/^https?:\/\//, '').replace(/^ssh:\/\//, '').replace(/^git@/, '').replace(/^github\.com[:/]/, 'github.com/');
  const match = /^github\.com\/([^/\s]+)\/([^/@\s]+?)(?:\.git)?(?:@([^\s]+))?$/.exec(cleaned);
  if (!match) return undefined;
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3] ?? 'HEAD'}/README.md`;
}
