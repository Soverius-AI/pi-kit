import { DestroyRef, inject } from '@angular/core';
import { patchState, signalStore, withHooks, withState } from '@ngrx/signals';

/** A signal that ticks once a second, for elapsed times on running rows. */
export const ClockStore = signalStore(
  { providedIn: 'root' },
  withState({ now: Date.now() }),
  withHooks({
    onInit(store) {
      const timer = setInterval(() => patchState(store, { now: Date.now() }), 1000);
      inject(DestroyRef).onDestroy(() => clearInterval(timer));
    },
  }),
);
export type ClockStore = InstanceType<typeof ClockStore>;
