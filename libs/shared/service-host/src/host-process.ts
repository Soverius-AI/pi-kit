import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RemoteAccessStatus } from '@pi-kit/protocol';
import { type HostDiscovery, liveDiscovery } from './discovery';
import { connectHostChannel, RpcError, type RpcPeer } from './host-channel';
import {
  asStartupFailure,
  type DesktopAnswer,
  fields,
  type HostAttachment,
  type StartupFailure,
} from './host-protocol';
import type { InstanceKeyEncryption } from './instance-key';
import type { WatchdogStatus } from './watchdog';

export class HostStartError extends Error {
  constructor(
    message: string,
    readonly failure?: StartupFailure,
  ) {
    super(message);
  }
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };

/** The exit code of a host the desktop started that found another host owning the data folder. */
export const HOST_ALREADY_RUNNING = 3;

export interface SpawnedHost {
  pid: number | undefined;
  exited: Promise<Exit>;
}

/**
 * Starts the host on the running Electron binary as plain Node. The IPC channel carries nothing: it only ends the host
 * (and with it the backend) when this process goes, for a host this app owns.
 */
export function spawnServiceHost(entry: string, env: NodeJS.ProcessEnv): SpawnedHost {
  const child = spawn(process.execPath, [entry], {
    cwd: join(entry, '..'),
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const exited = new Promise<Exit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  return { pid: child.pid, exited };
}

/**
 * Keeps a service host running for a supervisor nobody watches (the desktop's Windows sign-in entry, the scheduled task of a
 * Windows server install, which restarts nothing that exits): started again after a crash with a growing pause, ended by a
 * clean exit (stopped on purpose, or another host owns the folder), and given up after six quick failures in a row.
 */
export async function superviseServiceHost(
  start: () => SpawnedHost,
  log: (line: string) => void,
  sleep: (ms: number) => Promise<unknown> = delay,
  now: () => number = Date.now,
): Promise<void> {
  let failures = 0;
  for (;;) {
    const startedAt = now();
    const host = start();
    const exit = await host.exited;
    log(`service host ${host.pid} exited (code ${exit.code}, signal ${exit.signal})`);
    if (exit.code === 0) return;
    failures = now() - startedAt > 60_000 ? 1 : failures + 1;
    if (failures > 5) {
      log('the service host keeps stopping; giving up until the service is started again');
      return;
    }
    await sleep(Math.min(30_000, 1000 * 2 ** failures));
  }
}

export interface FindHostOptions {
  /** Which running host to take; others are waited out. */
  accept(discovery: HostDiscovery): boolean;
  /** Settles when waiting is pointless (the host this app started has exited). */
  gone?: Promise<unknown>;
  timeoutMs?: number;
}

/** The desktop's connection to the service host. */
export class HostClient {
  backendPid: number | undefined;

  /** Waits for a running host that `accept`s, through `<dataDir>/service.json`, and enters it with the token found there. */
  static async find(
    dataDir: string,
    options: FindHostOptions,
  ): Promise<{ client: HostClient; discovery: HostDiscovery }> {
    let ended = false;
    void options.gone?.then(() => (ended = true));
    const deadline = Date.now() + (options.timeoutMs ?? Infinity);
    for (;;) {
      const discovery = liveDiscovery(dataDir);
      if (discovery && options.accept(discovery)) {
        try {
          return { client: new HostClient(await connectHostChannel(discovery.socket, discovery.token)), discovery };
        } catch {
          // Written but not yet listening, or just gone: look again.
        }
      }
      if (ended) throw new Error('The pi-kit service host exited before it accepted a connection.');
      if (Date.now() > deadline) throw new Error('The pi-kit background service did not start in time.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  constructor(private readonly peer: RpcPeer) {
    peer.on('spawned', (data) => {
      const pid = fields(data)?.['pid'];
      if (typeof pid === 'number') this.backendPid = pid;
    });
  }

  get connected(): boolean {
    return !this.peer.isClosed;
  }

  async attach(): Promise<HostAttachment> {
    const attachment = await this.peer.call<HostAttachment>('attach');
    this.backendPid = attachment.backendPid;
    return attachment;
  }

  /** The first start; rejects with `HostStartError`, carrying the backend's own reason when it gave one. */
  async start(): Promise<{ bootId?: string }> {
    try {
      return await this.peer.call<{ bootId?: string }>('start');
    } catch (error) {
      const failure = fields(error instanceof RpcError ? error.data : undefined)?.['failure'];
      throw new HostStartError(error instanceof Error ? error.message : String(error), asStartupFailure(failure));
    }
  }

  retry(): void {
    void this.peer.call('retry').catch(() => undefined);
  }

  stop(): void {
    void this.peer.call('stop').catch(() => undefined);
  }

  appUpdateEvent(event: unknown): void {
    this.peer.emit('app-update-event', event);
  }

  onStatus(listener: (status: WatchdogStatus) => void): void {
    this.peer.on('status', (data) => listener(data as WatchdogStatus));
  }

  onClose(listener: () => void): void {
    this.peer.onClose(listener);
  }

  /** Answers the backend's requests for what only the desktop can do; `undefined` sends no answer. */
  serveBackendRequests(answer: (message: unknown) => Promise<DesktopAnswer>): void {
    this.peer.handle('backend-request', (message) => answer(message));
  }

  /** Lends the desktop's OS-protected storage to the host's instance key. */
  serveSealing(encryption: InstanceKeyEncryption): void {
    this.peer.handle('seal.available', () => encryption.available());
    this.peer.handle('seal.encrypt', async (value) => {
      if (typeof value !== 'string') throw new Error('Invalid sealing request.');
      return (await encryption.encrypt(value)).toString('base64');
    });
    this.peer.handle('seal.decrypt', (value) => {
      if (typeof value !== 'string') throw new Error('Invalid sealing request.');
      return encryption.decrypt(Buffer.from(value, 'base64'));
    });
  }

  readonly remote = {
    status: () => this.peer.call<RemoteAccessStatus>('remote.status'),
    start: (port?: number) => this.peer.call<RemoteAccessStatus>('remote.start', port),
    stop: () => this.peer.call<RemoteAccessStatus>('remote.stop'),
    beginPairing: () => this.peer.call<RemoteAccessStatus>('remote.beginPairing'),
    approvePairing: (id: string) => this.peer.call<RemoteAccessStatus>('remote.approvePairing', id),
    rejectPairing: (id: string) => this.peer.call<RemoteAccessStatus>('remote.rejectPairing', id),
    revokeDevice: (id: string) => this.peer.call<RemoteAccessStatus>('remote.revokeDevice', id),
    setupUrl: () => this.peer.call<string | undefined>('remote.setupUrl'),
  };
}
