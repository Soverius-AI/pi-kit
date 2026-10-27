import { Language } from '@pi-kit/i18n';
import { DestroyRef, inject, NgZone } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import { ApiClient, BackendStatus, healthHealth, unwrap } from '@pi-kit/api';
import { RENDERER_POLICY } from './renderer-policy';
import { withBackendEvents } from './store';
import { ToastStore } from './toast.store';

export type HealthState = 'checking' | 'ok' | 'error';

/**
 * Is the backend there, and is it still the same process ? It polls `GET /api/health`, whose answer carries a `bootId`
 * that is new for every backend process. A change of `bootId`, or a return after an outage, bumps `epoch`; the transcript and
 * the terminal watch it and reconnect their streams (the runner replays the stored log). In the desktop app the
 * watchdog in Electron main also pushes its state over the preload's status channel (`withBackendEvents`), which is how "restarting" is known before the
 * first poll misses.
 */
export const HealthStore = signalStore(
  { providedIn: 'root' },
  withState<{ state: HealthState; epoch: number }>({ state: 'checking', epoch: 0 }),
  withProps(() => ({ _policy: inject(RENDERER_POLICY) })),
  withBackendEvents(),
  withMethods((store) => {
    const translate = inject(Language).t;
    const client = inject(ApiClient).client;
    const toasts = inject(ToastStore);
    let bootId: string | undefined;
    let misses = 0;
    let inFlight: Promise<void> | undefined;

    const answered = (id: string | undefined): void => {
      const wasDown = store.state() === 'error';
      const restarted = bootId !== undefined && id !== undefined && id !== bootId;
      bootId = id ?? bootId;
      misses = 0;
      patchState(store, { state: 'ok' });
      if (restarted) {
        toasts.show('success', translate('shared.healthStore.theBackendRestartedReopeningYourThread'));
        patchState(store, (s) => ({ epoch: s.epoch + 1 }));
      } else if (wasDown) {
        toasts.show('info', translate('shared.healthStore.reconnectedToTheBackend'));
        patchState(store, (s) => ({ epoch: s.epoch + 1 }));
      }
    };

    const missed = (): void => {
      misses += 1;
      if (misses >= store._policy.healthMisses && store.state() !== 'error') patchState(store, { state: 'error' });
    };

    const poll = (): Promise<void> => {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const body = await unwrap(
            healthHealth({ client, parseAs: 'json', signal: AbortSignal.timeout(store._policy.healthTimeoutMs) }),
          );
          if (body.status === 'ok') answered(body.bootId);
          else missed();
        } catch {
          missed();
        } finally {
          inFlight = undefined;
        }
      })();
      return inFlight;
    };

    return {
      async check(): Promise<void> {
        if (store.state() === 'error') patchState(store, { state: 'checking' });
        await poll();
      },
      poll,
      /** The watchdog's state, as it arrives over the status channel. */
      onStatus(status: BackendStatus): void {
        if (status.state === 'restarting') {
          misses = store._policy.healthMisses;
          patchState(store, { state: 'error' });
          toasts.show('warning', translate('shared.healthStore.theBackendStoppedUnexpectedlyRestartingIt'));
        } else if (status.state === 'failed') {
          patchState(store, { state: 'error' });
          toasts.show('error', translate('shared.healthStore.theBackendKeepsStoppingQuitAndReopen'));
        } else if (status.state === 'running') {
          void poll();
        }
      },
    };
  }),
  withHooks({
    onInit(store) {
      void store.check();
      // The poll must not keep Angular's zone busy (it would defeat stability checks); state changes re-enter the zone through signals.
      const timer = inject(NgZone).runOutsideAngular(() =>
        setInterval(() => void store.poll(), store._policy.healthPollMs),
      );
      inject(DestroyRef).onDestroy(() => clearInterval(timer));
      store.watchBackend((status) => store.onStatus(status));
    },
  }),
);
export type HealthStore = InstanceType<typeof HealthStore>;
