import type { Serializable } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { InstanceKeyRequestSchema } from '@pi-kit/protocol';
import type { BackendEndpoint, Health, RunningBackend, SpawnOptions } from './backend';
import type { HostLevel } from './discovery';
import { RpcError, type RpcPeer } from './host-channel';
import {
  type DesktopAnswer,
  detachedAnswer,
  fields,
  type HostAttachment,
  type HostStatus,
  isRemoteDeviceId,
  isRemotePort,
  type StartupFailure,
  startupFailureOf,
} from './host-protocol';
import { InstanceKeyError, type InstanceKeyEncryption, InstanceKeyStore } from './instance-key';
import { MigratingSealing } from './instance-key-sealing';
import type { OwnerAccess } from './owner-gateway';
import type { RemoteAccess } from './remote-access';
import { BackendActivity, type SleepGuard } from './sleep-guard';
import {
  BackendWatchdog,
  DEFAULT_WATCHDOG_OPTIONS,
  type BackendHandle,
  type WatchdogOptions,
  type WatchdogStatus,
} from './watchdog';

/** Where the backend comes from and what it is told; the host's own environment (PATH, PI_KIT_LOG_DIR, proxies) passes through. */
export type HostConfig = Omit<SpawnOptions, 'env' | 'onOutput'>;

export type LaunchedBackend = BackendHandle & { running: RunningBackend; health: Health };

export type RemoteAccessControl = Pick<
  RemoteAccess,
  | 'status'
  | 'start'
  | 'stop'
  | 'beginPairing'
  | 'approvePairing'
  | 'rejectPairing'
  | 'revokeDevice'
  | 'setupUrl'
  | 'restore'
  | 'dispose'
>;

export interface ServiceHostDeps {
  allocate(): Promise<BackendEndpoint>;
  spawn(endpoint: BackendEndpoint, options: SpawnOptions): RunningBackend;
  /** Runs `spawnIt` and resolves once that backend is healthy (`launchForWatchdog`). */
  launch(spawnIt: () => RunningBackend): Promise<LaunchedBackend>;
  ping(endpoint: BackendEndpoint): Promise<Health | undefined>;
  output(chunk: Buffer, stream: 'stdout' | 'stderr'): void;
  log(line: string): void;
  schedule(fn: () => void, ms: number): () => void;
  now(): number;
  exit(code: number): void;
  remote?: RemoteAccessControl;
  /** Resume remembered phone access once the backend is up (off for smoke runs). */
  restoreRemote?: boolean;
  /** Held while a thread runs or a background agent is active. */
  sleepGuard?: SleepGuard;
  /** Seals the instance key in this process; without it only an attached desktop can. */
  hostSealing?: InstanceKeyEncryption;
  /** The owner's browser door, open while the host is. */
  owner?: OwnerAccess;
  /** The web app of this host's install, handed to an attaching desktop. */
  rendererRoot?: string;
}

/** Longer than the backend's own shutdown grace (15 s), so a clean shutdown is never cut short. */
const STOP_GRACE_MS = 20_000;
const KEY_UNAVAILABLE = { error: 'Protected instance key operation unavailable.', errorCode: 'unavailable' };

/** Only PI_KIT_DATA_DIR is required: a packaged host finds backend, renderer and version beside itself, even in a moving AppImage mount. */
export function hostConfigFromEnv(
  env: NodeJS.ProcessEnv,
  hostDir: string,
): HostConfig & { rendererRoot: string; level: HostLevel } {
  const dataDir = env['PI_KIT_DATA_DIR'];
  if (!dataDir) throw new Error('PI_KIT_DATA_DIR is required to start the pi-kit service host.');
  const asar = join(hostDir, '..', 'app.asar');
  return {
    entry: env['PI_KIT_BACKEND_ENTRY'] || join(hostDir, 'main.js'),
    origin: env['PI_KIT_ORIGIN'] || 'app://pi-kit',
    dataDir,
    cwd: env['PI_KIT_CWD'] || homedir(),
    version: env['PI_KIT_VERSION'] || bundledVersion(hostDir),
    rendererRoot: env['PI_KIT_RENDERER_ROOT'] || join(asar, 'renderer', 'browser'),
    level: env['PI_KIT_SERVICE_LEVEL'] === 'login' ? 'login' : 'app',
  };
}

/** The packaged app's version, from the asar beside the host. */
export function bundledVersion(hostDir: string): string {
  try {
    const path = join(hostDir, '..', 'app.asar', 'package.json');
    const version = (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Owns the backend (one port and token for its life) whether or not a desktop is attached; the desktop asks for the first start so it can answer a broken database. */
export class ServiceHost {
  private endpoint: BackendEndpoint | undefined;
  private watchdog: BackendWatchdog | undefined;
  private starting: Promise<{ bootId?: string }> | undefined;
  private bootId: string | undefined;
  private stopping = false;
  private generation = 0;
  private current: RunningBackend | undefined;
  private readonly backends = new Map<number, RunningBackend>();
  private startupFailure: StartupFailure | undefined;
  private status: WatchdogStatus = { state: 'starting', restarts: 0 };
  private desktop: RpcPeer | undefined;
  private readonly keys: InstanceKeyStore;
  private activity: BackendActivity | undefined;

  constructor(
    private readonly config: HostConfig,
    private readonly deps: ServiceHostDeps,
    private readonly watchdogOptions: WatchdogOptions = DEFAULT_WATCHDOG_OPTIONS,
  ) {
    const sealing = deps.hostSealing ? new MigratingSealing(deps.hostSealing, this.sealing) : this.sealing;
    this.keys = new InstanceKeyStore(() => join(config.dataDir, 'instance-keys', 'identity.v1.enc'), sealing);
  }

  /** The backend's address, for phone access; fixed once `open()` resolved. */
  get backend(): BackendEndpoint | undefined {
    return this.endpoint;
  }

  async open(): Promise<void> {
    this.endpoint = await this.deps.allocate();
    // A build without the renderer (development) has no browser door; the rest of the host does not depend on it.
    await this.deps.owner
      ?.listen()
      .catch((error: Error) => this.deps.log(`browser access unavailable: ${error.message}`));
  }

  /**
   * A connection that proved the token. It may ask and command (the `pi-kit` command does); it becomes the desktop, which
   * the backend's requests go to and whose storage seals the instance key, only by calling `attach`. A newer desktop
   * replaces an older one.
   */
  accept(peer: RpcPeer): void {
    peer.onClose(() => {
      if (this.desktop !== peer) return;
      this.desktop = undefined;
      this.deps.log('desktop detached');
    });
    peer.handle('attach', (): HostAttachment => {
      if (!this.endpoint) throw new RpcError('The service host is not open yet.');
      const previous = this.desktop;
      this.desktop = peer;
      this.deps.log('desktop attached');
      if (previous && previous !== peer) previous.close();
      const pid = this.current?.child.pid;
      const rendererRoot = this.deps.rendererRoot;
      return {
        endpoint: this.endpoint,
        status: this.status,
        ...(pid ? { backendPid: pid } : {}),
        ...(rendererRoot ? { rendererRoot } : {}),
      };
    });
    peer.handle('status', (): HostStatus => {
      const pid = this.current?.child.pid;
      return {
        status: this.status,
        desktopAttached: !!this.desktop,
        ...(this.endpoint ? { backendUrl: this.endpoint.url } : {}),
        ...(pid ? { backendPid: pid } : {}),
      };
    });
    // What `attach` answers too, without becoming the desktop: for the `pi-kit` command's backend calls.
    peer.handle('backend', (): BackendEndpoint => {
      if (!this.endpoint || !this.watchdog) throw new RpcError('The backend is not running.');
      return { ...this.endpoint };
    });
    peer.handle('owner.link', () => {
      if (!this.deps.owner) throw new RpcError('This pi-kit has no browser access.');
      return this.deps.owner.link();
    });
    peer.handle('owner.revoke', () => this.deps.owner?.revokeAll());
    peer.handle('start', () => this.start());
    peer.handle('retry', () => this.watchdog?.retry());
    peer.handle('stop', () => void this.stop());
    peer.on('app-update-event', (event) => this.toBackend(undefined, { type: 'app-update-event', event }));
    const remote = this.deps.remote;
    if (!remote) return;
    peer.handle('remote.status', () => remote.status());
    peer.handle('remote.setupUrl', () => remote.setupUrl());
    peer.handle('remote.beginPairing', () => remote.beginPairing());
    peer.handle('remote.stop', () => remote.stop());
    peer.handle('remote.start', (port) => {
      if (!isRemotePort(port)) throw new RpcError('Invalid remote access port');
      return remote.start(port);
    });
    for (const action of ['approvePairing', 'rejectPairing', 'revokeDevice'] as const)
      peer.handle(`remote.${action}`, (id) => {
        if (!isRemoteDeviceId(id)) throw new RpcError('Invalid remote access ID');
        return remote[action](id);
      });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.deps.log('service host stopping');
    this.activity?.stop();
    await this.deps.remote?.dispose().catch(() => this.deps.log('Remote access could not shut down cleanly.'));
    await this.deps.owner?.close();
    const running = this.current;
    this.watchdog?.stop();
    running?.stop();
    if (running)
      await Promise.race([running.exited, new Promise<void>((resolve) => this.deps.schedule(resolve, STOP_GRACE_MS))]);
    this.deps.exit(0);
  }

  /**
   * The first start; a failure carries the backend's own reason as `data.failure`. Later calls answer the same start, and
   * one after a failure tries again (the desktop calls it after recreating a broken database).
   */
  start(): Promise<{ bootId?: string }> {
    if (this.watchdog) return Promise.resolve(this.bootId ? { bootId: this.bootId } : {});
    this.starting ??= this.firstStart().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async firstStart(): Promise<{ bootId?: string }> {
    const endpoint = this.endpoint;
    if (!endpoint || this.stopping) throw new RpcError('The service host is not running.');
    this.startupFailure = undefined;
    let first: LaunchedBackend;
    try {
      first = await this.deps.launch(() => this.spawn(endpoint));
    } catch (error) {
      const failure = this.startupFailure;
      throw new RpcError(error instanceof Error ? error.message : String(error), failure ? { failure } : undefined);
    }
    if (this.stopping) {
      first.kill();
      throw new RpcError('The service host is stopping.');
    }
    let adopted: LaunchedBackend | undefined = first;
    this.bootId = first.health.bootId;
    this.watchdog = new BackendWatchdog(
      {
        launch: async () => {
          const handle = adopted ?? (await this.deps.launch(() => this.spawn(endpoint)));
          adopted = undefined;
          return handle;
        },
        ping: async () => !!(await this.deps.ping(endpoint)),
        schedule: (fn, ms) => this.deps.schedule(fn, ms),
        now: () => this.deps.now(),
        report: (status) => {
          this.status = status;
          this.desktop?.emit('status', status);
        },
      },
      this.watchdogOptions,
    );
    this.watchdog.start();
    const guard = this.deps.sleepGuard;
    if (guard) {
      this.activity = new BackendActivity(
        () => this.endpoint,
        (active) => (active ? guard.hold() : guard.release()),
      );
      this.activity.start();
    }
    if (this.deps.restoreRemote)
      void this.deps.remote
        ?.restore()
        .catch(() => this.deps.log('Remembered remote access could not be restored; local work remains available.'));
    return this.bootId ? { bootId: this.bootId } : {};
  }

  private spawn(endpoint: BackendEndpoint): RunningBackend {
    const generation = ++this.generation;
    const running = this.deps.spawn(endpoint, {
      ...this.config,
      onOutput: (chunk, stream) => this.deps.output(chunk, stream),
    });
    this.backends.set(generation, running);
    this.current = running;
    running.child.on('message', (message: unknown) => this.fromBackend(generation, message));
    void running.exited.then(() => this.backends.delete(generation));
    this.deps.log(`backend started, pid ${running.child.pid}, ${running.url}`);
    this.desktop?.emit('spawned', { pid: running.child.pid });
    return running;
  }

  private fromBackend(generation: number, value: unknown): void {
    const failure = startupFailureOf(value);
    if (failure) {
      this.startupFailure = failure;
      return;
    }
    const id = fields(value)?.['id'];
    if (typeof id !== 'string') return;
    void this.answer(generation, value).then((body) => {
      if (body) this.toBackend(generation, { type: 'desktop-answer', id, ...body });
    });
  }

  private async answer(generation: number, value: unknown): Promise<DesktopAnswer> {
    const message = fields(value);
    if (message?.['type'] === 'instance-key') return this.instanceKey(generation, message['keyRequest']);
    const desktop = this.desktop;
    if (desktop) {
      try {
        return await desktop.call<DesktopAnswer>('backend-request', value);
      } catch {
        // The desktop went away during the request; answer as if it had never been there.
      }
    }
    return detachedAnswer(value);
  }

  private async instanceKey(generation: number, request: unknown): Promise<DesktopAnswer> {
    const parsed = InstanceKeyRequestSchema.safeParse(request);
    if (generation !== this.generation || this.stopping || !parsed.success) return KEY_UNAVAILABLE;
    const key = parsed.data;
    try {
      const result =
        key.action === 'info'
          ? await this.keys.info(key.instanceId, key.create)
          : await this.keys.sign(key.instanceId, key.claims);
      return { result };
    } catch (error) {
      this.deps.log(`instance key unavailable (${error instanceof InstanceKeyError ? error.code : 'failed'})`);
      return error instanceof InstanceKeyError ? { ...KEY_UNAVAILABLE, error: error.message } : KEY_UNAVAILABLE;
    }
  }

  /** The desktop's safeStorage: the seal of keys made before the host sealed its own, and the fallback where the host cannot seal. */
  private get sealing(): InstanceKeyEncryption {
    const desktop = (): RpcPeer => {
      if (!this.desktop) throw new Error('No desktop attached.');
      return this.desktop;
    };
    return {
      available: async () => !!this.desktop && (await this.desktop.call<boolean>('seal.available')) === true,
      encrypt: async (value) => Buffer.from(await desktop().call<string>('seal.encrypt', value), 'base64'),
      decrypt: (value) => desktop().call<string>('seal.decrypt', value.toString('base64')),
    };
  }

  private toBackend(generation: number | undefined, message: unknown): void {
    const running = generation === undefined ? this.current : this.backends.get(generation);
    if (running?.child.connected) running.child.send(message as Serializable);
  }
}
