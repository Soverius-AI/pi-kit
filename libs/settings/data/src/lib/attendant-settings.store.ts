import { signalStore, withHooks } from '@ngrx/signals';
import { withLatestRequest } from '@pi-kit/data-access';
import { withModelList } from './settings/with-model-list';

export const AttendantSettingsStore = signalStore(
  withLatestRequest(),
  withModelList(),
  withHooks({
    onInit(store) {
      void store.loadModels();
    },
  }),
);
export type AttendantSettingsStore = InstanceType<typeof AttendantSettingsStore>;
