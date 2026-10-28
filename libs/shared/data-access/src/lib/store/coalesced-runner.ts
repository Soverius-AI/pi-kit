/**
 * A runner for `work` that never overlaps itself: a call that arrives while a run is going is coalesced with any others into one trailing run with
 * the newest value, and every caller's promise settles with the run that covers its call. For reads the backend cannot cancel once started, where a
 * burst of requests must collapse into one request now and one at the end.
 */
export function coalescedRunner<T>(work: (value: T) => Promise<void>): (value: T) => Promise<void> {
  let running: Promise<void> | undefined;
  let trailing: { value: T } | undefined;
  return (value: T): Promise<void> => {
    if (running) {
      trailing = { value };
      return running;
    }
    running = (async () => {
      try {
        let next: { value: T } | undefined = { value };
        while (next) {
          trailing = undefined;
          await work(next.value);
          next = trailing;
        }
      } finally {
        running = undefined;
        trailing = undefined;
      }
    })();
    return running;
  };
}
