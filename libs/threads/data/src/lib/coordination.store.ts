import { computed, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { tap } from 'rxjs';
import { ApiClient, coordinationGet, unwrap } from '@pi-kit/api';
import { withLatestRequest, withPolling } from '@pi-kit/data-access';
import type { FileLease, OtherAgentInfo } from '@pi-kit/protocol';
import { THREADS_POLICY } from './threads-policy';

import { ThreadsStore } from './threads.store';

interface CoordinationState {
  /** The thread the numbers below are for. */
  threadId: string | undefined;
  /** Other threads' active leases on files in the folder the selected thread works in. */
  leases: FileLease[];
  /** Other agents next to the selected thread: other threads, "pi in a terminal". */
  others: OtherAgentInfo[];
  /** The panels that want the chips, by name (`files`, `review`). */
  wanted: readonly string[];
}

/**
 * Who else is working next to the open thread: the files other threads edited lately ("being edited by Fix e2e" in the Files panel
 * and review mode) and the other agents in the folder or in a worktree of the repository. The backend computes both from its file leases; this store
 * reads them while a panel wants them, again whenever the folder changes (an edit is a change) and every 20 seconds (a lease expires without any).
 */
export const CoordinationStore = signalStore(
  { providedIn: 'root' },
  withState<CoordinationState>({ threadId: undefined, leases: [], others: [], wanted: [] }),
  withLatestRequest(),
  withPolling(),
  withProps(() => ({ _policy: inject(THREADS_POLICY) })),
  withComputed((store) => ({
    /** The leases by file path (a file can be leased by more than one thread). */
    byPath: computed(() => {
      const map = new Map<string, FileLease[]>();
      for (const lease of store.leases()) map.set(lease.path, [...(map.get(lease.path) ?? []), lease]);
      return map;
    }),
    /** "Also working here": other agents that are running or waiting, or pi in a terminal. */
    active: computed(() => store.others().filter((o) => o.state !== 'idle')),
  })),
  withMethods((store) => {
    const api = inject(ApiClient);
    const threads = inject(ThreadsStore);
    const methods = {
      /** A panel says whether it shows the chips right now. */
      want(owner: string, on: boolean): void {
        patchState(store, (s) =>
          s.wanted.includes(owner) === on
            ? s
            : { wanted: on ? [...s.wanted, owner] : s.wanted.filter((w) => w !== owner) },
        );
      },
      /** "being edited by Fix e2e", for the file; the first lease when several threads hold it. */
      leaseOf(path: string): FileLease | undefined {
        return store.byPath().get(path)?.[0];
      },
      async refresh(signal?: AbortSignal): Promise<void> {
        const id = threads.selectedId();
        if (!id) {
          store._cancelRequest('coordination');
          patchState(store, { threadId: undefined, leases: [], others: [] });
          return;
        }
        await store._request(
          'coordination',
          (requestSignal) => unwrap(coordinationGet({ client: api.client, signal: requestSignal, path: { id } })),
          {
            signal,
            valid: () => id === threads.selectedId(),
            next: (result) => {
              const same =
                JSON.stringify(result.leases) === JSON.stringify(store.leases()) &&
                JSON.stringify(result.others) === JSON.stringify(store.others());
              if (!same || store.threadId() !== id)
                patchState(store, { threadId: id, leases: result.leases, others: result.others });
            },
          },
        );
      },
    };

    return methods;
  }),
  withHooks({
    onInit(store) {
      const threads = inject(ThreadsStore);
      const poll = (): void =>
        store._startPolling('coordination', {
          intervalMs: store._policy.coordinationRefreshMs,
          run: (signal) => store.refresh(signal),
        });
      // Reads while a panel wants it: again when the thread changes and on a timer.
      effect((onCleanup) => {
        threads.selectedId();
        if (store.wanted().length === 0) return;
        untracked(poll);
        onCleanup(() => store._stopPolling('coordination'));
      });
      // And at once when the folder changes (an edit by another thread is a change there).
      rxMethod<unknown>(
        tap(() => {
          if (store.wanted().length > 0) poll();
        }),
      )(threads.folderChanges);
    },
  }),
);
export type CoordinationStore = InstanceType<typeof CoordinationStore>;
