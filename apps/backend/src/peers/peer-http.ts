import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { request, type RequestOptions } from 'node:https';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { PeerOriginSchema } from '@pi-kit/protocol';

export const PEER_TLS = Symbol('PEER_TLS');
export class PeerHttpError extends Error {
  constructor(readonly status: number) {
    super('The peer rejected this operation.');
  }
}

/** Direct tailnet TLS; no proxy, redirects, cookies, local master tokens or TLS-verification fallback. */
@Injectable()
export class PeerHttp {
  constructor(
    @Optional() @Inject(PEER_TLS) private readonly tls: Pick<RequestOptions, 'ca' | 'lookup' | 'agent'> = {},
  ) {}

  open(
    origin: string,
    path: string,
    method: string,
    headers: OutgoingHttpHeaders = {},
    body?: Buffer,
    source?: Readable,
    signal?: AbortSignal,
  ): Promise<IncomingMessage> {
    const target = new URL(PeerOriginSchema.parse(origin));
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\]/.test(path)) throw new Error('Invalid peer route.');
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          ...this.tls,
          protocol: 'https:',
          hostname: target.hostname,
          port: target.port || 443,
          path,
          method,
          headers: { ...headers, host: target.host },
          rejectUnauthorized: true,
          signal,
        },
        (response) => {
          if ((response.statusCode ?? 500) >= 300 && (response.statusCode ?? 500) < 400) {
            response.destroy();
            reject(new Error('Peer redirects are not allowed.'));
          } else resolve(response);
        },
      );
      outgoing.once('error', reject);
      if (body !== undefined) outgoing.setHeader('Content-Length', body.length);
      if (source) {
        source.once('error', () => outgoing.destroy());
        source.pipe(outgoing);
      } else outgoing.end(body);
    });
  }

  async json(origin: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const response = await this.open(
      origin,
      path,
      body === undefined ? 'GET' : 'POST',
      bytes ? { 'content-type': 'application/json' } : {},
      bytes,
      undefined,
      signal,
    );
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk as Uint8Array);
        length += bytes.length;
        if (length > 65536) throw new Error('Peer response too large.');
        chunks.push(bytes);
      }
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300)
        throw new PeerHttpError(response.statusCode ?? 500);
      if (!/^application\/(?:json|problem\+json)(?:;|$)/i.test(String(response.headers['content-type'] ?? '')))
        throw new Error('Invalid peer response.');
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally {
      response.destroy();
    }
  }
}
