import { DestroyRef, inject } from '@angular/core';
import { patchState, signalStoreFeature, withMethods, withState } from '@ngrx/signals';
import { errorMessage } from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import { SETTINGS_POLICY } from '../settings-policy';

export function withSettingsSave() {
  return signalStoreFeature(
    withState({ saving: 0, saved: false, reloadReasons: [] as string[] }),
    withMethods((store) => {
      const toasts = inject(ToastStore);
      const policy = inject(SETTINGS_POLICY);
      let timer: ReturnType<typeof setTimeout> | undefined;
      inject(DestroyRef).onDestroy(() => clearTimeout(timer));
      const showSaved = (): void => {
        clearTimeout(timer);
        patchState(store, { saved: true });
        timer = setTimeout(() => patchState(store, { saved: false }), policy.savedMs);
      };
      return {
        _showSaved: showSaved,
        _needReload(reason: string): void {
          patchState(store, (s) => ({
            reloadReasons: s.reloadReasons.includes(reason) ? s.reloadReasons : [...s.reloadReasons, reason],
          }));
        },
        async _trackSave<T>(work: () => Promise<T>, failure: string): Promise<T | undefined> {
          patchState(store, (s) => ({ saving: s.saving + 1 }));
          try {
            const value = await work();
            showSaved();
            return value;
          } catch (error) {
            toasts.show('error', `${failure}: ${errorMessage(error)}`);
            return undefined;
          } finally {
            patchState(store, (s) => ({ saving: s.saving - 1 }));
          }
        },
      };
    }),
  );
}
