import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants, type MakeDirectoryOptions } from 'node:fs';
import path from 'node:path';
import { SandboxError } from './protocol.js';

/** Filesystem requests as executed inside the confined worker. OS policy, not this class, decides access. */
export class WorkerFilesystem {
  static readonly MAX_FILE = 4 * 1024 * 1024;
  // O_NONBLOCK keeps a FIFO from parking a libuv thread in open(2) forever; it is a no-op for regular files.
  private static readonly NONBLOCK = constants.O_NONBLOCK ?? 0;
  private static readonly WRITE_FLAGS: Record<string, number> = {
    w: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    wx: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    a: constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    ax: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND,
  };

  constructor(
    readonly cwd: string,
    readonly aliasCwd: string,
    readonly temp: string,
  ) {}

  /** Maps the caller's spelling of the workspace (e.g. macOS /var vs /private/var) onto the canonical one. */
  resolve(p: unknown): string {
    if (typeof p !== 'string' || p.includes('\0') || p.length > 32768)
      throw new SandboxError('Expected a filesystem path string', 'INVALID_ARGUMENT');
    const absolute = path.resolve(this.cwd, p);
    const relative = path.relative(this.aliasCwd, absolute);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      ? path.join(this.cwd, relative)
      : absolute;
  }

  async run(operation: string, args: unknown[], signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new SandboxError('aborted', 'ABORT_ERR');
    if (operation === 'artifact.write') {
      if (!Buffer.isBuffer(args[0]) || args[0].length > WorkerFilesystem.MAX_FILE)
        throw new SandboxError('Artifact exceeds 4 MiB', 'FILE_LIMIT');
      const name = path.join(this.temp, `output-${randomUUID()}.txt`);
      await fs.writeFile(name, args[0], { flag: 'wx', mode: 0o600, signal });
      return name;
    }
    const target = this.resolve(args[0]);
    switch (operation) {
      case 'readFile': {
        const { length } = WorkerFilesystem.options<{ length?: unknown }>(args[1], ['length']);
        if (
          length !== undefined &&
          (typeof length !== 'number' ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            length > WorkerFilesystem.MAX_FILE)
        )
          throw new SandboxError('readFile length must be an integer up to 4 MiB', 'INVALID_ARGUMENT');
        return this.readFile(target, length, signal);
      }
      case 'writeFile': {
        const data = args[1];
        if (typeof data !== 'string' && !(data instanceof Uint8Array))
          throw new SandboxError('Expected string or bytes', 'INVALID_ARGUMENT');
        const options = WorkerFilesystem.options<{ encoding?: BufferEncoding; mode?: number; flag?: string }>(args[2], [
          'encoding',
          'mode',
          'flag',
        ]);
        return this.writeFile(target, data, options, signal);
      }
      case 'mkdir':
        await fs.mkdir(target, WorkerFilesystem.options<MakeDirectoryOptions>(args[1], ['recursive', 'mode']));
        return;
      case 'access':
        if (args[1] !== undefined && typeof args[1] !== 'number')
          throw new SandboxError('access mode must be a number', 'INVALID_ARGUMENT');
        await fs.access(target, args[1] ?? constants.F_OK);
        return;
      case 'stat': {
        const s = await fs.stat(target);
        return {
          size: s.size,
          mode: s.mode,
          mtimeMs: s.mtimeMs,
          atimeMs: s.atimeMs,
          ctimeMs: s.ctimeMs,
          birthtimeMs: s.birthtimeMs,
          dev: s.dev,
          ino: s.ino,
          nlink: s.nlink,
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
          isSymbolicLink: s.isSymbolicLink(),
        };
      }
      case 'readdir': {
        const names = await fs.readdir(target);
        if (names.length > 50000) throw new SandboxError('Directory entry limit', 'FILE_LIMIT');
        return names;
      }
      default:
        throw new SandboxError(`Unsupported filesystem operation: ${operation}`, 'UNSUPPORTED_OPERATION');
    }
  }

  private async readFile(target: string, length: number | undefined, signal: AbortSignal): Promise<Buffer> {
    const handle = await fs.open(target, constants.O_RDONLY | WorkerFilesystem.NONBLOCK);
    try {
      const s = await handle.stat();
      if (!s.isFile()) throw new SandboxError('readFile supports regular files only', 'NOT_REGULAR_FILE');
      if (length === undefined && s.size > WorkerFilesystem.MAX_FILE)
        throw new SandboxError('readFile supports regular files up to 4 MiB', 'FILE_LIMIT');
      const capacity = length ?? s.size + 1;
      const buffer = Buffer.alloc(capacity);
      let n = 0;
      while (n < capacity) {
        if (signal.aborted) throw new SandboxError('aborted', 'ABORT_ERR');
        const { bytesRead } = await handle.read(buffer, n, capacity - n, n);
        if (!bytesRead) break;
        n += bytesRead;
      }
      if (length === undefined && n > s.size)
        throw new SandboxError('File grew during read; retry explicitly', 'FILE_CHANGED');
      return buffer.subarray(0, n);
    } finally {
      await handle.close();
    }
  }

  private async writeFile(
    target: string,
    data: string | Uint8Array,
    { encoding, mode, flag = 'w' }: { encoding?: BufferEncoding; mode?: number; flag?: string },
    signal: AbortSignal,
  ): Promise<void> {
    const flags = WorkerFilesystem.WRITE_FLAGS[flag];
    if (flags === undefined) throw new SandboxError('Unsupported write flag', 'INVALID_ARGUMENT');
    const handle = await fs.open(target, flags | WorkerFilesystem.NONBLOCK, mode ?? 0o666);
    try {
      if (!(await handle.stat()).isFile())
        throw new SandboxError('writeFile supports regular files only', 'NOT_REGULAR_FILE');
      await handle.writeFile(data, { encoding, signal });
    } finally {
      await handle.close();
    }
  }

  private static options<T extends object>(value: unknown, allowed: string[]): T {
    if (value === undefined) return {} as T;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((k) => !allowed.includes(k))
    )
      throw new SandboxError('Unsupported filesystem options', 'INVALID_ARGUMENT');
    return value as T;
  }
}
