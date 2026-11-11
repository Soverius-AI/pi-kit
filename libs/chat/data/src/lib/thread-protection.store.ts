import { computed, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  isLocalExecution,
  threadsGetProtection,
  threadsSetProtection,
  unwrap,
  WORKBENCH,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import { Language } from '@pi-kit/i18n';
import type { SetThreadProtection, ThreadProtection } from '@pi-kit/protocol';
import { ChatStore } from './chat.store';

interface ThreadProtectionStoreState {
  protectionFor: { threadId: string; protection: ThreadProtection } | undefined;
  errorFor: { threadId: string; error: string } | undefined;
  loadingFor: string | undefined;
  pendingFor: { threadId: string; status: 'saving' | 'settingUp' } | undefined;
}

export const ThreadProtectionStore = signalStore(
  { providedIn: 'root' },
  withState<ThreadProtectionStoreState>({
    protectionFor: undefined,
    errorFor: undefined,
    loadingFor: undefined,
    pendingFor: undefined,
  }),
  withProps(() => ({
    _chat: inject(ChatStore),
    _api: inject(ApiClient),
    _toasts: inject(ToastStore),
    _translate: inject(Language).t,
    remote: inject(WORKBENCH).remote,
    /** Only the desktop app can ask for the password. */
    canSetUpLinux: isLocalExecution() && typeof window !== 'undefined' && !!window.piKit?.setUpLinuxSandbox,
  })),
  withComputed((store) => ({
    threadId: computed(() => store._chat.threadId()),
    protection: computed(() => {
      const held = store.protectionFor();
      return held?.threadId === store._chat.threadId() ? held?.protection : undefined;
    }),
    error: computed(() => {
      const failed = store.errorFor();
      return failed?.threadId === store._chat.threadId() ? failed?.error : undefined;
    }),
    loading: computed(() => store.loadingFor() !== undefined && store.loadingFor() === store._chat.threadId()),
    pendingStatus: computed(() =>
      store.pendingFor()?.threadId === store._chat.threadId() ? store.pendingFor()?.status : undefined,
    ),
    pending: computed(
      () => store.pendingFor() !== undefined && store.pendingFor()?.threadId === store._chat.threadId(),
    ),
  })),
  withComputed((store) => ({
    mode: computed(() => store.protection()?.mode ?? 'bypass'),
    canOpen: computed(() => !store.pending() && (!!store.protection() || !!store.error())),
    canChange: computed(
      () =>
        !store.remote &&
        !!store.protection() &&
        !store.loading() &&
        !store.pending() &&
        !store._chat.running() &&
        !store._chat.waitingForAnswer(),
    ),
  })),
  withMethods((store) => {
    const take = (threadId: string, protection: ThreadProtection): void => {
      const held = store.protectionFor();
      if (threadId !== store._chat.threadId()) return;
      if (held?.threadId === threadId && protection.generation < held.protection.generation) return;
      patchState(store, {
        protectionFor: { threadId, protection },
        ...(store.errorFor()?.threadId === threadId ? { errorFor: undefined } : {}),
      });
    };

    // Health changes keep the generation, so only the newest read of a thread may land.
    const reads = new Map<string, number>();
    let lastRead = 0;
    const read = async (threadId: string, foreground = false): Promise<void> => {
      const sequence = ++lastRead;
      reads.set(threadId, sequence);
      const latest = () => reads.get(threadId) === sequence;
      if (foreground) patchState(store, { loadingFor: threadId });
      try {
        const protection = await unwrap(threadsGetProtection({ client: store._api.client, path: { id: threadId } }));
        if (latest()) take(threadId, protection);
      } catch (error) {
        if (latest() && threadId === store._chat.threadId())
          patchState(store, { errorFor: { threadId, error: errorMessage(error) } });
      } finally {
        if (latest() && store.loadingFor() === threadId) patchState(store, { loadingFor: undefined });
      }
    };

    const write = async (
      threadId: string | undefined,
      status: 'saving' | 'settingUp',
      request: (threadId: string) => Promise<ThreadProtection>,
    ): Promise<void> => {
      if (!threadId || threadId !== store._chat.threadId() || !store.canChange()) {
        store._toasts.show('warning', store._translate('chat.threadProtection.notApplied'));
        return;
      }
      patchState(store, { pendingFor: { threadId, status } });
      try {
        take(threadId, await request(threadId));
      } catch (error) {
        store._toasts.show(
          'error',
          store._translate(`chat.threadProtection.${status === 'saving' ? 'saveFailed' : 'setupFailed'}`, {
            value1: errorMessage(error),
          }),
        );
      } finally {
        if (store.pendingFor()?.threadId === threadId) patchState(store, { pendingFor: undefined });
      }
    };

    return {
      _read: read,

      retry(): void {
        const threadId = store._chat.threadId();
        if (threadId && !store.loading()) void read(threadId, true);
      },

      change(body: SetThreadProtection, threadId: string | undefined): Promise<void> {
        return write(threadId, 'saving', (id) =>
          unwrap(threadsSetProtection({ client: store._api.client, path: { id }, body })),
        );
      },

      setUpLinux(threadId: string | undefined): Promise<void> {
        return write(threadId, 'settingUp', async (id) => {
          await window.piKit?.setUpLinuxSandbox?.();
          return unwrap(threadsSetProtection({ client: store._api.client, path: { id }, body: { mode: 'sandboxed' } }));
        });
      },
    };
  }),
  withHooks({
    onInit(store) {
      effect(() => {
        const threadId = store._chat.threadId();
        if (threadId) untracked(() => void store._read(threadId, true));
      });
      effect((onCleanup) => {
        const threadId = store._chat.threadId();
        // Bypass too: the owner may enable protection elsewhere, and a remote browser has no Refresh.
        if (!threadId) return;
        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = (): void => {
          timer = setTimeout(async () => {
            if (!store.loading() && !store.pending()) await store._read(threadId);
            if (live) schedule();
          }, 5_000);
        };
        schedule();
        onCleanup(() => {
          live = false;
          clearTimeout(timer);
        });
      });
    },
  }),
);
export type ThreadProtectionStore = InstanceType<typeof ThreadProtectionStore>;
