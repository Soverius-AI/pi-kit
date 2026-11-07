import {
  InstanceIdSchema,
  isRemoteApiPath,
  isReviewedRemoteApi,
  StoredDeviceGrantsSchema,
  type RemoteAccessDevice,
  type RemoteAccessPairing,
  type RemoteAccessRequest,
  type StoredDeviceGrant,
} from '@pi-kit/protocol';
import { randomBytes, randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RemoteAccessGateway, RemoteAccessOptions } from './remote-access';
import { RemoteAccessStores } from './remote-access-store';
import { Http, RateLimit } from './remote-gateway-http';
import { PeerTransport } from './remote-gateway-peer';
import { BackendProxy } from './remote-gateway-proxy';
import { RendererFiles } from './remote-gateway-static';

const DEVICE = '__Host-pi-kit-device';
const PAIR = '__Host-pi-kit-pair';
// Browsers cap persistent cookies. Renew this rolling lifetime; approval itself has no age cutoff.
const COOKIE_SECONDS = 400 * 86400;
type Pending = RemoteAccessRequest & {
  cookieHash: string;
  approved: boolean;
  polls: number;
  finalizing?: boolean;
  grant?: { token: string; device: StoredDeviceGrant };
};
type Device = StoredDeviceGrant & { streams: Set<() => void>; cookieRenewedAt?: number };

export class RemoteGateway implements RemoteAccessGateway {
  private readonly origin: string;
  private readonly host: string;
  private deviceCookie = DEVICE;
  private pairCookie = PAIR;
  private server?: Server;
  private pairing?: RemoteAccessPairing;
  private readonly pending = new Map<string, Pending>();
  private readonly devices = new Map<string, Device>();
  private readonly pairAttempts = new RateLimit(20);
  private readonly proxy: BackendProxy;
  private readonly peers: PeerTransport;
  private readonly files: RendererFiles;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: Pick<RemoteAccessOptions, 'rendererRoot' | 'backend' | 'grants' | 'cookieScope'> & {
      publicOrigin: string;
    },
  ) {
    // Only canonical HTTPS Tailscale DNS origins; Serve uses a virtual tailnet port.
    if (
      !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net(?::[1-9][0-9]{0,4})?$/.test(
        options.publicOrigin,
      )
    )
      throw new Error('Invalid phone origin');
    const origin = new URL(options.publicOrigin);
    if (origin.origin !== options.publicOrigin || (origin.port && Number(origin.port) > 65535))
      throw new Error('Invalid phone origin');
    this.origin = origin.origin;
    this.host = origin.host;
    this.proxy = new BackendProxy(options.backend);
    this.peers = new PeerTransport(this.proxy);
    this.files = new RendererFiles(options.rendererRoot);
  }

  /** Deliberately narrow reviewed API surface; no generic administrative or HTML proxy. */
  private allowed(path: string, method: string): boolean {
    if (method === 'GET' && (path === '/api/instances' || /^\/api\/instances\/[a-f0-9-]{36}\/projects$/.test(path)))
      return true;
    const relay = /^\/api\/instances\/([^/]+)\/proxy(\/api\/.*)$/.exec(path);
    if (relay)
      return (
        InstanceIdSchema.safeParse(relay[1]).success &&
        isRemoteApiPath(relay[2]) &&
        isReviewedRemoteApi(relay[2], method)
      );
    return isReviewedRemoteApi(path, method);
  }

  async listen(): Promise<string> {
    await this.files.verify();
    const grants = StoredDeviceGrantsSchema.parse((await this.options.grants?.load()) ?? []);
    if (this.options.cookieScope) {
      const id = InstanceIdSchema.parse(await this.options.cookieScope());
      this.deviceCookie = `__Host-pi-kit-${id}-device`;
      this.pairCookie = `__Host-pi-kit-${id}-pair`;
    }
    if (this.server) throw new Error('Gateway already listening');
    this.devices.clear();
    for (const grant of grants) this.devices.set(grant.id, { ...grant, streams: new Set() });
    const server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) Http.json(res, 500, { error: 'Request failed' });
        else res.destroy();
      });
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 15000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.timer = setInterval(() => this.expire(), 1000);
    this.timer.unref();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No gateway address');
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.pairing = undefined;
    this.pending.clear();
    // Shutdown/Disable disconnects viewers, not durable owner approval.
    for (const device of this.devices.values()) for (const abort of device.streams) abort();
    this.devices.clear();
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
  }

  beginPairing(): RemoteAccessPairing {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const code = Array.from(randomBytes(12), (n) => alphabet[n & 31]).join('');
    this.pairing = { code, url: `${this.origin}/phone#${code}`, expiresAt: Date.now() + 5 * 60000 };
    return { ...this.pairing };
  }
  approve(id: string): void {
    this.expire();
    const p = this.pending.get(id);
    if (p && this.devices.size < 20) p.approved = true;
  }
  reject(id: string): void {
    this.pending.delete(id);
  }
  async revoke(id: string): Promise<void> {
    const device = this.devices.get(id);
    this.devices.delete(id);
    if (device) for (const abort of device.streams) abort();
    // Access is already blocked locally even if persistence fails. Never report success then.
    await this.options.grants?.revoke(id);
  }
  status(): { pairing?: RemoteAccessPairing; requests: RemoteAccessRequest[]; devices: RemoteAccessDevice[] } {
    this.expire();
    return {
      pairing: this.pairing && { ...this.pairing },
      requests: [...this.pending.values()].map(({ id, name, confirmationCode, expiresAt }) => ({
        id,
        name,
        confirmationCode,
        expiresAt,
      })),
      devices: [...this.devices.values()].map(RemoteAccessStores.publicDevice),
    };
  }
  private expire() {
    const now = Date.now();
    if (this.pairing && this.pairing.expiresAt <= now) this.pairing = undefined;
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
  }
  private device(req: IncomingMessage): Device | undefined {
    const proof = Http.cookie(req, this.deviceCookie);
    if (!/^[A-Za-z0-9_-]{43}$/.test(proof)) return undefined;
    const key = Http.hash(proof);
    const device = [...this.devices.values()].find((d) => d.cookieHash === key);
    if (device) device.lastSeenAt = Date.now();
    return device;
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    Http.secure(res);
    if (
      req.headers.host !== this.host ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    )
      return Http.json(res, 403, { error: 'Invalid host' });
    const raw = req.url ?? '';
    const peerRequest = raw.startsWith('/peer/');
    if (peerRequest && req.headers.origin)
      return Http.json(res, 403, { error: 'Peer transport does not accept browser origins' });
    if (!peerRequest && req.headers.origin && req.headers.origin !== this.origin)
      return Http.json(res, 403, { error: 'Invalid origin' });
    if (!peerRequest && !['GET', 'HEAD'].includes(req.method ?? '') && req.headers.origin !== this.origin)
      return Http.json(res, 403, { error: 'Origin required' });
    const path = Http.path(raw, ['/api/', '/peer/api/api/']);
    if (path === undefined) return Http.json(res, 400, { error: 'Invalid path' });
    this.expire();
    if (peerRequest) return this.peers.handle(req, res, path);
    if (path === '/phone/pair' && req.method === 'POST') return this.pair(req, res);
    if (path === '/phone/pair/status' && req.method === 'GET') return this.poll(req, res);
    const device = this.device(req);
    if (path === '/phone/session' && req.method === 'GET') {
      if (device) {
        const { id, name, createdAt, lastSeenAt, cookieHash, csrf } = device;
        await this.options.grants?.save({ id, name, createdAt, lastSeenAt, cookieHash, csrf });
        Http.setCookie(res, this.deviceCookie, Http.cookie(req, this.deviceCookie), COOKIE_SECONDS);
        device.cookieRenewedAt = Date.now();
      }
      return Http.json(res, device ? 200 : 401, device ? { token: device.csrf } : { error: 'Pairing required' });
    }
    if (path === '/api' || path.startsWith('/api/')) {
      if (!device || req.headers.authorization !== `Bearer ${device.csrf}`)
        return Http.json(res, 401, { error: 'Pairing required' });
      if (!this.allowed(path, req.method ?? '')) return Http.json(res, 403, { error: 'Route unavailable on phone' });
      if (Date.now() - (device.cookieRenewedAt ?? 0) >= 86400000) {
        Http.setCookie(res, this.deviceCookie, Http.cookie(req, this.deviceCookie), COOKIE_SECONDS);
        device.cookieRenewedAt = Date.now();
      }
      return this.proxy.forward(req, res, { deviceId: device.id, streams: device.streams });
    }
    if (!['GET', 'HEAD'].includes(req.method ?? '')) return Http.json(res, 405, { error: 'Method not allowed' });
    if (path === '/phone' || (path === '/' && !device)) return this.files.pairingPage(res, req.method === 'HEAD');
    if (path === '/phone/pairing.js' || path === '/phone/jsQR.js') return this.files.serve(path, req, res, false);
    if (path.startsWith('/phone/')) return Http.json(res, 404, { error: 'Not found' });
    return this.files.serve(path, req, res, !!device);
  }
  private async pair(req: IncomingMessage, res: ServerResponse) {
    if (!this.pairAttempts.hit()) return Http.json(res, 429, { error: 'Try again later' });
    const body = await Http.readBody(req, 1024);
    if (!body) return Http.json(res, 413, { error: 'Request too large' });
    let code: unknown;
    try {
      code = (JSON.parse(body.toString()) as { code?: unknown }).code;
    } catch {
      /* invalid */
    }
    if (!this.pairing || typeof code !== 'string' || code !== this.pairing.code || this.pairing.expiresAt <= Date.now())
      return Http.json(res, 400, { error: 'Invalid or expired code' });
    if (this.pending.size >= 20 || this.devices.size >= 20)
      return Http.json(res, 429, { error: 'Device limit reached' });
    this.pairing = undefined;
    const token = Http.secret();
    const p: Pending = {
      id: Http.secret(),
      name: (req.headers['user-agent'] ?? 'Phone').replace(/[^\x20-\x7e]/g, '').slice(0, 100) || 'Phone',
      confirmationCode: String(randomInt(100000, 1000000)),
      expiresAt: Date.now() + 120000,
      cookieHash: Http.hash(token),
      approved: false,
      polls: 0,
    };
    this.pending.set(p.id, p);
    Http.setCookie(res, this.pairCookie, token, 120);
    return Http.json(res, 200, { id: p.id, confirmationCode: p.confirmationCode, expiresAt: p.expiresAt });
  }
  private async poll(req: IncomingMessage, res: ServerResponse) {
    const key = Http.hash(Http.cookie(req, this.pairCookie));
    const p = [...this.pending.values()].find((entry) => entry.cookieHash === key);
    if (!p) return Http.json(res, 401, { error: 'Pairing expired or rejected' });
    if (++p.polls > 150) {
      this.pending.delete(p.id);
      return Http.json(res, 429, { error: 'Try again later' });
    }
    if (!p.approved || p.finalizing) return Http.json(res, 200, { status: 'pending' });
    if (this.devices.size >= 20) return Http.json(res, 429, { error: 'Device limit reached' });
    p.finalizing = true;
    // Reuse the prepared proof if a write committed but its acknowledgement was lost.
    // A retry may not replace a previously committed cookie hash/CSRF identity.
    if (!p.grant) {
      const token = Http.secret();
      const now = Date.now();
      p.grant = {
        token,
        device: {
          id: p.id,
          name: p.name,
          createdAt: now,
          lastSeenAt: now,
          cookieHash: Http.hash(token),
          csrf: Http.secret(),
        },
      };
    }
    const { token, device: grant } = p.grant;
    try {
      // Only issue a usable cookie after the approval is durably committed.
      await this.options.grants?.save(grant);
      if (!this.server || !this.pending.has(p.id) || p.expiresAt <= Date.now() || res.destroyed) {
        await this.options.grants?.revoke(p.id);
        return Http.json(res, 401, { error: 'Pairing expired or rejected' });
      }
      this.pending.delete(p.id);
      this.devices.set(p.id, { ...grant, streams: new Set() });
      Http.setCookie(res, this.deviceCookie, token, COOKIE_SECONDS);
      return Http.json(res, 200, { status: 'approved' });
    } finally {
      p.finalizing = false;
    }
  }
}
