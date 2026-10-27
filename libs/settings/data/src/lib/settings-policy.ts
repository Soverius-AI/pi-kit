import { InjectionToken } from '@angular/core';

export interface SettingsPolicy {
  readonly savedMs: number;
  readonly connectorPollMs: number;
  readonly loginWaitMs: number;
  readonly loginPollMs: number;
}

/** Runtime policy, overridable at the application or feature injector. */
export const DEFAULT_SETTINGS_POLICY: SettingsPolicy = {
  savedMs: 2500,
  connectorPollMs: 2000,
  loginWaitMs: 10000,
  loginPollMs: 100,
};

export const SETTINGS_POLICY = new InjectionToken<SettingsPolicy>('SETTINGS_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_SETTINGS_POLICY,
});
