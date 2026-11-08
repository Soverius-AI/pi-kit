import {
  hasControlCharacter,
  hopByHopHeaders,
  REMOTE_REQUEST_HEADER_BLOCK,
  REMOTE_RESPONSE_HEADER_BLOCK,
} from '@pi-kit/protocol';
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

  /** The headers every gateway response carries. */
  static secure(res: ServerResponse): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
  }

  /**
   * The raw request path, exactly as the backend router matches it, or undefined when it is unsafe. Nothing is decoded
   * before routing (an encoded slash must not make a route segment); only paths under `encoded` may carry escapes, since
   * SDK ids can be encoded absolute filesystem paths.
   */
  static path(raw: string, encoded: string[]): string | undefined {
    const path = raw.split('?')[0];
    if (!raw.startsWith('/') || raw.startsWith('//') || path.includes('\\') || hasControlCharacter(path, true))
      return undefined;
    if (path.includes('%')) {
      if (!encoded.some((prefix) => path.startsWith(prefix))) return undefined;
      try {
        if (hasControlCharacter(decodeURIComponent(path))) return undefined;
      } catch {
        return undefined;
      }
    }
    if (path.split('/').some((s) => s === '.' || s === '..')) return undefined;
    return path;
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
