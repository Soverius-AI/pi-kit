import { InjectionToken } from '@angular/core';

export interface FilesPolicy {
  readonly typeAheadMs: number;
  readonly searchDelayMs: number;
}

/** Runtime policy, overridable at the application or feature injector. */
export const DEFAULT_FILES_POLICY: FilesPolicy = {
  typeAheadMs: 700,
  searchDelayMs: 120,
};

export const FILES_POLICY = new InjectionToken<FilesPolicy>('FILES_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_FILES_POLICY,
});
