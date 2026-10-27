/** Shared defaults for the transcript meter and the sidebar's context badges. */
export interface ContextThresholds {
  readonly warning: number;
  readonly error: number;
}
export const DEFAULT_CONTEXT_THRESHOLDS: ContextThresholds = { warning: 70, error: 90 };
