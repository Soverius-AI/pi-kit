import { InjectionToken } from '@angular/core';
import { DEFAULT_CONTEXT_THRESHOLDS, type ContextThresholds } from '@pi-kit/ui';

export const CONTEXT_POLICY = new InjectionToken<ContextThresholds>('CONTEXT_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_CONTEXT_THRESHOLDS,
});
