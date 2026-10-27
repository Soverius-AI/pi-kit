import { type AbstractAgent, type Message } from '@ag-ui/client';
import { DestroyRef, inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { type ChatSessionState } from './chat/chat-state';

export type ReplayView = Pick<
  ChatSessionState,
  | 'thinkTimes'
  | 'queue'
  | 'compacting'
  | 'retry'
  | 'runError'
  | 'lastAborted'
  | 'promptActive'
  | 'statuses'
  | 'liveContextTokens'
  | 'liveCost'
  | 'liveTokens'
  | 'liveTurns'
  | 'stats'
>;
export interface CachedThreadReplay {
  cursor: string;
  messages: Message[];
  state: unknown;
  interrupts: AbstractAgent['pendingInterrupts'];
  view?: ReplayView;
  visitedAt: number;
}
export const THREAD_CACHE_IDLE_MS = 15 * 60_000;

/** Visited transcripts stay in signals; neither navigation nor a sync clears their rendered messages. */
export const ThreadReplayCacheStore = signalStore(
  { providedIn: 'root' },
  withState({ entries: {} as Record<string, CachedThreadReplay>, activeId: undefined as string | undefined }),
  withMethods((store) => ({
    activate(id: string | undefined, now = Date.now()) {
      const entries = Object.fromEntries(
        Object.entries(store.entries()).filter(
          ([key, entry]) => key === store.activeId() || now - entry.visitedAt < THREAD_CACHE_IDLE_MS,
        ),
      );
      // Time spent reading the active thread never counts as idle time.
      for (const key of [store.activeId(), id])
        if (key && entries[key]) entries[key] = { ...entries[key], visitedAt: now };
      patchState(store, { entries, activeId: id });
    },
    record(id: string, value: Omit<CachedThreadReplay, 'visitedAt'>) {
      if (id !== store.activeId()) return;
      patchState(store, { entries: { ...store.entries(), [id]: { ...value, visitedAt: Date.now() } } });
    },
    forget(id: string) {
      const entries = { ...store.entries() };
      delete entries[id];
      patchState(store, { entries });
    },
    prune(memoryPressure = false, now = Date.now()) {
      const entries = Object.fromEntries(
        Object.entries(store.entries()).filter(
          ([id, entry]) => id === store.activeId() || (!memoryPressure && now - entry.visitedAt < THREAD_CACHE_IDLE_MS),
        ),
      );
      if (Object.keys(entries).length !== Object.keys(store.entries()).length) patchState(store, { entries });
    },
  })),
  withHooks({
    onInit(store) {
      // Chromium exposes heap pressure where available; hosts can also forward a memorypressure event.
      const check = () => {
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } })
          .memory;
        store.prune(!!memory && memory.usedJSHeapSize > memory.jsHeapSizeLimit * 0.8);
      };
      const pressure = () => store.prune(true);
      const timer = setInterval(check, 30_000);
      window.addEventListener('memorypressure', pressure);
      inject(DestroyRef).onDestroy(() => {
        clearInterval(timer);
        window.removeEventListener('memorypressure', pressure);
      });
    },
  }),
);
