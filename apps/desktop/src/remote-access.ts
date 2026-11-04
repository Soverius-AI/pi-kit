import type { RemoteAccessPairing, RemoteAccessSetupAction, RemoteAccessStatus } from '@pi-kit/protocol';
import { RemoteGateway } from './remote-gateway';
import type { Backend } from './remote-gateway-proxy';
import { RemoteAccessSetup } from './remote-access-setup';
import {
  RemoteAccessStores,
  RemoteStorageError,
  type RemoteGrantStore,
  type RemotePreferenceStore,
} from './remote-access-store';
import { RemoteAccessCommandError, ServeConfig, StatusDataError, TailscaleCli, TailscaleStatus } from './tailscale-cli';

export interface RemoteAccessProcess {
  /** Resolves for both a spawn error and process exit. Never includes CLI output. */
  exited: Promise<void>;
  kill(signal: 'SIGINT' | 'SIGKILL'): void;
  output?(): string;
}

/** Injection seam: tests need never invoke an installed Tailscale or publish a listener. */
export interface RemoteAccessDependencies extends Pick<TailscaleCli, 'findCli' | 'run' | 'launch'> {
  startupTimeoutMs: number;
  pollIntervalMs: number;
  shutdownTimeoutMs: number;
  gatewayFactory(options: RemoteAccessOptions & { publicOrigin: string }): RemoteAccessGateway;
}

export interface RemoteAccessOptions {
  rendererRoot: string;
  backend: () => Backend | undefined;
  grants?: RemoteGrantStore;
  preferences?: RemotePreferenceStore;
  published?(origin: string): Promise<void>;
  cookieScope?(): Promise<string>;
}

export interface RemoteAccessGateway {
  listen(): Promise<string>;
  close(): Promise<void>;
  beginPairing(): RemoteAccessPairing;
  approve(id: string): void;
  reject(id: string): void;
  revoke(id: string): void | Promise<void>;
  status(): Pick<RemoteAccessStatus, 'pairing' | 'requests' | 'devices'>;
}

class Cancelled extends Error {}

/** Explicit opt-in Tailscale publication of an authenticated, loopback-only gateway. */
export class RemoteAccess {
  private static readonly DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
  /** What a failed Tailscale or storage call means for the user; the generic status/start failures are built from the step. */
  private static readonly FAILURES: Record<string, Partial<RemoteAccessStatus>> = {
    storage: {
      issue: 'storage-unavailable',
      diagnostic: 'storage: unavailable',
      message:
        'Saved phone approvals could not be read or committed. Check that this profile’s backend and database are available, then retry. Tailscale approvals do not need to be changed.',
    },
    'cli-mode': {
      issue: 'status-failed',
      message:
        'Tailscale opened in app mode instead of command mode. This is a pi-kit integration issue; your Tailscale approvals do not need to be changed.',
    },
    permission: {
      issue: 'permission-denied',
      setupAction: 'tailscale',
      message: 'Tailscale denied permission. Open Tailscale and check this computer’s access permissions, then retry.',
    },
    unavailable: {
      state: 'disconnected',
      issue: 'connection-required',
      setupAction: 'tailscale',
      message: 'Tailscale is installed but its daemon is unreachable. Open Tailscale and connect first.',
    },
    assets: {
      issue: 'assets-missing',
      diagnostic: 'gateway: assets-missing',
      message: 'Remote access application files are missing. Reinstall or rebuild pi-kit, then retry.',
    },
  };

  private readonly deps: RemoteAccessDependencies;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private interaction = 0;
  private disposed = false;
  private port = 8443;
  private current: RemoteAccessStatus = { port: this.port, state: 'unavailable' };
  private cli?: string;
  private consentUrl?: string;
  private authenticatedGateway?: RemoteAccessGateway;
  private target?: string;
  private child?: RemoteAccessProcess;
  private childExited = false;
  private gatewayDns?: string;
  private staleMapping?: { dns: string; target: string; port: number };

  constructor(
    dependencies: Partial<RemoteAccessDependencies> = {},
    private readonly options: RemoteAccessOptions,
  ) {
    const cli = new TailscaleCli();
    this.deps = {
      findCli: () => cli.findCli(),
      run: (file, args) => cli.run(file, args),
      launch: (file, args) => cli.launch(file, args),
      startupTimeoutMs: 10000,
      pollIntervalMs: 200,
      shutdownTimeoutMs: 1500,
      gatewayFactory: (options) => new RemoteGateway(options),
      ...dependencies,
    };
  }

  setupUrl(): string | undefined {
    return this.consentUrl;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  status(): Promise<RemoteAccessStatus> {
    return this.serial(async (): Promise<RemoteAccessStatus> =>
      this.disposed
        ? { port: this.port, state: 'unavailable', message: 'Remote access has been disposed.' }
        : this.report(),
    );
  }

  private async report(): Promise<RemoteAccessStatus> {
    try {
      return await this.withRememberedDevices(await this.inspect());
    } catch (error) {
      await this.cleanup();
      return this.failure(error, 'status');
    }
  }

  private async inspect(): Promise<RemoteAccessStatus> {
    this.cli ??= await this.deps.findCli();
    if (!this.cli)
      return this.set({
        state: 'unavailable',
        issue: 'cli-unavailable',
        setupAction: 'tailscale',
        message: 'Install Tailscale to use remote access.',
      });
    let output: string;
    try {
      output = await this.deps.run(this.cli, ['status', '--json']);
    } catch (error) {
      await this.cleanup();
      return this.failure(error, 'status');
    }
    const status = TailscaleStatus.parse(output);
    const versionField = { ...(status.version && { version: status.version }) };
    if (!status.running) {
      if (this.child) await this.cleanup();
      return this.set({
        ...versionField,
        state: 'disconnected',
        issue: 'connection-required',
        setupAction: 'tailscale',
        message: status.needsLogin
          ? 'Sign in to Tailscale and connect to your tailnet first.'
          : 'Open Tailscale and connect to your tailnet first.',
      });
    }
    const dns = status.dnsName;
    const httpsReady = status.httpsReady;
    const base = {
      ...versionField,
      ...(dns && { dnsName: dns }),
      ...(httpsReady === undefined ? {} : { httpsReady }),
    };
    const config = await this.serveStatus(this.cli);
    if (this.staleMapping) {
      if (config.owned(this.staleMapping.dns, this.staleMapping.target, this.staleMapping.port))
        return this.fail(
          `Tailscale retained the previous remote access mapping on port ${this.staleMapping.port}. Review and remove that specific mapping in Tailscale before retrying.`,
        );
      this.staleMapping = undefined;
    }
    if (this.child && !this.childExited && this.target && dns && config.owned(dns, this.target, this.port))
      return this.set({
        ...base,
        state: 'serving',
        url: new URL(`https://${dns}:${this.port}`).origin,
        ...this.authenticatedGateway?.status(),
      });
    if (this.child && this.current.state === 'serving') {
      await this.cleanup();
      return this.fail('Remote access stopped or its HTTPS configuration changed. Start again to retry.');
    }
    if (status.reportsCertificates && !httpsReady)
      return this.set({
        ...base,
        state: 'available',
        issue: 'https-required',
        setupAction: 'https',
        message: 'Enable HTTPS certificates in the Tailscale admin console for this computer, then refresh.',
      });
    return this.set({ ...base, state: 'available' });
  }

  start(port?: number): Promise<RemoteAccessStatus> {
    if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535))
      return Promise.reject(new Error('Invalid remote access port'));
    if (
      port !== undefined &&
      port !== this.port &&
      (this.child || this.current.state === 'serving' || this.current.state === 'starting')
    )
      return Promise.reject(new Error('Stop remote access before changing its port'));
    this.interaction++;
    const generation = this.generation;
    const checkpoint = () => {
      if (generation !== this.generation) throw new Cancelled();
    };
    return this.serial(async () => {
      if (this.disposed || generation !== this.generation)
        return { port: this.port, state: 'unavailable', message: 'Remote access start was cancelled.' };
      if (port !== undefined && port !== this.port) {
        if (this.child || this.current.state === 'serving' || this.current.state === 'starting')
          throw new Error('Stop remote access before changing its port');
        this.port = port;
      }
      try {
        // This is explicit consent, separate from whether the current network can serve.
        await this.options.preferences?.save({ desiredEnabled: true, httpsPort: this.port });
        const status = await this.inspect();
        if (status.state !== 'available' || status.issue) return { ...status };
        const dns = status.dnsName;
        if (!dns)
          return this.fail(
            'Tailscale has no valid ts.net DNS name. Enable MagicDNS and HTTPS in the Tailscale admin console.',
            'https-required',
          );
        this.consentUrl = undefined;
        const cli = this.cli;
        if (!cli) return this.fail('Tailscale is no longer available. Refresh its status and retry.');
        const url = new URL(`https://${dns}:${this.port}`).origin;
        const versionField = { ...(status.version && { version: status.version }) };
        if ((await this.serveStatus(cli)).listeners(this.port).length)
          return this.fail(
            `Tailscale port ${this.port} is already configured (possibly for Funnel). Existing configuration was not changed.`,
            'port-in-use',
          );
        checkpoint();
        await this.openGateway(url);
        checkpoint();
        if ((await this.serveStatus(cli)).listeners(this.port).length) {
          await this.cleanup();
          return this.fail(
            `Tailscale port ${this.port} changed while starting. Existing configuration was not changed.`,
            'port-in-use',
          );
        }
        checkpoint();
        this.gatewayDns = dns;
        this.set({ state: 'starting', dnsName: dns, ...versionField });
        const target = this.target;
        if (!target) throw new Error('The connectivity gateway is unavailable.');
        const child = this.launchServe(cli, target);
        const deadline = Date.now() + this.deps.startupTimeoutMs;
        while (Date.now() < deadline && !this.childExited) {
          checkpoint();
          const check = await this.serveStatus(cli);
          if (this.childExited) break;
          checkpoint();
          if (check.owned(dns, target, this.port)) {
            await this.options.published?.(url);
            checkpoint();
            return this.set({
              state: 'serving',
              ...versionField,
              dnsName: dns,
              url,
              ...this.authenticatedGateway?.status(),
            });
          }
          if (this.processGuidance(child.output?.() ?? '')) break;
          await new Promise((resolve) => setTimeout(resolve, this.deps.pollIntervalMs));
        }
        checkpoint();
        return this.abandon(() =>
          this.fail(
            'HTTPS was not ready. Open Tailscale, enable HTTPS certificates in the admin console and approve HTTPS if requested, then retry.',
            'start-failed',
          ),
        );
      } catch (error) {
        if (error instanceof Cancelled) {
          await this.cleanup();
          return this.current;
        }
        return this.abandon(() => this.failure(error, 'start'));
      }
    });
  }

  /** Give up a start: what the Serve process said wins over the generic failure. */
  private async abandon(fallback: () => RemoteAccessStatus): Promise<RemoteAccessStatus> {
    const guidance = this.processGuidance(this.child?.output?.() ?? '');
    await this.cleanup();
    return guidance ? (this.current = guidance) : fallback();
  }

  /** Foreground Serve; its exit after a successful start turns into an error status and a cleanup. */
  private launchServe(cli: string, target: string): RemoteAccessProcess {
    const child = this.deps.launch(cli, ['serve', `--https=${this.port}`, target]);
    this.child = child;
    this.childExited = false;
    void child.exited.then(() => {
      if (this.child !== child) return;
      this.childExited = true;
      if (this.current.state === 'serving') {
        this.fail('The remote access process exited. Start again to retry.');
        void this.serial(async () => {
          // A queued explicit start may already have replaced this process.
          if (this.child === child) await this.cleanup();
        });
      }
    });
    return child;
  }

  beginPairing(): Promise<RemoteAccessStatus> {
    return this.mutateGateway((gateway) => gateway.beginPairing());
  }

  approvePairing(id: string): Promise<RemoteAccessStatus> {
    return this.mutateGateway((gateway) => gateway.approve(id), id);
  }

  rejectPairing(id: string): Promise<RemoteAccessStatus> {
    return this.mutateGateway((gateway) => gateway.reject(id), id);
  }

  revokeDevice(id: string): Promise<RemoteAccessStatus> {
    return this.serial(async () => {
      if (typeof id !== 'string' || !RemoteAccess.DEVICE_ID.test(id)) throw new Error('Invalid remote access ID');
      if (this.disposed) throw new Error('Remote access is unavailable');
      if (this.authenticatedGateway) await this.authenticatedGateway.revoke(id);
      else if (this.options.grants) await this.options.grants.revoke(id);
      else throw new Error('Remote access is not serving');
      return this.withRememberedDevices(await this.inspect());
    });
  }

  private async withRememberedDevices(status: RemoteAccessStatus): Promise<RemoteAccessStatus> {
    if (this.authenticatedGateway || !this.options.grants) return { ...status };
    return { ...status, devices: (await this.options.grants.load()).map(RemoteAccessStores.publicDevice) };
  }

  private mutateGateway(action: (gateway: RemoteAccessGateway) => unknown, id?: string): Promise<RemoteAccessStatus> {
    const generation = this.generation;
    return this.serial(async () => {
      if (id !== undefined && (typeof id !== 'string' || !RemoteAccess.DEVICE_ID.test(id)))
        throw new Error('Invalid remote access ID');
      if (this.disposed || generation !== this.generation) throw new Error('Remote access is unavailable');
      const status = await this.inspect();
      const gateway = this.authenticatedGateway;
      if (status.state !== 'serving' || !gateway || this.disposed || generation !== this.generation)
        throw new Error('Remote access is not serving');
      await action(gateway);
      return (this.current = { ...status, pairing: undefined, ...gateway.status() });
    });
  }

  /** Restore only persisted prior consent, after the correct backend/profile is healthy. */
  async restore(): Promise<void> {
    const interaction = this.interaction;
    const value = await this.options.preferences?.load();
    // A late startup read must not undo a newer explicit Enable/Disable or mutate an active port.
    if (!value || this.disposed || this.child || interaction !== this.interaction) return;
    this.port = value.httpsPort;
    if (value.desiredEnabled) await this.start(value.httpsPort);
  }

  stop(): Promise<RemoteAccessStatus> {
    ++this.interaction;
    ++this.generation;
    return this.serial(async () => {
      await this.cleanup();
      // Cleanup happens even when the preference write fails; no false durable-success report.
      await this.options.preferences?.save({ desiredEnabled: false, httpsPort: this.port });
      return this.disposed ? { port: this.port, state: 'unavailable' } : this.report();
    });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    ++this.generation;
    return this.serial(async () => {
      await this.cleanup();
      this.set({ state: 'unavailable' });
    });
  }

  private set(status: Omit<RemoteAccessStatus, 'port'>): RemoteAccessStatus {
    return (this.current = { port: this.port, ...status });
  }

  private fail(
    message: string,
    issue?: RemoteAccessStatus['issue'],
    setupAction?: RemoteAccessSetupAction,
  ): RemoteAccessStatus {
    return this.set({ state: 'error', message, ...(issue && { issue }), ...(setupAction && { setupAction }) });
  }

  private async serveStatus(cli: string): Promise<ServeConfig> {
    try {
      return ServeConfig.parse(await this.deps.run(cli, ['serve', 'status', '--json']));
    } catch (error) {
      if (error instanceof StatusDataError) throw error;
      const failure = error instanceof RemoteAccessCommandError ? error : new RemoteAccessCommandError('failed');
      // Step is a fixed label, never a command string or raw output.
      throw Object.assign(failure, { step: 'serve-status' });
    }
  }

  private failure(error: unknown, operation: 'status' | 'start'): RemoteAccessStatus {
    const command = error instanceof RemoteAccessCommandError ? error : undefined;
    const data = error instanceof StatusDataError ? error : undefined;
    const step = data?.step ?? (command && 'step' in command ? 'serve-status' : operation);
    const diagnostic = `${step}: ${data?.reason ?? command?.diagnostic ?? 'operation-failed'}`;
    const known: Partial<RemoteAccessStatus> =
      error instanceof RemoteStorageError
        ? RemoteAccess.FAILURES.storage
        : data?.reason === 'cli-mode'
          ? RemoteAccess.FAILURES['cli-mode']
          : command?.kind === 'permission' || command?.kind === 'unavailable'
            ? RemoteAccess.FAILURES[command.kind]
            : operation === 'start' && (error as { code?: unknown } | null)?.code === 'ENOENT'
              ? RemoteAccess.FAILURES.assets
              : {
                  issue: operation === 'status' ? 'status-failed' : 'start-failed',
                  message:
                    command?.kind === 'timeout'
                      ? `Tailscale ${step} query timed out. Open Tailscale and retry.`
                      : `Could not read Tailscale ${step === 'serve-status' ? 'Serve status' : operation === 'status' ? 'status' : 'remote access setup'}. Refresh or retry after checking Tailscale.`,
                };
    return this.set({ state: 'error', diagnostic, ...known });
  }

  private processGuidance(output: string): RemoteAccessStatus | undefined {
    for (const candidate of output.match(/https:\/\/[^\s<>"']+/g) ?? []) {
      const url = RemoteAccessSetup.approvalUrl(candidate);
      if (url) {
        this.consentUrl = url;
        return this.fail(
          'Approve Tailscale Serve for this computer, then start remote access again.',
          'approval-required',
          'authorize',
        );
      }
    }
    if (/permission denied|access denied|not permitted/i.test(output))
      return this.failure(new RemoteAccessCommandError('permission'), 'start');
    if (/not connected|daemon.*not running|failed to connect/i.test(output))
      return this.failure(new RemoteAccessCommandError('unavailable'), 'start');
    if (/https.*(?:not enabled|disabled)|enable https/i.test(output))
      return this.fail(
        'Enable HTTPS certificates in the Tailscale admin console, then retry.',
        'https-required',
        'https',
      );
    if (/address already in use|port.*in use/i.test(output))
      return this.fail(
        `Port ${this.port} is already in use. Review its existing Tailscale configuration before retrying.`,
        'port-in-use',
      );
    return undefined;
  }

  private async openGateway(publicOrigin: string): Promise<void> {
    const gateway = this.deps.gatewayFactory({ ...this.options, publicOrigin });
    this.authenticatedGateway = gateway;
    const target = await gateway.listen();
    if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(target)) throw new Error('Invalid gateway target');
    this.target = target;
  }

  private async cleanup(): Promise<void> {
    const gateway = this.authenticatedGateway;
    this.authenticatedGateway = undefined;
    if (gateway) await gateway.close();
    const child = this.child;
    this.child = undefined;
    if (child && !this.childExited)
      for (const signal of ['SIGINT', 'SIGKILL'] as const) {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
        const exited = await Promise.race([
          child.exited.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.deps.shutdownTimeoutMs)),
        ]);
        if (exited) break;
      }
    // Foreground Serve normally removes its own session. Never issue `off` or
    // `reset`: another editor may now own that port. Verify removal read-only;
    // a retained mapping must be reviewed manually (even a closed local port
    // could later be reused by another process). A crash cannot run this check.
    if (this.target && this.gatewayDns) {
      this.staleMapping = { dns: this.gatewayDns, target: this.target, port: this.port };
      if (this.cli) {
        try {
          const config = await this.serveStatus(this.cli);
          if (!config.owned(this.gatewayDns, this.target, this.port)) this.staleMapping = undefined;
        } catch {
          /* retain candidate; the next status read will verify it */
        }
      }
    }
    this.gatewayDns = undefined;
    this.target = undefined;
    this.current = { port: this.port, state: 'available' };
  }
}
