import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  localRuntimeHardware,
  localRuntimeModels,
  localRuntimeReadConfig,
  localRuntimeConfigFile,
  localRuntimeSaveConfigFile,
  localRuntimeModelOptions,
  localRuntimeSaveModelOptions,
  unwrap,
} from '@pi-kit/api';
import { withLatestRequest } from '@pi-kit/data-access';
import type {
  LocalCatalog,
  LocalHardware,
  LocalConfigFile,
  LocalModelOptions,
  LocalModelOptionsSave,
} from '@pi-kit/protocol';

/** Discovery and recommendations are independent from the backend-owned long-running setup job. */
export const LocalModelCatalogStore = signalStore(
  { providedIn: 'root' },
  withState({
    hardware: undefined as LocalHardware | undefined,
    catalog: undefined as LocalCatalog | undefined,
    directory: '',
    configPath: '',
    configPathInitialized: false,
    query: '',
    catalogQuery: '',
    catalogContextTokens: 8192,
    lastAddedModelId: undefined as string | undefined,
    hardwareError: undefined as string | undefined,
    catalogError: undefined as string | undefined,
  }),
  withLatestRequest(),
  withComputed((store) => ({
    detecting: computed(() => store._requestStates()['local-hardware']?.status === 'loading'),
    searching: computed(() => store._requestStates()['local-catalog']?.status === 'loading'),
  })),
  withMethods((store) => {
    const api = inject(ApiClient);
    return {
      modelOptions(path: string, model: string): Promise<LocalModelOptions> {
        return unwrap(localRuntimeModelOptions({ client: api.client, query: { path, model } }));
      },
      saveModelOptions(input: LocalModelOptionsSave): Promise<LocalModelOptions> {
        return unwrap(localRuntimeSaveModelOptions({ client: api.client, body: input }));
      },
      configFile(path: string): Promise<LocalConfigFile> {
        return unwrap(localRuntimeConfigFile({ client: api.client, query: { path } }));
      },
      saveConfigFile(path: string, text: string, version: string): Promise<LocalConfigFile> {
        return unwrap(localRuntimeSaveConfigFile({ client: api.client, body: { path, text, version } }));
      },
      setDirectory(directory: string): void {
        patchState(store, { directory });
      },
      setConfigPath(configPath: string): void {
        patchState(store, { configPath, configPathInitialized: true });
      },
      async readConfig(): Promise<void> {
        patchState(store, { hardwareError: undefined });
        await store._request(
          'local-hardware',
          (signal) =>
            unwrap(
              localRuntimeReadConfig({
                client: api.client,
                body: {
                  path: store.configPath().trim(),
                  ...(store.directory().trim() ? { directory: store.directory().trim() } : {}),
                },
                signal,
              }),
            ),
          {
            next: (hardware) =>
              patchState(store, {
                hardware,
                configPath: hardware.llamaSwapConfigPath ?? '',
                configPathInitialized: true,
              }),
            error: (error) => patchState(store, { hardwareError: errorMessage(error) }),
          },
        );
      },
      setQuery(query: string): void {
        patchState(store, { query });
      },
      rememberDownload(id: string): void {
        patchState(store, { lastAddedModelId: id });
      },
      async detect(): Promise<void> {
        const directory = store.directory().trim();
        patchState(store, { hardwareError: undefined });
        await store._request(
          'local-hardware',
          (signal) =>
            unwrap(localRuntimeHardware({ client: api.client, query: directory ? { directory } : {}, signal })),
          {
            next: (hardware) =>
              patchState(store, {
                hardware,
                ...(!store.configPathInitialized()
                  ? { configPath: hardware.llamaSwapConfigPath ?? '', configPathInitialized: true }
                  : {}),
              }),
            error: (error) => patchState(store, { hardwareError: errorMessage(error) }),
          },
        );
      },
      async search(contextTokens: number): Promise<void> {
        const query = store.query().trim();
        patchState(store, { catalogError: undefined });
        await store._request(
          'local-catalog',
          (signal) => unwrap(localRuntimeModels({ client: api.client, query: { query, contextTokens }, signal })),
          {
            next: (catalog) => patchState(store, { catalog, catalogQuery: query, catalogContextTokens: contextTokens }),
            error: (error) => patchState(store, { catalogError: errorMessage(error) }),
          },
        );
      },
    };
  }),
);
