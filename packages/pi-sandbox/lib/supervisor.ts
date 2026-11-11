// The only module that imports SRT at runtime. One supervisor process serves one sandbox.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { SandboxOptions } from './core.js';
import { copyFile, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { IpcChannel, SandboxError, type WireError } from './protocol.js';
import { SandboxPolicy } from './policy.js';
import { ProcessTree } from './process-tree.js';
import javaAgent from '@anthropic-ai/sandbox-runtime/vendor/java-proxy-agent/srt-proxy-agent.jar';
import seccompArm64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/arm64/apply-seccomp';
import seccompX64 from '@anthropic-ai/sandbox-runtime/vendor/seccomp/x64/apply-seccomp';

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
interface WorkerProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<number | null>;
  kill(): void;
}

class Supervisor {
  private static readonly TRASH = 'pi-srt-trash-';
  /** Written in terms of process.platform and process.arch, so a release target's bundle keeps only its own helper. */
  private static readonly HELPERS = {
    seccomp:
      process.platform === 'linux'
        ? Supervisor.bundled(process.arch === 'arm64' ? seccompArm64 : seccompX64)
        : undefined,
    javaAgent: process.platform === 'win32' ? undefined : Supervisor.bundled(javaAgent),
  };
  private manager?: Manager;
  private worker?: WorkerProcess;
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
    if (message.action !== 'create') throw new SandboxError('Invalid supervisor action', 'PROTOCOL_ERROR');
    SandboxPolicy.validate(message.options);
    const options: SandboxOptions = message.options;
    const cwd = await realpath(options.cwd).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      throw new SandboxError(`The thread’s folder ${options.cwd} no longer exists.`, 'WORKSPACE_MISSING');
    });
    SandboxPolicy.assertWorkspace(cwd);
    void Supervisor.sweepTrash();
    this.temp = await realpath(await mkdtemp(path.join(tmpdir(), 'pi-srt-')));
    const ripgrep = await Supervisor.provideRipgrep(this.temp);
    await manager.initialize(
      SandboxPolicy.compile({ ...options, cwd }, this.temp, { ...Supervisor.HELPERS, ripgrep }),
      async () => false,
      false,
    );
    const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));
    const worker = (this.worker =
      process.platform === 'win32'
        ? await Supervisor.startMxc(manager, workerPath, cwd)
        : await Supervisor.startWrapped(manager, workerPath, cwd, this.temp));
    worker.stderr.on('data', (b: Buffer) => {
      this.workerStderr = (this.workerStderr + b.toString()).slice(-4096);
    });
    void worker.exited.then(
      (code) => {
        if (this.stopping) return;
        void this.fatal(
          Supervisor.needsLinuxSetup(this.workerStderr)
            ? new SandboxError(
                `This machine needs the one-time Linux sandbox setup: Ubuntu withholds from bubblewrap's children the capabilities the sandbox needs. ${this.workerStderr}`.trim(),
                'LINUX_SETUP_REQUIRED',
              )
            : new SandboxError(
                `Restricted worker exited (${code ?? 'signal'}); unfinished mutations are uncertain. ${this.workerStderr}`.trim(),
                'WORKER_EXIT',
              ),
        );
      },
      (error: unknown) => void this.fatal(error),
    );
    this.workerChannel = new IpcChannel<WorkerResponse, WorkerMessage>(
      worker.stdout,
      worker.stdin,
      (response) => this.forward(response),
      (error) => void this.fatal(error),
    );
    await this.workerChannel.send({ type: 'init', cwd, aliasCwd: options.cwd, temp: this.temp });
  }

  private static async startWrapped(
    manager: Manager,
    workerPath: string,
    cwd: string,
    temp: string,
  ): Promise<WorkerProcess> {
    const wrapped = await manager.wrapWithSandboxArgv(
      `exec ${ProcessTree.shellQuote(process.execPath)} ${ProcessTree.shellQuote(workerPath)}`,
      '/bin/sh',
      undefined,
      undefined,
      cwd,
      { commandId: randomUUID(), commandText: 'pi-sandbox worker' },
    );
    const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd,
      env: { ...SandboxPolicy.cleanEnv({}, { cwd, temp }), ...wrapped.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve(signal ? null : code));
      }),
      kill: () => {
        ProcessTree.killGroup(child.pid, 'SIGKILL');
        child.kill('SIGKILL');
      },
    };
  }

  /** The container gets only a fixed set of Windows variables, so the Node mode goes in the command. */
  private static async startMxc(manager: Manager, workerPath: string, cwd: string): Promise<WorkerProcess> {
    for (const part of [process.execPath, workerPath])
      if (/["%^!]/.test(part))
        throw new SandboxError(`The sandbox runtime path ${part} cannot be quoted for cmd`, 'INVALID_ARGUMENT');
    // A runtime inside the profile sits under read-denied folders, which Node's realpath of the module would stat.
    const launch = `"${process.execPath}" --preserve-symlinks --preserve-symlinks-main "${workerPath}"`;
    const spawned = await manager.spawnSandboxed?.(
      process.versions.electron ? `set "ELECTRON_RUN_AS_NODE=1" && ${launch}` : launch,
      { cwd, commandId: randomUUID(), commandText: 'pi-sandbox worker' },
    );
    if (!spawned?.stdin || !spawned.stdout || !spawned.stderr)
      throw new SandboxError('The MXC sandbox did not give the worker its standard streams', 'WORKER_EXIT');
    const { stdin, stdout, stderr } = spawned;
    return {
      stdin,
      stdout,
      stderr,
      exited: spawned.wait().then(
        ({ exitCode }) => {
          spawned.dispose();
          return exitCode;
        },
        (error: unknown) => {
          spawned.dispose();
          throw error;
        },
      ),
      kill: () => spawned.kill(),
    };
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

  private async stopWorker(worker: WorkerProcess, record: (error: unknown) => void): Promise<void> {
    // A worker that already exited has no stdin left to ask.
    let code = await Supervisor.within(worker.exited, 0);
    if (code === undefined) {
      void this.workerChannel?.send({ type: 'close' }).catch(record);
      code = await Supervisor.within(worker.exited, 1750);
    }
    if (code === undefined) {
      worker.kill();
      code = await Supervisor.within(worker.exited, 1500);
      if (code === undefined) return void record('Restricted worker termination unconfirmed');
    }
    // Without the Linux setup the seccomp helper fails before the worker starts, so nothing ran that could outlive it.
    if (code !== 0 && !Supervisor.needsLinuxSetup(this.workerStderr))
      record(
        `Restricted worker did not confirm orderly shutdown; command mutations/descendant teardown may be uncertain. ${this.workerStderr}`.trim(),
      );
  }

  /** pi's own agent folder is unreadable in the sandbox, so its ripgrep is copied where the worker's pi looks. */
  private static async provideRipgrep(temp: string): Promise<string | undefined> {
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const configured = process.env.PI_CODING_AGENT_DIR;
    const agent = configured ? configured.replace(/^~(?=$|[\\/])/, homedir()) : path.join(homedir(), '.pi', 'agent');
    const bin = path.join(temp, '.pi', 'agent', 'bin');
    await mkdir(bin, { recursive: true });
    for (const source of [Supervisor.bundled(`./vendor/ripgrep/${name}`), path.join(agent, 'bin', name)]) {
      const copied = await copyFile(source, path.join(bin, name)).then(
        () => path.join(bin, name),
        () => undefined,
      );
      if (copied) return copied;
    }
    return undefined;
  }

  /** Ubuntu's bwrap-userns-restrict leaves SRT's seccomp helper without CAP_SYS_ADMIN until pi-kit's own bwrap is set up. */
  private static needsLinuxSetup(stderr: string): boolean {
    return (
      process.platform === 'linux' &&
      stderr.includes('nested userns is capability-restricted') &&
      !existsSync(SandboxPolicy.LINUX_BWRAP)
    );
  }

  /** undefined when the worker is still there after `ms`. */
  private static within(exited: Promise<number | null>, ms: number): Promise<number | null | undefined> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      exited.catch(() => null),
      new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms))),
    ]).finally(() => clearTimeout(timer));
  }

  /** esbuild emits SRT's helper binaries next to this bundle and hands their paths out relative to it. */
  private static bundled(asset: string): string {
    return fileURLToPath(new URL(asset, import.meta.url));
  }

  /** Removes trash left by supervisors that were killed after acknowledging close; live scope temps are never touched. */
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
