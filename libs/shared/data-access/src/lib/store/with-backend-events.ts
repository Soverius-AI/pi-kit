import { InjectionToken, Injector, NgZone, inject } from '@angular/core';
import { patchState, signalStoreFeature, withMethods, withProps, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { BackendStatus } from '@pi-kit/api';
import { Observable, tap } from 'rxjs';

/**
 * The backend watchdog's status channel (apps/desktop/src/watchdog.ts over the preload): an observable of its states. A browser
 * (`npm run dev:web`) has no channel, so it never emits. Tests provide their own.
 */
export const BACKEND_STATUS = new InjectionToken<Observable<BackendStatus>>('BACKEND_STATUS', {
  providedIn: 'root',
  factory: () => {
    const zone = inject(NgZone);
    return new Observable<BackendStatus>((subscriber) => {
      const off = window.piKit?.onBackendStatus?.((status) => zone.run(() => subscriber.next(status)));
      return () => off?.();
    });
  },
});

/**
 * Follows the status channel: the newest status is state (`backendStatus`), and `watchBackend(handler)` calls the store's own reaction on every
 * event for the life of the store. Call it from `onInit`.
 */
export function withBackendEvents() {
  return signalStoreFeature(
    withState<{ backendStatus: BackendStatus | undefined }>({ backendStatus: undefined }),
    withProps(() => ({ _channel: inject(BACKEND_STATUS), _injector: inject(Injector) })),
    withMethods((store) => ({
      watchBackend(handler: (status: BackendStatus) => void): void {
        const follow = rxMethod<BackendStatus>(
          tap((status) => {
            patchState(store, { backendStatus: status });
            handler(status);
          }),
          { injector: store._injector },
        );
        follow(store._channel);
      },
    })),
  );
}
