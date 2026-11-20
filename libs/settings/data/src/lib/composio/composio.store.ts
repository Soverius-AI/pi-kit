import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import {
  ApiClient,
  composioAdd,
  composioConnectLink,
  composioConnectState,
  composioConnections,
  composioForgetKey,
  composioSearch,
  composioLink,
  composioSetKey,
  composioStatus,
  composioToolkits,
  composioUnwire,
  composioWire,
  unwrap,
} from '@pi-kit/api';
import { withLatestRequest, withRequestStatus } from '@pi-kit/data-access';
import type {
  ComposioConnect,
  ComposioConnection,
  ComposioFoundApp,
  ComposioStatus,
  ComposioToolkit,
} from '@pi-kit/protocol';
import { BrandLogosStore } from '../brand-logos.store';
import { ConnectorsStore } from '../connectors.store';

interface ComposioState {
  visible: boolean;
  status: ComposioStatus | undefined;
  toolkits: ComposioToolkit[];
  connections: ComposioConnection[];
  /** The apps reached through the Composio Connect sign-in. */
  connect: ComposioConnect | undefined;
  /** Composio's answer to the last search, with the query it answers. */
  found: { query: string; apps: ComposioFoundApp[] } | undefined;
  searching: boolean;
}

export const ComposioStore = signalStore(
  { providedIn: 'root' },
  withState<ComposioState>({
    visible: false,
    status: undefined,
    toolkits: [],
    connections: [],
    connect: undefined,
    found: undefined,
    searching: false,
  }),
  withRequestStatus(),
  withLatestRequest(),
  withMethods((store) => {
    const api = inject(ApiClient);
    const connectors = inject(ConnectorsStore);
    const logos = inject(BrandLogosStore);
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
        await methods.loadConnect();
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
      async loadConnect(): Promise<void> {
        const connect = await run(() => unwrap(composioConnectState({ client: api.client })));
        if (!connect) return;
        // Keep links already made: a new one would start another pending account in Composio.
        const links = new Map(store.connect()?.apps.map((app) => [app.toolkit, app.signInUrl]));
        patchState(store, {
          connect: {
            ...connect,
            apps: connect.apps.map((app) =>
              app.connected ? app : { ...app, signInUrl: links.get(app.toolkit) ?? null },
            ),
          },
        });
      },
      async wire(toolkit: string, name: string): Promise<boolean> {
        const connect = await run(() => unwrap(composioWire({ client: api.client, body: { toolkit, name } })));
        if (!connect) return false;
        patchState(store, { connect });
        if (connect.signedIn && !connect.apps.find((app) => app.toolkit === toolkit)?.connected)
          await methods.connectLink(toolkit);
        return true;
      },
      async searchApps(query: string): Promise<void> {
        const q = query.trim();
        if (!q) return;
        patchState(store, { searching: true });
        try {
          const apps = await unwrap(composioSearch({ client: api.client, query: { q } }));
          patchState(store, { found: { query: q, apps } });
          void logos.load(apps.map((app) => app.toolkit));
        } catch (error) {
          store.requestFailed(error);
        } finally {
          patchState(store, { searching: false });
        }
      },
      async connectLink(toolkit: string): Promise<void> {
        const app = await run(() => unwrap(composioConnectLink({ client: api.client, path: { toolkit } })));
        const connect = store.connect();
        if (app && connect)
          patchState(store, {
            connect: { ...connect, apps: connect.apps.map((a) => (a.toolkit === toolkit ? app : a)) },
          });
      },
      async unwire(toolkit: string): Promise<void> {
        const connect = await run(() => unwrap(composioUnwire({ client: api.client, path: { toolkit } })));
        if (connect) patchState(store, { connect });
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
