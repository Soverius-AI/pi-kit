import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunningBackend } from './backend';
import { connectHostChannel, hostSocketPath, listenHostChannel } from './host-channel';
import { HostClient, HostStartError } from './host-process';
import { NOT_RUNNING, runServiceCli, type CliContext } from './service-cli';
import { type LaunchedBackend, ServiceHost } from './service-host';

const TOKEN = 'k'.repeat(64);

/** A backend child: what it receives over IPC, and an exit the test triggers. */
function fakeBackend(pid: number) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    connected: true,
    received: [] as unknown[],
    send(message: unknown) {
      child.received.push(structuredClone(message));
      return true;
    },
  });
  let exit!: () => void;
  const exited = new Promise<{ code: number | null; signal: null }>(
    (resolve) => (exit = () => resolve({ code: 1, signal: null })),
  );
  const running = {
    url: 'http://127.0.0.1:1',
    port: 1,
    token: 't'.repeat(32),
    child: child as unknown as ChildProcess,
    exited,
    stop: () => undefined,
  } satisfies RunningBackend;
  return { running, child, exit };
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A host listening on a real socket in a scratch data folder, with a backend that is healthy unless told otherwise. */
async function startHost(backend: ReturnType<typeof fakeBackend>, healthy = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pk-host-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const host = new ServiceHost(
    { entry: 'main.js', origin: 'app://pi-kit', dataDir, cwd: dataDir, version: '0.0.0' },
    {
      allocate: async () => ({ url: 'http://127.0.0.1:1', port: 1, token: 't'.repeat(32) }),
      spawn: () => backend.running,
      launch: async (spawnIt): Promise<LaunchedBackend> => {
        const running = spawnIt();
        if (!healthy) {
          await running.exited;
          throw new Error('The backend exited before it became healthy.');
        }
        return { exited: running.exited, kill: running.stop, running, health: { status: 'ok', bootId: 'boot-1' } };
      },
      ping: async () => ({ status: 'ok' }),
      output: () => undefined,
      log: () => undefined,
      schedule: () => () => undefined,
      now: () => 0,
      exit: () => undefined,
    },
  );
  await host.open();
  const path = hostSocketPath(dataDir);
  const server: Server = await listenHostChannel(path, TOKEN, (peer) => host.accept(peer));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const desktop = async () => {
    const peer = await connectHostChannel(path, TOKEN);
    cleanup.push(async () => peer.close());
    return { client: new HostClient(peer), close: () => peer.close() };
  };
  return { path, desktop };
}

describe('ServiceHost with a desktop on its socket', () => {
  it('hands the backend’s own startup failure to the desktop, so a broken database can be offered for reset', async () => {
    const backend = fakeBackend(2000);
    const { desktop } = await startHost(backend, false);
    const { client } = await desktop();
    await client.attach();
    const started = client.start();
    await vi.waitFor(() => expect(backend.child.listenerCount('message')).toBe(1));
    backend.child.emit('message', {
      type: 'startup-failure',
      reason: 'database-broken',
      message: 'file is not a database',
    });
    backend.exit();

    const error = await started.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HostStartError);
    expect((error as HostStartError).failure).toEqual({ reason: 'database-broken', message: 'file is not a database' });
  });

  it('answers the backend’s request through the attached desktop', async () => {
    const backend = fakeBackend(2000);
    const { desktop } = await startHost(backend);
    const { client } = await desktop();
    const asked: unknown[] = [];
    client.serveBackendRequests(async (message) => {
      asked.push(message);
      return {};
    });
    await client.attach();
    await client.start();

    backend.child.emit('message', { type: 'open-path', id: 'r1', path: '/tmp/a.txt' });
    await vi.waitFor(() => expect(backend.child.received).toEqual([{ type: 'desktop-answer', id: 'r1' }]));
    expect(asked).toEqual([{ type: 'open-path', id: 'r1', path: '/tmp/a.txt' }]);
  });

  it('answers the backend itself once the desktop is gone, so no request waits for a window', async () => {
    const backend = fakeBackend(2000);
    const { desktop } = await startHost(backend);
    const { client, close } = await desktop();
    client.serveBackendRequests(async () => ({ result: 'from the desktop' }));
    await client.attach();
    await client.start();
    close();

    await vi.waitFor(() => {
      backend.child.emit('message', { type: 'browser', id: 'b1', threadId: 't1' });
      expect(backend.child.received).toContainEqual({
        type: 'desktop-answer',
        id: 'b1',
        result: { state: expect.objectContaining({ threadId: 't1' }) },
      });
    });
  });

  it('keeps signing with the instance key after the desktop that unsealed it is gone', async () => {
    const backend = fakeBackend(2000);
    const { desktop } = await startHost(backend);
    const { client, close } = await desktop();
    client.serveSealing({
      available: async () => true,
      encrypt: async (value) => Buffer.from(value),
      decrypt: async (value) => value.toString(),
    });
    await client.attach();
    await client.start();
    const instanceId = randomUUID();
    backend.child.emit('message', {
      type: 'instance-key',
      id: 'k1',
      keyRequest: { action: 'info', instanceId, create: true },
    });
    await vi.waitFor(() =>
      expect(backend.child.received).toContainEqual(expect.objectContaining({ id: 'k1', result: expect.anything() })),
    );
    close();
    await vi.waitFor(() => expect(client.connected).toBe(false));

    const claims = { aud: randomUUID(), purpose: 'session', nonce: 'n'.repeat(16) };
    backend.child.emit('message', {
      type: 'instance-key',
      id: 'k2',
      keyRequest: { action: 'sign', instanceId, claims },
    });
    await vi.waitFor(() =>
      expect(backend.child.received).toContainEqual({ type: 'desktop-answer', id: 'k2', result: expect.any(String) }),
    );
  });

  it('answers nothing to a connection without the token', async () => {
    const { path } = await startHost(fakeBackend(2000));
    const intruder = await connectHostChannel(path, 'x'.repeat(64));

    await expect(intruder.call('attach')).rejects.toThrow('closed');
  });

  it('answers `pi-kit service status` without taking the place of the open desktop', async () => {
    const backend = fakeBackend(2000);
    const { path, desktop } = await startHost(backend);
    const { client } = await desktop();
    const asked: unknown[] = [];
    client.serveBackendRequests(async (message) => {
      asked.push(message);
      return {};
    });
    await client.attach();
    await client.start();
    const printed: string[] = [];

    const code = await runServiceCli(['service', 'status'], io(printed), {
      ...cli,
      discover: () => ({
        pid: process.pid,
        version: '0.0.0',
        level: 'login',
        socket: path,
        token: TOKEN,
        startedAt: 'now',
      }),
    });
    expect(code).toBe(0);
    expect(printed.join('')).toContain('Backend: running, pid 2000');

    backend.child.emit('message', { type: 'open-path', id: 'r9', path: '/tmp/b.txt' });
    await vi.waitFor(() => expect(backend.child.received).toContainEqual({ type: 'desktop-answer', id: 'r9' }));
    expect(asked).toHaveLength(1);
  });

  it.each([[], ['--help'], ['service', '--help'], ['logs']].map((args) => ({ args })))(
    'shows complete service commands in help for $args',
    async ({ args }) => {
      const printed: string[] = [];
      const code = await runServiceCli(args, io(printed), cli);
      expect(code).toBe(args[0] === 'logs' ? 2 : 0);
      const output = printed.join('');
      for (const command of ['status', 'install', 'uninstall', 'start', 'stop', 'restart', 'logs']) {
        expect(output).toContain(`pi-kit service ${command}`);
      }
      expect(output).toContain('not "pi-kit logs"');
    },
  );

  it('exits `pi-kit service status` with 3 when nothing runs, for scripts', async () => {
    expect(await runServiceCli(['service', 'status'], io([]), cli)).toBe(NOT_RUNNING);
  });
});

const io = (printed: string[]) => ({
  out: (text: string) => void printed.push(text),
  err: (text: string) => void printed.push(text),
});
const cli: CliContext = {
  version: '0.0.0',
  serviceName: 'test',
  logDir: tmpdir(),
  manager: undefined,
  discover: () => undefined,
  connect: (host) => connectHostChannel(host.socket, host.token),
  tail: () => undefined,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
