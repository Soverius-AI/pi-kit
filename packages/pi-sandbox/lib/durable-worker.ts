// Loaded only inside the confined worker. Explicit dispatch is the allowlist: no generic method evaluation.
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context';
import type {
  BinaryReader,
  TextLineReader,
  DirReader,
  FileError,
  FileErrorCode,
  Result,
  ShellExecOptions,
} from '@earendil-works/pi-durable/env';
import { DurableCodec, type DurableWireValue } from './durable-codec.js';
import type { DurableOutputEvent } from './durable.js';

type Handle =
  | { kind: 'binary'; reader: BinaryReader }
  | { kind: 'text'; reader: TextLineReader }
  | { kind: 'dir'; reader: DirReader };
interface Job {
  controller: AbortController;
  events: DurableOutputEvent[];
  bytes: number;
  result: DurableWireValue;
  done: boolean;
  promise: Promise<void>;
  wake?: () => void;
}

export class DurableWorkerHandler {
  /** Upper bound for one long poll, so a lost wake-up never stalls the host. */
  private static readonly POLL_MS = 1000;
  private static readonly BACKLOG_BYTES = 512 * 1024;
  private static readonly CONTENT_OPERATIONS = new Set([
    'readTextFile',
    'readTextLines',
    'readBinaryFile',
    'writeFile',
    'appendFile',
    'truncateFile',
    'flushFile',
    'openBinaryReader',
    'openTextLineReader',
  ]);
  private readonly handles = new Map<string, Handle>();
  private readonly jobs = new Map<string, Job>();
  private sequence = 0;
  private closed = false;

  private constructor(
    private readonly env: NodeExecutionEnv,
    private readonly environment: Record<string, string>,
  ) {}

  static create(cwd: string): DurableWorkerHandler {
    // The SDK's inheritEnv:true inherits this snapshot of the already sanitized worker, never the backend's environment.
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value;
    return new DurableWorkerHandler(new NodeExecutionEnv({ cwd }), environment);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await this.env.cleanup(BACKGROUND_CONTEXT);
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
    for (const { reader } of this.handles.values()) await reader.close(BACKGROUND_CONTEXT);
    this.handles.clear();
    this.jobs.clear();
  }

  async request(operation: string, rawArgs: unknown[], { signal }: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.closed) throw new Error('Durable worker is closed');
    if (!operation.startsWith('durable.')) throw new Error('Invalid durable operation');
    const name = operation.slice('durable.'.length);
    const args = rawArgs.map((value) => DurableCodec.decode(value));
    const meta = args[0];
    if (DurableCodec.isRecord(meta) && meta.$durable === 'context') {
      args.shift();
      this.env.cwd = DurableWorkerHandler.string(meta.cwd);
    }
    const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
    switch (name) {
      case 'cleanup':
        return this.close();
      case 'execStart':
        return this.execStart(args[0], args[1]);
      case 'execPoll':
        return this.execPoll(DurableWorkerHandler.string(args[0]), signal);
      case 'execCancel':
        return this.execCancel(DurableWorkerHandler.string(args[0]));
      case 'handle':
        return this.handle(args, context);
    }
    if (DurableWorkerHandler.CONTENT_OPERATIONS.has(name)) {
      const target = await stat(path.resolve(this.env.cwd, DurableWorkerHandler.string(args[0]))).catch(
        () => undefined,
      );
      // FIFOs and devices would park a thread forever (or stream without end); only regular files are content.
      if (target && (target.isFIFO() || target.isSocket() || target.isCharacterDevice() || target.isBlockDevice()))
        return DurableWorkerHandler.failure('invalid', 'Only regular files are supported');
    }
    return this.file(name, args, context);
  }

  private execStart(command: unknown, rawOptions: unknown): string {
    if (this.jobs.size >= 128) throw new Error('Too many command handles');
    if (!DurableCodec.isCommand(command)) throw new Error('Invalid command');
    const options = DurableWorkerHandler.shellOptions(rawOptions);
    const id = String(++this.sequence);
    const controller = new AbortController();
    const job: Job = { controller, events: [], bytes: 0, result: undefined, done: false, promise: Promise.resolve() };
    const finish = (result: DurableWireValue) => {
      job.result = result;
      job.done = true;
      job.wake?.();
    };
    this.jobs.set(id, job);
    job.promise = this.env
      .exec(
        command,
        {
          ...options,
          cwd: options.cwd ?? this.env.cwd,
          env: { ...(options.inheritEnv === false ? {} : this.environment), ...options.env },
          inheritEnv: false,
          onOutput: (text, _context, info) => {
            job.bytes += Buffer.byteLength(text);
            if (job.bytes > DurableWorkerHandler.BACKLOG_BYTES)
              throw new Error('Durable output transport backlog exceeded');
            job.events.push({ text, info });
            job.wake?.();
          },
        },
        withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      )
      .then(
        (result) => finish(DurableCodec.encode(result)),
        (error: unknown) =>
          finish({
            ok: false,
            error: { $durable: 'error', name: 'ExecutionError', code: 'unknown', message: String(error) },
          }),
      );
    return id;
  }

  private async execPoll(id: string, signal?: AbortSignal): Promise<unknown> {
    const job = this.jobs.get(id);
    if (!job) throw new Error('Unknown command handle');
    if (!job.events.length && !job.done)
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          job.wake = undefined;
          signal?.removeEventListener('abort', wake);
          resolve();
        };
        const timer = setTimeout(wake, DurableWorkerHandler.POLL_MS);
        job.wake = wake;
        signal?.addEventListener('abort', wake, { once: true });
      });
    const events = job.events.splice(0);
    job.bytes = 0;
    if (job.done) this.jobs.delete(id);
    return { events, done: job.done, result: job.result };
  }

  private async execCancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.controller.abort();
    await job.promise;
    this.jobs.delete(id);
  }

  private async handle(args: unknown[], context: Context): Promise<unknown> {
    const id = DurableWorkerHandler.string(args[0]);
    const method = DurableWorkerHandler.string(args[1]);
    const params = args.slice(2);
    const handle = this.handles.get(id);
    if (!handle) return DurableWorkerHandler.failure('invalid', 'Invalid or stale reader handle');
    if (method === 'close') {
      this.handles.delete(id);
      await handle.reader.close(context);
      return undefined;
    }
    if (handle.kind === 'binary') {
      if (method === 'info') return DurableCodec.encode(await handle.reader.info(context));
      if (method === 'read')
        return DurableCodec.encode(
          await handle.reader.read(
            DurableWorkerHandler.number(params[0]),
            DurableWorkerHandler.number(params[1]),
            context,
          ),
        );
      if (method === 'scanLines') {
        const options = DurableWorkerHandler.object(params[0]);
        return DurableCodec.encode(
          await handle.reader.scanLines(
            {
              startLine: DurableWorkerHandler.number(options.startLine),
              endLine: DurableWorkerHandler.optional(options.endLine, DurableWorkerHandler.number),
            },
            context,
          ),
        );
      }
    }
    if (handle.kind === 'text' && method === 'readLine')
      return DurableCodec.encode(await handle.reader.readLine(context));
    if (handle.kind === 'dir' && method === 'next')
      return DurableCodec.encode(await handle.reader.next(DurableWorkerHandler.number(params[0]), context));
    return DurableWorkerHandler.failure('invalid', 'Invalid or stale reader handle');
  }

  private async file(name: string, args: unknown[], context: Context): Promise<unknown> {
    const { string, number, boolean, object, optional } = DurableWorkerHandler;
    let result: Result<unknown, FileError>;
    switch (name) {
      case 'openBinaryReader':
      case 'openTextLineReader':
      case 'openDirReader': {
        if (this.handles.size >= 1024) return DurableWorkerHandler.failure('invalid', 'Too many open readers');
        const target = string(args[0]);
        if (name === 'openBinaryReader') {
          const options = optional(args[1], object);
          const opened = await this.env.openBinaryReader(
            target,
            options && { noFollow: optional(options.noFollow, boolean) },
            context,
          );
          return opened.ok ? this.register({ kind: 'binary', reader: opened.value }) : DurableCodec.encode(opened);
        }
        if (name === 'openTextLineReader') {
          const opened = await this.env.openTextLineReader(target, context);
          return opened.ok ? this.register({ kind: 'text', reader: opened.value }) : DurableCodec.encode(opened);
        }
        const opened = await this.env.openDirReader(target, context);
        return opened.ok ? this.register({ kind: 'dir', reader: opened.value }) : DurableCodec.encode(opened);
      }
      case 'absolutePath':
        result = await this.env.absolutePath(string(args[0]), context);
        break;
      case 'joinPath': {
        const parts = args[0];
        if (!Array.isArray(parts)) throw new Error('Invalid durable path parts');
        result = await this.env.joinPath(parts.map(string), context);
        break;
      }
      case 'readTextFile':
        result = await this.env.readTextFile(string(args[0]), context);
        break;
      case 'readTextLines': {
        const options = optional(args[1], object);
        result = await this.env.readTextLines(
          string(args[0]),
          options && { maxLines: optional(options.maxLines, number) },
          context,
        );
        break;
      }
      case 'readBinaryFile':
        result = await this.env.readBinaryFile(string(args[0]), context);
        break;
      case 'writeFile':
        result = await this.env.writeFile(string(args[0]), DurableWorkerHandler.content(args[1]), context);
        break;
      case 'appendFile':
        result = await this.env.appendFile(string(args[0]), DurableWorkerHandler.content(args[1]), context);
        break;
      case 'truncateFile':
        result = await this.env.truncateFile(string(args[0]), number(args[1]), context);
        break;
      case 'flushFile':
        result = await this.env.flushFile(string(args[0]), context);
        break;
      case 'renameFile':
        result = await this.env.renameFile(string(args[0]), string(args[1]), context);
        break;
      case 'fileInfo':
        result = await this.env.fileInfo(string(args[0]), context);
        break;
      case 'listDir':
        result = await this.env.listDir(string(args[0]), context);
        break;
      case 'canonicalPath':
        result = await this.env.canonicalPath(string(args[0]), context);
        break;
      case 'exists':
        result = await this.env.exists(string(args[0]), context);
        break;
      case 'createDir': {
        const options = optional(args[1], object);
        result = await this.env.createDir(
          string(args[0]),
          options && { recursive: optional(options.recursive, boolean) },
          context,
        );
        break;
      }
      case 'remove': {
        const options = optional(args[1], object);
        result = await this.env.remove(
          string(args[0]),
          options && { recursive: optional(options.recursive, boolean), force: optional(options.force, boolean) },
          context,
        );
        break;
      }
      case 'createTempDir':
        result = await this.env.createTempDir(optional(args[0], string), context);
        break;
      case 'createTempFile': {
        const temp = optional(args[0], object);
        result = await this.env.createTempFile(
          temp && { prefix: optional(temp.prefix, string), suffix: optional(temp.suffix, string) },
          context,
        );
        break;
      }
      default:
        throw new Error('Unsupported durable operation');
    }
    return DurableCodec.encode(result);
  }

  private register(handle: Handle): DurableWireValue {
    const id = String(++this.sequence);
    this.handles.set(id, handle);
    return { ok: true, value: { $durable: 'handle', id, kind: handle.kind } };
  }

  private static failure(code: FileErrorCode, message: string): DurableWireValue {
    return { ok: false, error: { $durable: 'error', name: 'FileError', code, message } };
  }

  private static shellOptions(value: unknown): Omit<ShellExecOptions, 'onOutput'> {
    const { string, number, boolean, object, optional } = DurableWorkerHandler;
    const input = optional(value, object) ?? {};
    const spill = optional(input.spill, object);
    const window = optional(input.window, object);
    return {
      cwd: optional(input.cwd, string),
      env: optional(input.env, (env) =>
        Object.fromEntries(Object.entries(object(env)).map(([key, v]) => [key, string(v)])),
      ),
      inheritEnv: optional(input.inheritEnv, boolean),
      timeout: optional(input.timeout, number),
      spill: spill && { afterBytes: number(spill.afterBytes), afterLines: number(spill.afterLines) },
      window: window && {
        maxBytes: number(window.maxBytes),
        maxLines: number(window.maxLines),
        minIntervalMs: number(window.minIntervalMs),
        bytesPerSecond: number(window.bytesPerSecond),
      },
    };
  }

  private static optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined {
    return value === undefined ? undefined : parse(value);
  }

  private static string(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Invalid durable string argument');
    return value;
  }

  private static number(value: unknown): number {
    if (typeof value !== 'number') throw new Error('Invalid durable number argument');
    return value;
  }

  private static boolean(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new Error('Invalid durable boolean argument');
    return value;
  }

  private static object(value: unknown): Record<string, unknown> {
    if (!DurableCodec.isRecord(value)) throw new Error('Invalid durable options');
    return value;
  }

  private static content(value: unknown): string | Uint8Array {
    if (typeof value === 'string' || value instanceof Uint8Array) return value;
    throw new Error('Invalid durable file content');
  }
}
