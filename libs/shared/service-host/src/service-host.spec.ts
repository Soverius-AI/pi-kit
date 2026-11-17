import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_RESET_PENDING_FILE } from '@pi-kit/protocol';
import type { RunningBackend } from './backend';
import { DatabaseReset } from './database-reset';
import { connectHostChannel, hostSocketPath, listenHostChannel } from './host-channel';
import { HOST_ALREADY_RUNNING, HostClient, HostStartError } from './host-process';
import { NOT_RUNNING, runCli, type CliContext } from './service-cli';
import { FileWrappingKeys, HostSealing, instanceKeyFile, KeyringWrappingKeys } from './instance-key-sealing';
import { hostConfigFromEnv, type LaunchedBackend, ServiceHost, type ServiceHostDeps } from './service-host';
import type { ServiceManager } from './service-registration';
import { WatchdogSettings } from './watchdog-settings';
import { DEFAULT_WATCHDOG_OPTIONS } from './watchdog';

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
async function startHost(
  backend: ReturnType<typeof fakeBackend>,
  healthy = true,
  extra: (dataDir: string) => Partial<ServiceHostDeps> = () => ({}),
) {
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
      ...extra(dataDir),
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
  return { path, desktop, dataDir, host };
}

describe('ServiceHost with a desktop on its socket', () => {
  it('backs up over authenticated RPC before startup and refuses while running or stopping', async () => {
    const { host, desktop, dataDir } = await startHost(fakeBackend(2000));
    const { client } = await desktop();
    await client.attach();
    await writeFile(join(dataDir, 'pi-kit.sqlite'), 'original');
    const backup = await client.backupDatabases();
    expect(backup.files).toEqual(['pi-kit.sqlite']);
    expect(backup.directory.startsWith(dataDir)).toBe(true);
    await client.start();
    await expect(client.backupDatabases()).rejects.toThrow('starting, running, or stopping');
    void host.stop();
    await expect(client.backupDatabases()).rejects.toThrow('starting, running, or stopping');
  });

  it('refuses reset during startup, then permits backup and retry after the failed child exits', async () => {
    const backend = fakeBackend(2000);
    let launches = 0;
    const { desktop, dataDir } = await startHost(backend, true, () => ({
      launch: async (spawnIt) => {
        const running = spawnIt();
        if (++launches === 1) {
          await running.exited;
          throw new Error('startup failure');
        }
        return { exited: running.exited, kill: running.stop, running, health: { status: 'ok' } };
      },
    }));
    const { client } = await desktop();
    await client.attach();
    const start = client.start();
    const failed = expect(start).rejects.toThrow('startup failure');
    await vi.waitFor(() => expect(client.backendPid).toBe(2000));
    await expect(client.backupDatabases()).rejects.toThrow('starting, running, or stopping');
    backend.exit();
    await failed;
    await writeFile(join(dataDir, 'pi-kit.sqlite'), 'original');
    expect((await client.backupDatabases()).files).toEqual(['pi-kit.sqlite']);
    await expect(client.start()).resolves.toEqual({});
    expect(launches).toBe(2);
  });
  it('refuses a still-live child even after launch has rejected', async () => {
    const backend = fakeBackend(2000);
    const { desktop } = await startHost(backend, true, () => ({
      launch: async (spawnIt) => {
        spawnIt();
        throw new Error('health check failed before child exit');
      },
    }));
    const { client } = await desktop();
    await client.attach();
    await expect(client.start()).rejects.toThrow('health check failed');
    await expect(client.backupDatabases()).rejects.toThrow('starting, running, or stopping');
    backend.exit();
    await vi.waitFor(async () => expect((await client.backupDatabases()).files).toEqual([]));
  });

  it('refuses reset and restore from a connection that is not the attached desktop', async () => {
    const { desktop, dataDir } = await startHost(fakeBackend(2000));
    const { client: cli } = await desktop();
    await writeFile(join(dataDir, 'pi-kit.sqlite'), 'original');
    await expect(cli.backupDatabases()).rejects.toThrow('Only the attached desktop app');
    await expect(cli.restoreDatabases()).rejects.toThrow('Only the attached desktop app');
    const { client } = await desktop();
    await client.attach();
    await expect(cli.backupDatabases()).rejects.toThrow('Only the attached desktop app');
    expect(await readFile(join(dataDir, 'pi-kit.sqlite'), 'utf8')).toBe('original');
  });

  it('restores an interrupted reset over RPC, then starts with the original files', async () => {
    const { desktop, dataDir } = await startHost(fakeBackend(2000));
    const { client } = await desktop();
    await client.attach();
    const directory = join(dataDir, 'database-backup-interrupted');
    await mkdir(directory);
    await writeFile(join(directory, 'pi-kit.sqlite'), 'original');
    await writeFile(join(dataDir, 'bg-agents.sqlite'), 'not yet moved');
    await writeFile(
      join(dataDir, DATABASE_RESET_PENDING_FILE),
      JSON.stringify({ version: 1, directory, files: ['pi-kit.sqlite', 'bg-agents.sqlite'] }),
    );
    expect(await client.restoreDatabases()).toEqual({ directory, files: ['pi-kit.sqlite'] });
    expect(await readFile(join(dataDir, 'pi-kit.sqlite'), 'utf8')).toBe('original');
    expect(await readFile(join(dataDir, 'bg-agents.sqlite'), 'utf8')).toBe('not yet moved');
    await expect(readFile(join(dataDir, DATABASE_RESET_PENDING_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(client.start()).resolves.toEqual({ bootId: 'boot-1' });
  });

  it('clears the marker of a completed reset before starting, but keeps an incomplete one', async () => {
    let launches = 0;
    const { desktop, dataDir } = await startHost(fakeBackend(2000), true, () => ({
      launch: async (spawnIt) => {
        launches++;
        const running = spawnIt();
        return { exited: running.exited, kill: running.stop, running, health: { status: 'ok' } };
      },
    }));
    const { client } = await desktop();
    await client.attach();
    const directory = join(dataDir, 'database-backup-done');
    await mkdir(directory);
    await writeFile(join(directory, 'pi-kit.sqlite'), 'original');
    const marker = join(dataDir, DATABASE_RESET_PENDING_FILE);
    await writeFile(marker, JSON.stringify({ version: 1, directory, files: ['pi-kit.sqlite'] }));
    await writeFile(join(directory, 'backup.json'), JSON.stringify({ version: 1, completed: false }));
    expect(DatabaseReset.clearCompleted(dataDir)).toBe(false);
    await writeFile(join(directory, 'backup.json'), JSON.stringify({ version: 1, completed: true }));
    await client.start();
    expect(launches).toBe(1);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(directory, 'pi-kit.sqlite'), 'utf8')).toBe('original');
  });

  it('starts without watchdog polling and leaves a crashed backend down by default', async () => {
    const backend = fakeBackend(2000);
    const schedule = vi.fn(() => () => undefined);
    const { host, path } = await startHost(backend, true, () => ({ schedule }));
    const peer = await connectHostChannel(path, TOKEN);
    cleanup.push(async () => peer.close());
    await host.start();
    expect(await peer.call('watchdog.status')).toEqual({ enabled: false, supported: true });
    expect(schedule).not.toHaveBeenCalled();
    backend.exit();
    await vi.waitFor(async () => {
      expect(await peer.call('status')).toMatchObject({ status: { state: 'failed' } });
    });
    expect(schedule).not.toHaveBeenCalled();
    await expect(peer.call('backend')).rejects.toThrow('not running');
  });

  it('persists and applies authenticated watchdog commands without replacing the desktop', async () => {
    const backend = fakeBackend(2000);
    const schedule = vi.fn(() => () => undefined);
    const { host, path, dataDir, desktop } = await startHost(backend, true, () => ({ schedule }));
    const { client } = await desktop();
    await client.attach();
    await host.start();
    const peer = await connectHostChannel(path, TOKEN);
    cleanup.push(async () => peer.close());
    expect(await peer.call('watchdog.set', true)).toEqual({ enabled: true, supported: true });
    expect(WatchdogSettings.read(dataDir)).toBe(true);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), DEFAULT_WATCHDOG_OPTIONS.pingIntervalMs);
    expect(await peer.call('status')).toMatchObject({ desktopAttached: true });
    expect(await peer.call('watchdog.set', false)).toEqual({ enabled: false, supported: true });
    expect(WatchdogSettings.read(dataDir)).toBe(false);
    await expect(peer.call('watchdog.set', 'true')).rejects.toThrow('Invalid watchdog');
  });

  it('reads an opt-in saved before the host starts', async () => {
    const schedule = vi.fn(() => () => undefined);
    const { host, path } = await startHost(fakeBackend(2000), true, (dataDir) => {
      WatchdogSettings.write(dataDir, true);
      return { schedule };
    });
    await host.start();
    const peer = await connectHostChannel(path, TOKEN);
    cleanup.push(async () => peer.close());
    expect(await peer.call('watchdog.status')).toEqual({ enabled: true, supported: true });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), DEFAULT_WATCHDOG_OPTIONS.pingIntervalMs);
  });

  it('answers watchdog preferences directly to a backend with no desktop attached', async () => {
    const backend = fakeBackend(2000);
    const { host, dataDir } = await startHost(backend);
    await host.start();
    backend.child.emit('message', { type: 'watchdog', id: 'w1' });
    backend.child.emit('message', { type: 'watchdog', id: 'w2', enabled: true });
    backend.child.emit('message', { type: 'watchdog', id: 'w3', enabled: 'yes' });
    backend.child.emit('message', { type: 'backend-restart', id: 'r1' });
    await vi.waitFor(() => expect(backend.child.received).toHaveLength(4));
    expect(backend.child.received).toContainEqual({
      type: 'desktop-answer',
      id: 'w1',
      result: { enabled: false, supported: true },
    });
    expect(backend.child.received).toContainEqual({
      type: 'desktop-answer',
      id: 'w2',
      result: { enabled: true, supported: true },
    });
    expect(backend.child.received).toContainEqual({
      type: 'desktop-answer',
      id: 'w3',
      error: 'Invalid watchdog preference.',
      errorCode: 'failed',
    });
    expect(backend.child.received).toContainEqual({ type: 'desktop-answer', id: 'r1', result: {} });
    expect(WatchdogSettings.read(dataDir)).toBe(true);
  });

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

  it('signs with an instance key it sealed itself, with no desktop ever attached', async () => {
    const backend = fakeBackend(2000);
    const entries = new Map<string, string>();
    const store = {
      available: () => true,
      get: (account: string) => entries.get(account),
      set: (account: string, value: string) => void entries.set(account, value),
    };
    const { host } = await startHost(backend, true, (dataDir) => ({
      hostSealing: new HostSealing(
        new KeyringWrappingKeys(() => store, dataDir),
        new FileWrappingKeys(instanceKeyFile(dataDir)),
      ),
    }));
    await host.start();
    const instanceId = randomUUID();
    backend.child.emit('message', {
      type: 'instance-key',
      id: 'k1',
      keyRequest: { action: 'info', instanceId, create: true },
    });
    backend.child.emit('message', {
      type: 'instance-key',
      id: 'k2',
      keyRequest: {
        action: 'sign',
        instanceId,
        claims: { aud: randomUUID(), purpose: 'session', nonce: 'n'.repeat(16) },
      },
    });
    await vi.waitFor(() =>
      expect(backend.child.received).toContainEqual({ type: 'desktop-answer', id: 'k2', result: expect.any(String) }),
    );
  });

  it('hands the backend endpoint to a local client only while the backend runs', async () => {
    const { path, host } = await startHost(fakeBackend(2000));
    const command = await connectHostChannel(path, TOKEN);
    cleanup.push(async () => command.close());

    await expect(command.call('backend')).rejects.toThrow('not running');
    await host.start();
    expect(await command.call('backend')).toEqual({ url: 'http://127.0.0.1:1', port: 1, token: 't'.repeat(32) });
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

    const code = await runCli(['service', 'status'], io(printed), {
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
      const code = await runCli(args, io(printed), cli);
      expect(code).toBe(args[0] === 'logs' ? 2 : 0);
      const output = printed.join('');
      for (const command of ['status', 'install', 'uninstall', 'start', 'stop', 'restart', 'logs']) {
        expect(output).toContain(`pi-kit service ${command}`);
      }
      expect(output).toContain('not "pi-kit logs"');
    },
  );

  it('prints the host status as JSON for scripts, without the host token', async () => {
    const backend = fakeBackend(2000);
    const { path, host } = await startHost(backend);
    await host.start();
    const printed: string[] = [];
    const owner = {
      pid: process.pid,
      version: '0.0.0',
      level: 'login' as const,
      socket: path,
      token: TOKEN,
      startedAt: 'now',
    };
    expect(await runCli(['service', 'status', '--json'], io(printed), { ...cli, discover: () => owner })).toBe(0);
    expect(JSON.parse(printed.join(''))).toMatchObject({
      installed: false,
      host: { pid: process.pid, level: 'login', version: '0.0.0' },
      desktopAttached: false,
      backendPid: 2000,
      status: { state: expect.any(String), restarts: 0 },
    });
    expect(printed.join('')).not.toContain(TOKEN);
  });

  it('refuses `pi-kit serve` while another host owns the profile', async () => {
    let served = 0;
    const serve = async () => ++served;
    const owner = { pid: 7, version: '0.0.0', level: 'login' as const, socket: 's', token: 't', startedAt: 'now' };
    expect(await runCli(['serve'], io([]), { ...cli, serve, discover: () => owner })).toBe(HOST_ALREADY_RUNNING);
    expect(served).toBe(0);
    expect(await runCli(['serve'], io([]), { ...cli, serve })).toBe(1);
  });

  it.each([
    ['newer', '2.0.0', false],
    ['older', '0.0.1', true],
  ])(
    'leaves the registration of a %s install alone only when it is newer, at sign-in and at boot',
    async (_, version, replaced) => {
      for (const level of [[], ['--level', 'boot']]) {
        let installs = 0;
        const registration = (installed: boolean) =>
          ({
            unsupported: async () => undefined,
            installed: () => installed,
            install: async () => (++installs, true),
            registered: () => undefined,
          }) as unknown as ServiceManager;
        const other = { entry: '/srv/pi-kit-server/backend/service-host.cjs', version };
        const code = await runCli(['service', 'install', ...level], io([]), {
          ...cli,
          version: '1.0.0',
          manager: registration(level.length === 0),
          bootManager: registration(false),
          otherInstall: () => other,
          sleep: async () => undefined,
          discover: () => ({ pid: 1, version, level: 'login', socket: 's', token: 't', startedAt: 'now' }),
        });
        expect(installs).toBe(replaced ? 1 : 0);
        expect(code).toBe(replaced ? 0 : 1);
      }
    },
  );

  it('replaces the sign-in registration with the boot one before starting it, on macOS', async () => {
    const steps: string[] = [];
    const registration = (kind: string, installed: boolean) =>
      ({
        unsupported: async () => undefined,
        installed: () => installed,
        install: async () => (steps.push(`${kind} install`), true),
        uninstall: async () => void steps.push(`${kind} uninstall`),
        registered: () => undefined,
      }) as unknown as ServiceManager;
    const running = { pid: 9, version: '1.0.0', level: 'login' as const, socket: 's', token: 't', startedAt: 'now' };
    const code = await runCli(['service', 'install', '--level', 'boot'], io([]), {
      ...cli,
      manager: registration('agent', true),
      bootManager: registration('daemon', false),
      sleep: async () => undefined,
      discover: () => running,
      connect: async () => ({ call: async () => void steps.push('stop host'), close: () => undefined }) as never,
    });
    expect(steps.slice(0, 3)).toEqual(['stop host', 'agent uninstall', 'daemon install']);
    expect(code).toBe(0);
  });

  it('says a boot install that changed nothing is already installed', async () => {
    const printed: string[] = [];
    const daemon = { installed: () => true, install: async () => false } as unknown as ServiceManager;
    const running = { pid: 9, version: '1.0.0', level: 'login' as const, socket: 's', token: 't', startedAt: 'now' };
    await runCli(['service', 'install', '--level', 'boot'], io(printed), {
      ...cli,
      bootManager: daemon,
      sleep: async () => undefined,
      discover: () => running,
    });
    expect(printed[0]).toBe('Already installed: pi-kit starts at boot on this Mac.\n');
  });

  it('keeps the boot registration the only one: plain install changes nothing, plain uninstall removes it', async () => {
    const steps: string[] = [];
    const registration = (kind: string, installed: boolean) =>
      ({
        unsupported: async () => undefined,
        installed: () => installed,
        install: async () => (steps.push(`${kind} install`), true),
        uninstall: async () => void steps.push(`${kind} uninstall`),
        registered: () => undefined,
      }) as unknown as ServiceManager;
    const atBoot = { ...cli, manager: registration('agent', false), bootManager: registration('daemon', true) };
    expect(await runCli(['service', 'install'], io([]), atBoot)).toBe(0);
    expect(await runCli(['service', 'uninstall'], io([]), atBoot)).toBe(0);
    expect(steps).toEqual(['daemon uninstall']);
  });

  it('puts a server install’s pi-kit on PATH when it installs the service, and leaves the desktop’s alone', async () => {
    const manager = {
      unsupported: async () => undefined,
      installed: () => false,
      install: async () => true,
      registered: () => undefined,
    } as unknown as ServiceManager;
    const running = { pid: 9, version: '1.0.0', level: 'login' as const, socket: 's', token: 't', startedAt: 'now' };
    let asked = 0;
    const base = { ...cli, manager, sleep: async () => undefined, discover: () => running };
    const putOnPath = () => (asked++, 'Added C:\\pi-kit\\bin to your PATH.');
    const printed: string[] = [];
    await runCli(['service', 'install'], io(printed), { ...base, putOnPath });
    expect(asked).toBe(0);
    const server = { root: 'C:\\pi-kit', version: '1.0.0', target: 'win32-x64', releases: 'r' };
    await runCli(['service', 'install'], io(printed), { ...base, putOnPath, serverInstall: server });
    expect(asked).toBe(1);
    expect(printed).toContain('Added C:\\pi-kit\\bin to your PATH.\n');
  });

  it('names the install that runs, and says when its folder or the registered install changed underneath it', async () => {
    const install = await mkdtemp(join(tmpdir(), 'pk-install-'));
    try {
      await mkdir(join(install, 'backend'));
      await writeFile(join(install, 'package.json'), '{"version":"2.0.0"}');
      const printed: string[] = [];
      const host = {
        pid: 9,
        version: '1.0.0',
        level: 'login' as const,
        socket: 's',
        token: 't',
        startedAt: 'now',
        install,
      };
      await runCli(['service', 'status'], io(printed), {
        ...cli,
        discover: () => host,
        connect: async () =>
          ({
            call: async () => ({ status: { state: 'running', restarts: 0 }, desktopAttached: false }),
            close: () => undefined,
          }) as never,
        otherInstall: () => ({ entry: join(install, 'gone', 'backend', 'service-host.cjs'), version: 'unknown' }),
      });
      const text = printed.join('');
      expect(text).toContain(`Background service: installed by another pi-kit (${join(install, 'gone')})`);
      expect(text).toContain(`version 1.0.0, since now, from ${install}`);
      expect(text).toContain(`${install} now holds 2.0.0; run "pi-kit service restart" to run it.`);
      expect(text).toContain(`The registered install (${join(install, 'gone')}) is gone`);
    } finally {
      await rm(install, { recursive: true, force: true });
    }
  });

  it('exits `pi-kit service status` with 3 when nothing runs, for scripts', async () => {
    expect(await runCli(['service', 'status'], io([]), cli)).toBe(NOT_RUNNING);
  });
});

const io = (printed: string[]) => ({
  out: (text: string) => void printed.push(text),
  err: (text: string) => void printed.push(text),
});
const cli: CliContext = {
  version: '0.0.0',
  serviceName: 'test',
  dataDir: tmpdir(),
  logDir: tmpdir(),
  manager: undefined,
  discover: () => undefined,
  connect: (host) => connectHostChannel(host.socket, host.token),
  tail: () => undefined,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

describe('a packaged host finds its install', () => {
  it.each([
    ['the desktop app', { 'app.asar/package.json': '{"version":"1.2.3"}' }],
    ['a server install', { 'package.json': '{"version":"1.2.3"}' }],
  ])('in %s: the backend, web app and version beside itself', async (_, files: Record<string, string>) => {
    const install = await mkdtemp(join(tmpdir(), 'pk-install-'));
    cleanup.push(() => rm(install, { recursive: true, force: true }));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(install, path, '..'), { recursive: true });
      await writeFile(join(install, path), content);
    }
    const config = hostConfigFromEnv({ PI_KIT_DATA_DIR: install }, join(install, 'backend'));
    expect(config).toMatchObject({
      entry: join(install, 'backend', 'main.js'),
      rendererRoot: join(install, 'renderer', 'browser'),
      version: '1.2.3',
    });
  });
});
