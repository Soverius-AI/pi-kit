import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { RemoteAccess } from '../../apps/desktop/src/remote-access';
import { RemoteAccessStores } from '../../apps/desktop/src/remote-access-store';
import { InstanceKeyStore } from '../../apps/desktop/src/instance-key';
import { fixtureEncryption, startBackend, until } from './instance';

const root = process.env['PI_KIT_TAILNET_TEST_ROOT']!,
  scratch = process.env['PI_KIT_TAILNET_TEST_DIR']!;
const ports = (process.env['PI_KIT_TAILNET_TEST_PORTS'] ?? '8444,8445').split(',').map(Number);
let osKey = Buffer.alloc(0);
async function loadSealingKey(): Promise<void> {
  const keyFile = join(scratch, 'os-key');
  osKey = await readFile(keyFile).catch(async () => {
    const key = randomBytes(32);
    await writeFile(keyFile, key, { mode: 0o600 });
    return key;
  });
}
const encryption = fixtureEncryption(() => osKey);

async function instance(label: string, port: number) {
  const directory = join(scratch, label);
  await mkdir(directory, { recursive: true });
  const keys = new InstanceKeyStore(() => join(directory, 'instance-key.enc'), encryption);
  const backend = await startBackend({ root, directory, label, keys: () => keys });
  const id = (await backend.owner('/api/instance', 'PATCH', { name: label })).instanceId as string;
  await backend.owner('/api/threads', 'POST', { cwd: backend.project, title: `${label} plans a feature` });
  const connection = () => ({ url: backend.url, token: backend.token });
  const stores = new RemoteAccessStores(connection);
  const access = new RemoteAccess(
    {},
    {
      rendererRoot: join(root, 'dist/apps/renderer/browser'),
      backend: connection,
      grants: stores.grants,
      preferences: stores.preferences,
      published: stores.published,
      cookieScope: stores.cookieScope,
    },
  );
  const status = await access.start(port);
  if (status.state !== 'serving') {
    await access.dispose();
    await backend.stop();
    throw new Error(`${label} on port ${port}: ${status.state} ${status.issue ?? ''} ${status.message ?? ''}`);
  }
  return {
    label,
    id,
    port,
    project: backend.project,
    publicUrl: status.url!,
    owner: backend.owner,
    access,
    async stop() {
      await access.dispose();
      await backend.stop();
    },
  };
}

async function main() {
  await mkdir(scratch, { recursive: true });
  await loadSealingKey();
  const alpha = await instance('Alpha', ports[0]);
  const beta = await instance('Beta', ports[1]).catch(async (error: unknown) => {
    await alpha.stop();
    throw error;
  });
  const instances = { alpha, beta };
  const controlToken = randomBytes(16).toString('hex');
  const control = createServer(async (req, res) => {
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
    };
    if (req.headers['x-fixture-key'] !== controlToken) return answer(403, { error: 'forbidden' });
    const [, action, which] = (req.url ?? '').split('/');
    const target = instances[which as keyof typeof instances];
    try {
      if (action === 'status')
        return answer(
          200,
          Object.fromEntries(
            await Promise.all(
              Object.values(instances).map(async (item) => [
                item.label,
                { id: item.id, publicUrl: item.publicUrl, project: item.project, ...(await item.access.status()) },
              ]),
            ),
          ),
        );
      if (action === 'pair' && target) return answer(200, (await target.access.beginPairing()).pairing);
      if (action === 'approve' && target) {
        for (const request of (await target.access.status()).requests ?? [])
          await target.access.approvePairing(request.id);
        return answer(200, (await target.access.status()).devices);
      }
      if (action === 'peer') {
        const invitation = await alpha.owner('/api/instances/invitations', 'POST');
        await beta.owner('/api/instances/connect', 'POST', { invitation: invitation.invitation, allowRelay: true });
        return answer(200, { alpha: await alpha.owner('/api/instances'), beta: await beta.owner('/api/instances') });
      }
      if (action === 'peer-approve') {
        const manager = await alpha.owner('/api/instances');
        for (const request of manager.requests)
          await alpha.owner(`/api/instances/requests/${request.pairId}/approve`, 'POST', { allowRelay: true });
        await until(
          async () =>
            (await beta.owner('/api/instances')).peers.some(
              (peer: any) => peer.peerId === alpha.id && peer.state === 'active',
            ),
          'reciprocal confirmation',
        );
        return answer(200, { alpha: await alpha.owner('/api/instances'), beta: await beta.owner('/api/instances') });
      }
      if (action === 'peers')
        return answer(200, { alpha: await alpha.owner('/api/instances'), beta: await beta.owner('/api/instances') });
      return answer(404, { error: 'unknown action' });
    } catch (error) {
      return answer(500, { error: String(error) });
    }
  });
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
  const controlUrl = `http://127.0.0.1:${(control.address() as { port: number }).port}`;
  await writeFile(
    join(scratch, 'state.json'),
    JSON.stringify(
      {
        pid: process.pid,
        controlUrl,
        controlToken,
        alpha: { id: alpha.id, publicUrl: alpha.publicUrl },
        beta: { id: beta.id, publicUrl: beta.publicUrl },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(`fixture ready: Alpha ${alpha.publicUrl}  Beta ${beta.publicUrl}  control ${controlUrl}`);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    control.closeAllConnections();
    control.close();
    await Promise.allSettled([alpha.stop(), beta.stop()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void close());
  process.on('SIGINT', () => void close());
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
