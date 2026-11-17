import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { ApiClient, errorMessage, settingsWatchdog, settingsSetWatchdog, unwrap } from '@pi-kit/api';
import type { WatchdogSettings } from '@pi-kit/protocol';

/** Owner-only host recovery settings, also available from an owner browser. */
export const WatchdogStore = signalStore(
  { providedIn: 'root' },
  withState({ status: undefined as WatchdogSettings | undefined, busy: false, error: undefined as string | undefined }),
  withMethods((store) => {
    const api = inject(ApiClient);
    return {
      async load(): Promise<void> {
        try {
          patchState(store, { status: await unwrap(settingsWatchdog({ client: api.client })), error: undefined });
        } catch (error) {
          patchState(store, { error: errorMessage(error) });
        }
      },
      async setEnabled(enabled: boolean): Promise<void> {
        if (store.busy()) return;
        patchState(store, { busy: true, error: undefined });
        try {
          patchState(store, { status: await unwrap(settingsSetWatchdog({ client: api.client, body: { enabled } })) });
        } catch (error) {
          patchState(store, { error: errorMessage(error) });
        } finally {
          patchState(store, { busy: false });
        }
      },
    };
  }),
);
