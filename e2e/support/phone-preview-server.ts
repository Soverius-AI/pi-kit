// Persistent, loopback-only visual fixture. No real tailnet, profile, models or credentials.
import { app } from 'electron';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { join } from 'node:path';
import { RemoteGateway } from '../../libs/shared/service-host/src/remote-gateway';
import { startBackend } from './instance';

app.setActivationPolicy('accessory');
app
  .whenReady()
  .then(async () => {
    const scratch = process.env['PHONE_PREVIEW_DIR']!;
    const root = process.env['PHONE_PREVIEW_ROOT']!;
    const controlToken = randomBytes(32).toString('hex');
    const backend = await startBackend({ root, directory: scratch, label: 'Preview workspace' });
    const { url: backendUrl, token, project } = backend;
    const api = (path: string, body?: unknown) =>
      fetch(backendUrl + '/api/' + path, {
        method: body === undefined ? 'GET' : path.startsWith('settings/') ? 'PUT' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const threadResponse = await api('threads', { cwd: project, title: 'Plan a small feature' });
    if (!threadResponse.ok) throw new Error('Could not seed fixture thread');
    const thread = (await threadResponse.json()) as { id: string };
    await api('settings/thread', { value: thread.id });
    await api('settings/workspace', { value: project });
    const publicOrigin = 'https://phone.fixture.ts.net:8443';
    const gateway = new RemoteGateway({
      rendererRoot: join(root, 'dist/apps/renderer/browser'),
      backend: () => ({ url: backendUrl, token }),
      publicOrigin,
    });
    const local = new URL(await gateway.listen());
    await writeFile(
      join(scratch, 'cert.cnf'),
      '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=pi-kit isolated simulator fixture\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',
    );
    const certPath = join(scratch, 'cert.pem');
    const cert = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        join(scratch, 'key.pem'),
        '-out',
        certPath,
        '-config',
        join(scratch, 'cert.cnf'),
      ],
      { stdio: 'ignore' },
    );
    if (cert.status !== 0) throw new Error('Could not create fixture certificate');
    let browserOrigin = '';
    const tls = createTlsServer(
      { key: await readFile(join(scratch, 'key.pem')), cert: await readFile(certPath) },
      (req, res) => {
        const headers = { ...req.headers, host: new URL(publicOrigin).host };
        if (headers.origin === browserOrigin) headers.origin = publicOrigin;
        const upstream = request(
          { hostname: '127.0.0.1', port: local.port, method: req.method, path: req.url, headers },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
          },
        );
        upstream.on('error', () => res.destroy());
        res.on('close', () => upstream.destroy());
        req.pipe(upstream);
      },
    );
    await new Promise<void>((done) => tls.listen(0, '127.0.0.1', done));
    browserOrigin = `https://localhost:${(tls.address() as { port: number }).port}`;
    let pairCode = gateway.beginPairing().code;
    const control = createServer(async (req, res) => {
      if (req.headers['x-preview-key'] !== controlToken) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.url === '/approve' && req.method === 'POST') {
        for (const request of gateway.status().requests) gateway.approve(request.id);
      }
      if (req.url === '/pair' && req.method === 'POST') pairCode = gateway.beginPairing().code;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...gateway.status(), pairingUrl: `${browserOrigin}/phone#${pairCode}` }));
    });
    await new Promise<void>((done) => control.listen(0, '127.0.0.1', done));
    await writeFile(
      join(scratch, 'state.json'),
      JSON.stringify({
        pid: process.pid,
        url: browserOrigin,
        pairingUrl: `${browserOrigin}/phone#${pairCode}`,
        certPath,
        controlUrl: `http://127.0.0.1:${(control.address() as { port: number }).port}`,
        controlToken,
      }),
      { mode: 0o600 },
    );
    console.log('PWA preview ready:', browserOrigin);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      control.closeAllConnections();
      control.close();
      tls.closeAllConnections();
      tls.close();
      await gateway.close();
      await backend.stop();
      app.quit();
    };
    process.on('SIGTERM', () => void close());
    process.on('SIGINT', () => void close());
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
