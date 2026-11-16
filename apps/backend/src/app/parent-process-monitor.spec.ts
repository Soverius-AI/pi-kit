import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendConfig } from './config';
import { ParentProcessMonitor } from './parent-process-monitor';

describe('parent process lifecycle', () => {
  const monitors: ParentProcessMonitor[] = [];
  const monitor = () => {
    const owner = new ParentProcessMonitor({
      shutdown: { parentPid: process.pid + 100, parentPollMs: 10, graceMs: 100 },
    } as BackendConfig);
    monitors.push(owner);
    owner.onApplicationBootstrap();
    return owner;
  };
  afterEach(() => {
    for (const owner of monitors.splice(0)) owner.onModuleDestroy();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('requests one normal Nest shutdown on parent loss, and tears down its monitor', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid !== process.pid) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    const before = process.listenerCount('SIGTERM');
    const owner = monitor();
    await vi.advanceTimersByTimeAsync(100);
    expect(kill.mock.calls.filter(([pid]) => pid === process.pid)).toEqual([[process.pid, 'SIGTERM']]);
    owner.onModuleDestroy();
    expect(process.listenerCount('SIGTERM')).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not confuse permission denial with a dead parent', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('forbidden'), { code: 'EPERM' });
    });
    monitor();
    await vi.advanceTimersByTimeAsync(30);
    expect(kill).toHaveBeenCalledTimes(3);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('records %s once before beginning shutdown', (signal) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const before = process.listeners(signal);
    monitor();
    const guard = process.listeners(signal).find((fn) => !before.includes(fn));
    guard!(signal);
    guard!(signal);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('BACKEND_SHUTDOWN '),
      ParentProcessMonitor.name,
    );
    const record = JSON.parse((warn.mock.calls[0][0] as string).split('BACKEND_SHUTDOWN ')[1]);
    expect(record).toMatchObject({ at: expect.any(String), pid: process.pid, signal });
  });

  it('retains the shutdown deadline through module destruction so a later hook cannot hang', async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const before = process.listeners('SIGTERM');
    const owner = monitor();
    const guard = process.listeners('SIGTERM').find((fn) => !before.includes(fn));
    expect(guard).toBeDefined();
    guard!('SIGTERM');
    owner.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
