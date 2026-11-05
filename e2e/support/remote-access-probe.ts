// Real HTTPS browser + production Angular + isolated backend. No Tailscale configuration or user credentials.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { RemoteGateway } from '../../libs/shared/service-host/src/remote-gateway';
import { RemoteAccessStores } from '../../libs/shared/service-host/src/remote-access-store';
import { bounded, startBackend, until, type Backend } from './instance';
import QRCode from 'qrcode';
import { assertPhoneLayout } from './phone-layout-probe';

async function main(): Promise<void> {
  await app.whenReady();
  const scratch = process.env['PI_KIT_PHONE_TEST_DIR'];
  const root = process.env['PI_KIT_PHONE_TEST_ROOT'];
  assert.ok(scratch && root);
  await mkdir(join(scratch, 'project'), { recursive: true });
  await writeFile(join(scratch, 'project', 'phone-smoke.txt'), 'Phone file access works.\n');
  const token = randomBytes(32).toString('hex');
  let backend: Backend | undefined;
  let gateway: RemoteGateway | undefined;
  let tls: ReturnType<typeof httpsServer> | undefined;
  let phone: BrowserWindow | undefined;
  try {
    backend = await startBackend({ root, directory: scratch, token });
    const backendUrl = backend.url,
      project = backend.project;
    const restartBackend = async () => {
      backend = await startBackend({ root, directory: scratch, token, port: Number(new URL(backendUrl).port) });
    };
    const ownerHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const identity = await fetch(`${backendUrl}/api/instance`, {
      method: 'PATCH',
      headers: ownerHeaders,
      body: JSON.stringify({ name: 'Build Box' }),
    }).then((response) => response.json());
    assert.equal(identity.name, 'Build Box');
    console.log('STEP isolated backend ready');
    const origin = 'https://phone.fixture.ts.net:8443';
    const gatewayOptions = {
      rendererRoot: process.env['PHONE_E2E_RENDERER_ROOT'] ?? join(root, 'dist/apps/renderer/browser'),
      backend: () => ({ url: backendUrl, token }),
      publicOrigin: origin,
      grants: new RemoteAccessStores(() => ({ url: backendUrl, token })).grants,
    };
    gateway = new RemoteGateway(gatewayOptions);
    let local = new URL(await gateway.listen());
    tls = httpsServer(
      { key: await readFile(join(scratch, 'key.pem')), cert: await readFile(join(scratch, 'cert.pem')) },
      (req, res) => {
        const outgoing = request(
          { hostname: '127.0.0.1', port: local.port, method: req.method, path: req.url, headers: req.headers },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
          },
        );
        outgoing.on('error', () => res.destroy());
        res.on('close', () => outgoing.destroy());
        req.pipe(outgoing);
      },
    );
    const secure = tls;
    await new Promise<void>((resolve, reject) => {
      secure.once('error', reject);
      secure.listen(8443, '127.0.0.1', resolve);
    });
    phone = new BrowserWindow({
      show: false,
      width: 390,
      height: 844,
      useContentSize: true,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: `phone-test-${randomBytes(8).toString('hex')}`,
      },
    });
    phone.webContents.session.setCertificateVerifyProc((req, callback) =>
      callback(req.hostname === 'phone.fixture.ts.net' ? 0 : -3),
    );
    // Never depend on external font/CDN availability in this isolated network regression.
    phone.webContents.session.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: new URL(details.url).origin !== origin }),
    );
    const errors: string[] = [];
    phone.webContents.on('console-message', (details) => {
      if (details.level === 'error') errors.push(details.message);
    });
    let leaked = false;
    const statuses: { path: string; status: number }[] = [];
    phone.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
      if (
        new URL(details.url).pathname.startsWith('/api/') &&
        Object.values(details.requestHeaders).some((value) => String(value).includes(token))
      )
        leaked = true;
      callback({ requestHeaders: details.requestHeaders });
    });
    phone.webContents.session.webRequest.onResponseStarted((details) => {
      if (new URL(details.url).pathname.startsWith('/api/'))
        statuses.push({ path: new URL(details.url).pathname, status: details.statusCode });
    });
    const pairing = gateway.beginPairing();
    await phone.loadURL(pairing.url);
    assert.equal(await phone.webContents.executeJavaScript('location.hash'), '', 'fragment secret removed from URL');
    assert.equal(await phone.webContents.executeJavaScript('document.querySelector("#code").value'), pairing.code);
    assert.equal(
      await phone.webContents.executeJavaScript('typeof window.jsQR'),
      'function',
      'local Safari-compatible QR decoder loaded under nonce CSP',
    );
    const manifest = await phone.webContents.executeJavaScript(`(async()=>{
      const response=await fetch(document.querySelector('link[rel="manifest"]').href);
      const data=await response.json();
      const icons=await Promise.all(data.icons.map(async icon=>{const image=await createImageBitmap(await fetch(icon.src).then(r=>r.blob()));const dimensions=image.width+'x'+image.height;image.close();return dimensions===icon.sizes;}));
      return {type:response.headers.get('Content-Type'),display:data.display,id:data.id,start:data.start_url,icons};
    })()`);
    assert.equal(manifest.type, 'application/manifest+json; charset=utf-8');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.id, '/');
    assert.equal(manifest.start, '/');
    assert.ok(manifest.icons.every(Boolean), 'every install icon decodes at its declared size');
    const qrImage = (await QRCode.toBuffer(pairing.url, { width: 480, margin: 4 })).toString('base64');
    await phone.webContents.executeJavaScript(`(async()=>{
      const bytes=Uint8Array.from(atob(${JSON.stringify(qrImage)}), c=>c.charCodeAt(0));
      const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
      const draw=()=>canvas.getContext('2d').drawImage(image,0,0);draw();
      const stream=canvas.captureStream(10),timer=setInterval(draw,80);
      window.__qrProbe={stream,timer,calls:0,image};
      Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{window.__qrProbe.calls++;return stream;}});
      document.querySelector('#code').value='';document.querySelector('#scan').click();
    })()`);
    await until(
      async () =>
        (await phone!.webContents.executeJavaScript('document.querySelector("#code").value')) === pairing.code,
      'real jsQR decodes the synthetic on-device video',
    );
    assert.equal(await phone.webContents.executeJavaScript('window.__qrProbe.calls'), 1);
    assert.equal(
      await phone.webContents.executeJavaScript('window.__qrProbe.stream.getTracks().every(t=>t.readyState==="ended")'),
      true,
      'scanning success releases camera tracks',
    );
    assert.equal(gateway.status().requests.length, 0, 'camera scan only fills code; access request stays explicit');
    await phone.webContents.executeJavaScript('clearInterval(window.__qrProbe.timer);window.__qrProbe.image.close()');
    console.log('STEP local camera-video QR scan complete without OS camera permission');
    const renewed = gateway.beginPairing();
    await phone.webContents.executeJavaScript(`location.hash=${JSON.stringify(renewed.code)}`);
    await until(
      async () =>
        (await phone!.webContents.executeJavaScript(
          'location.hash === "" && document.querySelector("#code").value',
        )) === renewed.code,
      'Safari-style same-document QR renewal',
    );
    await phone.webContents.executeJavaScript('document.querySelector("#pair").requestSubmit()');
    const activeGateway = gateway;
    const client = phone.webContents;
    await until(async () => activeGateway.status().requests.length === 1, 'desktop pairing request');
    const pending = gateway.status().requests[0];
    assert.ok(pending);
    await until(
      async () =>
        (await client.executeJavaScript('document.querySelector("#status").textContent')).includes(
          pending.confirmationCode,
        ),
      'matching confirmation code',
    );
    assert.equal(
      await phone.webContents.executeJavaScript('fetch("/phone/session").then(r=>r.status)'),
      401,
      'no session before desktop approval',
    );
    gateway.approve(pending.id);
    console.log('STEP phone approved');
    await until(
      async () => !!(await client.executeJavaScript('document.querySelector("pk-root .pk-shell")')),
      'production Angular phone UI',
    );
    await until(
      async () => statuses.some((entry) => entry.path === '/api/setup' && entry.status === 200),
      'onboarding/bootstrap API',
    );
    assert.equal(await phone.webContents.executeJavaScript('typeof window.piKit'), 'undefined');
    assert.equal(
      await phone.webContents.executeJavaScript('document.querySelector("meta[name=pi-kit-connection]").content'),
      'device',
    );
    assert.equal(leaked, false, 'desktop token never enters browser requests');
    console.log('STEP production app bootstrapped');
    const result = await bounded(
      phone.webContents.executeJavaScript(`(async () => {
      const {token}=await fetch('/phone/session').then(r=>r.json());
      const headers={Authorization:'Bearer '+token};
      const environment=await fetch('/api/instance',{headers}).then(r=>r.json());
      const privateDevices=await fetch('/api/instance/devices',{headers});
      const forbiddenRename=await fetch('/api/instance',{method:'PATCH',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({name:'forbidden'})});
      const health=await fetch('/api/health',{headers});
      const files=await fetch('/api/workspaces/'+encodeURIComponent(${JSON.stringify(project)})+'/files',{headers});
      const forbidden=await fetch('/api/secrets',{headers});
      const created=await fetch('/api/threads',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({cwd:${JSON.stringify(project)},title:'Phone smoke test'})});
      const thread=await created.json();
      const selection=await fetch('/api/settings/thread',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({value:thread.id})});
      const workspace=await fetch('/api/settings/workspace',{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({value:${JSON.stringify(project)}})});
      return {environment,privateDevices:privateDevices.status,forbiddenRename:forbiddenRename.status,threadOwner:thread.instanceId,health:health.status,files:files.status,forbidden:forbidden.status,created:created.status,selection:selection.status,workspace:workspace.status,overflow:document.documentElement.scrollWidth>innerWidth};
    })()`),
    );
    console.log('STEP phone APIs complete', result);
    assert.equal(result.environment.instanceId, identity.instanceId);
    assert.equal(result.environment.name, 'Build Box');
    assert.equal(result.threadOwner, identity.instanceId, 'project and new chat share the stable owner');
    assert.equal(result.privateDevices, 403, 'grant hashes and nonces are private owner APIs');
    assert.equal(result.forbiddenRename, 403, 'phone cannot rename the host');
    assert.equal(result.health, 200);
    assert.equal(result.files, 200, 'encoded computer path survives gateway routing');
    assert.equal(result.forbidden, 403);
    assert.equal(result.created, 201, 'phone creates a thread without a model invocation');
    assert.equal(result.selection, 204, 'phone can remember its selected thread');
    assert.equal(result.workspace, 204, 'phone can remember its selected workspace');
    assert.equal(result.overflow, false, 'phone layout fits its viewport');
    await phone.loadURL(origin);
    console.log('STEP selected thread page reloaded');
    await until(
      async () => !!(await client.executeJavaScript('document.querySelector(\'[aria-label="Message to pi"]\')')),
      'phone composer for selected thread',
    );
    await until(
      async () => statuses.some((entry) => entry.path.endsWith('/agent/pi/connect') && entry.status === 200),
      'CopilotKit authenticated replay connection',
    );
    await assertPhoneLayout(phone);
    const worklet = await bounded(
      client.executeJavaScript(
        `(async () => {
      const context = new AudioContext();
      try { await context.audioWorklet.addModule(new URL('audio/pcm-tap.js', document.baseURI).href); return true; }
      finally { await context.close(); }
    })()`,
        true,
      ),
    );
    assert.equal(worklet, true, 'live voice worklet loads under phone CSP without microphone access');
    if (process.env['PHONE_E2E_ARTIFACT_DIR']) {
      await mkdir(process.env['PHONE_E2E_ARTIFACT_DIR'], { recursive: true });
      await writeFile(
        join(process.env['PHONE_E2E_ARTIFACT_DIR'], 'iphone-app.png'),
        (await phone.webContents.capturePage()).toPNG(),
      );
    }
    assert.deepEqual(
      statuses.filter((entry) => entry.status >= 500),
      [],
      `unexpected bootstrap failures: ${JSON.stringify(statuses)}`,
    );
    assert.ok(
      !errors.some((error) => /Refused to (?:execute|load)|Content Security Policy|NG0\d{3}/.test(error)),
      errors.join('\n'),
    );
    // Recreate both processes against the same isolated profile. No new QR/approval.
    await gateway.close();
    await bounded(backend!.stop(), 10000);
    await restartBackend();
    gateway = new RemoteGateway(gatewayOptions);
    local = new URL(await gateway.listen());
    const restored = await fetch(`${backendUrl}/api/instance`, { headers: ownerHeaders }).then((response) =>
      response.json(),
    );
    assert.equal(restored.instanceId, identity.instanceId);
    assert.equal(restored.name, 'Build Box');
    assert.equal(gateway.status().devices.length, 1);
    assert.equal(
      await phone.webContents.executeJavaScript('fetch("/phone/session").then(r=>r.status)'),
      200,
      'device cookie resumes after backend/listener restart',
    );
    await phone.loadURL(origin);
    await until(
      async () => !!(await client.executeJavaScript('document.querySelector(\'[aria-label="Message to pi"]\')')),
      'selected chat restores without re-pairing',
    );
    console.log('STEP stable environment, selected project/chat and device approval survived full restart');
    await gateway.revoke(pending.id);
    assert.equal(await phone.webContents.executeJavaScript('fetch("/phone/session").then(r=>r.status)'), 401);
    try {
      await phone.loadURL(origin);
    } catch (error) {
      // A concurrent health poll can already be redirecting the revoked app to /phone.
      if ((error as { code?: string }).code !== 'ERR_ABORTED') throw error;
    }
    await until(
      async () => (await client.executeJavaScript('document.querySelector("h1")?.textContent')) === 'Pair your device',
      'revoked phone returns to pairing',
    );
    console.log(
      'PASS HTTPS pairing, durable restart approval, stable named environment and project/chat ownership, production Angular bootstrap, same-origin session APIs, encoded files, revocation, no desktop token leak',
    );
  } catch (error) {
    console.error('Backend diagnostics:', backend?.log().slice(-3000));
    throw error;
  } finally {
    phone?.destroy();
    tls?.closeAllConnections();
    const secure = tls;
    if (secure?.listening) await new Promise<void>((resolve) => secure.close(() => resolve()));
    await gateway?.close();
    await backend?.stop();
  }
}
app.commandLine.appendSwitch('host-resolver-rules', 'MAP phone.fixture.ts.net 127.0.0.1');
void main().then(
  () => app.exit(0),
  (error: unknown) => {
    process.stderr.write(String(error instanceof Error ? error.stack : error) + '\n', () => app.exit(1));
  },
);
