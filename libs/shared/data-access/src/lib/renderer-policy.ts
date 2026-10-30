import { InjectionToken } from '@angular/core';

export interface RendererPolicy {
  readonly healthTimeoutMs: number;
  readonly healthPollMs: number;
  readonly healthMisses: number;
  readonly toastMs: number;
  readonly maxToasts: number;
  readonly providerUsageFreshMs: number;
}

/** Runtime policy, overridable at the application or feature injector. */
export const DEFAULT_RENDERER_POLICY: RendererPolicy = {
  healthPollMs: 10000,
  healthTimeoutMs: 30000,
  healthMisses: 2,
  toastMs: 6000,
  maxToasts: 4,
  providerUsageFreshMs: 30000,
};

export const RENDERER_POLICY = new InjectionToken<RendererPolicy>('RENDERER_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_RENDERER_POLICY,
});
