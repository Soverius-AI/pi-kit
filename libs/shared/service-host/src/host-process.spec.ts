import { describe, expect, it } from 'vitest';
import { superviseServiceHost } from './host-process';

/** A host that exits with `code` after running `ms` on a clock the test moves. */
function hosts(runs: Array<[code: number, ms: number]>) {
  let clock = 0;
  const pauses: number[] = [];
  let started = 0;
  return {
    pauses,
    started: () => started,
    start: () => {
      const [code, ms] = runs[started++] ?? [0, 0];
      clock += ms;
      return { pid: started, exited: Promise.resolve({ code, signal: null }) };
    },
    sleep: async (ms: number) => void pauses.push(ms),
    now: () => clock,
  };
}

describe('superviseServiceHost', () => {
  it('starts a crashed host again with a growing pause, and ends when it exits cleanly', async () => {
    const run = hosts([
      [1, 10],
      [1, 10],
      [0, 10],
    ]);
    await superviseServiceHost(run.start, () => undefined, run.sleep, run.now);
    expect(run.started()).toBe(3);
    expect(run.pauses).toEqual([2_000, 4_000]);
  });

  it('gives up after six quick failures in a row, and counts again after a host that ran a while', async () => {
    const quick = hosts(Array.from({ length: 10 }, () => [1, 10] as [number, number]));
    const lines: string[] = [];
    await superviseServiceHost(quick.start, (line) => void lines.push(line), quick.sleep, quick.now);
    expect(quick.started()).toBe(6);
    expect(lines.at(-1)).toContain('giving up');

    const recovered = hosts([
      [1, 10],
      [1, 10],
      [1, 120_000],
      [0, 10],
    ]);
    await superviseServiceHost(recovered.start, () => undefined, recovered.sleep, recovered.now);
    expect(recovered.pauses).toEqual([2_000, 4_000, 2_000]);
  });
});
