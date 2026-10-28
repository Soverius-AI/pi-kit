import { describe, expect, it } from 'vitest';
import { coalescedRunner } from './coalesced-runner';

describe('coalescedRunner', () => {
  it('folds the calls made while one runs into one trailing run with the newest value, and every caller waits for it', async () => {
    const runs: number[] = [];
    let release!: () => void;
    const run = coalescedRunner(async (value: number) => {
      runs.push(value);
      if (value === 1) await new Promise<void>((resolve) => (release = resolve));
    });
    const first = run(1);
    const second = run(2);
    const third = run(3);
    let settled = 0;
    for (const call of [first, second, third]) void call.then(() => settled++);
    await Promise.resolve();
    expect(runs).toEqual([1]);
    release();
    await Promise.all([first, second, third]);
    expect(runs).toEqual([1, 3]);
    expect(settled).toBe(3);
  });

  it('starts afresh once nothing runs', async () => {
    const runs: string[] = [];
    const run = coalescedRunner(async (value: string) => void runs.push(value));
    await run('a');
    await run('b');
    expect(runs).toEqual(['a', 'b']);
  });
});
