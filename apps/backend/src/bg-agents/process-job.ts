/**
 * What survives a crash around a `bash` call, and what holds an agent back. pi-durable's `NodeExecutionEnv`
 * runs a command detached in its own process group and kills the group when the call is aborted, so Stop needs nothing
 * from here. A crash of the backend is different: the command's processes may keep running, and nothing can prove they
 * are gone. So the intent of every `bash` call is persisted before the command runs (`bg_agents.cleanup_json`) and cleared
 * after it; an agent found with an intent at the next start is held until the user discards it ("Discard and resume").
 * The same hold pauses an agent that restarted too often (the crash-loop limit).
 */
export interface CleanupIntent {
  callId: string;
  command: string;
  startedAt: number;
}

export type HoldReason = 'cleanup' | 'crash-loop';

/** The command's intent as the tool hook sees the call. */
export function cleanupIntent(callId: string, args: Record<string, unknown>): CleanupIntent {
  return { callId, command: String(args['command'] ?? ''), startedAt: Date.now() };
}

/** Whether a start now is the third within the window (three in ten minutes pause the agent). */
export const CRASH_LOOP_LIMIT = 3;
export const CRASH_LOOP_WINDOW_MS = 10 * 60_000;
export function crashLoop(failures: readonly number[], now = Date.now()): { failures: number[]; looping: boolean } {
  const recent = failures.filter((at) => now - at < CRASH_LOOP_WINDOW_MS);
  recent.push(now);
  return { failures: recent, looping: recent.length >= CRASH_LOOP_LIMIT };
}

/**
 * The agents held back, by conversation id. A hook of the agent extension awaits `until()` before every model request
 * and tool call: a held agent runs no code until `release()`, and a restart finds it exactly where it was, because the
 * waiting happens inside the durable task. An abort of the task ends the wait too.
 */
export class Holds {
  private readonly held = new Map<string, { reason: HoldReason; promise: Promise<void>; release: () => void }>();

  hold(id: string, reason: HoldReason): void {
    if (this.held.has(id)) return;
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    this.held.set(id, { reason, promise, release });
  }

  release(id: string): void {
    const entry = this.held.get(id);
    this.held.delete(id);
    entry?.release();
  }

  reasonOf(id: string): HoldReason | undefined {
    return this.held.get(id)?.reason;
  }

  /** Resolves at once for an agent that is not held, when it is released, or when the asking task is aborted. */
  until(id: string, signal: AbortSignal | undefined): Promise<void> {
    const entry = this.held.get(id);
    if (!entry || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        signal?.removeEventListener('abort', done);
        resolve();
      };
      signal?.addEventListener('abort', done, { once: true });
      void entry.promise.then(done);
    });
  }
}
