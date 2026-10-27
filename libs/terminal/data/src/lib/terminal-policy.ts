import { InjectionToken } from '@angular/core';

export interface TerminalPolicy {
  readonly maxRetries: number;
  readonly baseRetryMs: number;
  readonly resizeDelayMs: number;
}

/** Runtime policy, overridable at the application or feature injector. */
export const DEFAULT_TERMINAL_POLICY: TerminalPolicy = {
  maxRetries: 5,
  baseRetryMs: 1000,
  resizeDelayMs: 80,
};

export const TERMINAL_POLICY = new InjectionToken<TerminalPolicy>('TERMINAL_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_TERMINAL_POLICY,
});
