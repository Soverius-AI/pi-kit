import { isRemoteDataType } from '@pi-kit/protocol';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import { Http } from './remote-gateway-http';

export type Backend = { url: string; token: string };
export type ProxyOptions = {
  deviceId?: string;
  streams?: Set<() => void>;
  path?: string;
  body?: Buffer;
  peerToken?: string;
};

/** Forwards reviewed requests to the local backend: data responses only, no redirects, torn down with the client or the device. */
export class BackendProxy {
  constructor(private readonly backend: () => Backend | undefined) {}

  /** The backend, only while it is a plain loopback origin. */
  target(): { backend: Backend; url: URL } | undefined {
    const backend = this.backend();
    if (!backend || !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/.test(backend.url)) return undefined;
    const url = new URL(backend.url);
    const ok =
      url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash;
    return ok ? { backend, url } : undefined;
  }

  forward(req: IncomingMessage, res: ServerResponse, options: ProxyOptions = {}): void {
    const target = this.target();
    if (!target) return Http.json(res, 503, { error: 'Backend unavailable' });
    const outgoing = Http.headers(req.headers);
    outgoing['authorization'] = `Bearer ${target.backend.token}`;
    if (options.deviceId) outgoing['x-pi-device-id'] = options.deviceId;
    if (options.peerToken) outgoing['x-pi-peer-session'] = options.peerToken;
    if (options.body !== undefined) outgoing['content-length'] = String(options.body.length);
    // Never pass the public browser Origin into local backend CORS handling.
    delete outgoing['origin'];
    const upstream = request(
      {
        protocol: 'http:',
        hostname: target.url.hostname.replace(/^\[|\]$/g, ''),
        port: target.url.port || 80,
        path: options.path ?? req.url,
        method: req.method,
        headers: outgoing,
      },
      (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
          response.destroy();
          return Http.json(res, 502, { error: 'Redirect not allowed' });
        }
        if (!isRemoteDataType(response.headers['content-type'])) {
          response.destroy();
          return Http.json(res, 502, { error: 'Document response not allowed' });
        }
        res.writeHead(response.statusCode ?? 502, Http.headers(response.headers, true));
        pipeline(response, res, () => cleanup());
      },
    );
    const abort = () => {
      upstream.destroy();
      res.destroy();
    };
    const cleanup = () => {
      options.streams?.delete(abort);
      res.off('close', abort);
    };
    options.streams?.add(abort);
    res.once('close', abort);
    upstream.once('error', () => {
      cleanup();
      if (!res.headersSent) Http.json(res, 502, { error: 'Backend unavailable' });
      else res.destroy();
    });
    req.once('aborted', abort);
    if (options.body !== undefined) upstream.end(options.body);
    else
      pipeline(req, upstream, (error) => {
        if (error) abort();
      });
  }
}
