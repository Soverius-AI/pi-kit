import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const diagnostics = new URL('./fatal-diagnostics.ts', import.meta.url).href;

describe('fatal backend diagnostics', () => {
  it.each([
    { trigger: "setTimeout(() => { throw new Error('fatal test marker'); }, 0)", origin: 'uncaughtException' },
    { trigger: "void Promise.reject(new Error('fatal test marker'))", origin: 'unhandledRejection' },
  ])('records $origin before Node’s default dump without suppressing the fatal exit', ({ trigger, origin }) => {
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(diagnostics)}); ${trigger}`],
      {
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toMatch(new RegExp(`FATAL ${origin}: Error: fatal test marker`));
    expect(child.stderr.indexOf(`FATAL ${origin}`)).toBeLessThan(child.stderr.lastIndexOf('Error: fatal test marker'));
    const context = child.stderr.split('\n').find((line) => line.includes(' FATAL_CONTEXT '));
    expect(JSON.parse(context!.split(' FATAL_CONTEXT ')[1])).toMatchObject({
      pid: child.pid,
      platform: process.platform,
      arch: process.arch,
      origin,
    });
  });

  it('preserves OS failure details without suppressing the fatal exit', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(diagnostics)}); throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL', errno: -4071, syscall: 'spawn' });`,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    const context = child.stderr.split('\n').find((line) => line.includes(' FATAL_CONTEXT '));
    expect(JSON.parse(context!.split(' FATAL_CONTEXT ')[1])).toMatchObject({
      pid: child.pid,
      code: 'EINVAL',
      errno: -4071,
      syscall: 'spawn',
    });
  });
});
