import { EMPTY, Observable, catchError, defer, endWith, repeat, tap, timer } from 'rxjs';

/** Shared transport signal for an ended or refused long-lived connection. */
export type Dropped = { type: 'dropped' };

/** Reopens an event transport until unsubscribed; RxJS owns retry scheduling and its cancellation. */
export function reconnectingEvents<T>(
  connect: (signal: AbortSignal, onEvent: (event: T) => void) => Promise<void>,
  retryMs: readonly [number, ...number[]],
  resetOnEvent: boolean,
): Observable<T | Dropped> {
  return defer(() => {
    let attempt = 0;
    return new Observable<T>((subscriber) => {
      const abort = new AbortController();
      void connect(abort.signal, (event) => subscriber.next(event)).then(
        () => subscriber.complete(),
        (error) => subscriber.error(error),
      );
      return () => abort.abort();
    }).pipe(
      tap(() => {
        if (resetOnEvent) attempt = 0;
      }),
      catchError(() => EMPTY),
      endWith<T | Dropped>({ type: 'dropped' }),
      repeat({ delay: () => timer(retryMs[Math.min(attempt++, retryMs.length - 1)]) }),
    );
  });
}
