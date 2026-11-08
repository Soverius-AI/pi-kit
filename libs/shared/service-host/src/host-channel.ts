import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** A browser screenshot answer is the largest frame; anything bigger is a broken or hostile peer. */
const MAX_FRAME_CHARS = 64 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 5_000;

type Frame =
  | { t: 'hello'; token: string }
  | { t: 'call'; id: number; method: string; params?: unknown }
  | { t: 'result'; id: number; result?: unknown }
  | { t: 'error'; id: number; message: string; data?: unknown }
  | { t: 'event'; name: string; data?: unknown };

export class RpcError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/**
 * Where the service host listens for the desktop: a Unix socket in the data folder (a temporary folder when that path is too
 * long for a socket address), a named pipe on Windows, both named after the folder so two profiles never meet.
 */
export function hostSocketPath(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  const id = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\pi-kit-host-${id}`;
  const inData = join(dataDir, 'host.sock');
  // A socket address holds 104 bytes on macOS and 108 on Linux.
  if (Buffer.byteLength(inData) < 100) return inData;
  return join(process.env['XDG_RUNTIME_DIR'] || tmpdir(), `pi-kit-host-${id}.sock`);
}

/** One end of the host channel: calls both ways, answered in any order, and events. */
export class RpcPeer {
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private authenticated: boolean;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly handlers = new Map<string, (params: unknown) => unknown>();
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();
  private readonly closeListeners = new Set<() => void>();

  /** With `expectToken`, nothing is accepted before a hello that carries it; `ready` runs once it has. */
  constructor(
    private readonly socket: Socket,
    expectToken?: string,
    private readonly ready: () => void = () => undefined,
  ) {
    this.authenticated = expectToken === undefined;
    const expected = expectToken === undefined ? undefined : Buffer.from(expectToken);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.read(chunk, expected));
    socket.on('close', () => this.end());
    socket.on('error', () => socket.destroy());
    if (expected) {
      const timer = setTimeout(() => {
        if (!this.authenticated) socket.destroy();
      }, HELLO_TIMEOUT_MS);
      timer.unref();
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  hello(token: string): void {
    this.write({ t: 'hello', token });
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError('The pi-kit service host connection is closed.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ t: 'call', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  handle(method: string, handler: (params: unknown) => unknown): void {
    this.handlers.set(method, handler);
  }

  emit(name: string, data?: unknown): void {
    this.write({ t: 'event', name, ...(data === undefined ? {} : { data }) });
  }

  on(name: string, listener: (data: unknown) => void): void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(listener);
  }

  onClose(listener: () => void): void {
    if (this.closed) queueMicrotask(listener);
    else this.closeListeners.add(listener);
  }

  close(): void {
    this.socket.end();
  }

  private write(frame: Frame): void {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(JSON.stringify(frame) + '\n');
  }

  private read(chunk: string, expected: Buffer | undefined): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_FRAME_CHARS) {
      this.socket.destroy();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        this.socket.destroy();
        return;
      }
      if (!this.authenticated) {
        const given = frame?.t === 'hello' && typeof frame.token === 'string' ? Buffer.from(frame.token) : undefined;
        if (!expected || !given || given.length !== expected.length || !timingSafeEqual(given, expected)) {
          this.socket.destroy();
          return;
        }
        this.authenticated = true;
        this.ready();
        continue;
      }
      void this.dispatch(frame);
    }
  }

  private async dispatch(frame: Frame): Promise<void> {
    switch (frame?.t) {
      case 'call': {
        const handler = this.handlers.get(frame.method);
        if (!handler) {
          this.write({ t: 'error', id: frame.id, message: `Unknown method ${frame.method}` });
          return;
        }
        try {
          const result = await handler(frame.params);
          this.write({ t: 'result', id: frame.id, ...(result === undefined ? {} : { result }) });
        } catch (error) {
          this.write({
            t: 'error',
            id: frame.id,
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof RpcError && error.data !== undefined ? { data: error.data } : {}),
          });
        }
        return;
      }
      case 'result':
        this.settle(frame.id)?.resolve(frame.result);
        return;
      case 'error':
        this.settle(frame.id)?.reject(new RpcError(String(frame.message), frame.data));
        return;
      case 'event':
        for (const listener of this.listeners.get(frame.name) ?? []) listener(frame.data);
        return;
    }
  }

  private settle(id: number) {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    return pending;
  }

  private end(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new RpcError('The pi-kit service host connection closed.');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }
}

export class HostAlreadyRunningError extends Error {
  constructor() {
    super('Another pi-kit service host already runs for this data folder.');
  }
}

/**
 * Listens on `path`; a connection becomes a peer only after its hello carries `token`. A socket another host answers on is
 * never taken over; one nobody answers on is left over from a host that died, and is replaced.
 */
export async function listenHostChannel(path: string, token: string, onPeer: (peer: RpcPeer) => void): Promise<Server> {
  const unix = !path.startsWith('\\\\');
  const server = createServer((socket) => {
    const peer: RpcPeer = new RpcPeer(socket, token, () => onPeer(peer));
  });
  // Windows: a host the scheduled task starts runs in that task's logon session, whose default pipe permissions leave out
  // the owner's own unelevated sign-in, so the desktop could not connect. Any local account may open the pipe; the token
  // hello is what keeps the others out (ADR-0036). Unix sockets stay owner-only.
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path, readableAll: !unix, writableAll: !unix }, () => {
        server.off('error', reject);
        resolve();
      });
    });
  try {
    await listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    if (await answers(path)) throw new HostAlreadyRunningError();
    if (!unix) throw error;
    await unlink(path).catch(() => undefined);
    await listen();
  }
  if (unix) await chmod(path, 0o600);
  return server;
}

function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export function connectHostChannel(path: string, token: string): Promise<RpcPeer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      const peer = new RpcPeer(socket);
      peer.hello(token);
      resolve(peer);
    });
  });
}
