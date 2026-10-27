import { computed } from '@angular/core';
import { patchState, signalStoreFeature, withComputed, withMethods, withState } from '@ngrx/signals';
import { errorMessage } from '@pi-kit/api';

/** Where a store's main request stands. */
export type RequestStatus = 'idle' | 'loading' | 'error';

/**
 * `idle` / `loading` / `error` for the one request a store is mostly about (the thread list, the session tree, the settings overview). `error`
 * carries the message the view shows. A store with a second, independent request keeps that one in its own state.
 */
export function withRequestStatus() {
  return signalStoreFeature(
    withState<{ requestStatus: RequestStatus; error: string | undefined }>({ requestStatus: 'idle', error: undefined }),
    withComputed(({ requestStatus }) => ({
      loading: computed(() => requestStatus() === 'loading'),
      failed: computed(() => requestStatus() === 'error'),
    })),
    withMethods((store) => ({
      requestStarted(): void {
        patchState(store, { requestStatus: 'loading', error: undefined });
      },
      requestDone(): void {
        patchState(store, { requestStatus: 'idle', error: undefined });
      },
      requestFailed(error: unknown): void {
        patchState(store, { requestStatus: 'error', error: errorMessage(error) });
      },
      clearError(): void {
        patchState(store, { requestStatus: 'idle', error: undefined });
      },
    })),
  );
}
