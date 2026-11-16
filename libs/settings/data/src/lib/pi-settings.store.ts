import { signalStore, withHooks } from '@ngrx/signals';
import { withLatestRequest } from '@pi-kit/data-access';
import { withPiSettings } from './settings/with-pi-settings';

export const PiSettingsStore = signalStore(
  withLatestRequest(),
  withPiSettings(),
  withHooks({
    onInit(store) {
      void store.loadSettings();
    },
  }),
);
export type PiSettingsStore = InstanceType<typeof PiSettingsStore>;
