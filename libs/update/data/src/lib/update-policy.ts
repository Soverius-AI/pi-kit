import { InjectionToken } from '@angular/core';

export interface UpdatePolicy {
  readonly maxLines: number;
  readonly retryMs: number;
}

/** Runtime policy, overridable at the application or feature injector. */
export const DEFAULT_UPDATE_POLICY: UpdatePolicy = {
  maxLines: 60,
  retryMs: 3000,
};

export const UPDATE_POLICY = new InjectionToken<UpdatePolicy>('UPDATE_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_UPDATE_POLICY,
});
