// Run inside the integration-test container as tester, against the packaged app.
// Destructive ONLY to this test user's pi-kit service. No desktop is attached.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const data = join(process.env.HOME, '.config/pi-kit');
const discovery = () => JSON.parse(readFileSync(join(data, 'service.json'), 'utf8'));
const cli = (...args) => spawnSync('pi-kit', ['service', ...args], { encoding: 'utf8', timeout: 75_000 });
const status = () => JSON.parse(execFileSync(process.execPath, ['/opt/host-rpc.mjs', 'status'], { encoding: 'utf8' }));
const checkCli = (...args) => {
  const result = cli(...args);
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
async function until(label, predicate, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      // Discovery/socket may temporarily disappear during recovery.
    }
    await sleep(250);
  }
  throw new Error(`Timed out: ${label}`);
}
const ready = () =>
  until('healthy detached backend', () => {
    const current = status();
    assert.equal(current.desktopAttached, false);
    return current.status.state === 'running' && current;
  });
const report = (name, details) => console.log(`PASS ${name}${details ? `: ${details}` : ''}`);

await ready();
report('fresh service runs without a desktop');
for (const file of ['service.json', 'host.sock']) {
  const metadata = statSync(join(data, file));
  assert.equal(metadata.mode & 0o777, 0o600, `${file} must be owner-only`);
  assert.equal(metadata.uid, process.getuid());
}
report('discovery file and host socket permissions', '0600, owned by tester');

const beforeInstall = discovery().pid;
checkCli('install');
assert.equal(discovery().pid, beforeInstall, 'idempotent install must not restart the host');
report('idempotent service install');

await new Promise((resolve, reject) => {
  const socket = createConnection(discovery().socket);
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error('Bad authentication was not closed'));
  }, 7_000);
  socket.on('connect', () => socket.write(JSON.stringify({ t: 'hello', token: 'invalid-test-token' }) + '\n'));
  socket.on('data', () => {
    clearTimeout(timer);
    socket.destroy();
    reject(new Error('Bad authentication received data'));
  });
  socket.on('error', reject);
  socket.on('close', () => {
    clearTimeout(timer);
    resolve();
  });
});
report('unauthenticated local RPC rejected');

const backendBefore = status().backendPid;
process.kill(backendBefore, 'SIGKILL');
const recovered = await until('watchdog recovers backend', () => {
  const current = status();
  return current.status.state === 'running' && current.backendPid !== backendBefore && current;
});
assert.equal(discovery().pid, beforeInstall, 'backend crash must not restart the host');
assert.ok(recovered.status.restarts >= 1);
report('watchdog restarts crashed backend', `${backendBefore} -> ${recovered.backendPid}`);

const hostBefore = discovery().pid;
process.kill(hostBefore, 'SIGKILL');
await until('systemd recovers crashed host', () => discovery().pid !== hostBefore);
await ready();
report('systemd restarts crashed service host', `${hostBefore} -> ${discovery().pid}`);

const healthy = status();
const health = await fetch(`${healthy.backendUrl}/api/health`);
assert.equal(health.status, 401);
const denied = await fetch(`${healthy.backendUrl}/api/threads`);
assert.equal(denied.status, 401);
report('unauthenticated health and thread APIs denied', '401 / 401');

const ownerBeforeDuplicate = discovery().pid;
const duplicate = spawnSync('/opt/pi-kit/pi-kit', ['/opt/pi-kit/resources/backend/service-host.cjs'], {
  encoding: 'utf8',
  timeout: 15_000,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PI_KIT_SERVICE_LEVEL: 'app',
    PI_KIT_DATA_DIR: data,
    PI_KIT_LOG_DIR: join(data, 'logs'),
  },
});
assert.equal(duplicate.status, 3, duplicate.stderr);
assert.equal(discovery().pid, ownerBeforeDuplicate);
await ready();
report('duplicate host refused', 'exit 3');

report('CLI stop', checkCli('stop'));
await sleep(6_000); // Greater than systemd RestartSec: a clean stop must stay stopped.
assert.equal(cli('status').status, 3);
report('clean stop remains stopped');
report('CLI start', checkCli('start'));
await ready();
const beforeRestart = discovery().pid;
report('CLI restart', checkCli('restart'));
await ready();
assert.notEqual(discovery().pid, beforeRestart);
report('CLI uninstall', checkCli('uninstall'));
assert.equal(cli('status').status, 3);
report('CLI reinstall', checkCli('install'));
await ready();
console.log('Lifecycle suite complete; service left running for pairing tests.');
