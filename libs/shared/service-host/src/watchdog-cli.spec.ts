import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RpcPeer } from './host-channel';
import { runCli, type CliContext } from './service-cli';
import { WatchdogSettings } from './watchdog-settings';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pk-watchdog-cli-'));
  directories.push(dir);
  const ctx: CliContext = {
    version: '1.0.0',
    serviceName: 'pi-kit',
    dataDir: dir,
    logDir: dir,
    manager: undefined,
    discover: () => undefined,
    connect: async () => {
      throw new Error('unexpected connection');
    },
    tail: () => undefined,
    sleep: async () => undefined,
  };
  const printed: string[] = [];
  return {
    ctx,
    printed,
    io: { out: (text: string) => void printed.push(text), err: (text: string) => void printed.push(text) },
  };
};

describe('pi-kit watchdog', () => {
  it('is off by default and can be enabled or disabled before the host starts', async () => {
    const { ctx, printed, io } = setup();
    expect(await runCli(['watchdog', 'status'], io, ctx)).toBe(0);
    expect(printed.join('')).toContain('disabled');
    expect(await runCli(['watchdog', 'enable'], io, ctx)).toBe(0);
    expect(WatchdogSettings.read(ctx.dataDir)).toBe(true);
    expect(await runCli(['watchdog', 'disable'], io, ctx)).toBe(0);
    expect(WatchdogSettings.read(ctx.dataDir)).toBe(false);
  });

  it('applies changes through a running host and closes the connection', async () => {
    const { ctx, io } = setup();
    const call = vi.fn(async () => ({ enabled: true, supported: true }));
    const close = vi.fn();
    ctx.discover = () => ({ pid: 1, version: '1.0.0', level: 'serve', startedAt: 'now', socket: 's', token: 't' });
    ctx.connect = async () => ({ call, close }) as unknown as RpcPeer;
    expect(await runCli(['watchdog', 'enable'], io, ctx)).toBe(0);
    expect(call).toHaveBeenLastCalledWith('watchdog.set', true);
    expect(await runCli(['watchdog', 'status'], io, ctx)).toBe(0);
    expect(call).toHaveBeenLastCalledWith('watchdog.status', undefined);
    expect(await runCli(['watchdog', 'disable'], io, ctx)).toBe(0);
    expect(call).toHaveBeenLastCalledWith('watchdog.set', false);
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('does not silently save an offline setting if a running host cannot be reached', async () => {
    const { ctx, io } = setup();
    ctx.discover = () => ({ pid: 1, version: '1.0.0', level: 'serve', startedAt: 'now', socket: 's', token: 't' });
    expect(await runCli(['watchdog', 'enable'], io, ctx)).toBe(1);
    expect(WatchdogSettings.read(ctx.dataDir)).toBe(false);
  });

  it.each([
    ['watchdog', 'on'],
    ['watchdog', 'enable', 'extra'],
  ])('rejects invalid arguments %j', async (...args) => {
    const { ctx, io } = setup();
    expect(await runCli(args, io, ctx)).toBe(2);
  });
});
