import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { ApiClient, computerUseOpen, computerUseSet, computerUseState, errorMessage, unwrap } from '@pi-kit/api';
import type { ComputerUsePermission, ComputerUseState } from '@pi-kit/protocol';

interface ComputerUseStoreState {
  state: ComputerUseState | undefined;
  /** The switch or a permission page is being changed. */
  busy: boolean;
  error: string | undefined;
}

/**
 * Settings › Computer use (`@pi-kit/computer-use`): the switch, which app macOS asks and, on macOS while computer use is on, what it has granted. The page reads it again
 * every few seconds and whenever the window gets the focus back from System Settings, so a permission switched on there shows here without a click. The backend
 * reloads the idle sessions after the switch changes; Relaunch is the desktop app's (`window.piKit.relaunch`), because macOS applies Screen Recording only then.
 */
export const ComputerUseStore = signalStore(
  { providedIn: 'root' },
  withState<ComputerUseStoreState>({ state: undefined, busy: false, error: undefined }),
  withMethods((store) => {
    const api = inject(ApiClient);
    const run = async (call: () => Promise<ComputerUseState>): Promise<void> => {
      patchState(store, { busy: true });
      try {
        patchState(store, { state: await call(), error: undefined });
      } catch (error) {
        patchState(store, { error: errorMessage(error) });
      } finally {
        patchState(store, { busy: false });
      }
    };
    return {
      async load(): Promise<void> {
        try {
          patchState(store, { state: await unwrap(computerUseState({ client: api.client })), error: undefined });
        } catch (error) {
          patchState(store, { error: errorMessage(error) });
        }
      },
      setEnabled(enabled: boolean): Promise<void> {
        return run(() => unwrap(computerUseSet({ client: api.client, body: { enabled } })));
      },
      open(permission: ComputerUsePermission): Promise<void> {
        return run(() => unwrap(computerUseOpen({ client: api.client, path: { permission } })));
      },
      /** Whether this window can relaunch the app (the desktop app; not a browser tab). */
      canRelaunch(): boolean {
        return typeof window !== 'undefined' && typeof window.piKit?.relaunch === 'function';
      },
      relaunch(): Promise<void> {
        return window.piKit?.relaunch?.() ?? Promise.resolve();
      },
    };
  }),
);
