import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import type { ThreadSummary } from '@pi-kit/protocol';
import type { PkMenuItem } from '@pi-kit/ui';
import { ThreadShell } from './ports';
import { ThreadsStore } from './threads.store';

/**
 * Another part of pi-kit adding to the outcome badge's menu. EXTENSION POINT: `LearnStore` registers "Learn a skill from this thread" and `ScoreStore`
 * "Score this thread" here with `OutcomeMenuStore.extend(...)`; its items follow the built-in ones, and `run` is called when one of them is chosen. Item ids must be
 * namespaced by the contributor (`learn:draft`) so they never meet a built-in id.
 */
export interface OutcomeMenuContribution {
  /** The items to add for this thread (none to add nothing). */
  items(thread: ThreadSummary): readonly PkMenuItem[];
  run(itemId: string, thread: ThreadSummary): void | Promise<void>;
}

export const OUTCOME_SHOW = 'outcome:show';
export const OUTCOME_PR = 'outcome:pr';

interface OutcomeMenuState {
  /** The open menu: the thread it belongs to and where it was opened (viewport coordinates of the badge). */
  open: { threadId: string; x: number; y: number } | undefined;
  contributions: readonly OutcomeMenuContribution[];
}

/**
 * The menu of the outcome badge: "Show the outcome" (review mode on the Outcome source) and, for a pull request, "Open the pull
 * request". The badge is on the sidebar row and at the end of the breadcrumb strip; both ask this store to open the menu and one host draws it.
 */
export const OutcomeMenuStore = signalStore(
  { providedIn: 'root' },
  withState<OutcomeMenuState>({ open: undefined, contributions: [] }),
  withComputed((store) => {
    const translate = inject(Language).t;
    const threads = inject(ThreadsStore);
    const thread = computed(() => {
      const open = store.open();
      return open ? threads.threads().find((t) => t.id === open.threadId) : undefined;
    });
    return {
      thread,
      items: computed<PkMenuItem[]>(() => {
        const t = thread();
        const outcome = t?.state.outcome;
        if (!t || !outcome) return [];
        const items: PkMenuItem[] = [{ id: OUTCOME_SHOW, label: translate('threads.outcomeMenuStore.showTheOutcome') }];
        if (outcome.kind === 'pr' && outcome.url)
          items.push({ id: OUTCOME_PR, label: translate('threads.outcomeMenuStore.openThePullRequest') });
        for (const contribution of store.contributions()) items.push(...contribution.items(t));
        return items;
      }),
    };
  }),
  withMethods((store) => {
    // The shell opens review mode (it lives in the app, which may import the review domain; this library may not): a port, like the waiting badge's.
    const shell = inject(ThreadShell);

    return {
      /** Opens the menu of a thread's badge at a point (the badge's lower left corner). */
      openFor(threadId: string, x: number, y: number): void {
        patchState(store, { open: { threadId, x, y } });
      },

      close(): void {
        patchState(store, { open: undefined });
      },

      /** Adds to the menu; returns the function that takes it away again. */
      extend(contribution: OutcomeMenuContribution): () => void {
        patchState(store, (s) => ({ contributions: [...s.contributions, contribution] }));
        return () => patchState(store, (s) => ({ contributions: s.contributions.filter((c) => c !== contribution) }));
      },

      async choose(itemId: string): Promise<void> {
        const thread = store.thread();
        patchState(store, { open: undefined });
        if (!thread) return;
        if (itemId === OUTCOME_SHOW) return shell.openOutcome(thread.id);
        if (itemId === OUTCOME_PR) {
          const url = thread.state.outcome?.url;
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
          return;
        }
        for (const contribution of store.contributions()) {
          if (contribution.items(thread).some((item) => item.id === itemId)) return contribution.run(itemId, thread);
        }
      },
    };
  }),
);
export type OutcomeMenuStore = InstanceType<typeof OutcomeMenuStore>;
