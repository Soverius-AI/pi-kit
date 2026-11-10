// Host-side RPC facade. NodeExecutionEnv must never be imported here: it runs only inside the confined worker.
import {
  FileError,
  ExecutionError,
  type ExecutionEnv,
  type BinaryReader,
  type TextLineReader,
  type DirReader,
  type FileErrorCode,
  type ExecutionErrorCode,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type ShellOutputInfo,
} from '@earendil-works/pi-durable/env';
import type { Context } from '@earendil-works/chord/context';
import type { SandboxClient } from './core.js';
import { DurableCodec } from './durable-codec.js';

export interface DurableOutputEvent {
  text: string;
  info: ShellOutputInfo;
}
export interface DurableExecPacket {
  events: DurableOutputEvent[];
  done: boolean;
  result?: Result<ShellExecResult, ExecutionError>;
}
export interface DurableEnvironmentOptions {
  cwd: string;
  namespaceId: string;
  /** Called once by cleanup(); the owner decides whether that closes the sandbox client. */
  release: () => Promise<void>;
}

type FileResult<T> = Promise<Result<T, FileError>>;

export class DurableSandbox implements ExecutionEnv {
  private static readonly FILE_ERROR_CODES: readonly FileErrorCode[] = [
    'aborted',
    'not_found',
    'permission_denied',
    'not_directory',
    'is_directory',
    'invalid',
    'not_supported',
    'unknown',
  ];
  private static readonly EXECUTION_ERROR_CODES: readonly ExecutionErrorCode[] = [
    'aborted',
    'timeout',
    'shell_unavailable',
    'spawn_error',
    'callback_error',
    'unknown',
  ];
  readonly id: string;
  cwd: string;
  private closed = false;
  private readonly release: () => Promise<void>;

  private constructor(
    private readonly client: Pick<SandboxClient, 'request'>,
    { cwd, namespaceId, release }: DurableEnvironmentOptions,
  ) {
    if (!cwd || !namespaceId) throw new Error('Durable sandbox requires cwd and namespaceId');
    this.id = namespaceId;
    this.cwd = cwd;
    this.release = release;
  }

  static environment(client: Pick<SandboxClient, 'request'>, options: DurableEnvironmentOptions): ExecutionEnv {
    return new DurableSandbox(client, options);
  }

  absolutePath(path: string, context: Context): FileResult<string> {
    return this.rpc('absolutePath', [path], context);
  }
  joinPath(parts: string[], context: Context): FileResult<string> {
    return this.rpc('joinPath', [parts], context);
  }
  readTextFile(path: string, context: Context): FileResult<string> {
    return this.rpc('readTextFile', [path], context);
  }
  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): FileResult<string[]> {
    return this.rpc('readTextLines', [path, options], context);
  }
  readBinaryFile(path: string, context: Context): FileResult<Uint8Array> {
    return this.rpc('readBinaryFile', [path], context);
  }
  writeFile(path: string, content: string | Uint8Array, context: Context): FileResult<void> {
    return this.rpc('writeFile', [path, content], context);
  }
  appendFile(path: string, content: string | Uint8Array, context: Context): FileResult<void> {
    return this.rpc('appendFile', [path, content], context);
  }
  truncateFile(path: string, size: number, context: Context): FileResult<void> {
    return this.rpc('truncateFile', [path, size], context);
  }
  flushFile(path: string, context: Context): FileResult<void> {
    return this.rpc('flushFile', [path], context);
  }
  renameFile(source: string, destination: string, context: Context): FileResult<void> {
    return this.rpc('renameFile', [source, destination], context);
  }
  fileInfo(path: string, context: Context): FileResult<FileInfo> {
    return this.rpc('fileInfo', [path], context);
  }
  listDir(path: string, context: Context): FileResult<FileInfo[]> {
    return this.rpc('listDir', [path], context);
  }
  canonicalPath(path: string, context: Context): FileResult<string> {
    return this.rpc('canonicalPath', [path], context);
  }
  exists(path: string, context: Context): FileResult<boolean> {
    return this.rpc('exists', [path], context);
  }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): FileResult<void> {
    return this.rpc('createDir', [path, options], context);
  }
  remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): FileResult<void> {
    return this.rpc('remove', [path, options], context);
  }
  createTempDir(prefix: string | undefined, context: Context): FileResult<string> {
    return this.rpc('createTempDir', [prefix], context);
  }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): FileResult<string> {
    return this.rpc('createTempFile', [options], context);
  }
  openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): FileResult<BinaryReader> {
    return this.rpc('openBinaryReader', [path, options], context);
  }
  openTextLineReader(path: string, context: Context): FileResult<TextLineReader> {
    return this.rpc('openTextLineReader', [path], context);
  }
  openDirReader(path: string, context: Context): FileResult<DirReader> {
    return this.rpc('openDirReader', [path], context);
  }

  async watch(): Promise<Result<never, FileError>> {
    return { ok: false, error: new FileError('not_supported', 'Sandbox watchers have no safe event transport') };
  }

  async exec(
    command: string | string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const fail = (code: ExecutionErrorCode, message: string): Result<ShellExecResult, ExecutionError> => ({
      ok: false,
      error: new ExecutionError(code, message),
    });
    const signal = context.abortSignal;
    if (signal?.aborted) return fail('aborted', 'Command aborted');
    if (!DurableCodec.isCommand(command)) return fail('spawn_error', 'Invalid command argv');
    let id: string | undefined;
    let cancelled: Promise<void> | undefined;
    // A started command is cancelled by its own RPC; the aborted caller context would refuse to deliver it.
    const cancel = (): Promise<void> | undefined => {
      if (id) cancelled ??= this.rpc<void>('execCancel', [id]).catch(() => undefined);
      return cancelled;
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const { onOutput, ...serializable } = options ?? {};
      id = await this.rpc<string>('execStart', [command, serializable]);
      while (true) {
        if (signal?.aborted) {
          await cancel();
          return fail('aborted', 'Command aborted');
        }
        const packet = await this.rpc<DurableExecPacket>('execPoll', [id]);
        for (const event of packet.events) {
          try {
            onOutput?.(event.text, context, event.info);
          } catch (error) {
            await cancel();
            return fail('callback_error', String(error));
          }
        }
        if (packet.done && !signal?.aborted) {
          if (!packet.result) throw new Error('Missing durable command result');
          return packet.result;
        }
      }
    } catch (error) {
      await cancel();
      return fail(signal?.aborted ? 'aborted' : 'unknown', error instanceof Error ? error.message : String(error));
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  async cleanup(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.request('durable.cleanup', []);
    } finally {
      await this.release();
    }
  }

  private async rpc<T>(name: string, args: unknown[], context?: Context): Promise<T> {
    if (this.closed) throw new Error('Durable sandbox environment is closed');
    const encoded = [{ $durable: 'context', cwd: this.cwd }, ...args].map((value) => DurableCodec.encode(value));
    const value = await this.client.request<unknown>(`durable.${name}`, encoded, { signal: context?.abortSignal });
    return DurableCodec.decode(value, (record) => this.revive(record)) as T;
  }

  private revive(record: Record<string, unknown>): unknown {
    if (record.$durable === 'error') {
      if (typeof record.message !== 'string') throw new Error('Invalid durable error');
      if (record.name === 'ExecutionError') {
        const code = DurableSandbox.EXECUTION_ERROR_CODES.find((c) => c === record.code) ?? 'unknown';
        const error = new ExecutionError(code, record.message);
        if (typeof record.spillPath === 'string') error.spillPath = record.spillPath;
        return error;
      }
      const code = DurableSandbox.FILE_ERROR_CODES.find((c) => c === record.code) ?? 'unknown';
      return new FileError(code, record.message, typeof record.path === 'string' ? record.path : undefined);
    }
    if (record.$durable !== 'handle') return undefined;
    if (typeof record.id !== 'string') throw new Error('Invalid durable reader handle');
    const id = record.id;
    const close = (context: Context): Promise<void> => this.rpc<void>('handle', [id, 'close'], context);
    switch (record.kind) {
      case 'binary':
        return {
          info: (context) => this.rpc('handle', [id, 'info'], context),
          read: (offset, length, context) => this.rpc('handle', [id, 'read', offset, length], context),
          scanLines: (options, context) => this.rpc('handle', [id, 'scanLines', options], context),
          close,
        } satisfies BinaryReader;
      case 'text':
        return { readLine: (context) => this.rpc('handle', [id, 'readLine'], context), close } satisfies TextLineReader;
      case 'dir':
        return {
          next: (maxEntries, context) => this.rpc('handle', [id, 'next', maxEntries], context),
          close,
        } satisfies DirReader;
      default:
        throw new Error('Invalid durable reader kind');
    }
  }
}
