import { DestroyRef, inject } from '@angular/core';
import { signalStoreFeature, withMethods } from '@ngrx/signals';

export interface PollingOptions {
  intervalMs: number;
  /** Must ignore an aborted result, or pass this signal to a latest request. */
  run: (signal: AbortSignal) => Promise<void>;
  error?: (error: unknown) => void;
}

/** Poll while a consumer is active. Wait between completed reads, so slow requests never overlap. */
export function withPolling() {
  return signalStoreFeature(
    withMethods(() => {
      const destroyRef = inject(DestroyRef);
      const polls = new Map<string, { abort: AbortController; timer?: ReturnType<typeof setTimeout> }>();
      const stop = (key: string): void => {
        const poll = polls.get(key);
        if (!poll) return;
        poll.abort.abort();
        clearTimeout(poll.timer);
        polls.delete(key);
      };
      destroyRef.onDestroy(() => {
        for (const key of polls.keys()) stop(key);
      });
      return {
        _stopPolling: stop,
        _startPolling(key: string, options: PollingOptions): void {
          if (destroyRef.destroyed) return;
          stop(key);
          const poll = { abort: new AbortController(), timer: undefined as ReturnType<typeof setTimeout> | undefined };
          polls.set(key, poll);
          const tick = async (): Promise<void> => {
            try {
              await options.run(poll.abort.signal);
            } catch (error) {
              if (!poll.abort.signal.aborted) options.error?.(error);
            } finally {
              if (!poll.abort.signal.aborted) poll.timer = setTimeout(() => void tick(), options.intervalMs);
            }
          };
          void tick();
        },
      };
    }),
  );
}
