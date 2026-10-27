import { DestroyRef, inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { ApiClient, browserAction, browserState, errorMessage, unwrap } from '@pi-kit/api';
import { withLatestRequest, withPolling } from '@pi-kit/data-access';
import type { BrowserAction, BrowserResult, BrowserState } from '@pi-kit/protocol';

/** Component-scoped browser state. The actual page belongs to the chat in Electron and survives closing the panel. */
export const BrowserStore = signalStore(
  withState({
    threadId: undefined as string | undefined,
    page: undefined as BrowserState | undefined,
    busy: false,
    error: undefined as string | undefined,
  }),
  withLatestRequest(),
  withPolling(),
  withMethods((store) => {
    const api = inject(ApiClient);
    const destroyRef = inject(DestroyRef);
    let revision = 0;
    let epoch = 0;
    let actionSettled = Promise.resolve();
    const methods = {
      /** Recheck native navigation after preparing an attachment, immediately before committing its draft context. */
      async confirmDocument(threadId: string, documentId: string): Promise<boolean> {
        const mine = epoch;
        if (store.threadId() !== threadId || destroyRef.destroyed) return false;
        const page = await store._request(
          'browser-context',
          (signal) => unwrap(browserState({ client: api.client, path: { id: threadId }, signal })),
          { valid: () => mine === epoch && !destroyRef.destroyed },
        );
        if (mine !== epoch || destroyRef.destroyed) return false;
        return !!page?.open && page.documentId === documentId;
      },
      watch(threadId: string | undefined, intervalMs: number): void {
        store._stopPolling('browser');
        store._cancelRequests();
        epoch++;
        revision++;
        patchState(store, { threadId, page: undefined, busy: false, error: undefined });
        if (!threadId) return;
        store._startPolling('browser', {
          intervalMs,
          run: async (signal) => {
            if (store.busy()) return;
            const before = revision;
            await store._request(
              'browser',
              (signal) => unwrap(browserState({ client: api.client, path: { id: threadId }, signal })),
              {
                signal,
                valid: () => store.threadId() === threadId && revision === before && !store.busy(),
                next: (page) => patchState(store, { page, error: undefined }),
                error: (error) => patchState(store, { error: errorMessage(error) }),
              },
            );
          },
        });
      },
      async act(action: BrowserAction): Promise<BrowserResult | undefined> {
        const threadId = store.threadId();
        if (!threadId) return;
        if (store.busy()) {
          if (action.action !== 'inspect' || action.enabled !== false) return;
          // Keep Stop/Escape usable while the picker is starting or another action is finishing.
          const owner = epoch;
          await actionSettled;
          if (destroyRef.destroyed || owner !== epoch) return;
          return methods.act(action);
        }
        let settle!: () => void;
        actionSettled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        const mine = epoch;
        const page = store.page();
        const startingInspection = action.action === 'inspect' && !action.ref && action.enabled !== false;
        revision++;
        store._cancelRequest('browser');
        patchState(store, { busy: true, error: undefined });
        if (startingInspection && page) patchState(store, { page: { ...page, inspecting: true } });
        try {
          const result = await unwrap(browserAction({ client: api.client, path: { id: threadId }, body: action }));
          if (!destroyRef.destroyed && mine === epoch) {
            patchState(store, { page: result.state });
            return result;
          }
        } catch (error) {
          if (!destroyRef.destroyed && mine === epoch) {
            patchState(store, { error: errorMessage(error) });
            if (startingInspection && page) patchState(store, { page });
          }
        } finally {
          if (mine === epoch) {
            revision++;
            patchState(store, { busy: false });
          }
          settle();
        }
        return undefined;
      },
    };
    return methods;
  }),
);
