import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { type BackgroundServiceStatus, errorMessage, isLocalExecution } from '@pi-kit/api';

interface BackgroundServiceStoreState {
  /** Undefined until read, and where this window cannot manage it (a browser tab, a paired phone). */
  status: BackgroundServiceStatus | undefined;
  /** The switch is moving the backend; the app restarts when it is done. */
  busy: boolean;
  error: string | undefined;
}

const bridge = () => (isLocalExecution() && typeof window !== 'undefined' ? window.piKit : undefined);

/**
 * Settings › General › Background (ADR-0036): whether the backend keeps running as a service the operating system starts at
 * sign-in. Only the desktop app manages it; switching restarts the app, which moves the backend into or out of the service.
 */
export const BackgroundServiceStore = signalStore(
  { providedIn: 'root' },
  withState<BackgroundServiceStoreState>({ status: undefined, busy: false, error: undefined }),
  withMethods((store) => ({
    async load(): Promise<void> {
      const get = bridge()?.getBackgroundService;
      if (!get) return;
      try {
        patchState(store, { status: await get(), error: undefined });
      } catch (error) {
        patchState(store, { error: errorMessage(error) });
      }
    },
    async installCommand(): Promise<void> {
      const install = bridge()?.installCommand;
      const status = store.status();
      if (!install || !status) return;
      try {
        patchState(store, { status: { ...status, cli: await install() }, error: undefined });
      } catch (error) {
        patchState(store, { error: errorMessage(error) });
      }
    },
    async setEnabled(enabled: boolean): Promise<void> {
      const set = bridge()?.setBackgroundService;
      if (!set) return;
      patchState(store, { busy: true, error: undefined });
      try {
        await set(enabled);
      } catch (error) {
        patchState(store, { busy: false, error: errorMessage(error) });
      }
    },
  })),
);
