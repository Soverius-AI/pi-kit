import type { ModelProvider } from '@pi-kit/protocol';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };

/** `localhost`, loopback and private-network addresses: a server the person runs, not a cloud provider. */
export function localAddress(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    return local ? (url.port ? `${host}:${url.port}` : host) : undefined;
  } catch {
    return undefined;
  }
}

const KIND_ORDER: Record<ModelProvider['kind'], number> = { subscription: 0, 'api-key': 1, environment: 2, other: 3, local: 4 };

/**
 * How each provider that has a usable model is signed in, for the headings of the model picker: a subscription, a stored API key, a key from the environment, or a server on this
 * machine or network (shown by its address). Nothing here reads a credential; pi's status says where it comes from.
 */
export function modelProviders(
  runtime: Pick<ModelRuntime, 'getProvider' | 'getProviderAuthStatus' | 'isUsingSubscription'>,
  available: ReadonlyArray<{ provider: string; baseUrl?: string }>,
): ModelProvider[] {
  const ids = [...new Set(available.map((m) => m.provider))];
  const out = ids.map((id): ModelProvider => {
    const address = localAddress(available.find((m) => m.provider === id)?.baseUrl);
    const source = runtime.getProviderAuthStatus(id).source;
    const kind: ModelProvider['kind'] = address
      ? 'local'
      : runtime.isUsingSubscription(id)
        ? 'subscription'
        : source === 'environment'
          ? 'environment'
          : source === 'stored' || source === 'runtime' || source === 'models_json_key' || source === 'models_json_command'
            ? 'api-key'
            : 'other';
    return { id, name: runtime.getProvider(id)?.name ?? id, kind, ...(address ? { address } : {}) };
  });
  return out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));
}
