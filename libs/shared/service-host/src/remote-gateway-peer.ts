import { isRemoteApiPath, isReviewedRemoteApi } from '@pi-kit/protocol';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Http, RateLimit } from './remote-gateway-http';
import type { BackendProxy } from './remote-gateway-proxy';

/** Instance-to-instance traffic under /peer: control calls pass through with a size cap, API calls only with a session the backend authorizes. */
export class PeerTransport {
  private static readonly CONTROL = [
    '/peer/pair/request',
    '/peer/pair/status',
    '/peer/pair/ack',
    '/peer/challenge',
    '/peer/session',
    '/peer/unpair',
  ];
  private readonly control = new RateLimit(200);

  constructor(private readonly proxy: BackendProxy) {}

  async handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const raw = req.url ?? '';
    const method = req.method ?? '';
    if (path.startsWith('/peer/api/')) {
      const api = path.slice('/peer/api'.length);
      if (!isRemoteApiPath(api) || !isReviewedRemoteApi(api, method))
        return Http.json(res, 403, { error: 'Unavailable peer operation' });
      const token = req.headers['x-pi-peer-session'];
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
        return Http.json(res, 401, { error: 'Peer authentication required' });
      const target = this.proxy.target();
      if (!target) return Http.json(res, 503, { error: 'Instance unavailable' });
      try {
        const check = await fetch(target.backend.url.replace(/\/$/, '') + '/api/peer/authorize', {
          method: 'POST',
          redirect: 'error',
          headers: { authorization: `Bearer ${target.backend.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ token, path: api, method }),
        });
        if (check.status === 401 || check.status === 403) {
          res.setHeader('x-pi-peer-auth', 'renew');
          return Http.json(res, 401, { error: 'Peer session renewal required' });
        }
        if (!check.ok) return Http.json(res, 503, { error: 'Instance unavailable' });
        const result = (await check.json()) as { allowed?: unknown };
        if (result.allowed !== true) return Http.json(res, 403, { error: 'Unavailable peer operation' });
      } catch {
        return Http.json(res, 503, { error: 'Instance unavailable' });
      }
      if (!res.destroyed) this.proxy.forward(req, res, { path: '/api' + raw, peerToken: token });
      return;
    }
    if (!this.control.hit()) return Http.json(res, 429, { error: 'Try again later' });
    if (!(
      (method === 'GET' && path === '/peer/identity') ||
      (method === 'POST' && PeerTransport.CONTROL.includes(path))
    ))
      return Http.json(res, 404, { error: 'Not found' });
    let body: Buffer | undefined;
    if (method === 'POST') {
      body = await Http.readBody(req, 16384);
      if (!body) return Http.json(res, 413, { error: 'Peer request too large' });
    }
    if (!res.destroyed) this.proxy.forward(req, res, { path: '/api' + raw, body });
  }
}
