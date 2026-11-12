import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteGateway } from './remote-gateway';
import type { StoredDeviceGrant } from '@pi-kit/protocol';
import type { RemoteGrantStore } from './remote-access-store';

const origin = 'https://safe-node.tailnet.ts.net:8443';
const host = new URL(origin).host;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(
  override?: { url: string; token: string },
  publicOrigin = origin,
  grants?: RemoteGrantStore,
  extra?: { cookieScope?: string; peerAllowed?: boolean; previewOrigins?: string[] },
) {
  const host = new URL(publicOrigin).host;
  const root = await mkdtemp(join(tmpdir(), 'remote-gateway-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<html><head></head><body>APP SHELL</body></html>');
  await writeFile(join(root, 'main.js'), 'console.log("asset")');
  await writeFile(join(root, '.secret'), 'secret file');
  await mkdir(join(root, 'assets'));
  const upstreamHeaders: Array<Record<string, unknown>> = [];
  const upstreamPaths: string[] = [];
  const backend = createServer((req, res) => {
    upstreamHeaders.push(req.headers);
    upstreamPaths.push(req.url ?? '');
    if (req.url === '/api/peer/authorize' && extra?.peerAllowed !== undefined) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ allowed: extra.peerAllowed }));
      return;
    }
    if (req.url?.includes('events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'x-replay-id': 'replay',
        'Set-Cookie': 'bad=1',
        'Access-Control-Allow-Origin': '*',
      });
      res.write('data: first\n\n');
      return;
    }
    if (req.url?.includes('redirect')) {
      res.writeHead(302, { location: 'https://evil.test' });
      res.end();
      return;
    }
    if (req.url?.includes('document')) {
      res.setHeader('Content-Type', 'text/html');
      res.end('<script>bad()</script>');
      return;
    }
    res.setHeader('Set-Cookie', 'master=bad');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((done) => backend.listen(0, '127.0.0.1', done));
  cleanup.push(() => stop(backend));
  const address = backend.address();
  if (!address || typeof address === 'string') throw Error();
  const gateway = new RemoteGateway({
    rendererRoot: root,
    publicOrigin,
    grants,
    previewOrigins: extra?.previewOrigins,
    ...(extra?.cookieScope ? { cookieScope: async () => extra.cookieScope! } : {}),
    backend: () => override ?? { url: `http://127.0.0.1:${address.port}`, token: 'MASTER-SECRET' },
  });
  const url = await gateway.listen();
  cleanup.push(() => gateway.close());
  const call = (path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request(
        url + path,
        {
          method: options.method ?? 'GET',
          headers: {
            Host: host,
            ...(options.method && options.method !== 'GET' ? { Origin: publicOrigin } : {}),
            ...(options.body === undefined
              ? {}
              : {
                  'Content-Length': String(Buffer.byteLength(JSON.stringify(options.body))),
                  'Content-Type': 'application/json',
                }),
            ...options.headers,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk.toString()));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
    });
  const pair = async () => {
    const p = gateway.beginPairing();
    const response = await call('/phone/pair', { method: 'POST', body: { code: p.code } });
    const id = JSON.parse(response.body).id as string;
    const pendingCookie = (response.headers['set-cookie'] as string[])[0].split(';')[0];
    gateway.approve(id);
    const approved = await call('/phone/pair/status', { headers: { Cookie: pendingCookie } });
    const deviceCookie = (approved.headers['set-cookie'] as string[])[0].split(';')[0];
    const session = await call('/phone/session', { headers: { Cookie: deviceCookie } });
    const token = JSON.parse(session.body).token as string;
    return { id, cookie: deviceCookie, token, headers: { Cookie: deviceCookie, Authorization: `Bearer ${token}` } };
  };
  return { gateway, call, pair, url, root, upstreamHeaders, upstreamPaths };
}
async function stop(server: Server) {
  await new Promise<void>((done) => {
    server.close(() => done());
    server.closeAllConnections();
  });
}

describe('RemoteGateway', () => {
  it('only injects allowed dedicated-host previews into the authenticated shell, matching CSP', async () => {
    const f = await fixture(undefined, origin, undefined, {
      previewOrigins: [origin, 'https://safe-node.tailnet.ts.net:9999', 'https://dedicated.example'],
    });
    const anonymous = await f.call('/');
    expect(anonymous.body).not.toContain('pi-kit-preview-origins');
    const session = await f.pair();
    const response = await f.call('/', { headers: session.headers });
    expect(response.headers['content-security-policy']).toContain('frame-src https://dedicated.example;');
    expect(response.body).toContain('content="[&quot;https://dedicated.example&quot;]"');
  });

  it('uses profile-scoped cookies so independent ports do not overwrite one another', async () => {
    const id = '6f622128-1520-4c72-ad47-6d91da71f350';
    const f = await fixture(undefined, origin, undefined, { cookieScope: id });
    const device = await f.pair();
    expect(device.cookie).toMatch(new RegExp(`^__Host-pi-kit-${id}-device=`));
    await f.call('/api/health', {
      headers: { ...device.headers, 'x-pi-device-id': 'spoofed', 'x-pi-peer-session': 'spoofed' },
    });
    expect(f.upstreamHeaders.at(-1)?.['x-pi-device-id']).toBe(device.id);
    expect(f.upstreamHeaders.at(-1)?.['x-pi-peer-session']).toBeUndefined();
  });
  it('separates node control transport from browser sessions and checks each reviewed data request', async () => {
    const f = await fixture(undefined, origin, undefined, { peerAllowed: true });
    expect((await f.call('/peer/identity')).status).toBe(200);
    expect((await f.call('/peer/identity', { headers: { Origin: origin } })).status).toBe(403);
    expect((await f.call('/peer/authorize', { method: 'POST', headers: { Origin: '' }, body: {} })).status).toBe(404);
    expect((await f.call('/peer/api/api/health')).status).toBe(401);
    const headers = {
      'x-pi-peer-session': 'a'.repeat(43),
      Cookie: 'secret=bad',
      Authorization: 'Bearer attacker',
      'x-pi-device-id': 'spoofed',
    };
    expect((await f.call('/peer/api/api/health', { headers })).status).toBe(200);
    expect(f.upstreamPaths.slice(-2)).toEqual(['/api/peer/authorize', '/api/peer/api/api/health']);
    expect(f.upstreamHeaders.at(-1)).toMatchObject({
      authorization: 'Bearer MASTER-SECRET',
      'x-pi-peer-session': 'a'.repeat(43),
    });
    expect(f.upstreamHeaders.at(-1)?.cookie).toBeUndefined();
    expect(f.upstreamHeaders.at(-1)?.['x-pi-device-id']).toBeUndefined();
    for (const path of [
      '/api/instance/devices',
      '/api/instances',
      '/api/browser',
      '/api/instances/6f622128-1520-4c72-ad47-6d91da71f350/proxy/api/health',
    ])
      expect((await f.call('/peer/api' + path, { headers })).status).toBe(403);
    expect(
      (
        await f.call('/peer/pair/request', {
          method: 'POST',
          headers: { Origin: '' },
          body: { proof: 'x'.repeat(17000) },
        })
      ).status,
    ).toBe(413);
  });
  it('validates canonical origins and requires preserved Host, not forwarded headers', async () => {
    for (const publicOrigin of [
      'http://safe-node.tailnet.ts.net:8443',
      origin + '/',
      'https://evil.test:8443',
      origin + '@evil.test',
      'https://safe-node.tailnet.ts.net:0',
      'https://safe-node.tailnet.ts.net:65536',
      'https://safe-node.tailnet.ts.net:1.5',
      'https://safe-node.tailnet.ts.net:09443',
      'https://safe-node.tailnet.ts.net:9443/path',
      'https://safe-node.tailnet.ts.net:9443?query',
      'https://safe-node.tailnet.ts.net:9443#hash',
      'https://user@safe-node.tailnet.ts.net:9443',
    ]) {
      expect(() => new RemoteGateway({ rendererRoot: '.', backend: () => undefined, publicOrigin })).toThrow();
    }
    const { call } = await fixture();
    expect((await call('/', { headers: { Host: '127.0.0.1', 'X-Forwarded-Host': host } })).status).toBe(403);
    expect(
      (await call('/phone/pair', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: {} })).status,
    ).toBe(403);
  });
  it.each(['https://safe-node.tailnet.ts.net:9443', 'https://safe-node.tailnet.ts.net'])(
    'pairs securely on canonical custom/default origin %s',
    async (publicOrigin) => {
      const { call, pair } = await fixture(undefined, publicOrigin);
      const session = await pair();
      expect((await call('/phone/session', { headers: session.headers })).status).toBe(200);
      expect(
        (await call('/phone/session', { headers: { ...session.headers, Host: new URL(publicOrigin).host + ':443' } }))
          .status,
      ).toBe(403);
      expect((await call('/phone/pair', { method: 'POST', headers: { Origin: origin }, body: {} })).status).toBe(403);
    },
  );
  it('serves public pairing, but never unauthenticated application navigation or API', async () => {
    const { call } = await fixture();
    const root = await call('/');
    expect(root.body).toContain('Pair your device');
    expect(root.body).not.toContain('APP SHELL');
    expect(root.headers['content-security-policy']).toContain("script-src 'nonce-");
    expect((await call('/threads/a')).body).toContain('Pair your device');
    expect((await call('/main.js')).status).toBe(200);
    expect((await call('/api/threads')).status).toBe(401);
    expect((await call('/phone/session')).status).toBe(401);
  });
  it('serves install metadata and icons before pairing with a manifest-specific MIME and CSP', async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, 'manifest.webmanifest'),
      JSON.stringify({ name: 'pi-kit', start_url: '/', display: 'standalone' }),
    );
    await mkdir(join(f.root, 'icons'));
    await writeFile(join(f.root, 'icons', 'icon-192.png'), Buffer.from([137, 80, 78, 71]));
    const manifest = await f.call('/manifest.webmanifest');
    expect(manifest.status).toBe(200);
    expect(manifest.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    expect(JSON.parse(manifest.body).name).toBe('pi-kit');
    expect((await f.call('/icons/icon-192.png')).headers['content-type']).toBe('image/png');
    expect((await f.call('/phone')).headers['content-security-policy']).toContain("manifest-src 'self'");
    expect((await f.call('/api/threads')).status).toBe(401);
  });

  it('permits camera only on the pairing page and serves only the exact local scanner assets', async () => {
    const f = await fixture();
    await mkdir(join(f.root, 'phone'));
    for (const name of ['pairing.js', 'jsQR.js', 'private.js'])
      await writeFile(join(f.root, 'phone', name), '/* local scanner fixture */');
    const page = await f.call('/phone');
    expect(page.headers['permissions-policy']).toBe('camera=(self), microphone=(), geolocation=()');
    const nonce = String(page.headers['content-security-policy']).match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(page.body).toContain(`nonce="${nonce}" src="/phone/jsQR.js"`);
    expect(page.body).toContain(`nonce="${nonce}" src="/phone/pairing.js"`);
    for (const name of ['pairing.js', 'jsQR.js']) {
      const asset = await f.call('/phone/' + name);
      expect(asset.status).toBe(200);
      expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(asset.headers['permissions-policy']).toContain('camera=()');
      expect((await f.call('/phone/' + name, { method: 'HEAD' })).body).toBe('');
      expect((await f.call('/phone/' + name, { method: 'POST' })).status).toBe(405);
    }
    expect((await f.call('/phone/private.js')).status).toBe(404);
    expect((await f.call('/phone/%2e%2e%2fmain.js')).status).toBe(400);
    const session = await f.pair();
    expect((await f.call('/', { headers: session.headers })).headers['permissions-policy']).toContain('camera=()');
    expect((await f.call('/api/health', { headers: session.headers })).headers['permissions-policy']).toContain(
      'microphone=(self)',
    );
  });

  it('requires one-use code and explicit desktop approval, issues only secure cookies and csrf nonce', async () => {
    const { gateway, call } = await fixture();
    const pairing = gateway.beginPairing();
    expect(pairing.code).toMatch(/^[A-Z2-7]{12}$/);
    expect(pairing.url).toBe(origin + '/phone#' + pairing.code);
    const response = await call('/phone/pair', {
      method: 'POST',
      body: { code: pairing.code },
      headers: { 'User-Agent': '<script>phone</script>' },
    });
    const pending = JSON.parse(response.body);
    expect(gateway.status().requests[0].confirmationCode).toBe(pending.confirmationCode);
    expect((await call('/phone/pair', { method: 'POST', body: { code: pairing.code } })).status).toBe(400);
    const pendingCookie = (response.headers['set-cookie'] as string[])[0];
    expect(pendingCookie).toContain('HttpOnly; Secure; SameSite=Strict');
    const headers = { Cookie: pendingCookie.split(';')[0] };
    expect(JSON.parse((await call('/phone/pair/status', { headers })).body).status).toBe('pending');
    expect((await call('/phone/session', { headers })).status).toBe(401);
    gateway.approve(pending.id);
    const approved = await call('/phone/pair/status', { headers });
    expect(JSON.parse(approved.body).status).toBe('approved');
    expect((await call('/phone/pair/status', { headers })).status).toBe(401);
    expect(gateway.status().devices).toHaveLength(1);
    expect(JSON.stringify(gateway.status())).not.toContain('cookieHash');
  });
  it('requires cookie AND csrf and overwrites auth without leaking master credentials or response cookies/CORS', async () => {
    const { call, pair, upstreamHeaders } = await fixture();
    const session = await pair();
    expect((await call('/api/threads', { headers: { Cookie: session.cookie } })).status).toBe(401);
    expect((await call('/api/threads', { headers: { Authorization: `Bearer ${session.token}` } })).status).toBe(401);
    const response = await call('/api/threads', {
      headers: { ...session.headers, 'X-Forwarded-For': 'evil', 'X-Replay-Id': '42' },
    });
    expect(response.status).toBe(200);
    expect(response.body).not.toContain('MASTER-SECRET');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(upstreamHeaders[0]['authorization']).toBe('Bearer MASTER-SECRET');
    expect(upstreamHeaders[0]['cookie']).toBeUndefined();
    expect(upstreamHeaders[0]['x-forwarded-for']).toBeUndefined();
    expect(upstreamHeaders[0]['x-replay-id']).toBe('42');
    const index = await call('/', { headers: session.headers });
    expect(index.body).toContain('<meta name="pi-kit-connection" content="device">');
    expect(index.headers['content-security-policy']).toContain("script-src 'self'");
    expect(index.headers['content-security-policy']).toContain(
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    );
    expect(index.headers['content-security-policy']).toContain("font-src 'self' data: https://fonts.gstatic.com");
    expect(index.headers['content-security-policy']).toContain("connect-src 'self'; frame-src 'none'");
  });
  it('lets a paired browser finish or skip onboarding without bypassing cookie, CSRF, or Origin checks', async () => {
    const { call, pair, upstreamPaths } = await fixture();
    const path = '/api/setup/state';
    const body = { state: 'completed' };
    expect((await call(path, { method: 'POST', body })).status).toBe(401);
    const session = await pair();
    expect((await call(path, { method: 'POST', headers: { Cookie: session.cookie }, body })).status).toBe(401);
    expect(
      (await call(path, { method: 'POST', headers: { Authorization: `Bearer ${session.token}` }, body })).status,
    ).toBe(401);
    for (const Origin of ['', 'https://evil.test'])
      expect((await call(path, { method: 'POST', headers: { ...session.headers, Origin }, body })).status).toBe(403);
    expect(upstreamPaths).toEqual([]);
    for (const state of ['completed', 'skipped'])
      expect((await call(path, { method: 'POST', headers: session.headers, body: { state } })).status).toBe(200);
    expect(upstreamPaths).toEqual([path, path]);
  });
  it('denies unreviewed administrative, browser, and sandbox routes even with a valid session', async () => {
    const { call, pair } = await fixture();
    const { headers } = await pair();
    expect((await call('/api/setup', { headers })).status).toBe(200);
    for (const path of [
      '/api/dev',
      '/api/openapi.json',
      '/api/secrets',
      '/api/auth/login',
      '/api/update',
      '/api/about/pi-update',
      '/api/computer-use',
      '/api/diagnostics',
      '/api/genui-sandbox/frame.html',
      '/api/mcp-apps/foo',
      '/api/threads/id/browser',
      '/api/setup/local-runtime',
      '/api/mcp/file',
    ])
      expect((await call(path, { headers })).status, path).toBe(403);
    for (const path of [
      '/api/settings/key',
      '/api/resources/toggle',
      '/api/providers/remove',
      '/api/setup/local/test',
      '/api/setup/local/save',
      '/api/setup/ready',
      '/api/setup/scratch',
    ])
      expect((await call(path, { method: 'POST', headers, body: {} })).status).toBe(403);
    expect((await call('/api/threads', { method: 'POST', headers, body: {} })).status).toBe(200);
    expect((await call('/api/copilotkit', { method: 'POST', headers, body: {} })).status).toBe(200);
    expect((await call('/api/threads/redirect', { headers })).status).toBe(502);
    expect((await call('/api/threads/document', { headers })).status).toBe(502);
  });
  it.each(['revoke', 'close'])('streams without buffering and terminates on %s', async (action) => {
    const { pair, url, gateway, call } = await fixture();
    const session = await pair();
    let closed!: () => void;
    const ended = new Promise<void>((done) => (closed = done));
    await new Promise<void>((done, reject) => {
      const req = request(url + '/api/threads/events', { headers: { Host: host, ...session.headers } }, (res) => {
        expect(res.headers['x-replay-id']).toBe('replay');
        res.once('data', (chunk) => {
          expect(chunk.toString()).toContain('data: first');
          done();
        });
        res.once('close', closed);
      });
      req.on('error', reject);
      req.end();
    });
    if (action === 'close') await gateway.close();
    else await gateway.revoke(session.id);
    await ended;
    if (action !== 'close') expect((await call('/phone/session', { headers: session.headers })).status).toBe(401);
  });
  it('bounds attempts and expires enrollment codes, not approved devices', async () => {
    const { gateway, call, pair } = await fixture();
    const session = await pair();
    const p = gateway.beginPairing();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60000);
    expect((await call('/phone/pair', { method: 'POST', body: { code: p.code } })).status).toBe(400);
    vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 86400000);
    expect((await call('/phone/session', { headers: session.headers })).status).toBe(200);
    for (let i = 0; i < 20; i++) await call('/phone/pair', { method: 'POST', body: { code: 'wrong' } });
    expect((await call('/phone/pair', { method: 'POST', body: { code: 'wrong' } })).status).toBe(429);
  });
  it('restores approval after closing/recreating a listener and persists explicit revocation', async () => {
    const rows = new Map<string, StoredDeviceGrant>();
    const store: RemoteGrantStore = {
      load: async () => structuredClone([...rows.values()]),
      save: async (grant) => {
        rows.set(grant.id, structuredClone(grant));
      },
      revoke: async (id) => {
        rows.delete(id);
      },
    };
    const first = await fixture(undefined, origin, store);
    const device = await first.pair();
    await first.gateway.close();
    expect(rows.size).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 365 * 86400000);
    const second = await fixture(undefined, origin, store);
    const response = await second.call('/phone/session', { headers: device.headers });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).token).toBe(device.token);
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=34560000');
    for (const path of ['/api/instance/devices', '/api/instance/access'])
      expect((await second.call(path, { headers: device.headers })).status).toBe(403);
    expect(
      (await second.call('/api/instance', { method: 'PATCH', headers: device.headers, body: { name: 'bad' } })).status,
    ).toBe(403);
    await second.gateway.revoke(device.id);
    await second.gateway.close();
    const third = await fixture(undefined, origin, store);
    expect((await third.call('/phone/session', { headers: device.headers })).status).toBe(401);
  });

  it('does not issue a device cookie when durable approval cannot be written', async () => {
    const store: RemoteGrantStore = {
      load: async () => [],
      save: async () => {
        throw new Error('disk unavailable');
      },
      revoke: async () => undefined,
    };
    const f = await fixture(undefined, origin, store);
    const invitation = f.gateway.beginPairing();
    const requested = await f.call('/phone/pair', { method: 'POST', body: { code: invitation.code } });
    const pendingCookie = (requested.headers['set-cookie'] as string[])[0].split(';')[0];
    f.gateway.approve(JSON.parse(requested.body).id);
    const result = await f.call('/phone/pair/status', { headers: { Cookie: pendingCookie } });
    expect(result.status).toBe(500);
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(f.gateway.status().devices).toEqual([]);
    expect(result.body).not.toContain('disk unavailable');
  });

  it('retries an uncertain committed approval with the same cookie proof, never a replacement credential', async () => {
    let persisted: StoredDeviceGrant | undefined;
    let failAcknowledgement = true;
    const store: RemoteGrantStore = {
      load: async () => [],
      revoke: async () => undefined,
      save: async (grant) => {
        if (persisted) expect(grant).toEqual(persisted);
        persisted = structuredClone(grant);
        if (failAcknowledgement) {
          failAcknowledgement = false;
          throw new Error('acknowledgement lost');
        }
      },
    };
    const f = await fixture(undefined, origin, store);
    const invitation = f.gateway.beginPairing();
    const requested = await f.call('/phone/pair', { method: 'POST', body: { code: invitation.code } });
    const pendingCookie = (requested.headers['set-cookie'] as string[])[0].split(';')[0];
    f.gateway.approve(JSON.parse(requested.body).id);
    expect((await f.call('/phone/pair/status', { headers: { Cookie: pendingCookie } })).status).toBe(500);
    const retried = await f.call('/phone/pair/status', { headers: { Cookie: pendingCookie } });
    expect(retried.status).toBe(200);
    expect(JSON.parse(retried.body)).toEqual({ status: 'approved' });
    expect(retried.headers['set-cookie']).toBeDefined();
  });

  it('preserves encoded SDK path parameters without decoding them into routing segments', async () => {
    const { call, pair } = await fixture();
    const { headers } = await pair();
    const workspace = encodeURIComponent('/home/user/project');
    const thread = encodeURIComponent('/home/user/.pi/sessions/thread.jsonl');
    for (const path of [
      `/api/workspaces/${workspace}/files`,
      `/api/workspaces/${workspace}/watch`,
      `/api/workspaces/${workspace}/tree`,
      `/api/workspaces/${workspace}/trust`,
      `/api/threads/${thread}`,
      `/api/threads/${thread}/changes/${encodeURIComponent('src/main.ts')}`,
    ]) {
      expect((await call(path, { headers })).status, path).toBe(200);
    }
    expect(
      (await call(`/api/workspaces/${workspace}/terminal/input`, { method: 'POST', headers, body: {} })).status,
    ).toBe(200);
    for (const path of [
      '/api/%74hreads',
      '/api/threads/id/%62rowser',
      '/api/threads/id/browser',
      '/api/threads/id%00',
      '/api/threads/%ZZ',
    ]) {
      expect((await call(path, { headers })).status, path).not.toBe(200);
    }
  });
  it('does not mistake sandbox/genui substrings in SDK parameters for forbidden routes', async () => {
    const { call, pair } = await fixture();
    const { headers } = await pair();
    for (const name of ['sandbox repo', 'genui-project', 'mcp-app-project', 'browser']) {
      const cwd = encodeURIComponent(`/tmp/${name}`);
      const thread = encodeURIComponent(`/tmp/${name}/session.jsonl`);
      expect((await call(`/api/workspaces/${cwd}/files`, { headers })).status).toBe(200);
      expect((await call(`/api/workspaces/${cwd}/terminal`, { method: 'POST', headers, body: {} })).status).toBe(200);
      expect(
        (await call(`/api/threads/${thread}/changes/${encodeURIComponent('src/genui-file.ts')}`, { headers })).status,
      ).toBe(200);
      expect((await call(`/api/threads/${thread}/changes/foo-genui.ts`, { headers })).status).toBe(200);
      expect((await call(`/api/threads/${thread}/changes/browser`, { headers })).status).toBe(200);
      expect((await call(`/api/threads/${thread}/browser`, { headers })).status).toBe(403);
    }
    for (const path of [
      '/api/genui-sandbox/frame.html',
      '/api/mcp-sandbox/proxy.html',
      '/api/mcp-apps',
      '/api/copilotkit/mcp-apps/tool',
      '/api/agui/genui-sandbox/frame.html',
    ]) {
      expect((await call(path, { headers })).status).toBe(403);
    }
  });
  it('matches generated SDK conversation methods and narrowly permits selection persistence', async () => {
    const { call, pair } = await fixture();
    const { headers } = await pair();
    const id = encodeURIComponent('/workspace/session.jsonl');
    const cwd = encodeURIComponent('/workspace');
    const cases: Array<[string, string]> = [
      ['GET', '/api/setup'],
      ['GET', '/api/threads'],
      ['POST', '/api/threads'],
      ['GET', '/api/workspaces'],
      ['POST', '/api/workspaces'],
      ['PATCH', '/api/workspaces'],
      ['PUT', '/api/workspaces/order'],
      ['PUT', '/api/settings/thread'],
      ['PUT', '/api/settings/workspace'],
      ['GET', `/api/threads/${id}`],
      ['PATCH', `/api/threads/${id}`],
      ['POST', `/api/threads/${id}/placement`],
      ['PATCH', `/api/threads/${id}/model`],
      ['POST', `/api/threads/${id}/seen`],
      ['POST', `/api/threads/${id}/navigate`],
      ['POST', `/api/threads/${id}/summarize-branch`],
      ['POST', `/api/threads/${id}/label`],
      ['GET', `/api/threads/${id}/worktree`],
      ['GET', `/api/threads/${id}/worktree/message`],
      ['PUT', `/api/threads/${id}/review-comments`],
      ['PUT', `/api/threads/${id}/feedback`],
      ['POST', `/api/workspaces/${cwd}/terminal`],
      ['POST', `/api/workspaces/${cwd}/terminal/resize`],
      ['DELETE', `/api/workspaces/${cwd}/terminal`],
      ['POST', `/api/workspaces/${cwd}/fs/create`],
      ['POST', `/api/workspaces/${cwd}/fs/rename`],
      ['POST', `/api/workspaces/${cwd}/fs/delete`],
    ];
    for (const [method, path] of cases)
      expect(
        (await call(path, { method, headers, ...(method === 'GET' ? {} : { body: {} }) })).status,
        `${method} ${path}`,
      ).toBe(200);
    for (const [method, path] of [
      ['PUT', '/api/settings/theme'],
      ['PUT', '/api/settings/pi'],
      ['PATCH', '/api/pi-settings'],
      ['PUT', '/api/settings/%74hread'],
      ['POST', '/api/settings/thread'],
      ['PUT', `/api/threads/${id}/model`],
      ['DELETE', `/api/workspaces/${cwd}/terminal/stream`],
    ]) {
      expect((await call(path, { method, headers, body: {} })).status, `${method} ${path}`).toBe(403);
    }
  });
  it('permits authenticated voice usage and streams events but denies model administration', async () => {
    const { call, pair, url, upstreamHeaders } = await fixture();
    const session = await pair();
    const routes: Array<[string, string]> = [
      ['POST', '/api/transcribe'],
      ['POST', '/api/transcribe/stream'],
      ['POST', '/api/transcribe/live'],
      ['POST', '/api/transcribe/live/voice-id/chunk'],
      ['POST', '/api/transcribe/live/voice-id/end'],
      ['DELETE', '/api/transcribe/live/voice-id'],
      ['GET', '/api/transcribe/live/voice-id/events'],
    ];
    for (const [method, path] of routes) {
      expect((await call(path, { method, headers: { Cookie: session.cookie } })).status).toBe(401);
      expect((await call(path, { method, headers: { Authorization: `Bearer ${session.token}` } })).status).toBe(401);
      if (path.endsWith('/events')) continue;
      expect((await call(path, { method, headers: session.headers, body: { audio: 'fixture' } })).status).toBe(200);
    }
    await new Promise<void>((done, reject) => {
      const req = request(
        url + '/api/transcribe/live/voice-id/events',
        { headers: { Host: host, ...session.headers } },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.once('data', (chunk) => {
            expect(chunk.toString()).toContain('data: first');
            res.destroy();
            done();
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(upstreamHeaders).toHaveLength(routes.length);
    for (const forwarded of upstreamHeaders) {
      expect(forwarded['authorization']).toBe('Bearer MASTER-SECRET');
      expect(forwarded['cookie']).toBeUndefined();
    }
    for (const method of ['GET', 'POST', 'DELETE', 'PUT', 'PATCH']) {
      expect((await call('/api/transcribe/model', { method, headers: session.headers })).status).toBe(403);
    }
    for (const [method, path] of [
      ['GET', '/api/transcribe/live'],
      ['GET', '/api/transcribe/live/voice-id'],
      ['POST', '/api/transcribe/live/voice-id/events'],
      ['DELETE', '/api/transcribe/live/voice-id/chunk'],
      ['POST', '/api/transcribe/download'],
    ]) {
      expect((await call(path, { method, headers: session.headers })).status).toBe(403);
    }
  });
  it('validates packaged renderer before opening a listener', async () => {
    const missing = join(tmpdir(), 'phone-renderer-definitely-missing');
    const gateway = new RemoteGateway({ rendererRoot: missing, publicOrigin: origin, backend: () => undefined });
    await expect(gateway.listen()).rejects.toThrow();
    await gateway.close();
    const { root } = await fixture();
    await rm(join(root, 'index.html'));
    const noIndex = new RemoteGateway({ rendererRoot: root, publicOrigin: origin, backend: () => undefined });
    await expect(noIndex.listen()).rejects.toThrow();
    const outside = await mkdtemp(join(tmpdir(), 'outside-index-'));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'index.html'), 'outside');
    await symlink(join(outside, 'index.html'), join(root, 'index.html'));
    await expect(noIndex.listen()).rejects.toThrow('Renderer unavailable');
    await noIndex.close();
  });
  it('expires and rejects pending requests without granting access', async () => {
    const { gateway, call } = await fixture();
    const start = async () => {
      const pairing = gateway.beginPairing();
      const response = await call('/phone/pair', { method: 'POST', body: { code: pairing.code } });
      return {
        id: JSON.parse(response.body).id as string,
        headers: { Cookie: (response.headers['set-cookie'] as string[])[0].split(';')[0] },
      };
    };
    const rejected = await start();
    gateway.reject(rejected.id);
    gateway.approve(rejected.id);
    expect((await call('/phone/pair/status', { headers: rejected.headers })).status).toBe(401);
    const expired = await start();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121000);
    gateway.approve(expired.id);
    expect((await call('/phone/pair/status', { headers: expired.headers })).status).toBe(401);
    expect(gateway.status().devices).toHaveLength(0);
  });
  it('rejects non-literal/non-loopback backend targets without forwarding credentials', async () => {
    const backend = { url: 'http://localhost:3333', token: 'secret' };
    const { pair, call, upstreamHeaders } = await fixture(backend);
    const { headers } = await pair();
    for (const backendUrl of [
      'http://localhost:3333',
      'http://2130706433:3333',
      'http://127.1:3333',
      'https://127.0.0.1:3333',
      'http://example.com',
      'http://127.0.0.1:3333/path',
      'http://user@127.0.0.1:3333',
    ]) {
      backend.url = backendUrl;
      expect((await call('/api/threads', { headers })).status).toBe(503);
    }
    expect(upstreamHeaders).toHaveLength(0);
  });
  it('rejects traversal, symlink escapes, dotfiles, missing assets and non-GET static methods', async () => {
    const { root, call, pair } = await fixture();
    await symlink(join(root, '..'), join(root, 'escape'));
    await symlink(join(root, '.secret'), join(root, 'assets', 'secret.js'));
    const { headers } = await pair();
    // Resolved extension is checked as well as the requested path.
    for (const path of [
      '/../.secret',
      '/%2e%2e/.secret',
      '/escape/file.js',
      '/.secret',
      '/assets/secret.js',
      '/missing.js',
      '/assets/missing',
    ])
      expect((await call(path, { headers })).status).not.toBe(200);
    expect((await call('/main.js', { method: 'POST', headers, body: {} })).status).toBe(405);
    const outside = await mkdtemp(join(tmpdir(), 'phone-secret-'));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'secret.js'), 'outside secret');
    await symlink(join(outside, 'secret.js'), join(root, 'outside.js'));
    expect((await call('/outside.js', { headers })).status).toBe(404);
  });
});
