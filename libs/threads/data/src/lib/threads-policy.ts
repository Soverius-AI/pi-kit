import { InjectionToken } from '@angular/core';

export interface ThreadsPolicy {
  readonly listPollMs: number;
  readonly safetyRefreshPolls: number;
  readonly retryMs: readonly [number, ...number[]];
  readonly watchGraceMs: number;
  readonly attendantPollMs: number;
  readonly learnPollMs: number;
  readonly learnedPollMs: number;
  readonly coordinationRefreshMs: number;
  readonly changesSettleMs: number;
  readonly changesRefreshMs: number;
}

export const DEFAULT_THREADS_POLICY: ThreadsPolicy = {
  listPollMs: 5000,
  safetyRefreshPolls: 12,
  retryMs: [1000, 2000, 5000, 10000],
  watchGraceMs: 3000,
  attendantPollMs: 4000,
  learnPollMs: 1500,
  learnedPollMs: 1500,
  coordinationRefreshMs: 20000,
  changesSettleMs: 800,
  changesRefreshMs: 10000,
};

/** Runtime policy, overridable at the application or feature injector. */
export const THREADS_POLICY = new InjectionToken<ThreadsPolicy>('THREADS_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_THREADS_POLICY,
});
