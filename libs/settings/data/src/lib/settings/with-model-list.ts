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
import { ApiClient, errorMessage, settingsModels, unwrap } from '@pi-kit/api';
import { withLatestRequest } from '@pi-kit/data-access';
import type { SettingsModel } from '@pi-kit/protocol';
import { SettingsStore } from '../settings.store';
import { SettingsSlices } from './settings-slices';

export function withModelList<_>() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withLatestRequest>>(),
    withState<{ models: SettingsModel[] | undefined; modelsError: string | undefined }>({
      models: undefined,
      modelsError: undefined,
    }),
    withMethods((store) => {
      const api = inject(ApiClient);
      const slices = inject(SettingsSlices);
      const last = slices.get<SettingsModel[]>('models');
      if (last) patchState(store, { models: last });
      return {
        async loadModels(): Promise<void> {
          await store._request('models', (signal) => unwrap(settingsModels({ client: api.client, signal })), {
            next: (models) => {
              slices.set('models', models);
              patchState(store, { models, modelsError: undefined });
            },
            error: (error) => patchState(store, { modelsError: errorMessage(error) }),
          });
        },
      };
    }),
    withHooks((store) => {
      let leave: (() => void) | undefined;
      return {
        onInit() {
          leave = inject(SettingsStore).onProvidersChanged(async () => {
            if (store.models() !== undefined || store._requestStates()['models']) await store.loadModels();
          });
        },
        onDestroy() {
          leave?.();
        },
      };
    }),
  );
}
