import type { Readable, Writable } from 'node:stream';
import { serialize, deserialize } from 'node:v8';

export interface WireError {
  message: string;
  code: string;
}

export class SandboxError extends Error {
  code: string;
  /** Set on failed creation: true only when teardown was acknowledged (or nothing was allocated). */
  cleanupConfirmed?: boolean;

  constructor(message: string, code = 'SANDBOX_UNAVAILABLE') {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
  }

  static from(error: unknown): SandboxError {
    if (error instanceof SandboxError) return error;
    const wire = SandboxError.wire(error);
    return new SandboxError(wire.message, wire.code);
  }

  static wire(error: unknown): WireError {
    const details = error != null && (typeof error === 'object' || typeof error === 'function') ? error : {};
    const message = 'message' in details ? details.message : undefined;
    const code = 'code' in details ? details.code : undefined;
    return {
      message: String(message ?? error).slice(0, 4096),
      code: typeof code === 'string' ? code : 'SANDBOX_ERROR',
    };
  }
}

/** Length-prefixed v8 frames: Buffers survive, while functions, prototypes and handles cannot cross. */
export class IpcChannel<Incoming extends { type: string }, Outgoing extends { type: string }> {
  static readonly MAX_FRAME = 8 * 1024 * 1024;
  private chunks: Buffer[] = [];
  private size = 0;
  private queued = 0;
  private failed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly onMessage: (message: Incoming) => void,
    private readonly onError: (error: unknown) => void,
  ) {
    input.on('data', (chunk: Buffer) => this.receive(chunk));
    input.on('error', (error) => this.fail(error));
    output.on('error', (error) => this.fail(error));
  }

  async send(message: Outgoing): Promise<void> {
    if (this.failed) throw new SandboxError('IPC closed');
    const data = serialize(message);
    if (data.length > IpcChannel.MAX_FRAME || this.queued + data.length > 2 * IpcChannel.MAX_FRAME)
      throw new SandboxError('IPC capacity exceeded', 'IPC_LIMIT');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(data.length);
    this.queued += data.length;
    await new Promise<void>((resolve, reject) =>
      this.output.write(Buffer.concat([header, data]), (error) => {
        this.queued -= data.length;
        if (error) reject(error);
        else resolve();
      }),
    );
  }

  private receive(chunk: Buffer): void {
    if (this.failed) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (!this.failed && this.size >= 4) {
      if (this.chunks[0].length < 4) this.flatten();
      const length = this.chunks[0].readUInt32BE(0);
      if (!length || length > IpcChannel.MAX_FRAME)
        return this.fail(new SandboxError('IPC frame exceeds bound', 'PROTOCOL_ERROR'));
      if (this.size < length + 4) return;
      this.flatten();
      const buffered = this.chunks[0];
      const rest = buffered.subarray(length + 4);
      this.chunks = rest.length ? [rest] : [];
      this.size = rest.length;
      try {
        const message: unknown = deserialize(buffered.subarray(4, length + 4));
        if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string')
          throw new SandboxError('Invalid message', 'PROTOCOL_ERROR');
        this.onMessage(message as Incoming);
      } catch (error) {
        return this.fail(error);
      }
    }
  }

  private flatten(): void {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.size)];
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.chunks = [];
    this.size = 0;
    this.onError(error);
  }
}
