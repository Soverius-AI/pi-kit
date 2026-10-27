import { InjectionToken } from '@angular/core';

/** True on macOS/iOS; overridable per application or test injector. */
export const IS_MAC = new InjectionToken<boolean>('IS_MAC', {
  providedIn: 'root',
  factory: () =>
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || ''),
});
