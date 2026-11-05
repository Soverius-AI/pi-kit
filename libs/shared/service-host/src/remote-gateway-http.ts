import { hopByHopHeaders, REMOTE_REQUEST_HEADER_BLOCK, REMOTE_RESPONSE_HEADER_BLOCK } from '@pi-kit/protocol';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Primitive HTTP helpers shared by the gateway's routes. */
export class Http {
  static secret(): string {
    return randomBytes(32).toString('base64url');
  }

  static hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  static headers(input: IncomingMessage['headers'], upstream = false): Record<string, string | string[]> {
    const blocked = hopByHopHeaders(input.connection);
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || blocked.has(key) || REMOTE_REQUEST_HEADER_BLOCK.test(key)) continue;
      if (upstream && REMOTE_RESPONSE_HEADER_BLOCK.test(key)) continue;
      out[key] = value;
    }
    return out;
  }

  static cookie(req: IncomingMessage, name: string): string {
    const values = (req.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith(`${name}=`));
    return values.length === 1 ? values[0].slice(name.length + 1) : '';
  }

  static setCookie(res: ServerResponse, name: string, value: string, seconds: number): void {
    res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`);
  }

  static json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  /** The whole body, or undefined once it exceeds the limit. */
  static async readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const part of req) {
      const chunk = Buffer.from(part as Uint8Array);
      bytes += chunk.length;
      if (bytes > limit) return undefined;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}

/** At most `limit` hits per minute. */
export class RateLimit {
  private hits = 0;
  private windowStart = 0;
  constructor(private readonly limit: number) {}
  hit(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= 60000) {
      this.windowStart = now;
      this.hits = 0;
    }
    return ++this.hits <= this.limit;
  }
}
