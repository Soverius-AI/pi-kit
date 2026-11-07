// Native macOS integration test. Requires the isolated paths.json described in MACOS.md.
// This never targets the installed app's default profile or service label.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

assert.equal(process.platform, 'darwin');
const paths = JSON.parse(readFileSync('/tmp/pi-kit-macos-service-test/paths.json', 'utf8'));
assert.ok(paths.root.includes('/Library/Caches/pi-kit-macos-service-test-'));
assert.ok(paths.dataDir.startsWith(paths.root + '/'));
assert.match(paths.name, /^dev\.pi-kit\.app\.service\.[a-f0-9]{8}$/);
const env = { ...process.env, PI_KIT_DATA_DIR: paths.dataDir };
const discovery = () => JSON.parse(readFileSync(join(paths.dataDir, 'service.json'), 'utf8'));
const cli = (...args) => spawnSync(paths.launcher, ['service', ...args], { encoding: 'utf8', timeout: 75_000 });
const rpc = (method) =>
  JSON.parse(execFileSync(process.execPath, ['scripts/headless-test/host-rpc.mjs', method], { env, encoding: 'utf8' }));
const checkCli = (...args) => {
  const result = cli(...args);
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
async function until(label, predicate, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      // The discovery file/socket may temporarily disappear during restart.
    }
    await sleep(250);
  }
  throw new Error(`Timed out: ${label}`);
}
const ready = () =>
  until('healthy detached backend', () => {
    const status = rpc('status');
    assert.equal(status.desktopAttached, false);
    return status.status.state === 'running' && status;
  });
const report = (name, details) => console.log(`PASS ${name}${details ? `: ${details}` : ''}`);

const first = await ready();
report('native macOS service runs with no desktop attached');
const plist = join(process.env.HOME, 'Library', 'LaunchAgents', `${paths.name}.plist`);
const registration = JSON.parse(
  execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }),
);
assert.equal(registration.Label, paths.name);
assert.equal(registration.RunAtLoad, true);
assert.deepEqual(registration.KeepAlive, { SuccessfulExit: false });
assert.equal(registration.ProgramArguments[0], paths.binary);
assert.equal(registration.EnvironmentVariables.PI_KIT_DATA_DIR, paths.dataDir);
assert.equal(registration.EnvironmentVariables.ELECTRON_RUN_AS_NODE, '1');
const parent = Number(
  execFileSync('/bin/ps', ['-p', String(discovery().pid), '-o', 'ppid='], { encoding: 'utf8' }).trim(),
);
assert.equal(parent, 1);
report('real per-user LaunchAgent', 'RunAtLoad, failure-only KeepAlive, parent launchd (PID 1)');
// macOS ps reports the initial exec environment, not the host wrapper's later setenv calls.
// The spawned backend's exec environment proves it inherited the wrapper's isolated values.
const command = execFileSync('/bin/ps', ['eww', '-p', String(first.backendPid), '-o', 'command='], {
  encoding: 'utf8',
});
assert.ok(command.includes(`HOME=${paths.home}`), 'test HOME must reach the backend');
assert.ok(command.includes(`PI_CODING_AGENT_DIR=${paths.agentDir}`), 'test agent directory must reach the backend');
report('backend inherits isolated HOME and Pi agent directory');
for (const file of [join(paths.dataDir, 'service.json'), discovery().socket]) {
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(file).uid, process.getuid());
}
report('owner-only discovery/socket permissions', '0600');
const originalHost = discovery().pid;
checkCli('install');
assert.equal(discovery().pid, originalHost);
report('idempotent install does not restart host');
await new Promise((resolve, reject) => {
  const socket = createConnection(discovery().socket);
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error('Invalid local authentication was not closed'));
  }, 7_000);
  socket.on('connect', () => socket.write(JSON.stringify({ t: 'hello', token: 'invalid-test-token' }) + '\n'));
  socket.on('data', () => {
    clearTimeout(timer);
    socket.destroy();
    reject(new Error('Invalid local authentication received data'));
  });
  socket.on('error', reject);
  socket.on('close', () => {
    clearTimeout(timer);
    resolve();
  });
});
report('invalid local RPC authentication rejected');
for (const path of ['/api/health', '/api/threads']) assert.equal((await fetch(first.backendUrl + path)).status, 401);
report('unauthenticated backend APIs rejected');
const previousBackend = rpc('status').backendPid;
process.kill(previousBackend, 'SIGKILL');
const recovered = await until('watchdog recovers crashed backend', () => {
  const status = rpc('status');
  return status.status.state === 'running' && status.backendPid !== previousBackend && status;
});
assert.equal(discovery().pid, originalHost);
assert.ok(recovered.status.restarts >= 1);
report('watchdog restarts crashed backend', `${previousBackend} -> ${recovered.backendPid}`);
const previousHost = discovery().pid;
process.kill(previousHost, 'SIGKILL');
await until('launchd recovers crashed host', () => discovery().pid !== previousHost);
await ready();
report('launchd restarts crashed host', `${previousHost} -> ${discovery().pid}`);
const owner = discovery().pid;
const duplicate = spawnSync(paths.binary, [join(paths.backend, 'service-host.cjs')], {
  encoding: 'utf8',
  timeout: 15_000,
  env: {
    ...env,
    HOME: paths.home,
    PI_CODING_AGENT_DIR: paths.agentDir,
    PI_KIT_SERVICE_LEVEL: 'app',
    PI_KIT_LOG_DIR: join(paths.dataDir, 'logs'),
    ELECTRON_RUN_AS_NODE: '1',
  },
});
assert.equal(duplicate.status, 3, duplicate.stderr);
assert.equal(discovery().pid, owner);
report('duplicate host rejected', 'exit 3');
report('CLI stop', checkCli('stop'));
await sleep(12_000); // Beyond launchd's ordinary throttle interval: a clean exit must stay stopped.
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
assert.equal(existsSync(plist), false);
assert.notEqual(spawnSync('/bin/launchctl', ['print', `gui/${paths.uid}/${paths.name}`]).status, 0);
report('uninstall removes plist and loaded launchd job');
report('CLI reinstall', checkCli('install'));
await ready();
console.log('Native macOS lifecycle suite complete; isolated service left running for remote/model tests.');
