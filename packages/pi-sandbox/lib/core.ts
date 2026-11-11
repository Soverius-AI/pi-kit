import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IpcChannel, SandboxError, type WireError } from './protocol.js';
import { SandboxPolicy } from './policy.js';
import { ProcessTree } from './process-tree.js';
export { SandboxError } from './protocol.js';

export interface SandboxOptions {
  cwd: string;
  experimentalWindowsAccepted?: boolean;
  protectedPaths?: string[];
}
export interface SandboxExecOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  /** Seconds. */
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}
export interface SandboxClient {
  readonly state: 'active' | 'unavailable' | 'closed';
  readonly reason?: string;
  exec(command: string, cwd: string, options: SandboxExecOptions): Promise<{ exitCode: number | null }>;
  request<T = unknown>(operation: string, args: unknown[], options?: { signal?: AbortSignal }): Promise<T>;
  close(): Promise<void>;
}
type Action = 'create';
type Incoming =
  | { type: 'ready' }
  | { type: 'closed'; error?: WireError }
  | { type: 'fatal'; error?: WireError }
  | { type: 'data'; id: string; data: unknown }
  | { type: 'result'; id: string; value: unknown }
  | { type: 'error'; id: string; error?: WireError };
type Outgoing =
  | { type: 'init'; action: Action; options: SandboxOptions | Record<string, never> }
  | { type: 'cancel'; id: string }
  | { type: 'request'; id: string; operation: string; args: unknown[] }
  | { type: 'close' };
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
  onData?: (data: Buffer) => void;
}

export class Sandbox {
  static async create(options: SandboxOptions): Promise<SandboxClient> {
    try {
      SandboxPolicy.validate(options);
    } catch (error) {
      const e = SandboxError.from(error);
      e.cleanupConfirmed = true;
      throw e;
    }
    return SupervisorConnection.open('create', options);
  }
}

class SupervisorConnection implements SandboxClient {
  private static readonly SUPERVISOR = fileURLToPath(new URL('./supervisor.js', import.meta.url));
  private static readonly MAX_PENDING = 64;
  private static readonly OPERATIONS = new Set([
    'readFile',
    'writeFile',
    'mkdir',
    'access',
    'stat',
    'readdir',
    'artifact.write',
    'pi.grep',
  ]);
  private static readonly DURABLE = /^durable\.[A-Za-z][A-Za-z0-9.]{0,80}$/;
  /** Bounds a wedged supervisor; an orderly teardown acknowledges well before this. */
  private static readonly CLOSE_ACK_MS = 30_000;

  private phase: 'starting' | 'ready' | 'closing' | 'closed' | 'unavailable' = 'starting';
  private failure?: string;
  private closeAck?: { error?: SandboxError };
  private explicitlyClosed = false;
  private closing?: Promise<void>;
  private nextId = 0;
  private stderr = '';
  private readonly pending = new Map<string, Pending>();
  private readonly ready = SupervisorConnection.deferred<void>();
  private readonly settled = SupervisorConnection.deferred<void>();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly channel: IpcChannel<Incoming, Outgoing>;
  private readonly startTimer: NodeJS.Timeout;

  private constructor() {
    this.child = spawn(process.execPath, [SupervisorConnection.SUPERVISOR], {
      env: SandboxPolicy.supervisorEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stderr.on('data', (b: Buffer) => {
      this.stderr = (this.stderr + b.toString()).slice(-4096);
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.settled.resolve();
      if (this.explicitlyClosed && this.closeAck && !this.closeAck.error) return;
      this.fail(
        new SandboxError(
          `Sandbox supervisor exited (${code ?? signal}); outstanding mutations may be uncertain. ${this.stderr}`.trim(),
          'SUPERVISOR_EXIT',
        ),
      );
    });
    this.channel = new IpcChannel<Incoming, Outgoing>(
      this.child.stdout,
      this.child.stdin,
      (message) => this.receive(message),
      (error) => this.fail(error),
    );
    this.startTimer = setTimeout(
      () => this.fail(new SandboxError('Sandbox startup timed out', 'STARTUP_TIMEOUT')),
      45_000,
    );
  }

  static async open(action: Action, options: SandboxOptions | Record<string, never>): Promise<SupervisorConnection> {
    const connection = new SupervisorConnection();
    try {
      await Promise.all([connection.channel.send({ type: 'init', action, options }), connection.ready.promise]);
      return connection;
    } catch (error) {
      const e = SandboxError.from(error);
      connection.fail(e);
      try {
        await connection.close();
        e.cleanupConfirmed = true;
      } catch {
        e.cleanupConfirmed = false;
      }
      throw e;
    }
  }

  get state(): SandboxClient['state'] {
    return this.explicitlyClosed ? 'closed' : this.phase === 'ready' ? 'active' : 'unavailable';
  }

  get reason(): string | undefined {
    return this.failure;
  }

  request<T = unknown>(operation: string, args: unknown[], options?: { signal?: AbortSignal }): Promise<T> {
    if (
      typeof operation !== 'string' ||
      !(SupervisorConnection.OPERATIONS.has(operation) || SupervisorConnection.DURABLE.test(operation)) ||
      !Array.isArray(args)
    )
      return Promise.reject(
        new SandboxError(`Unsupported filesystem operation: ${operation}`, 'UNSUPPORTED_OPERATION'),
      );
    return this.call(operation, args, options?.signal) as Promise<T>;
  }

  exec(command: string, cwd: string, options: SandboxExecOptions): Promise<{ exitCode: number | null }> {
    const { timeout, env, signal, onData } = options;
    if (
      typeof command !== 'string' ||
      command.length > 131072 ||
      typeof cwd !== 'string' ||
      (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400))
    )
      return Promise.reject(new SandboxError('Invalid exec arguments', 'INVALID_ARGUMENT'));
    // The worker builds the final environment; only allowlisted caller variables may enter the sandbox at all.
    return this.call('exec', [command, cwd, { timeout, env: SandboxPolicy.pickEnv(env) }], signal, onData) as Promise<{
      exitCode: number | null;
    }>;
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.explicitlyClosed = true;
    if (this.phase !== 'unavailable') this.phase = 'closing';
    this.rejectPending(new SandboxError('Sandbox closed; unfinished mutations may be uncertain', 'SANDBOX_CLOSED'));
    void this.channel
      .send({ type: 'close' })
      .catch(() => undefined)
      .then(() => this.child.stdin.end());
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SupervisorConnection.CLOSE_ACK_MS);
      void this.settled.promise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!this.closeAck && !ProcessTree.exited(this.child)) {
      this.child.kill('SIGKILL');
      await ProcessTree.waitForExit(this.child, 1000);
    }
    this.phase = 'closed';
    const error = this.closeAck
      ? this.closeAck.error
      : new SandboxError(
          'Sandbox resource teardown unconfirmed; outstanding mutations/resources require review',
          'TEARDOWN_UNCONFIRMED',
        );
    if (error) {
      this.failure = error.message;
      throw error;
    }
  }

  private call(
    operation: string,
    args: unknown[],
    signal?: AbortSignal,
    onData?: (data: Buffer) => void,
  ): Promise<unknown> {
    if (this.phase !== 'ready')
      return Promise.reject(new SandboxError('Sandbox is unavailable/closed; no host fallback'));
    if (signal?.aborted) return Promise.reject(new SandboxError('aborted', 'ABORT_ERR'));
    if (this.pending.size >= SupervisorConnection.MAX_PENDING)
      return Promise.reject(new SandboxError('Too many pending operations', 'IPC_LIMIT'));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const abort = () => void this.channel.send({ type: 'cancel', id }).catch((error) => this.fail(error));
      const cleanup = () => signal?.removeEventListener('abort', abort);
      this.pending.set(id, { resolve, reject, cleanup, onData });
      signal?.addEventListener('abort', abort, { once: true });
      this.channel.send({ type: 'request', id, operation, args }).catch((error) => {
        this.pending.delete(id);
        cleanup();
        reject(error);
      });
    });
  }

  private receive(message: Incoming): void {
    switch (message.type) {
      case 'ready':
        if (this.phase !== 'starting') return;
        clearTimeout(this.startTimer);
        this.phase = 'ready';
        this.ready.resolve();
        return;
      case 'closed':
        this.closeAck = { error: message.error && new SandboxError(message.error.message, message.error.code) };
        if (this.closeAck.error) this.failure = this.closeAck.error.message;
        this.settled.resolve();
        return;
      case 'fatal':
        return this.fail(new SandboxError(message.error?.message || 'Sandbox failed', message.error?.code));
      case 'data': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        if (!Buffer.isBuffer(message.data) || message.data.length > 65536)
          return this.fail(new SandboxError('Invalid output frame', 'PROTOCOL_ERROR'));
        try {
          pending.onData?.(message.data);
        } catch {
          this.channel.send({ type: 'cancel', id: message.id }).catch((error) => this.fail(error));
        }
        return;
      }
      case 'result':
      case 'error': {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        pending.cleanup();
        if (message.type === 'error')
          pending.reject(new SandboxError(message.error?.message || 'Sandbox operation failed', message.error?.code));
        else pending.resolve(message.value);
        return;
      }
      default:
        this.fail(new SandboxError('Unexpected IPC message', 'PROTOCOL_ERROR'));
    }
  }

  private fail(error: unknown): void {
    const e = SandboxError.from(error);
    if (this.phase === 'closed' || this.phase === 'unavailable') return;
    this.failure = e.message;
    this.phase = 'unavailable';
    clearTimeout(this.startTimer);
    this.ready.reject(e);
    this.rejectPending(e);
    // Forced termination is never cleanup confirmation; it only stops a supervisor that ignored the failure.
    setTimeout(() => {
      if (!ProcessTree.exited(this.child)) this.child.kill('SIGKILL');
    }, 5000).unref();
  }

  private static deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  private rejectPending(error: SandboxError): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
