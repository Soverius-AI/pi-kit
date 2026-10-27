import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { LocalServer, LocalTestResult, SetupAuthEntry } from '@pi-kit/protocol';
import { isProviderAccount, keyStorageOf } from '@pi-kit/protocol';

/** The detection half of the first-run onboarding: pure reads of the agent folder, short probes of this machine. None of it changes anything. */

/** `auth.json` as a list of `{ provider, type, store }`; the key itself is looked at only to say where it lives and is never returned. */
export function readAuthEntries(agentDir: string): SetupAuthEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const entries: SetupAuthEntry[] = [];
  for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const credential = value as { type?: unknown; key?: unknown };
    if (credential.type === 'oauth') entries.push({ provider, type: 'oauth', store: 'auth.json' });
    else if (credential.type === 'api_key' && typeof credential.key === 'string') entries.push({ provider, type: 'api_key', store: keyStorageOf(credential.key) });
  }
  return entries.sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * The providers whose `auth.json` entry is an API key written out in full (not a command, not an environment variable) and carries nothing else that pi needs from the entry
 * (an `env` object: Cloudflare's account id): the keys "Move my existing keys into the keychain" may move.
 */
export function readMovableKeys(agentDir: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  return Object.entries(parsed as Record<string, unknown>)
    .filter(([provider, value]) => {
      const credential = value as { type?: unknown; key?: unknown; env?: unknown } | null;
      return isProviderAccount(provider) && credential?.type === 'api_key' && typeof credential.key === 'string' && keyStorageOf(credential.key) === 'auth.json' && !credential.env;
    })
    .map(([provider]) => provider)
    .sort();
}

/** The number of `.jsonl` session files below `<agent dir>/sessions` (one folder per project, two levels at most; a broken folder counts as none). */
export function countSessions(agentDir: string): number {
  const root = join(agentDir, 'sessions');
  let count = 0;
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (name.endsWith('.jsonl')) count += 1;
      else if (depth < 2) {
        try {
          if (statSync(path).isDirectory()) walk(path, depth + 1);
        } catch {
          // vanished while we looked
        }
      }
    }
  };
  walk(root, 0);
  return count;
}

export const agentDirFacts = (agentDir: string) => ({
  path: agentDir,
  exists: existsSync(agentDir),
  auth: readAuthEntries(agentDir),
  hasModelsJson: existsSync(join(agentDir, 'models.json')),
  hasSettings: existsSync(join(agentDir, 'settings.json')),
  sessionCount: countSessions(agentDir),
});

// ---- local model servers

export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The servers worth asking about without being told: llama-swap or llama.cpp's router on 8080, Ollama on 11434. `PI_KIT_LOCAL_PROBES` adds base URLs (comma separated). */
export function defaultProbes(env: NodeJS.ProcessEnv = process.env): { kind: LocalServer['kind']; name: string; baseUrl: string }[] {
  const extra = (env['PI_KIT_LOCAL_PROBES'] ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
    .map((baseUrl) => ({ kind: 'openai' as const, name: 'an OpenAI-compatible server', baseUrl }));
  return [
    { kind: 'llama-swap', name: 'llama-swap or llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
    { kind: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
    ...extra,
  ];
}

/** `http://host:port/v1` from whatever the user typed: a missing scheme gets `http://`, a trailing slash goes, and a bare host gets `/v1`. */
export function normalizeBaseUrl(input: string): string {
  let text = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  const url = new URL(text);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The address must start with http:// or https://.');
  url.hash = '';
  url.search = '';
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path === '' ? '/v1' : path;
  return url.toString().replace(/\/$/, '');
}

/**
 * Asks one base URL what it serves: the OpenAI-style `<base>/models` first, then Ollama's `/api/tags` on the same host. A server that answers neither, or
 * not within the timeout, is "not reachable" with a sentence for the reason. The request goes to the address the caller gave and nowhere else.
 */
export async function testEndpoint(baseUrl: string, fetchFn: Fetch = fetch as unknown as Fetch, timeoutMs = 3000): Promise<LocalTestResult> {
  let base: string;
  try {
    base = normalizeBaseUrl(baseUrl);
  } catch (error) {
    return { ok: false, baseUrl, models: [], error: error instanceof Error ? error.message : String(error) };
  }
  const ask = async (url: string): Promise<unknown> => {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return res.json();
  };
  try {
    const body = (await ask(`${base}/models`)) as { data?: { id?: unknown }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    const kind: LocalServer['kind'] = /:11434(\/|$)/.test(base) ? 'ollama' : /:8080(\/|$)/.test(base) ? 'llama-swap' : 'openai';
    return { ok: true, kind, baseUrl: base, models };
  } catch (first) {
    try {
      const origin = new URL(base).origin;
      const body = (await ask(`${origin}/api/tags`)) as { models?: { name?: unknown }[] };
      const models = (body.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string');
      return { ok: true, kind: 'ollama', baseUrl: base, models };
    } catch {
      const reason = first instanceof Error ? first.message : String(first);
      return { ok: false, baseUrl: base, models: [], error: /abort|timeout/i.test(reason) ? 'Nothing answered within three seconds.' : /ECONNREFUSED|fetch failed/i.test(reason) ? 'Nothing is listening there.' : reason };
    }
  }
}

/** Every default probe, at once; the ones that answer, with their models. */
export async function probeLocalServers(probes = defaultProbes(), fetchFn: Fetch = fetch as unknown as Fetch, timeoutMs = 800): Promise<LocalServer[]> {
  const keyOf = (url: string): string => {
    try {
      return normalizeBaseUrl(url);
    } catch {
      return url;
    }
  };
  const unique = probes.filter((probe, index) => probes.findIndex((p) => keyOf(p.baseUrl) === keyOf(probe.baseUrl)) === index);
  const results = await Promise.all(unique.map(async (probe) => ({ probe, result: await testEndpoint(probe.baseUrl, fetchFn, timeoutMs) })));
  return results.filter((r) => r.result.ok).map(({ probe, result }) => ({ kind: probe.kind === 'openai' ? (result.kind ?? 'openai') : probe.kind, name: probe.name, baseUrl: result.baseUrl, models: result.models }));
}

// ---- the pi command line

/** The directories of PATH that hold the app's own tools rather than the user's (`npm run` puts the repository's `node_modules/.bin` first). */
const own = (dir: string): boolean => /[\\/]node_modules[\\/]\.bin$/.test(dir);

/** The first `pi` executable on PATH, and its version (`pi --version`, three seconds at most). */
export async function findPathPi(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<{ found: boolean; path?: string; version?: string }> {
  const names = platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi.bat'] : ['pi'];
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    if (own(dir)) continue;
    for (const name of names) {
      const path = join(dir, name);
      try {
        if (!statSync(path).isFile()) continue;
      } catch {
        continue;
      }
      const version = await new Promise<string | undefined>((resolve) => {
        execFile(path, ['--version'], { timeout: 3000, env: { ...env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', NO_COLOR: '1' }, windowsHide: true }, (error, stdout, stderr) => {
          const text = `${stdout}\n${stderr}`;
          resolve(error && !text.trim() ? undefined : /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)?.[1]);
        });
      });
      return { found: true, path, ...(version ? { version } : {}) };
    }
  }
  return { found: false };
}

/** The host of `HTTPS_PROXY` / `HTTP_PROXY` without its credentials, or undefined. */
export function proxyHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env['HTTPS_PROXY'] || env['https_proxy'] || env['HTTP_PROXY'] || env['http_proxy'];
  if (!value) return undefined;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`).host;
  } catch {
    return undefined;
  }
}
