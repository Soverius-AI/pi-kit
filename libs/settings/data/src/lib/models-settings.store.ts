import { inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { ApiClient, settingsAbout, unwrap } from '@pi-kit/api';
import { withLatestRequest } from '@pi-kit/data-access';
import { withModelList } from './settings/with-model-list';
import { withPiSettings } from './settings/with-pi-settings';
import { withProviderList } from './settings/with-provider-list';

export const ModelsSettingsStore = signalStore(
  withState<{ piVersion: string | undefined }>({ piVersion: undefined }),
  withLatestRequest(),
  withPiSettings(),
  withProviderList(),
  withModelList(),
  withMethods((store) => {
    const api = inject(ApiClient);
    return {
      /** The scoped models in cycling order; `null` puts every model in scope. */
      setScope(patterns: string[] | null): Promise<void> {
        return store.patch({ enabledModels: patterns && patterns.length > 0 ? patterns : null });
      },
      async loadVersion(): Promise<void> {
        await store._request('about', (signal) => unwrap(settingsAbout({ client: api.client, signal })), {
          next: (about) => patchState(store, { piVersion: about.pi.version }),
        });
      },
    };
  }),
  withHooks({
    onInit(store) {
      void store.loadSettings();
      void store.loadProviders();
      void store.loadModels();
      void store.loadVersion();
    },
  }),
);
export type ModelsSettingsStore = InstanceType<typeof ModelsSettingsStore>;
