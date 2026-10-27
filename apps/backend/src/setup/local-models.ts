import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Adds a local, OpenAI-compatible server to pi's `models.json` (the format is pi's docs/models.md, "Configure a compatible endpoint"):
 * a provider with a base URL, the API pi speaks to it, a dummy key (the servers ignore it, pi needs one to count the provider as usable) and the model ids.
 * Everything else in the file stays as it is. The file is replaced atomically and keeps its mode (new files are 0600: `models.json` may hold keys).
 */
export function saveLocalProvider(agentDir: string, input: { provider: string; baseUrl: string; models: readonly string[]; modelDetails?: Record<string, Record<string, unknown>>; providerDetails?: Record<string, unknown> }): { path: string; models: number } {
  const path = join(agentDir, 'models.json');
  let file: { providers?: Record<string, Record<string, unknown>>; [key: string]: unknown } = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      file = parsed as typeof file;
    } catch (error) {
      // Never overwrite a file we cannot read: it is the user's.
      throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix or remove it, then try again.`, { cause: error });
    }
  }
  const providers = { ...(file.providers ?? {}) };
  const previous = providers[input.provider] ?? {};
  const known = Array.isArray(previous['models']) ? (previous['models'] as { id?: unknown }[]) : [];
  const ids = [...new Set(input.models)];
  // A model the file already describes keeps its description; new ids are added as bare entries.
  const models = ids.map((id) => ({ ...(known.find((m) => m?.id === id) ?? {}), ...input.modelDetails?.[id], id }));
  providers[input.provider] = { ...previous, baseUrl: input.baseUrl, api: previous['api'] ?? 'openai-completions', apiKey: previous['apiKey'] ?? 'local', ...input.providerDetails, models };
  const next = { ...(file['$schema'] === undefined && !existsSync(path) ? { $schema: 'https://pi.dev/schemas/models.schema.json' } : {}), ...file, providers };

  mkdirSync(dirname(path), { recursive: true });
  // Explicit credentials make this a private file even if an older models.json was world-readable.
  const mode = input.providerDetails?.['apiKey'] !== undefined ? 0o600 : existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
  return { path, models: ids.length };
}

/** Remove one connection, not model files or unrelated providers. Refuse malformed configuration. */
export function removeConfiguredProvider(agentDir: string, provider: string): unknown {
  const path = join(agentDir, 'models.json');
  if (!existsSync(path)) return undefined;
  const file = JSON.parse(readFileSync(path, 'utf8')) as { providers?: Record<string, Record<string, unknown>> };
  if (!file || typeof file !== 'object' || Array.isArray(file) ||
      (file.providers !== undefined && (!file.providers || typeof file.providers !== 'object' || Array.isArray(file.providers)))) {
    throw new Error('models.json is not a valid configuration. Fix it before removing a provider.');
  }
  if (!file.providers || !Object.hasOwn(file.providers, provider)) return undefined;
  const apiKey = file.providers[provider]?.['apiKey'];
  delete file.providers[provider];
  const mode = statSync(path).mode & 0o777;
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
  return apiKey;
}

/** A provider id for a server the user did not name: the product the probe recognised, or `local`. */
export function providerIdFor(kind: string | undefined): string {
  return kind === 'ollama' ? 'ollama' : kind === 'llama-swap' ? 'llama-swap' : 'local';
}

/** Compare the actual API endpoint, including its path; loopback spellings share one server. */
export function localProviderEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.toString().replace(/\/+$/, '');
  } catch { return baseUrl.replace(/\/+$/, ''); }
}

/** Add newly discovered IDs once per server, preserving each connection's curated model list. */
export function refreshExistingLocalProviders(agentDir: string, servers: readonly { baseUrl: string; models: readonly string[] }[]): void {
  const path = join(agentDir, 'models.json');
  if (!existsSync(path)) return;
  const file = JSON.parse(readFileSync(path, 'utf8')) as { providers?: Record<string, { baseUrl?: unknown; models?: { id?: unknown }[] }> };
  for (const server of servers) {
    const connections = Object.entries(file.providers ?? {}).filter(([provider, entry]) =>
      provider !== 'litellm' && typeof entry.baseUrl === 'string' && localProviderEndpoint(entry.baseUrl) === localProviderEndpoint(server.baseUrl));
    if (!connections.length) continue;
    const ids = (entry: { models?: { id?: unknown }[] }): string[] => Array.isArray(entry.models)
      ? entry.models.flatMap((model) => typeof model.id === 'string' ? [model.id] : []) : [];
    const known = new Set(connections.flatMap(([, entry]) => ids(entry)));
    const added = [...new Set(server.models)].filter((id) => !known.has(id));
    if (!added.length) continue;
    const [provider, entry] = connections.find(([id]) => id === 'llama-swap' || id === 'ollama' || id === 'local') ?? connections[0];
    saveLocalProvider(agentDir, { provider, baseUrl: entry.baseUrl as string, models: [...ids(entry), ...added] });
    entry.models = [...(Array.isArray(entry.models) ? entry.models : []), ...added.map((id) => ({ id }))];
  }
}

/** Remove only the unchanged provider that an earlier version recorded as its private engine. */
export function removeLegacyLocalProvider(agentDir: string, owner: unknown): void {
  if (!owner || typeof owner !== 'object') return;
  const { provider, baseUrl } = owner as { provider?: unknown; baseUrl?: unknown };
  if (typeof provider !== 'string' || !/^pi-kit-local(?:-\d+)?$/.test(provider) || typeof baseUrl !== 'string') return;
  const path = join(agentDir, 'models.json');
  if (!existsSync(path)) return;
  const file = JSON.parse(readFileSync(path, 'utf8')) as { providers?: Record<string, Record<string, unknown>> };
  const entry = file.providers?.[provider];
  if (!entry || entry['baseUrl'] !== baseUrl || entry['api'] !== 'openai-completions' || entry['apiKey'] !== 'local') return;
  delete file.providers?.[provider];
  const mode = statSync(path).mode & 0o777;
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}
