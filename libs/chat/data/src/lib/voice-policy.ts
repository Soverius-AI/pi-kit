import { InjectionToken } from '@angular/core';

export interface VoicePolicy {
  readonly readyWaitMs: number;
  readonly errorMs: number;
  readonly statusPollMs: number;
}

/** Runtime policy, overridable at the application or feature injector. */
export const DEFAULT_VOICE_POLICY: VoicePolicy = {
  readyWaitMs: 3000,
  errorMs: 9000,
  statusPollMs: 500,
};

export const VOICE_POLICY = new InjectionToken<VoicePolicy>('VOICE_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_VOICE_POLICY,
});
