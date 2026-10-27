import { Logger } from '@nestjs/common';
import { THINKING_LEVELS } from '@pi-kit/protocol';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import type { PiModule } from './load-pi';
import { chatGptModels, type ChatGptModel } from './chatgpt-model-catalog';

type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;
const PROVIDERS = ['openai', 'openai-codex'];
const logger = new Logger('ChatGptModelCatalog');

function liveModel(provider: string, entry: ChatGptModel, known?: Model): Model {
  const levels = entry.supported_reasoning_levels?.map((l) => (l.effort === 'none' ? 'off' : l.effort));
  const thinkingLevelMap: Model['thinkingLevelMap'] = levels
    ? Object.fromEntries(
        THINKING_LEVELS.map((level) => [level, levels.includes(level) ? (level === 'off' ? 'none' : level) : null]),
      )
    : known?.thinkingLevelMap;
  const input = entry.input_modalities?.filter((m): m is 'text' | 'image' => m === 'text' || m === 'image');
  return {
    ...known,
    id: entry.slug,
    name: entry.display_name,
    provider,
    api: provider === 'openai-codex' ? 'openai-codex-responses' : 'openai-responses',
    baseUrl: provider === 'openai-codex' ? 'https://chatgpt.com/backend-api' : 'https://api.openai.com/v1',
    input: input?.length ? input : (known?.input ?? ['text']),
    // New models can be selected before an SDK catalog update. Unknown limits/prices stay unknown.
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.context_window ?? known?.contextWindow ?? 0,
    maxTokens: known?.maxTokens ?? 0,
    reasoning: levels ? levels.some((l) => l !== 'off') : (known?.reasoning ?? false),
    thinkingLevelMap,
  };
}

/** Project the live account catalog into the SDK's lookup, selection, restoration and cycling paths. */
function withLiveSubscriptionModels(runtime: ModelRuntime): ModelRuntime {
  const catalogs = new Map<string, Model[]>();
  const errors = new Map<string, string>();
  const versions = new Map<string, number>();
  const getAvailable = runtime.getAvailable.bind(runtime);
  const getAvailableSnapshot = runtime.getAvailableSnapshot.bind(runtime);
  const getModels = runtime.getModels.bind(runtime);
  const getModel = runtime.getModel.bind(runtime);
  const getPhysicalModel = runtime.getPhysicalModel.bind(runtime);
  const getError = runtime.getError.bind(runtime);
  const subscription = (provider: string): boolean =>
    PROVIDERS.includes(provider) && runtime.isUsingSubscription(provider);
  const project = (models: readonly Model[], provider?: string): Model[] => {
    const out = models.filter((m) => m.api === 'pi-virtual' || !subscription(m.provider));
    for (const id of PROVIDERS) {
      if ((!provider || provider === id) && subscription(id)) {
        const virtualIds = new Set(out.filter((m) => m.provider === id).map((m) => m.id));
        out.push(...(catalogs.get(id) ?? []).filter((m) => !virtualIds.has(m.id)));
      }
    }
    return out;
  };
  runtime.getAvailable = async (provider, options) => {
    const available = await getAvailable(provider, options);
    await Promise.all(
      PROVIDERS.filter((id) => !provider || provider === id).map(async (id) => {
        const version = (versions.get(id) ?? 0) + 1;
        versions.set(id, version);
        if (!subscription(id)) {
          catalogs.delete(id);
          errors.delete(id);
          return;
        }
        if (process.env['PI_OFFLINE'] !== undefined) {
          catalogs.delete(id);
          return;
        }
        const signal = options?.signal ?? AbortSignal.timeout(15_000);
        try {
          const auth = await runtime.getAuth(id, { signal });
          if (!auth?.auth.apiKey) throw new Error('No ChatGPT access token is available.');
          const entries = await chatGptModels(auth.auth.apiKey, signal);
          signal.throwIfAborted();
          if (versions.get(id) !== version) return;
          catalogs.set(
            id,
            entries.map((entry) => liveModel(id, entry, getModel(id, entry.slug))),
          );
          errors.delete(id);
        } catch {
          if (versions.get(id) !== version) return;
          catalogs.delete(id);
          if (signal.aborted) throw signal.reason;
          const message = `Could not load live models for ${id}. Check your connection or sign in again.`;
          if (errors.get(id) !== message) logger.warn(message);
          errors.set(id, message);
        }
      }),
    );
    return project(available, provider);
  };
  runtime.getAvailableSnapshot = () => project(getAvailableSnapshot());
  runtime.getModels = (provider) => project(getModels(provider), provider);
  runtime.getModel = (provider, id) => {
    const known = getModel(provider, id);
    return subscription(provider) && known?.api !== 'pi-virtual'
      ? catalogs.get(provider)?.find((m) => m.id === id)
      : known;
  };
  runtime.getPhysicalModel = (provider, id) =>
    subscription(provider) ? catalogs.get(provider)?.find((m) => m.id === id) : getPhysicalModel(provider, id);
  runtime.getError = () => [getError(), ...errors.values()].filter(Boolean).join('\n\n') || undefined;
  // A credential change must not leave the previous account's catalog in synchronous selectors.
  const invalidate = (id: string): void => {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    catalogs.delete(id);
    errors.delete(id);
  };
  const login = runtime.login.bind(runtime);
  runtime.login = async (...args) => {
    invalidate(args[0]);
    const credential = await login(...args);
    await runtime.getAvailable(args[0]);
    return credential;
  };
  const logout = runtime.logout.bind(runtime);
  runtime.logout = async (...args) => {
    invalidate(args[0]);
    await logout(...args);
  };
  const setRuntimeApiKey = runtime.setRuntimeApiKey.bind(runtime);
  runtime.setRuntimeApiKey = async (...args) => {
    invalidate(args[0]);
    await setRuntimeApiKey(...args);
  };
  const removeRuntimeApiKey = runtime.removeRuntimeApiKey.bind(runtime);
  runtime.removeRuntimeApiKey = async (...args) => {
    invalidate(args[0]);
    await removeRuntimeApiKey(...args);
    await runtime.getAvailable(args[0]);
  };
  return runtime;
}

/** Every selectable runtime starts with the selected account's live catalog, never a static allowlist. */
export async function createModelRuntime(
  pi: PiModule,
  options?: Parameters<PiModule['ModelRuntime']['create']>[0],
): Promise<ModelRuntime> {
  const runtime = withLiveSubscriptionModels(await pi.ModelRuntime.create(options));
  await runtime.getAvailable(undefined, { signal: options?.signal });
  return runtime;
}
