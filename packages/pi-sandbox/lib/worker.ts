// Runs only after SRT has wrapped this process; every request below executes under OS confinement.
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IpcChannel, SandboxError, type WireError } from './protocol.js';
import { SandboxPolicy } from './policy.js';
import { ProcessTree } from './process-tree.js';
import { WorkerFilesystem } from './worker-fs.js';
import type { DurableWorkerHandler } from './durable-worker.js';

interface WorkerMessage {
  type: string;
  cwd?: unknown;
  aliasCwd?: unknown;
  temp?: unknown;
  id?: unknown;
  operation?: unknown;
  args?: unknown;
}
type WorkerResponse =
  | { type: 'ready' }
  | { type: 'data'; id: string; data: Buffer }
  | { type: 'result'; id: string; value: unknown }
  | { type: 'error'; id: string; error: WireError }
  | { type: 'fatal'; error: WireError };

class Worker {
  private static readonly SRT_RUNTIME_ENV =
    /^(https?_proxy|all_proxy|ftp_proxy|no_proxy|grpc_proxy|RSYNC_PROXY|SRT_SSH_PROXY_COMMAND|GIT_SSH_COMMAND|NODE_USE_ENV_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|CURL_CA_BUNDLE|GIT_SSL_CAINFO|CARGO_HTTP_CAINFO|JAVA_TOOL_OPTIONS)$/i;
  private files?: WorkerFilesystem;
  private durable?: Promise<DurableWorkerHandler>;
  private closing = false;
  private readonly running = new Map<string, { abort: () => void; done: Promise<void> }>();
  private readonly channel = new IpcChannel<WorkerMessage, WorkerResponse>(
    process.stdin,
    process.stdout,
    (message) => void this.dispatch(message).catch((error: unknown) => this.fatal(error)),
    (error) => void this.fatal(error),
  );

  constructor() {
    process.stdin.on('end', () => void this.shutdown());
    process.on('SIGTERM', () => void this.shutdown());
    process.on('SIGINT', () => void this.shutdown());
  }

  private async dispatch(message: WorkerMessage): Promise<void> {
    if (message.type === 'close') return this.shutdown();
    if (message.type === 'init') {
      if (this.files || typeof message.cwd !== 'string' || typeof message.temp !== 'string')
        throw new SandboxError('Invalid init', 'PROTOCOL_ERROR');
      const aliasCwd = typeof message.aliasCwd === 'string' ? message.aliasCwd : message.cwd;
      this.files = new WorkerFilesystem(message.cwd, aliasCwd, message.temp);
      return this.channel.send({ type: 'ready' });
    }
    const id = message.id;
    if (!this.files || this.closing || typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id))
      throw new SandboxError('Invalid request lifecycle', 'PROTOCOL_ERROR');
    if (message.type === 'cancel') return this.running.get(id)?.abort();
    if (
      message.type !== 'request' ||
      typeof message.operation !== 'string' ||
      !Array.isArray(message.args) ||
      this.running.has(id)
    )
      throw new SandboxError('Invalid operation request', 'PROTOCOL_ERROR');
    const controller = new AbortController();
    const done = this.execute(this.files, id, message.operation, message.args, controller.signal).finally(() =>
      this.running.delete(id),
    );
    this.running.set(id, { abort: () => controller.abort(), done });
  }

  private async execute(
    files: WorkerFilesystem,
    id: string,
    operation: string,
    args: unknown[],
    signal: AbortSignal,
  ): Promise<void> {
    try {
      let value: unknown;
      if (operation === 'exec') value = await this.exec(files, id, args, signal);
      else if (operation.startsWith('durable.')) value = await this.durableRequest(files, operation, args, signal);
      else if (operation === 'pi.grep') value = await this.grep(args, signal);
      else value = await files.run(operation, args, signal);
      if (signal.aborted)
        throw new SandboxError('aborted; a filesystem mutation may already have completed', 'ABORT_ERR');
      await this.channel.send({ type: 'result', id, value });
    } catch (error) {
      await this.channel
        .send({ type: 'error', id, error: SandboxError.wire(error) })
        .catch((sendError: unknown) => this.fatal(sendError));
    }
  }

  private async grep([params, cwd]: unknown[], signal: AbortSignal): Promise<unknown> {
    if (!params || typeof params !== 'object' || typeof cwd !== 'string')
      throw new SandboxError('Invalid grep request', 'INVALID_ARGUMENT');
    // pi reads its package.json and may download ripgrep when it loads: point it at this bundle and keep it offline.
    process.env.PI_PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
    process.env.PI_OFFLINE = '1';
    const { WorkerGrep } = await import('./worker-grep.js');
    return WorkerGrep.run(params, cwd, signal);
  }

  private async durableRequest(
    files: WorkerFilesystem,
    operation: string,
    args: unknown[],
    signal: AbortSignal,
  ): Promise<unknown> {
    if (operation === 'durable.cleanup' && !this.durable) return undefined;
    this.durable ??= import('./durable-worker.js').then(({ DurableWorkerHandler }) =>
      DurableWorkerHandler.create(files.cwd),
    );
    return (await this.durable).request(operation, args, { signal });
  }

  private async exec(
    files: WorkerFilesystem,
    id: string,
    args: unknown[],
    signal: AbortSignal,
  ): Promise<{ exitCode: number | null }> {
    const [command, requestedCwd, rawOptions] = args;
    if (typeof command !== 'string' || command.length > 131072 || typeof requestedCwd !== 'string')
      throw new SandboxError('Invalid command', 'INVALID_ARGUMENT');
    const options = (rawOptions ?? {}) as { env?: NodeJS.ProcessEnv; timeout?: number };
    const environment = SandboxPolicy.cleanEnv(options.env, { cwd: requestedCwd, temp: files.temp });
    // The worker itself started from a clean environment, so these can only be SRT's own proxy/CA settings.
    for (const [key, value] of Object.entries(process.env))
      if (Worker.SRT_RUNTIME_ENV.test(key)) environment[key] = value;
    const windows = process.platform === 'win32';
    const child = spawn(
      windows
        ? path.join(environment.SystemRoot as string, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : '/bin/bash',
      windows
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
        : ['--noprofile', '--norc', '-c', command],
      {
        cwd: files.resolve(requestedCwd),
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !windows,
        windowsHide: true,
      },
    );
    let timedOut = false;
    let killed = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (killed) return;
      killed = true;
      if (windows) {
        ProcessTree.taskkill(child.pid, environment).on('error', () => child.kill());
        return;
      }
      ProcessTree.killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => ProcessTree.killGroup(child.pid, 'SIGKILL'), 250);
    };
    signal.addEventListener('abort', terminate, { once: true });
    if (signal.aborted) terminate();
    if (options.timeout)
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeout * 1000);
    // Awaiting each frame before reading on keeps output bounded by pipe backpressure.
    const pump = async (stream: Readable): Promise<void> => {
      for await (const chunk of stream as AsyncIterable<Buffer>)
        for (let i = 0; i < chunk.length; i += 65536)
          await this.channel.send({ type: 'data', id, data: chunk.subarray(i, i + 65536) });
    };
    const output = Promise.all([pump(child.stdout), pump(child.stderr)]);
    output.catch(terminate);
    try {
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, sig) => {
          // Background jobs share the shell's process group; they must not hold the pipes open after it exits.
          if (!windows) ProcessTree.killGroup(child.pid, 'SIGKILL');
          setTimeout(() => {
            child.stdout.destroy();
            child.stderr.destroy();
          }, 500).unref();
          resolve(code ?? (sig === 'SIGTERM' ? 143 : sig === 'SIGKILL' ? 137 : null));
        });
      });
      await output;
      if (timedOut) throw new SandboxError(`timeout:${options.timeout}`, 'TIMEOUT');
      if (signal.aborted) throw new SandboxError('aborted', 'ABORT_ERR');
      return { exitCode };
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', terminate);
      if (!windows) ProcessTree.killGroup(child.pid, 'SIGKILL');
    }
  }

  private async fatal(error: unknown): Promise<void> {
    await this.channel.send({ type: 'fatal', error: SandboxError.wire(error) }).catch(() => undefined);
    await this.shutdown();
  }

  private async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    let code = 0;
    try {
      for (const run of this.running.values()) run.abort();
      await Promise.allSettled([...this.running.values()].map((run) => run.done));
      const durable = await this.durable?.catch(() => undefined);
      await durable?.close();
    } catch (error) {
      process.stderr.write(`Durable teardown failed: ${SandboxError.wire(error).message}\n`);
      code = 1;
    }
    process.exit(code);
  }
}

new Worker();
