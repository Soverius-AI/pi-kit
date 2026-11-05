import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, access, mkdir } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { RemoteGateway } from '../../libs/shared/service-host/src/remote-gateway';
import { RemoteAccessStores } from '../../libs/shared/service-host/src/remote-access-store';
import { InstanceKeyStore } from '../../libs/shared/service-host/src/instance-key';
import { fixtureEncryption, startBackend, until, type Backend } from './instance';

const root = process.env['PI_KIT_INSTANCE_TEST_ROOT']!,
  scratch = process.env['PI_KIT_INSTANCE_TEST_DIR']!;
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.fixture.ts.net 127.0.0.1');
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

const osKey = randomBytes(32);
const encryption = fixtureEncryption(() => osKey);
const owned: { stop(): Promise<void> }[] = [];
async function instance(label: string) {
  const directory = join(scratch, label);
  await mkdir(directory, { recursive: true });
  let keys = new InstanceKeyStore(() => join(directory, 'instance-key.enc'), encryption);
  let backend: Backend | undefined,
    gateway: RemoteGateway | undefined,
    local: URL | undefined,
    id = '';
  const start = async () => {
    backend = await startBackend({
      root,
      directory,
      label,
      keys: () => keys,
      args: ['--require', join(scratch, 'lookup.cjs')],
      env: { NODE_EXTRA_CA_CERTS: join(scratch, 'cert.pem') },
    });
    const identity = await backend.owner('/api/instance');
    if (id) assert.equal(identity.instanceId, id);
    id = identity.instanceId;
  };
  await start();
  await backend!.owner('/api/instance', 'PATCH', { name: label });
  const tls = createTlsServer(
    { key: await readFile(join(scratch, 'key.pem')), cert: await readFile(join(scratch, 'cert.pem')) },
    (req, res) => {
      if (!local) {
        res.writeHead(503).end();
        return;
      }
      const upstream = request(
        { hostname: '127.0.0.1', port: local.port, path: req.url, method: req.method, headers: req.headers },
        (response) => {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      res.once('close', () => upstream.destroy());
      req.pipe(upstream);
    },
  );
  await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
  const origin = `https://${label.toLowerCase()}.fixture.ts.net:${(tls.address() as { port: number }).port}`;
  const connection = () => ({ url: backend!.url, token: backend!.token });
  const stores = new RemoteAccessStores(connection);
  const listen = async () => {
    gateway = new RemoteGateway({
      rendererRoot: join(root, 'dist/apps/renderer/browser'),
      publicOrigin: origin,
      backend: connection,
      grants: stores.grants,
      cookieScope: stores.cookieScope,
    });
    local = new URL(await gateway.listen());
    await stores.published(origin);
  };
  await listen();
  const result = {
    get id() {
      return id;
    },
    get project() {
      return backend!.project;
    },
    get url() {
      return backend!.url;
    },
    get token() {
      return backend!.token;
    },
    origin,
    owner: (path: string, method?: string, body?: unknown) => backend!.owner(path, method, body),
    get gateway() {
      return gateway!;
    },
    async restart() {
      await gateway?.close();
      local = undefined;
      await backend?.stop();
      keys = new InstanceKeyStore(() => join(directory, 'instance-key.enc'), encryption);
      await start();
      await listen();
    },
    async stop() {
      await gateway?.close();
      await close(tls);
      await backend?.stop();
    },
  };
  owned.push(result);
  return result;
}

const step = (label: string) => console.log('STEP ' + label);
// Without a listener Electron quits with code 0 as soon as the phone window is destroyed during cleanup, before the failure is printed.
app.on('window-all-closed', () => undefined);
async function main() {
  await app.whenReady();
  let phone: BrowserWindow | undefined,
    targetId = '';
  try {
    const alpha = await instance('Alpha'),
      beta = await instance('Beta'),
      gamma = await instance('Gamma');
    targetId = beta.id;
    console.log('STEP three isolated instances, no Tailscale or OS keychain mutation');
    async function pair(a: typeof alpha, b: typeof beta) {
      const invitation = await a.owner('/api/instances/invitations', 'POST');
      await b.owner('/api/instances/connect', 'POST', { invitation: invitation.invitation, allowRelay: true });
      const manager = await a.owner('/api/instances'),
        request = manager.requests[0];
      assert.ok(request);
      const joiner = await b.owner('/api/instances');
      assert.equal(joiner.peers.find((peer: any) => peer.peerId === a.id).confirmationCode, request.confirmationCode);
      await a.owner(`/api/instances/requests/${request.pairId}/approve`, 'POST', { allowRelay: true });
      await until(
        async () =>
          (await b.owner('/api/instances')).peers.some((peer: any) => peer.peerId === a.id && peer.state === 'active'),
        'reciprocal confirmation',
      );
    }
    await pair(alpha, beta);
    await pair(beta, gamma);
    assert.equal((await alpha.owner(`/api/instances/${beta.id}/proxy/api/instance`)).instanceId, beta.id);
    assert.equal((await beta.owner(`/api/instances/${alpha.id}/proxy/api/instance`)).instanceId, alpha.id);
    const blocked = await fetch(
      alpha.url + `/api/instances/${beta.id}/proxy/api/instances/${gamma.id}/proxy/api/instance`,
      { headers: { authorization: `Bearer ${alpha.token}` } },
    );
    assert.equal(blocked.status, 403);
    const projects = await alpha.owner(`/api/instances/${beta.id}/projects`);
    assert.ok(projects.every((project: any) => project.instanceId === beta.id));
    const thread = await alpha.owner(`/api/instances/${beta.id}/proxy/api/threads`, 'POST', { cwd: beta.project });
    assert.equal(thread.instanceId, beta.id);
    await alpha.owner(`/api/instances/${beta.id}/proxy/api/threads/${thread.id}`, 'PATCH', { title: 'Only Beta' });
    const bash = await fetch(alpha.url + `/api/instances/${beta.id}/proxy/api/threads/${thread.id}/bash`, {
      method: 'POST',
      headers: { authorization: `Bearer ${alpha.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'pwd > owner-proof.txt' }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(bash.status, 200, await bash.text());
    assert.equal((await readFile(join(beta.project, 'owner-proof.txt'), 'utf8')).trim(), beta.project);
    await assert.rejects(access(join(alpha.project, 'owner-proof.txt')));
    console.log('STEP reciprocal control, target-local execution and one-hop rejection');
    phone = new BrowserWindow({
      show: false,
      width: 390,
      height: 844,
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'instances-' + randomBytes(8).toString('hex'),
      },
    });
    phone.webContents.on('render-process-gone', (_event, details) =>
      console.log('EVENT render-process-gone ' + JSON.stringify(details)),
    );
    phone.webContents.on('did-fail-load', (_event, code, description, url) =>
      console.log(`EVENT did-fail-load ${code} ${description} ${url}`),
    );
    phone.webContents.session.setCertificateVerifyProc((request, callback) =>
      callback(/^(alpha|beta|gamma)\.fixture\.ts\.net$/.test(request.hostname) ? 0 : -3),
    );
    let leaked = false,
      crossOrigin = false;
    phone.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      if (
        Object.values(details.requestHeaders).some((value) =>
          [alpha.token, beta.token, gamma.token].some((token) => String(value).includes(token)),
        )
      )
        leaked = true;
      if (new URL(details.url).hostname.endsWith('.fixture.ts.net') && new URL(details.url).origin !== alpha.origin)
        crossOrigin = true;
      callback({ requestHeaders: details.requestHeaders });
    });
    const invitation = alpha.gateway.beginPairing();
    await phone.loadURL(invitation.url);
    step('pairing page loaded');
    await phone.webContents.executeJavaScript(`document.querySelector('form').requestSubmit()`);
    await until(async () => alpha.gateway.status().requests.length === 1, 'phone request');
    step('phone requested');
    const deviceId = alpha.gateway.status().requests[0].id;
    alpha.gateway.approve(deviceId);
    await until(
      async () =>
        new URL(phone!.webContents.getURL()).pathname === '/' &&
        (await phone!.webContents.executeJavaScript(`!!document.querySelector('pk-thread-sidebar')`)),
      'approved PWA',
    );
    step('approved PWA');
    const ref = { instanceId: beta.id, cwd: beta.project, threadId: thread.id };
    await phone.loadURL(alpha.origin + '/#' + new URLSearchParams({ workbench: JSON.stringify(ref) }));
    await until(
      async () =>
        await phone!.webContents.executeJavaScript(
          `document.querySelector('[data-testid="active-environment"]')?.textContent.includes('Beta') && document.body.textContent.includes('Only Beta')`,
        ),
      'PWA remote owner',
    );
    step('PWA remote owner');
    assert.equal(
      await phone.webContents.executeJavaScript(
        `(async()=>{const {token}=await fetch('/phone/session').then(r=>r.json());return (await fetch('/api/instances/${gamma.id}/proxy/api/instance',{headers:{authorization:'Bearer '+token}})).status})()`,
      ),
      403,
    );
    await phone.webContents.executeJavaScript(
      `document.querySelector('#t-threads').checked=true; document.querySelector('[data-testid="add-project"]').click()`,
    );
    await until(
      async () =>
        await phone!.webContents.executeJavaScript(`!!document.querySelector('[data-testid="project-environment"]')`),
      'project chooser',
    );
    step('project chooser');
    assert.equal(
      await phone.webContents.executeJavaScript(`document.querySelector('[data-testid="project-environment"]').value`),
      alpha.id,
      'fresh Add/Open remains entry-local even while viewing Beta',
    );
    assert.equal(
      await phone.webContents.executeJavaScript(`document.documentElement.scrollWidth <= innerWidth + 1`),
      true,
    );
    await phone.webContents.executeJavaScript(`document.querySelector('[data-testid="project-cancel"]').click()`);
    await beta.restart();
    step('beta restarted');
    await until(
      async () => (await alpha.owner(`/api/instances/${beta.id}/proxy/api/instance`)).instanceId === beta.id,
      'target restart',
    );
    await alpha.restart();
    await phone.reload();
    step('alpha restarted');
    await until(
      async () =>
        await phone!.webContents.executeJavaScript(
          `document.body.textContent.includes('Only Beta') && !!document.querySelector('[data-testid="active-environment"]')`,
        ),
      'entry restart without pairing',
    );
    assert.equal(alpha.gateway.status().devices[0].id, deviceId);
    await beta.owner(`/api/instances/${alpha.id}`, 'DELETE');
    await until(
      async () =>
        (await alpha.owner('/api/instances')).peers.find((peer: any) => peer.peerId === beta.id)?.state === 'revoked',
      'bilateral unpair',
    );
    assert.equal(leaked, false, 'backend master tokens never enter PWA requests');
    assert.equal(crossOrigin, false, 'PWA credentials stay at its entry origin');
    console.log(
      'PASS reciprocal instances: TLS/JWS/IPC, target execution, project-first PWA, one hop, restart, revocation and token isolation',
    );
  } catch (error) {
    console.error(error);
    if (phone && !phone.isDestroyed()) {
      console.log('PAGE URL ' + phone.webContents.getURL());
      console.log(
        'PAGE TEXT ' +
          JSON.stringify(
            await phone.webContents.executeJavaScript('document.body.innerText.slice(0, 600)').catch(String),
          ),
      );
      console.log(
        'PAGE PROXY ' +
          JSON.stringify(
            await phone.webContents
              .executeJavaScript(
                `(async()=>{const s=await fetch('/phone/session');if(!s.ok)return 'session '+s.status;const {token}=await s.json();const r=await fetch(location.pathname.replace(/[/]$/,'')+'/api/instances/${targetId}/proxy/api/threads',{headers:{authorization:'Bearer '+token}});return r.status+' '+(await r.text()).slice(0,300)})()`,
              )
              .catch(String),
          ),
      );
    }
    throw error;
  } finally {
    phone?.destroy();
    for (const item of owned.reverse()) await item.stop();
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    process.stderr.write(String(error instanceof Error ? error.stack : error) + '\n', () => app.exit(1));
  },
);
