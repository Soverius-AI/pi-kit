import { Language } from '@pi-kit/i18n';
import { inject } from '@angular/core';
import { signalStoreFeature, type, withMethods, withState, type SignalStoreFeatureType } from '@ngrx/signals';
import { ApiClient } from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';

import { SETTINGS_POLICY } from '../settings-policy';
import { createSettingsCredentials, type CredentialsState } from './settings-credentials';
import { withSettingsSave } from './with-settings-save';

type Saves = SignalStoreFeatureType<typeof withSettingsSave>;

/** Owns provider sign-in and key workflows; requires only the overview and explicit save/reload operations. */
export function withSettingsCredentials<_>() {
  return signalStoreFeature(
    {
      state: type<Pick<CredentialsState, 'overview'>>(),
      methods: type<Pick<Saves['methods'], '_trackSave' | '_showSaved'> & { load: () => Promise<void> }>(),
    },
    withState<Omit<CredentialsState, 'overview'>>({ flow: undefined, keyWorkflow: undefined, credentialsChanged: 0 }),
    withMethods((store) => {
      const translate = inject(Language).t;
      return createSettingsCredentials(translate, store, {
        api: inject(ApiClient),
        toasts: inject(ToastStore),
        policy: inject(SETTINGS_POLICY),
        track: store._trackSave,
        showSaved: store._showSaved,
        load: store.load,
      });
    }),
  );
}
