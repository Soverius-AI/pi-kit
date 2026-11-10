// The only module that imports SRT at runtime. One supervisor process serves one sandbox.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SandboxOptions } from './core.js';
import { mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { IpcChannel, SandboxError, type WireError } from './protocol.js';
import { SandboxPolicy } from './policy.js';
import { ProcessTree } from './process-tree.js';
import javaAgent from '@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar';
import seccompArm64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp';
import seccompX64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp';
import srtWinArm64 from '@anthropic-ai/sandbox-runtime/vendor/srt-win/arm64/srt-win.exe';
import srtWinX64 from '@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe';

interface ClientMessage {
  type: string;
  action?: unknown;
  options?: unknown;
  id?: unknown;
  operation?: unknown;
  args?: unknown;
}
type WorkerResponse =
  | { type: 'ready' }
  | { type: 'data'; id: string; data: Buffer }
  | { type: 'result'; id: string; value: unknown }
  | { type: 'error'; id: string; error: WireError }
  | { type: 'fatal'; error?: WireError };
type SupervisorResponse =
  | Exclude<WorkerResponse, { type: 'ready' | 'fatal' }>
  | { type: 'ready' }
  | { type: 'fatal'; error: WireError }
  | { type: 'closed'; error?: WireError };
type WorkerMessage = ClientMessage | { type: 'init'; cwd: string; aliasCwd: string; temp: string };
type Manager = typeof import('@anthropic-ai/sandbox-runtime').SandboxManager;

class Supervisor {
  private static readonly TRASH = 'pi-srt-trash-';
  /** Written in terms of process.platform and process.arch, so a release target's bundle keeps only its own helper. */
  private static readonly HELPERS = {
    seccomp:
      process.platform === 'linux'
        ? Supervisor.bundled(process.arch === 'arm64' ? seccompArm64 : seccompX64)
        : undefined,
    srtWin:
      process.platform === 'win32' ? Supervisor.bundled(process.arch === 'arm64' ? srtWinArm64 : srtWinX64) : undefined,
    javaAgent: process.platform === 'win32' ? undefined : Supervisor.bundled(javaAgent),
  };
  private manager?: Manager;
  private worker?: ChildProcessWithoutNullStreams;
  private workerChannel?: IpcChannel<WorkerResponse, WorkerMessage>;
  private workerStderr = '';
  private temp?: string;
  private initialization?: Promise<void>;
  private stopping?: Promise<never>;
  private readonly channel = new IpcChannel<ClientMessage, SupervisorResponse>(
    process.stdin,
    process.stdout,
    (message) => this.receive(message),
    (error) => void this.fatal(error),
  );

  constructor() {
    process.stdin.on('end', () => void this.stop());
    process.on('SIGTERM', () => void this.stop());
    process.on('SIGINT', () => void this.stop());
  }

  private receive(message: ClientMessage): void {
    if (message.type === 'close') return void this.stop();
    if (message.type === 'init') {
      if (this.initialization)
        return void this.fatal(new SandboxError('Supervisor already initialized', 'PROTOCOL_ERROR'));
      this.initialization = this.initialize(message);
      this.initialization.catch((error: unknown) => this.fatal(error));
      return;
    }
    if (message.type !== 'request' && message.type !== 'cancel')
      return void this.fatal(new SandboxError('Invalid client message', 'PROTOCOL_ERROR'));
    if (!this.workerChannel || this.stopping) return void this.fatal(new SandboxError('Restricted worker unavailable'));
    this.workerChannel.send(message).catch((error: unknown) => this.fatal(error));
  }

  private async initialize(message: ClientMessage): Promise<void> {
    const srt = await import('@anthropic-ai/sandbox-runtime');
    const manager = (this.manager = srt.SandboxManager);
    const srtWin = Supervisor.HELPERS.srtWin ? srt.resolveSrtWin({ path: Supervisor.HELPERS.srtWin }) : undefined;
    if (message.action === 'setup') {
      if (!srtWin) throw new SandboxError('Native Windows only', 'UNSUPPORTED_PLATFORM');
      await srt.installWindowsSandboxAsync({ skipProfileGrant: true, allowLoopback: false, srtWin });
      return this.channel.send({ type: 'ready' });
    }
    if (message.action !== 'create') throw new SandboxError('Invalid supervisor action', 'PROTOCOL_ERROR');
    SandboxPolicy.validate(message.options);
    const options: SandboxOptions = message.options;
    if (srtWin) {
      // SRT's own check inside initialize() cannot tell a missing machine setup from other failures.
      const { errors, reinstallRequired } = await srt.checkWindowsDependenciesAsync({ srtWin, allowLoopback: false });
      if (errors.length)
        throw new SandboxError(
          errors.join('\n'),
          reinstallRequired || errors.some((error) => error.includes('windows-install'))
            ? 'WINDOWS_SETUP_REQUIRED'
            : 'DEPENDENCIES_UNAVAILABLE',
        );
    }
    const cwd = await realpath(options.cwd);
    SandboxPolicy.assertWorkspace(cwd);
    void Supervisor.sweepTrash();
    this.temp = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-srt-')));
    await manager.initialize(
      SandboxPolicy.compile({ ...options, cwd }, this.temp, Supervisor.HELPERS),
      async () => false,
      false,
    );
    if (
      process.platform === 'win32' &&
      (manager.getWindowsProfileRead() === 'granted' || manager.getWindowsProfileReadWarnings().length)
    )
      throw new SandboxError(
        'Existing Windows profile read grant requires manual review/repair; refusing to start',
        'WINDOWS_PROFILE_GRANT',
      );
    const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));
    const launch = `${ProcessTree.shellQuote(process.execPath)} ${ProcessTree.shellQuote(workerPath)}`;
    const wrapped = await manager.wrapWithSandboxArgv(
      process.platform === 'win32' ? `& ${launch}` : `exec ${launch}`,
      process.platform === 'win32' ? 'powershell' : '/bin/sh',
      undefined,
      undefined,
      cwd,
      { commandId: randomUUID(), commandText: 'pi-sandbox worker' },
    );
    const worker = (this.worker = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd,
      env: { ...SandboxPolicy.cleanEnv({}, { cwd, temp: this.temp }), ...wrapped.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    }));
    worker.stderr.on('data', (b: Buffer) => {
      this.workerStderr = (this.workerStderr + b.toString()).slice(-4096);
    });
    worker.on('error', (error) => void this.fatal(error));
    worker.on('exit', (code, signal) => {
      if (!this.stopping)
        void this.fatal(
          new SandboxError(
            `Restricted worker exited (${code ?? signal}); unfinished mutations are uncertain. ${this.workerStderr}`.trim(),
            'WORKER_EXIT',
          ),
        );
    });
    this.workerChannel = new IpcChannel<WorkerResponse, WorkerMessage>(
      worker.stdout,
      worker.stdin,
      (response) => this.forward(response),
      (error) => void this.fatal(error),
    );
    await this.workerChannel.send({ type: 'init', cwd, aliasCwd: options.cwd, temp: this.temp });
  }

  private forward(response: WorkerResponse): void {
    switch (response.type) {
      case 'ready':
        this.channel.send({ type: 'ready' }).catch((error: unknown) => this.fatal(error));
        return;
      case 'fatal':
        void this.fatal(new SandboxError(response.error?.message || 'Restricted worker failed', response.error?.code));
        return;
      case 'data':
      case 'result':
      case 'error':
        this.channel.send(response).catch((error: unknown) => this.fatal(error));
        return;
      default:
        void this.fatal(new SandboxError('Invalid worker response', 'PROTOCOL_ERROR'));
    }
  }

  private async fatal(error: unknown): Promise<void> {
    await this.channel.send({ type: 'fatal', error: SandboxError.wire(error) }).catch(() => undefined);
    await this.stop();
  }

  private stop(): Promise<never> {
    this.stopping ??= this.teardown();
    return this.stopping;
  }

  private async teardown(): Promise<never> {
    // An in-flight initialization may still spawn the worker; teardown must see it.
    await this.initialization?.catch(() => undefined);
    const errors: string[] = [];
    const record = (error: unknown) => errors.push(SandboxError.wire(error).message);
    if (this.worker) await this.stopWorker(this.worker, record);
    try {
      await this.manager?.reset();
    } catch (error) {
      record(error);
    }
    let trash: string | undefined;
    if (this.temp) {
      trash = path.join(path.dirname(this.temp), `${Supervisor.TRASH}${randomUUID()}`);
      await rename(this.temp, trash).catch((error: unknown) => {
        record(error);
        trash = undefined;
      });
    }
    // Acknowledge before deleting: HOME and TMPDIR point at the scope temp, so it can hold large caches.
    await this.channel
      .send({
        type: 'closed',
        ...(errors.length
          ? { error: { code: 'TEARDOWN_UNCONFIRMED', message: errors.join('; ').slice(0, 4096) } }
          : {}),
      })
      .catch(() => undefined);
    if (trash) await rm(trash, { recursive: true, force: true }).catch(() => undefined);
    process.exit(errors.length ? 1 : 0);
  }

  private async stopWorker(worker: ChildProcessWithoutNullStreams, record: (error: unknown) => void): Promise<void> {
    void this.workerChannel?.send({ type: 'close' }).catch(record);
    if (!(await ProcessTree.waitForExit(worker, 1750))) {
      if (process.platform === 'win32') {
        const taskkill = ProcessTree.taskkill(worker.pid, SandboxPolicy.cleanEnv());
        taskkill.on('error', record);
        if (!(await ProcessTree.waitForExit(taskkill, 1000))) {
          taskkill.kill();
          record('taskkill termination unconfirmed');
        }
      } else {
        const error = ProcessTree.killGroup(worker.pid, 'SIGKILL');
        if (error) record(error);
      }
      worker.kill('SIGKILL');
      if (!(await ProcessTree.waitForExit(worker, 500))) record('Restricted worker termination unconfirmed');
    }
    if (worker.exitCode !== 0 || worker.signalCode)
      record(
        `Restricted worker did not confirm orderly shutdown; command mutations/descendant teardown may be uncertain. ${this.workerStderr}`.trim(),
      );
  }

  /** Removes trash left by supervisors that were killed after acknowledging close; live scope temps are never touched. */
  /** esbuild emits SRT's helper binaries next to this bundle and hands their paths out relative to it. */
  private static bundled(asset: string): string {
    return fileURLToPath(new URL(asset, import.meta.url));
  }

  private static async sweepTrash(): Promise<void> {
    const entries = await readdir(tmpdir()).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(Supervisor.TRASH))
        .map((name) => rm(path.join(tmpdir(), name), { recursive: true, force: true }).catch(() => undefined)),
    );
  }
}

new Supervisor();
