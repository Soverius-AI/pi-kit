import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { ApiClient, errorMessage, roomsAddAgent, roomsAgents, roomsRemoveAgent, unwrap } from '@pi-kit/api';
import type { A2aAgent } from '@pi-kit/protocol';

interface A2aAgentsState {
  agents: A2aAgent[];
  busy: boolean;
  error: string | undefined;
}

export const A2aAgentsStore = signalStore(
  { providedIn: 'root' },
  withState<A2aAgentsState>({ agents: [], busy: false, error: undefined }),
  withMethods((store) => {
    const api = inject(ApiClient);
    return {
      async load(): Promise<void> {
        try {
          patchState(store, { agents: await unwrap(roomsAgents({ client: api.client })), error: undefined });
        } catch (error) {
          patchState(store, { error: errorMessage(error) });
        }
      },
      async add(url: string, token: string): Promise<boolean> {
        patchState(store, { busy: true, error: undefined });
        try {
          const agent = await unwrap(
            roomsAddAgent({
              client: api.client,
              body: { url: url.trim(), ...(token.trim() ? { token: token.trim() } : {}) },
            }),
          );
          patchState(store, { agents: [...store.agents(), agent] });
          return true;
        } catch (error) {
          patchState(store, { error: errorMessage(error) });
          return false;
        } finally {
          patchState(store, { busy: false });
        }
      },
      async remove(id: string): Promise<void> {
        patchState(store, { busy: true, error: undefined });
        try {
          await unwrap(roomsRemoveAgent({ client: api.client, path: { agentId: id } }));
          patchState(store, { agents: store.agents().filter((agent) => agent.id !== id) });
        } catch (error) {
          patchState(store, { error: errorMessage(error) });
        } finally {
          patchState(store, { busy: false });
        }
      },
    };
  }),
);
