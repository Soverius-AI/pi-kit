import { DestroyRef, inject } from '@angular/core';
import { patchState, signalStoreFeature, withMethods, withState } from '@ngrx/signals';
import { errorMessage } from '@pi-kit/api';

/** Per-operation status exposed by a latest-request store feature. */
export interface LatestRequestState {
  status: 'loading' | 'idle' | 'error';
  error?: string;
}

export interface LatestRequestOptions<T> {
  /** Check ownership as well as request order (for example, the currently selected thread). */
  valid?: () => boolean;
  signal?: AbortSignal;
  next?: (value: T) => void;
  error?: (error: unknown) => void;
  settled?: () => void;
}

/** Independent latest-wins reads, keyed by operation/resource. Only the owner may publish data, errors or completion. */
export function withLatestRequest() {
  return signalStoreFeature(
    withState({ _requestStates: {} as Record<string, LatestRequestState> }),
    withMethods((store) => {
      const destroyRef = inject(DestroyRef);
      const pending = new Map<string, AbortController>();
      const forget = (key: string): void =>
        patchState(store, (s) => {
          const next = { ...s._requestStates };
          delete next[key];
          return { _requestStates: next };
        });
      const cancel = (key: string): void => {
        pending.get(key)?.abort();
        pending.delete(key);
        forget(key);
      };
      const cancelAll = (): void => {
        for (const key of pending.keys()) cancel(key);
        patchState(store, { _requestStates: {} });
      };
      destroyRef.onDestroy(cancelAll);
      return {
        _cancelRequest: cancel,
        _cancelRequests: cancelAll,
        async _request<T>(
          key: string,
          work: (signal: AbortSignal) => Promise<T>,
          options: LatestRequestOptions<T> = {},
        ): Promise<T | undefined> {
          if (destroyRef.destroyed) return undefined;
          cancel(key);
          if (options.signal?.aborted) return undefined;
          const abort = new AbortController();
          pending.set(key, abort);
          const current = (): boolean =>
            pending.get(key) === abort && !abort.signal.aborted && (options.valid?.() ?? true);
          const cancelFromParent = (): void => {
            if (pending.get(key) === abort) cancel(key);
          };
          options.signal?.addEventListener('abort', cancelFromParent, { once: true });
          patchState(store, (s) => ({
            _requestStates: { ...s._requestStates, [key]: { status: 'loading' as const } },
          }));
          try {
            const value = await work(abort.signal);
            if (!current()) return undefined;
            patchState(store, (s) => ({ _requestStates: { ...s._requestStates, [key]: { status: 'idle' as const } } }));
            options.next?.(value);
            return current() ? value : undefined;
          } catch (error) {
            if (current()) {
              patchState(store, (s) => ({
                _requestStates: {
                  ...s._requestStates,
                  [key]: { status: 'error' as const, error: errorMessage(error) },
                },
              }));
              options.error?.(error);
            }
            return undefined;
          } finally {
            options.signal?.removeEventListener('abort', cancelFromParent);
            if (pending.get(key) === abort) {
              if (current()) options.settled?.();
              else forget(key);
              if (pending.get(key) === abort) pending.delete(key);
            }
          }
        },
      };
    }),
  );
}
