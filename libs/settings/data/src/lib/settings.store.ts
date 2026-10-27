import { signalStore } from '@ngrx/signals';
import { withSettingsCredentials } from './settings/with-settings-credentials';
import { withSettingsActions } from './settings/with-settings-actions';
import { withSettingsLifecycle } from './settings/with-settings-lifecycle';
import { withSettingsState } from './settings/with-settings-state';
export { sectionOfTab, type LoginPrompt } from './settings/settings-state';

/** Public facade for settings state, persistence, provider credentials and lifecycle. */
export const SettingsStore = signalStore(
  { providedIn: 'root' },
  withSettingsState(),
  withSettingsActions(),
  withSettingsCredentials(),
  withSettingsLifecycle(),
);
export type SettingsStore = InstanceType<typeof SettingsStore>;
