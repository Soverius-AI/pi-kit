import { InjectionToken } from '@angular/core';

export interface ReviewPolicy {
  readonly mirrorDelayMs: number;
}

/** Runtime policy, overridable at the application or feature injector. */
export const DEFAULT_REVIEW_POLICY: ReviewPolicy = {
  mirrorDelayMs: 400,
};

export const REVIEW_POLICY = new InjectionToken<ReviewPolicy>('REVIEW_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_REVIEW_POLICY,
});
