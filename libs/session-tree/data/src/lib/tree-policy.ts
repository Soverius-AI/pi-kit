import { InjectionToken } from '@angular/core';

export interface TreePolicy {
  readonly refetchDelayMs: number;
  /** How much of a user message with skill blocks the inspector keeps (the blocks are the point; a plain message keeps 120). */
  readonly skillEntryChars: number;
  /** The inspector lists this many entries; the rest is in an export. */
  readonly entryLimit: number;
}

export const DEFAULT_TREE_POLICY: TreePolicy = { refetchDelayMs: 120, skillEntryChars: 4000, entryLimit: 1000 };

/** Runtime policy, overridable at the application or feature injector. */
export const TREE_POLICY = new InjectionToken<TreePolicy>('TREE_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_TREE_POLICY,
});
