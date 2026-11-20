import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import {
  ApiClient,
  composioAdd,
  composioConnections,
  composioForgetKey,
  composioLink,
  composioSetKey,
  composioStatus,
  composioToolkits,
  unwrap,
} from '@pi-kit/api';
import { withLatestRequest, withRequestStatus } from '@pi-kit/data-access';
import type { ComposioConnection, ComposioStatus, ComposioToolkit } from '@pi-kit/protocol';
import { ConnectorsStore } from './connectors.store';

interface ComposioState {
  visible: boolean;
  status: ComposioStatus | undefined;
  toolkits: ComposioToolkit[];
  connections: ComposioConnection[];
}

export const ComposioStore = signalStore(
  { providedIn: 'root' },
  withState<ComposioState>({ visible: false, status: undefined, toolkits: [], connections: [] }),
  withRequestStatus(),
  withLatestRequest(),
  withMethods((store) => {
    const api = inject(ApiClient);
    const connectors = inject(ConnectorsStore);
    const run = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      store.requestStarted();
      try {
        const value = await work();
        store.requestDone();
        return value;
      } catch (error) {
        store.requestFailed(error);
        return undefined;
      }
    };
    const methods = {
      async load(): Promise<void> {
        await run(async () => {
          const status = await unwrap(composioStatus({ client: api.client }));
          patchState(store, { status });
          if (!status.configured) return;
          patchState(store, { connections: await unwrap(composioConnections({ client: api.client })) });
        });
        if (store.status()?.configured) await methods.search('');
      },
      open(): void {
        connectors.closeWizard();
        store.clearError();
        patchState(store, { visible: true, toolkits: [] });
        void methods.load();
      },
      close(): void {
        store._cancelRequests();
        store.clearError();
        patchState(store, { visible: false });
      },
      async setKey(apiKey: string): Promise<boolean> {
        if (!(await run(() => unwrap(composioSetKey({ client: api.client, body: { apiKey } }))))) return false;
        await methods.load();
        return true;
      },
      async forgetKey(): Promise<void> {
        const status = await run(() => unwrap(composioForgetKey({ client: api.client })));
        if (status) patchState(store, { status, toolkits: [], connections: [] });
      },
      async search(query: string): Promise<void> {
        await store._request(
          'search',
          (signal) =>
            unwrap(
              composioToolkits({ client: api.client, query: query.trim() ? { search: query.trim() } : {}, signal }),
            ),
          {
            next: (toolkits) => patchState(store, { toolkits }),
            error: (error) => store.requestFailed(error),
          },
        );
      },
      async add(toolkit: ComposioToolkit, readOnly: boolean): Promise<boolean> {
        const added = await run(() =>
          unwrap(composioAdd({ client: api.client, body: { toolkit: toolkit.slug, name: toolkit.name, readOnly } })),
        );
        if (!added) return false;
        patchState(store, { connections: [...store.connections().filter((c) => c.server !== added.server), added] });
        void connectors.refresh();
        return true;
      },
      async link(server: string): Promise<void> {
        const linked = await run(() => unwrap(composioLink({ client: api.client, path: { server } })));
        if (linked)
          patchState(store, { connections: store.connections().map((c) => (c.server === server ? linked : c)) });
      },
    };
    return methods;
  }),
);
