import { DestroyRef, inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { ApiClient, bgAgentsAnswer, bgAgentsList, bgAgentsMessage, bgAgentsRemove, bgAgentsResume, bgAgentsStop, errorMessage, unwrap } from '@pi-kit/api';
import { withLatestRequest } from '@pi-kit/data-access';
import type { BgAgent } from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';

/**
 * The background agents of the open thread, component-scoped like the browser's store: the list from the SDK when the
 * panel opens, then every change pushed over the status channel (the backend sends the whole list); message, answer a question, stop and delete.
 */
export const AgentsStore = signalStore(
  withState({
    threadId: undefined as string | undefined,
    agents: [] as BgAgent[],
    /** The agent whose transcript the panel shows, if any. */
    open: undefined as string | undefined,
    error: undefined as string | undefined,
  }),
  withLatestRequest(),
  withMethods((store) => {
    const api = inject(ApiClient);
    const threads = inject(ThreadsStore);
    const destroyRef = inject(DestroyRef);
    let unsubscribe: (() => void) | undefined;
    let generation = 0;
    destroyRef.onDestroy(() => unsubscribe?.());
    const call = async (work: () => Promise<unknown>): Promise<boolean> => {
      const owner = generation;
      const current = (): boolean => generation === owner && !destroyRef.destroyed;
      try {
        await work();
        if (!current()) return false;
        patchState(store, { error: undefined });
        return true;
      } catch (error) {
        if (current()) patchState(store, { error: errorMessage(error) });
        return false;
      }
    };
    return {
      /** Follows a thread: reads its agents once and takes every `agents` line of the status channel from then on. */
      watch(threadId: string | undefined): void {
        generation++;
        unsubscribe?.();
        unsubscribe = undefined;
        store._cancelRequests();
        patchState(store, { threadId, agents: [], open: undefined, error: undefined });
        if (!threadId) return;
        unsubscribe = threads.onStatusEvent((event) => {
          if (event.type === 'agents' && event.id === threadId) patchState(store, { agents: event.agents });
        });
        void store._request('agents', (signal) => unwrap(bgAgentsList({ client: api.client, path: { id: threadId }, signal })), {
          valid: () => store.threadId() === threadId && !destroyRef.destroyed,
          next: (agents) => patchState(store, { agents, error: undefined }),
          error: (error) => patchState(store, { error: errorMessage(error) }),
        });
      },
      openTranscript(agentId: string | undefined): void {
        patchState(store, { open: agentId });
      },
      async message(agentId: string, text: string, mode: 'steer' | 'followUp'): Promise<void> {
        const threadId = store.threadId();
        if (!threadId) return;
        await call(() => unwrap(bgAgentsMessage({ client: api.client, path: { id: threadId, agent: agentId }, body: { text, mode } })));
      },
      /** The user's answer to the agent's open question, or its dismissal; the agent gets it verbatim. */
      async answer(agentId: string, questionId: string, text: string | 'cancelled'): Promise<void> {
        const threadId = store.threadId();
        if (!threadId) return;
        const body = text === 'cancelled' ? { question: questionId, cancelled: true } : { question: questionId, text };
        await call(() => unwrap(bgAgentsAnswer({ client: api.client, path: { id: threadId, agent: agentId }, body })));
      },
      /** A held agent goes on: the person says the processes of its interrupted command are gone, or lifts the crash-loop limit. */
      async resume(agentId: string): Promise<void> {
        const threadId = store.threadId();
        if (!threadId) return;
        await call(() => unwrap(bgAgentsResume({ client: api.client, path: { id: threadId, agent: agentId } })));
      },
      async stop(agentId: string): Promise<void> {
        const threadId = store.threadId();
        if (!threadId) return;
        await call(() => unwrap(bgAgentsStop({ client: api.client, path: { id: threadId, agent: agentId } })));
      },
      async remove(agentId: string): Promise<void> {
        const threadId = store.threadId();
        if (!threadId) return;
        const removed = await call(() => unwrap(bgAgentsRemove({ client: api.client, path: { id: threadId, agent: agentId } })));
        if (!removed) return;
        if (store.open() === agentId) patchState(store, { open: undefined });
        patchState(store, (s) => ({ agents: s.agents.filter((agent) => agent.id !== agentId) }));
      },
    };
  }),
);
export type AgentsStoreType = InstanceType<typeof AgentsStore>;
