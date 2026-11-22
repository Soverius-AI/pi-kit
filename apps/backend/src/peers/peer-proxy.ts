import { ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { request } from 'node:http';
import type { IncomingMessage, IncomingHttpHeaders } from 'node:http';
import { pipeline, type Readable } from 'node:stream';
import type { Request, Response } from 'express';
import {
  A2A_EXTENSIONS_HEADER,
  A2A_TOKEN_HEADER,
  A2A_VERSION_HEADER,
  hopByHopHeaders,
  isRemoteApiPath,
  isRemoteDataType,
  isReviewedRemoteApi,
  REMOTE_RESPONSE_HEADER_BLOCK,
  WorkspaceSchema,
  type Workspace,
} from '@pi-kit/protocol';
import { z } from 'zod';
import type { BackendConfig } from '../app/config';
import { CONFIG } from '../app/config.token';
import { PeerSessions } from './peer-sessions';
import { PeerHttp } from './peer-http';
import type { PeerRecord } from '../db/peers.repository';

/** Streaming data plane. Every request captures its target and is checked again by the executing instance. */
@Injectable()
export class PeerProxy {
  static readonly CALLER_HEADER = 'x-pi-peer-id';

  constructor(
    private readonly peers: PeerSessions,
    private readonly network: PeerHttp,
    @Inject(CONFIG) private readonly config: BackendConfig,
  ) {}

  private static requestHeaders(input: IncomingHttpHeaders): Record<string, string> {
    const output: Record<string, string> = {};
    for (const name of [
      'accept',
      'content-type',
      'last-event-id',
      'x-pi-replay-cursor',
      'x-pi-thread-hydration',
      A2A_VERSION_HEADER,
      A2A_TOKEN_HEADER,
      A2A_EXTENSIONS_HEADER,
    ]) {
      const value = input[name];
      if (typeof value === 'string') output[name] = value;
    }
    return output;
  }

  private static checked(path: string, method: string): void {
    if (!isRemoteApiPath(path.split('?')[0]) || !isReviewedRemoteApi(path.split('?')[0], method))
      throw new ForbiddenException('This operation is unavailable through an instance connection.');
  }

  private static body(req: Request): Buffer | undefined {
    return req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body));
  }

  async remote(peerId: string, deviceId: string | undefined, path: string, req: Request, res: Response): Promise<void> {
    PeerProxy.checked(path, req.method);
    const peer = await this.peers.target(peerId, deviceId),
      body = PeerProxy.body(req),
      controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    const untrack = this.peers.track(peerId, abort);
    try {
      // Only retry a known pre-authorization rejection with a reproducible body. Never replay an uncertain mutation.
      const replayable =
        body !== undefined ||
        !(req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0'));
      const upstream = await this.fetch(peer, deviceId, {
        path,
        method: req.method,
        headers: PeerProxy.requestHeaders(req.headers),
        body,
        source: body === undefined ? req : undefined,
        signal: controller.signal,
        replayable,
      });
      await this.response(upstream, res);
    } catch (error) {
      if (!controller.signal.aborted && !res.headersSent)
        throw error instanceof ForbiddenException
          ? error
          : new ServiceUnavailableException(
              'This environment is offline, locked or incompatible. No operation was redirected elsewhere.',
            );
      res.destroy();
    } finally {
      res.off('close', abort);
      untrack();
    }
  }

  async incoming(token: string, path: string, req: Request, res: Response): Promise<void> {
    PeerProxy.checked(path, req.method);
    let peerId: string;
    try {
      peerId = (await this.peers.authorize(token)).peerId;
    } catch {
      res.setHeader('x-pi-peer-auth', 'renew');
      res.status(401).json({ error: 'Peer session renewal required' });
      return;
    }
    await this.local(path, req, res, peerId);
  }

  async self(path: string, req: Request, res: Response): Promise<void> {
    PeerProxy.checked(path, req.method);
    await this.local(path, req, res);
  }
  private async local(path: string, req: Request, res: Response, peerId?: string): Promise<void> {
    const controller = new AbortController(),
      abort = () => controller.abort();
    res.once('close', abort);
    const untrack = peerId ? this.peers.track(peerId, abort) : () => undefined,
      body = PeerProxy.body(req);
    try {
      const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        const outgoing = request(
          {
            hostname: '127.0.0.1',
            port: this.config.port,
            path,
            method: req.method,
            signal: controller.signal,
            headers: {
              ...PeerProxy.requestHeaders(req.headers),
              ...(peerId ? { [PeerProxy.CALLER_HEADER]: peerId } : {}),
              authorization: `Bearer ${this.config.token}`,
              ...(body ? { 'content-length': body.length } : {}),
            },
          },
          resolve,
        );
        outgoing.once('error', reject);
        if (body !== undefined) outgoing.end(body);
        else req.pipe(outgoing);
      });
      await this.response(upstream, res);
    } finally {
      res.off('close', abort);
      untrack();
    }
  }

  async call(
    peerId: string,
    path: string,
    method: string,
    body?: unknown,
    options: { signal?: AbortSignal; limit?: number; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: unknown }> {
    PeerProxy.checked(path, method);
    const peer = await this.peers.target(peerId);
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const response = await this.fetch(peer, undefined, {
      path,
      method,
      headers: { ...(bytes ? { 'content-type': 'application/json' } : {}), ...options.headers },
      body: bytes,
      signal: options.signal,
      replayable: true,
    });
    const buffers: Buffer[] = [];
    let length = 0;
    const limit = options.limit ?? 4 * 1024 * 1024;
    try {
      for await (const part of response) {
        const chunk = Buffer.from(part as Uint8Array);
        length += chunk.length;
        if (length > limit) throw new ServiceUnavailableException('The environment answered with too much data.');
        buffers.push(chunk);
      }
      await this.assertTarget(peer, undefined);
      const text = Buffer.concat(buffers).toString();
      const json =
        /json/.test(String(response.headers['content-type'] ?? '')) && text ? (JSON.parse(text) as unknown) : text;
      return { status: response.statusCode ?? 0, body: json };
    } finally {
      response.destroy();
    }
  }

  async stream(
    peerId: string,
    path: string,
    method: string,
    body?: unknown,
    options: { signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<IncomingMessage> {
    PeerProxy.checked(path, method);
    const peer = await this.peers.target(peerId);
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return await this.fetch(peer, undefined, {
      path,
      method,
      headers: { ...(bytes ? { 'content-type': 'application/json' } : {}), ...options.headers },
      body: bytes,
      signal: options.signal,
      replayable: true,
    });
  }

  async projects(peerId: string, deviceId?: string, signal?: AbortSignal): Promise<Workspace[]> {
    const peer = await this.peers.target(peerId, deviceId);
    const response = await this.fetch(peer, deviceId, {
      path: '/api/workspaces',
      method: 'GET',
      headers: {},
      signal,
      replayable: true,
    });
    const buffers: Buffer[] = [];
    let length = 0;
    try {
      if (response.statusCode !== 200) throw new ServiceUnavailableException('The environment is unavailable.');
      for await (const part of response) {
        const chunk = Buffer.from(part as Uint8Array);
        length += chunk.length;
        if (length > 4 * 1024 * 1024) throw new Error('Project list too large.');
        buffers.push(chunk);
      }
      const workspaces = z.array(WorkspaceSchema).parse(JSON.parse(Buffer.concat(buffers).toString()));
      if (workspaces.some((project) => project.instanceId === undefined))
        throw new ServiceUnavailableException(
          'This environment runs a pi-kit version without instance identity. Update it before using it remotely.',
        );
      if (workspaces.some((project) => project.instanceId !== peerId))
        throw new ForbiddenException('Project owner mismatch.');
      await this.assertTarget(peer, deviceId);
      return workspaces;
    } finally {
      response.destroy();
    }
  }
  /** One call to the peer with a session that is renewed once when the peer asks for it. */
  private async fetch(
    peer: PeerRecord,
    deviceId: string | undefined,
    call: {
      path: string;
      method: string;
      headers: Record<string, string>;
      body?: Buffer;
      source?: Readable;
      signal?: AbortSignal;
      replayable: boolean;
    },
  ): Promise<IncomingMessage> {
    const peerId = peer.identity.instanceId;
    const send = async (renew: boolean) => {
      const token = await this.peers.access(peerId, deviceId, renew);
      await this.assertTarget(peer, deviceId);
      if (renew && !call.replayable)
        throw new ServiceUnavailableException('Connection renewed. Retry the operation explicitly.');
      return this.network.open(
        peer.identity.origin,
        '/peer/api' + call.path,
        call.method,
        { ...call.headers, 'x-pi-peer-session': token },
        call.body,
        renew ? undefined : call.source,
        call.signal,
      );
    };
    const upstream = await send(false);
    if (upstream.statusCode !== 401 || upstream.headers['x-pi-peer-auth'] !== 'renew') return upstream;
    upstream.destroy();
    return send(true);
  }
  private async assertTarget(peer: PeerRecord, deviceId?: string): Promise<void> {
    const current = await this.peers.target(peer.identity.instanceId, deviceId);
    if (
      current.pairId !== peer.pairId ||
      current.revision !== peer.revision ||
      current.identity.origin !== peer.identity.origin ||
      current.identity.fingerprint !== peer.identity.fingerprint
    )
      throw new ForbiddenException('The originating instance grant changed.');
  }
  private async response(upstream: IncomingMessage, res: Response): Promise<void> {
    if (
      ((upstream.statusCode ?? 500) >= 300 && (upstream.statusCode ?? 500) < 400) ||
      !isRemoteDataType(upstream.headers['content-type'])
    ) {
      upstream.destroy();
      throw new ServiceUnavailableException(
        'Executable documents and redirects are not available through instance access.',
      );
    }
    const blocked = hopByHopHeaders(upstream.headers.connection);
    res.writeHead(
      upstream.statusCode ?? 502,
      Object.fromEntries(
        Object.entries(upstream.headers).filter(
          ([key, value]) => value !== undefined && !blocked.has(key) && !REMOTE_RESPONSE_HEADER_BLOCK.test(key),
        ),
      ) as Record<string, string | string[]>,
    );
    await new Promise<void>((resolve) => pipeline(upstream, res, () => resolve()));
  }
}
