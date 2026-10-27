import { computed, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import { ApiClient, unwrap, workspaceStatusStatus } from '@pi-kit/api';
import { ClockStore, withLatestRequest } from '@pi-kit/data-access';
import { THREADS_POLICY } from './threads-policy';
import { ThreadsStore } from './threads.store';

/**
 * How many files have uncommitted changes in the folder in view: the badge of the sidebar's "Working tree changes" button. It reads git's status of the folder the
 * panels work in (`ThreadsStore.folder`, the worktree while the thread has one) when that folder changes, when a run starts or ends, when the watch stream reports a change,
 * and every ten seconds. A folder that is not a git working tree, or a failed read, counts as 0, so the badge is simply absent.
 */
export const ChangedCountStore = signalStore(
  { providedIn: 'root' },
  withState<{ folder: string | undefined; _count: number }>({ folder: undefined, _count: 0 }),
  withLatestRequest(),
  withComputed((store) => {
    const threads = inject(ThreadsStore);
    return { count: computed(() => (threads.folder() === store.folder() ? store._count() : 0)) };
  }),
  withProps(() => ({ _policy: inject(THREADS_POLICY) })),
  withMethods((store) => {
    const api = inject(ApiClient);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (folder: string | undefined): Promise<void> => {
      if (folder !== store.folder()) patchState(store, { folder, _count: 0 });
      if (!folder) return store._cancelRequest('count');
      await store._request(
        'count',
        (signal) =>
          unwrap(
            workspaceStatusStatus({ client: api.client, path: { id: folder }, query: { thread: undefined }, signal }),
          ),
        {
          valid: () => store.folder() === folder,
          next: (status) => patchState(store, { _count: status.entries.length }),
          error: () => patchState(store, { _count: 0 }),
        },
      );
    };
    return {
      /** Reads the count for `folder`: at once for another folder, after a short settle for the same one. */
      refresh(folder: string | undefined): void {
        clearTimeout(timer);
        if (folder !== store.folder()) return void read(folder);
        timer = setTimeout(() => void read(folder), store._policy.changesSettleMs);
      },
      _stop(): void {
        clearTimeout(timer);
        store._cancelRequest('count');
      },
    };
  }),
  withHooks({
    onInit(store) {
      const threads = inject(ThreadsStore);
      const clock = inject(ClockStore);
      const running = computed(() =>
        threads
          .threads()
          .filter((t) => t.state.activity === 'running')
          .map((t) => t.id)
          .join(),
      );
      effect(() => {
        const folder = threads.folder();
        running();
        threads.watchTick();
        Math.floor(clock.now() / store._policy.changesRefreshMs);
        untracked(() => store.refresh(folder));
      });
    },
    onDestroy(store) {
      store._stop();
    },
  }),
);
export type ChangedCountStore = InstanceType<typeof ChangedCountStore>;
