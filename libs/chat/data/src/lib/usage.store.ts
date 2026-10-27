import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withProps, withState } from '@ngrx/signals';
import { ApiClient, errorMessage, sessionUsage, unwrap } from '@pi-kit/api';
import { Language } from '@pi-kit/i18n';

import type { ThreadUsage } from '@pi-kit/protocol';
import { ChatStore } from './chat.store';
import { CommandRegistry } from './commands';

interface UsagePopoverState {
  /** The thread the popover was opened for, or undefined when closed: another thread closes it without anything having to notice. */
  openFor: string | undefined;
  /** The usage and the thread it was read for. */
  usageFor: { threadId: string; usage: ThreadUsage } | undefined;
  loading: boolean;
  error: string | undefined;
}

/**
 * The popover the context ring opens (doc/docs/design-system.md, "Composer"): what is in the window, where pi compacts, what the thread
 * cost by model and how much of the input came from the cache. The fill and the compaction point are `ChatStore`'s live signals; the cost by model
 * and the cache hit come from the session file (`GET /api/threads/:id/usage`) and are read each time the popover opens.
 */
export const UsageStore = signalStore(
  { providedIn: 'root' },
  withState<UsagePopoverState>({ openFor: undefined, usageFor: undefined, loading: false, error: undefined }),
  withProps(() => ({ _chat: inject(ChatStore) })),
  withComputed((store) => ({
    open: computed(() => store.openFor() !== undefined && store.openFor() === store._chat.threadId()),
    usage: computed(() =>
      store.usageFor()?.threadId === store._chat.threadId() ? store.usageFor()?.usage : undefined,
    ),
  })),
  withComputed((store) => ({
    /** Cost by model, the dearest first; a free local model is left out unless it is the only one. */
    models: computed(() => {
      const rows = [...(store.usage()?.byModel ?? [])].sort((a, b) => b.cost - a.cost);
      const paid = rows.filter((m) => m.cost > 0);
      return (paid.length > 0 ? paid : rows).map((m) => ({
        key: `${m.provider}/${m.model}`,
        model: m.model,
        cost: m.cost,
        free: m.cost === 0,
      }));
    }),
    /** `78%`, or undefined when nothing was sent yet. */
    cacheHit: computed(() => {
      const ratio = store.usage()?.cacheHitRatio;
      return ratio == null ? undefined : `${Math.round(ratio * 100)}%`;
    }),
  })),
  withMethods((store) => {
    const translate = inject(Language).t;
    const chat = store._chat;
    const api = inject(ApiClient);
    const registry = inject(CommandRegistry);

    async function load(): Promise<void> {
      const id = chat.threadId();
      if (!id) return;
      patchState(store, { loading: true });
      try {
        const usage = await unwrap(sessionUsage({ client: api.client, path: { id } }));
        patchState(store, { usageFor: { threadId: id, usage }, error: undefined });
      } catch (error) {
        patchState(store, { error: errorMessage(error) });
      } finally {
        patchState(store, { loading: false });
      }
    }

    const close = (): void => patchState(store, { openFor: undefined });

    return {
      load,
      close,
      toggle(): void {
        if (store.open()) return close();
        patchState(store, { openFor: chat.threadId() });
        void load();
      },
      /** "Usage by turn": the usage dialog (`/cost`). */
      async openDialog(): Promise<void> {
        close();
        await registry.showUsage();
      },
      /** "Compact now": pi's `/compact` through the command registry; not while a run is going (pi compacts between turns). */
      async compactNow(): Promise<void> {
        close();
        const command = chat.findCommand('compact');
        if (command) await registry.run(command);
        else chat.say('warning', translate('chat.usageStore.compactUnavailable'));
      },
    };
  }),
);
export type UsageStore = InstanceType<typeof UsageStore>;
