import type { ModelRuntime } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { PiModule } from './load-pi';

type Options = NonNullable<Parameters<PiModule['ModelRuntime']['create']>[0]>;
type Store = NonNullable<Options['credentials']>;
type Provider = NonNullable<ReturnType<ModelRuntime['getProvider']>>;
const protectedRuntimes = new WeakSet<ModelRuntime>();

export const ANTHROPIC_API_KEY_ONLY =
  'Anthropic requires an API key in pi-kit. Claude subscription OAuth tokens are not supported; use an Anthropic Console API key.';

function isSubscriptionToken(key: string | undefined): boolean {
  return !!key && /^sk-ant-o(?:at|rt)/i.test(key.trim());
}

/** Never include the rejected secret in an error. */
export function assertAnthropicApiKey(key: string | undefined): void {
  if (isSubscriptionToken(key)) throw new Error(ANTHROPIC_API_KEY_ONLY);
}

/** Hide saved OAuth from resolution without deleting or changing the user's credentials. */
function apiKeyCredentials(store: Store): Store {
  return {
    async read(id, options) {
      const value = await store.read(id, options);
      return id === 'anthropic' && value?.type === 'oauth' ? undefined : value;
    },
    async list(options) {
      return (await store.list(options)).filter((v) => v.providerId !== 'anthropic' || v.type !== 'oauth');
    },
    modify(id, fn, options) {
      return store.modify(
        id,
        async (current) => {
          const next = await fn(id === 'anthropic' && current?.type === 'oauth' ? undefined : current);
          if (id === 'anthropic') {
            if (next?.type === 'oauth') throw new Error(ANTHROPIC_API_KEY_ONLY);
            assertAnthropicApiKey(next?.key);
          }
          return next;
        },
        options,
      );
    },
    delete: (id, options) => store.delete(id, options),
  };
}

function apiKeyOnly(provider: Provider): Provider {
  const inherited = provider.auth.apiKey;
  return {
    ...provider,
    auth: {
      apiKey: {
        name: 'Anthropic API key',
        async login(interaction) {
          const key = await interaction.prompt({ type: 'secret', message: 'Enter Anthropic API key' });
          interaction.signal.throwIfAborted();
          assertAnthropicApiKey(key);
          return { type: 'api_key', key };
        },
        async resolve({ ctx, credential, signal }) {
          // Keep configured key resolvers (including secret commands), but disable
          // the builtin's OAuth/bearer and federation environment fallback.
          const safeContext = {
            ...ctx,
            env: (name: string) =>
              name.startsWith('ANTHROPIC_') && name !== 'ANTHROPIC_API_KEY'
                ? Promise.resolve(undefined)
                : ctx.env(name),
          };
          const result = inherited ? await inherited.resolve({ ctx: safeContext, credential, signal }) : undefined;
          signal.throwIfAborted();
          // A legacy token pasted into an API-key slot is unconfigured, not a
          // failure of the entire multi-provider availability pass.
          return result?.auth.apiKey && !isSubscriptionToken(result.auth.apiKey) ? result : undefined;
        },
      },
    },
  };
}

/**
 * Install before the SDK's first availability check, which can refresh OAuth.
 * pi 1.x has no public provider-composition middleware. Its TS-private (not JS
 * private) composition method is the single boundary shared by startup, models.json,
 * extension registration, virtual models and refresh. Fail closed if it changes.
 */
export async function createApiKeyOnlyRuntime(pi: PiModule, options: Options = {}): Promise<ModelRuntime> {
  const runtime = await pi.ModelRuntime.create({
    ...options,
    refreshOnCreate: false,
  });
  if (protectedRuntimes.has(runtime)) return runtime;
  const internal = runtime as unknown as {
    composeProvider(id: string): Provider | undefined;
    credentials: { store: Store };
  };
  if (typeof internal.composeProvider !== 'function' || !internal.credentials?.store) {
    throw new Error(
      'Cannot enforce Anthropic API-key-only policy with this pi SDK. Please use a supported SDK version.',
    );
  }
  const storedCredentials = internal.credentials.store;
  internal.credentials.store = apiKeyCredentials(storedCredentials);
  // Metadata remains visible so Settings can explain/remove an old connection.
  runtime.listCredentials = (opts) => storedCredentials.list(opts);
  const authStatus = runtime.getProviderAuthStatus.bind(runtime);
  runtime.getProviderAuthStatus = (id) =>
    id === 'anthropic' && !runtime.hasConfiguredAuth(id) ? { configured: false } : authStatus(id);
  const compose = internal.composeProvider.bind(runtime);
  internal.composeProvider = (id) => {
    // The current OpenAI provider replaces the retired Codex connection.
    if (id === 'openai-codex') return undefined;
    const provider = compose(id);
    return id === 'anthropic' && provider ? apiKeyOnly(provider) : provider;
  };
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = async (providerOrModel, overrides) => {
    const id = typeof providerOrModel === 'string' ? providerOrModel : providerOrModel.provider;
    if (id === 'anthropic') assertAnthropicApiKey(overrides?.apiKey);
    return typeof providerOrModel === 'string'
      ? getAuth(providerOrModel, overrides)
      : getAuth(providerOrModel, overrides);
  };
  const setKey = runtime.setRuntimeApiKey.bind(runtime);
  runtime.setRuntimeApiKey = async (id, key, opts) => {
    if (id === 'anthropic') assertAnthropicApiKey(key);
    return setKey(id, key, opts);
  };
  const login = runtime.login.bind(runtime);
  runtime.login = async (id, type, interaction, opts) => {
    if (id === 'openai-codex') throw new Error('Legacy Codex is no longer supported. Use OpenAI instead.');
    if (id === 'anthropic' && type === 'oauth') throw new Error(ANTHROPIC_API_KEY_ONLY);
    return login(id, type, interaction, opts);
  };
  // A local refresh rebuilds every provider through the policy before auth checks.
  await runtime.refresh({ allowNetwork: options.allowModelNetwork === true, signal: options.signal });
  protectedRuntimes.add(runtime);
  return runtime;
}
