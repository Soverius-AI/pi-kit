import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type HostDiscovery, isNewerVersion, readDiscovery, removeDiscovery, writeDiscovery } from './discovery';
import { HostAlreadyRunningError, hostSocketPath, listenHostChannel } from './host-channel';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pk-own-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function listen(path: string): Promise<Server> {
  const server = await listenHostChannel(path, 'k'.repeat(64), () => undefined);
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

describe('one host per data folder', () => {
  it('never takes over a socket another host answers on, and replaces one nobody answers on', async () => {
    const path = hostSocketPath(await dataDir());
    await listen(path);
    await expect(listenHostChannel(path, 'k'.repeat(64), () => undefined)).rejects.toBeInstanceOf(
      HostAlreadyRunningError,
    );

    const stale = hostSocketPath(await dataDir());
    await writeFile(stale, '');
    await expect(listen(stale)).resolves.toBeDefined();
  });

  it('leaves the discovery file of the host that came next', async () => {
    const dir = await dataDir();
    const next: HostDiscovery = {
      pid: 222,
      version: '1.0.0',
      level: 'login',
      socket: '/tmp/next.sock',
      token: 't',
      startedAt: '2026-11-05T00:00:00.000Z',
    };
    writeDiscovery(dir, next);

    removeDiscovery(dir, 111);
    expect(readDiscovery(dir)).toEqual(next);
  });
});

describe('which install is newer', () => {
  it.each([
    ['0.10.0', '0.9.12', true],
    ['0.10.9', '0.10.9', false],
    ['1.0.0', '0.99.99', true],
    ['0.9.12', '0.10.0', false],
    ['development', '0.10.9', false],
    ['0.10.9', 'unknown', false],
    ['0.11.0-beta.1', '0.10.9', false],
  ])('%s is newer than %s: %s', (version, than, newer) => {
    expect(isNewerVersion(version, than)).toBe(newer);
  });
});

describe('the discovery file', () => {
  it.each(['app', 'login', 'serve'] as const)('reads back a host run at the %s level', async (level) => {
    const dir = await dataDir();
    const host: HostDiscovery = {
      pid: process.pid,
      version: '1.0.0',
      level,
      socket: 's',
      token: 't',
      startedAt: 'now',
    };
    writeDiscovery(dir, host);
    expect(readDiscovery(dir)).toEqual(host);
  });
});
