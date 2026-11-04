import { BROWSER_STEP_TIMEOUT_MS, BrowserOperationError } from '@pi-kit/protocol';

/** Bound native/CDP operations which may never settle. Late replies are observed but discarded. */
export function browserStep<T>(
  work: () => Promise<T>,
  message: string,
  options: { signal?: AbortSignal; timeoutMs?: number; interrupted?: (error: BrowserOperationError) => void } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = (ok: boolean, value: unknown): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      if (ok) resolve(value as T);
      else reject(value);
    };
    const interrupt = (error: BrowserOperationError): void => {
      if (finished) return;
      // Reject with the original reason even if retiring a native page throws.
      finish(false, error);
      try {
        options.interrupted?.(error);
      } catch {
        /* already destroyed */
      }
    };
    const cancel = (): void => interrupt(new BrowserOperationError('cancelled', 'Browser action cancelled.'));
    const timer = setTimeout(
      () => interrupt(new BrowserOperationError('timeout', message)),
      options.timeoutMs ?? BROWSER_STEP_TIMEOUT_MS,
    );
    if (options.signal?.aborted) {
      cancel();
      return;
    }
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      void work().then(
        (value) => finish(true, value),
        (error: unknown) => finish(false, error),
      );
    } catch (error) {
      finish(false, error);
    }
  });
}
