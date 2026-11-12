import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OwnerGateway, OwnerStateFile } from './owner-gateway';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function listening(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

/** The backend behind the owner listener: what it was asked, and JSON back. */
async function backend() {
  const asked: IncomingHttpHeaders[] = [];
  const port = await listening(
    createServer((req, res) => {
      asked.push({ ...req.headers, path: req.url });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    }),
  );
  return { asked, endpoint: { url: `http://127.0.0.1:${port}`, token: 'backend-token' } };
}

async function profile() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-kit-owner-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), '<html><head></head><body>app</body></html>');
  return {
    rendererRoot: dir,
    state: new OwnerStateFile(join(dir, 'data', 'owner.json')),
    statePath: join(dir, 'data', 'owner.json'),
  };
}

async function open(
  p: Awaited<ReturnType<typeof profile>>,
  endpoint: { url: string; token: string },
  preferredPort = 0,
) {
  const gateway = new OwnerGateway({
    rendererRoot: p.rendererRoot,
    backend: () => endpoint,
    state: p.state,
    preferredPort,
  });
  await gateway.listen();
  cleanup.push(() => gateway.close());
  const port = Number(new URL(gateway.link().url).port);
  return { gateway, port };
}

/** A request as a browser or another local process could make it, Host and Origin included. */
function call(
  port: number,
  {
    method = 'GET',
    path = '/',
    headers = {},
    body,
  }: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown },
) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const signIn = (port: number, code: string) =>
  call(port, {
    method: 'POST',
    path: '/owner/session',
    headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: { code },
  });
const codeOf = (url: string) => new URL(url).hash.slice('#owner='.length);

describe('owner listener', () => {
  it('uses one filtered exact-origin list for CSP and bootstrap, including changing backend targets', async () => {
    const p = await profile();
    let endpoint = { url: 'http://127.0.0.1:4300', token: 'secret' };
    const gateway = new OwnerGateway({
      ...p,
      backend: () => endpoint,
      preferredPort: 0,
      previewOrigins: ['https://preview.example', 'http://127.0.0.1:4300'],
    });
    await gateway.listen();
    cleanup.push(() => gateway.close());
    const port = Number(new URL(gateway.link().url).port);
    let response = await call(port, {});
    expect(response.headers['content-security-policy']).toContain('frame-src https://preview.example;');
    expect(response.body).toContain('content="[&quot;https://preview.example&quot;]"');
    endpoint = { url: 'https://preview.example', token: 'secret' };
    response = await call(port, {});
    expect(response.headers['content-security-policy']).toContain('frame-src http://127.0.0.1:4300;');
    expect(response.body).toContain('content="[&quot;http://127.0.0.1:4300&quot;]"');
  });

  it('signs a browser in once per link and passes it every backend route with the backend’s own token', async () => {
    const p = await profile();
    const { asked, endpoint } = await backend();
    const { gateway, port } = await open(p, endpoint);
    const code = codeOf(gateway.link().url);

    const signedIn = await signIn(port, code);
    expect(signedIn.status).toBe(200);
    const { token } = JSON.parse(signedIn.body) as { token: string };
    expect((await signIn(port, code)).status).toBe(400);

    const owned = await call(port, { path: '/api/settings/secrets', headers: { authorization: `Bearer ${token}` } });
    expect(owned.status).toBe(200);
    expect(asked).toEqual([
      expect.objectContaining({ path: '/api/settings/secrets', authorization: 'Bearer backend-token' }),
    ]);
    expect(asked[0]).not.toHaveProperty('x-pi-device-id');
    expect((await call(port, { path: '/' })).body).toContain('<meta name="pi-kit-connection" content="owner">');
  });

  it('refuses another host name, a foreign origin and a request without a signed-in token', async () => {
    const p = await profile();
    const { asked, endpoint } = await backend();
    const { gateway, port } = await open(p, endpoint);

    expect((await call(port, { headers: { host: `rebound.example:${port}` } })).status).toBe(403);
    const foreign = await call(port, {
      method: 'POST',
      path: '/owner/session',
      headers: { origin: 'http://evil.example' },
      body: { code: codeOf(gateway.link().url) },
    });
    expect(foreign.status).toBe(403);
    const unsigned = await call(port, {
      method: 'POST',
      path: '/owner/session',
      body: { code: codeOf(gateway.link().url) },
    });
    expect(unsigned.status).toBe(403);
    const anonymous = await call(port, { path: '/api/threads' });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers['www-authenticate']).toContain('pi-kit-owner');
    expect(asked).toEqual([]);
  });

  it('keeps its port and signed-in browsers across restarts until they are revoked, storing no token', async () => {
    const p = await profile();
    const { endpoint } = await backend();
    const busy = await listening(createServer());
    const first = await open(p, endpoint, busy);
    expect(first.port).not.toBe(busy);
    const { token } = JSON.parse((await signIn(first.port, codeOf(first.gateway.link().url))).body) as {
      token: string;
    };
    await first.gateway.close();
    expect(await readFile(p.statePath, 'utf8')).not.toContain(token);

    const second = await open(p, endpoint, busy);
    expect(second.port).toBe(first.port);
    const authorized = { path: '/api/threads', headers: { authorization: `Bearer ${token}` } };
    expect((await call(second.port, authorized)).status).toBe(200);
    await second.gateway.revokeAll();
    expect((await call(second.port, authorized)).status).toBe(401);
  });
});
