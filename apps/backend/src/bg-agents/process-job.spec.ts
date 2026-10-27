import { describe, expect, it } from 'vitest';
import { cleanupIntent, crashLoop, CRASH_LOOP_WINDOW_MS, Holds } from './process-job';

describe('Holds (an agent held until the user decides)', () => {
  it('lets an unheld agent through at once and a held one only on release', async () => {
    const holds = new Holds();
    await holds.until('a', undefined);
    holds.hold('a', 'cleanup');
    expect(holds.reasonOf('a')).toBe('cleanup');
    let through = false;
    const waiting = holds.until('a', undefined).then(() => (through = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(through).toBe(false);
    holds.release('a');
    await waiting;
    expect(through).toBe(true);
    expect(holds.reasonOf('a')).toBeUndefined();
  });

  it('ends the wait when the asking task is aborted, and keeps the first reason', async () => {
    const holds = new Holds();
    holds.hold('a', 'crash-loop');
    holds.hold('a', 'cleanup');
    expect(holds.reasonOf('a')).toBe('crash-loop');
    const aborter = new AbortController();
    const waiting = holds.until('a', aborter.signal);
    aborter.abort();
    await expect(waiting).resolves.toBeUndefined();
    await expect(holds.until('a', AbortSignal.abort())).resolves.toBeUndefined();
  });
});

describe('crashLoop (three starts in ten minutes)', () => {
  it('counts the starts inside the window only', () => {
    const now = 1_000_000_000;
    expect(crashLoop([], now)).toEqual({ failures: [now], looping: false });
    expect(crashLoop([now - 60_000], now).looping).toBe(false);
    expect(crashLoop([now - 120_000, now - 60_000], now)).toEqual({ failures: [now - 120_000, now - 60_000, now], looping: true });
    expect(crashLoop([now - CRASH_LOOP_WINDOW_MS - 1, now - 60_000], now).looping).toBe(false);
  });
});

describe('cleanupIntent', () => {
  it('keeps the command of the call', () => {
    expect(cleanupIntent('c1', { command: 'node --test test' })).toMatchObject({ callId: 'c1', command: 'node --test test' });
    expect(cleanupIntent('c2', {}).command).toBe('');
  });
});
