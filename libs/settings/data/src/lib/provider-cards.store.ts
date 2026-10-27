import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { ApiClient, errorMessage, setupDetect, setupSaveLocal, setupTestLocal, unwrap } from '@pi-kit/api';
import type { LocalServer, LocalTestResult, SetupInfo } from '@pi-kit/protocol';
import { cardStatuses } from '@pi-kit/ui';
import { SettingsStore } from './settings.store';

interface ProviderCardsState {
  info: SetupInfo | undefined;
  detecting: boolean;
  detectError: string | undefined;
  /** The subscription card's picker. */
  subscription: string;
  /** The local card: the address field, the last test, and what is being done. */
  localUrl: string;
  localOpen: boolean;
  local: {
    phase: 'idle' | 'testing' | 'saving';
    result?: LocalTestResult;
    error?: string;
    saved?: { provider: string; models: number };
  };
}

/**
 * The state behind `pk-get-model`, the four ways to get a model on the onboarding's second card, and behind the detected local servers of
 * Settings › Providers and its “Add a provider” wizard. It is here because both domains use it and only `settings` may own it. What detection found on this machine, the subscription
 * picker, the local-server card; signing in and the API-key workflow are `SettingsStore` (the same calls as Settings › Providers). `OnboardingStore` reads this store for the
 * flow's own steps.
 */
export const ProviderCardsStore = signalStore(
  { providedIn: 'root' },
  withState<ProviderCardsState>({
    info: undefined,
    detecting: false,
    detectError: undefined,
    subscription: '',
    localUrl: '',
    localOpen: false,
    local: { phase: 'idle' },
  }),
  withComputed((store) => {
    const translate = inject(Language).t;
    const settings = inject(SettingsStore);
    const providers = computed(() => settings.overview()?.providers ?? []);
    const models = computed(() => settings.overview()?.models ?? []);
    return {
      providers,
      statuses: computed(() => cardStatuses(translate, providers(), models())),
      /** The providers that sign in as a subscription, Radius aside. */
      subscriptions: computed(() => providers().filter((p) => p.subscription && p.methods.includes('oauth'))),
      radius: computed(() => providers().find((p) => p.id === 'radius')),
      servers: computed<LocalServer[]>(() => store.info()?.localServers ?? []),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const settings = inject(SettingsStore);

    const patchLocal = (patch: Partial<ProviderCardsState['local']>): void =>
      patchState(store, (s) => ({ local: { ...s.local, ...patch } }));

    const methods = {
      /** Looks at the machine again: detection, and pi's own overview for the cards. */
      async detect(): Promise<void> {
        patchState(store, { detecting: true, detectError: undefined });
        try {
          const info = await unwrap(setupDetect({ client: api.client, signal: undefined }));
          patchState(store, (s) => ({
            info,
            detecting: false,
            localUrl: s.localUrl || info.localServers[0]?.baseUrl || '',
          }));
        } catch (error) {
          patchState(store, { detecting: false, detectError: errorMessage(error) });
        }
      },

      setSubscription(id: string): void {
        patchState(store, { subscription: id });
      },
      signInRadius(): Promise<void> {
        return settings.login('radius', 'oauth');
      },
      signInSubscription(): Promise<void> {
        const id = store.subscription();
        return id ? settings.login(id, 'oauth') : Promise.resolve();
      },
      addKey(): void {
        settings.openKeyWorkflow();
      },

      /** The "Add a provider" wizard starts its local step from nothing: no test, no earlier save. */
      resetLocal(): void {
        patchState(store, { localOpen: false, local: { phase: 'idle' } });
      },
      setLocalUrl(url: string): void {
        patchState(store, { localUrl: url, local: { phase: 'idle' } });
      },
      toggleLocal(): void {
        patchState(store, (s) => ({ localOpen: !s.localOpen }));
      },
      /** "Test connection": what the address serves, with the models it lists. */
      async testLocal(): Promise<void> {
        const url = store.localUrl().trim();
        if (!url) return;
        patchLocal({ phase: 'testing', error: undefined, result: undefined });
        try {
          const result = await unwrap(setupTestLocal({ client: api.client, body: { baseUrl: url } }));
          patchLocal({
            phase: 'idle',
            result,
            ...(result.ok ? {} : { error: result.error ?? translate('settings.providerCardsStore.itDidNotAnswer') }),
          });
        } catch (error) {
          patchLocal({ phase: 'idle', error: errorMessage(error) });
        }
      },
      /** Writes the server into pi's `models.json` and reads pi's models again. A detected server needs no test first (the backend tests it). */
      async saveLocal(baseUrl: string, models?: string[]): Promise<void> {
        patchLocal({ phase: 'saving', error: undefined });
        try {
          const ids = models ?? (await unwrap(setupTestLocal({ client: api.client, body: { baseUrl } }))).models;
          if (ids.length === 0) throw new Error(translate('settings.providerCardsStore.theServerListsNoModelLoadOne'));
          const kind = store.servers().find((s) => s.baseUrl === baseUrl)?.kind ?? store.local().result?.kind;
          const provider = kind === 'ollama' ? 'ollama' : kind === 'llama-swap' ? 'llama-swap' : 'local';
          const saved = await unwrap(setupSaveLocal({ client: api.client, body: { provider, baseUrl, models: ids } }));
          patchLocal({ phase: 'idle', saved: { provider: saved.provider, models: saved.models } });
          await Promise.all([settings.load(), methods.detect()]);
        } catch (error) {
          patchLocal({ phase: 'idle', error: errorMessage(error) });
        }
      },
    };
    return methods;
  }),
);
export type ProviderCardsStore = InstanceType<typeof ProviderCardsStore>;
