import { inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type,
  withHooks,
  withMethods,
  withState,
  type SignalStoreFeatureType,
} from '@ngrx/signals';
import { ApiClient, errorMessage, settingsProviders, unwrap } from '@pi-kit/api';
import { withLatestRequest } from '@pi-kit/data-access';
import type { ProviderInfo } from '@pi-kit/protocol';
import { SettingsStore } from '../settings.store';
import { SettingsSlices } from './settings-slices';

export function withProviderList<_>() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withLatestRequest>>(),
    withState<{ providers: ProviderInfo[] | undefined; providersError: string | undefined }>({
      providers: undefined,
      providersError: undefined,
    }),
    withMethods((store) => {
      const api = inject(ApiClient);
      const slices = inject(SettingsSlices);
      const last = slices.get<ProviderInfo[]>('providers');
      if (last) patchState(store, { providers: last });
      return {
        async loadProviders(): Promise<void> {
          await store._request('providers', (signal) => unwrap(settingsProviders({ client: api.client, signal })), {
            next: (providers) => {
              slices.set('providers', providers);
              patchState(store, { providers, providersError: undefined });
            },
            error: (error) => patchState(store, { providersError: errorMessage(error) }),
          });
        },
      };
    }),
    withHooks((store) => {
      let leave: (() => void) | undefined;
      return {
        onInit() {
          leave = inject(SettingsStore).onProvidersChanged(async () => {
            if (store.providers() !== undefined || store._requestStates()['providers']) await store.loadProviders();
          });
        },
        onDestroy() {
          leave?.();
        },
      };
    }),
  );
}
