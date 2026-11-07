// The service host: plain Node on the Electron binary (ELECTRON_RUN_AS_NODE), never Electron's own APIs (ADR-0036).
import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  allocateEndpoint,
  appFolders,
  FileLog,
  HOST_ALREADY_RUNNING,
  HostAlreadyRunningError,
  hostConfigFromEnv,
  hostSocketPath,
  launchForWatchdog,
  listenHostChannel,
  pingHealth,
  CommandSleepGuard,
  FileWrappingKeys,
  HostSealing,
  instanceKeyFile,
  KeyringWrappingKeys,
  OWNER_PORT,
  OwnerGateway,
  OwnerStateFile,
  RemoteAccess,
  RemoteAccessStores,
  removeDiscovery,
  ServiceHost,
  sleepCommand,
  spawnBackend,
  writeDiscovery,
} from '@pi-kit/service-host';
import { KeyringSecretStore, selectSecretStore } from '@pi-kit/secret-store';

const { rendererRoot, level, ...config } = hostConfigFromEnv(process.env, __dirname);
const logDir = process.env['PI_KIT_LOG_DIR'];
const serviceLog = logDir ? new FileLog(logDir, 'service.log') : undefined;
const backendLog = logDir ? new FileLog(logDir, 'backend.log') : undefined;
/** service.log, and the terminal when `pi-kit serve` runs the host there. */
const note = (line: string) => {
  serviceLog?.line(line);
  if (level === 'serve') process.stderr.write(`${line}\n`);
};
const token = randomBytes(32).toString('hex');

const stores = new RemoteAccessStores(() => host.backend);
const remote = new RemoteAccess(
  {},
  {
    rendererRoot,
    backend: () => host.backend,
    grants: stores.grants,
    preferences: stores.preferences,
    published: stores.published,
    cookieScope: stores.cookieScope,
  },
);
const owner = new OwnerGateway({
  rendererRoot,
  backend: () => host.backend,
  state: new OwnerStateFile(join(config.dataDir, 'owner.json')),
  preferredPort: resolve(config.dataDir) === resolve(appFolders().dataDir) ? OWNER_PORT : 0,
});
const host: ServiceHost = new ServiceHost(config, {
  owner,
  rendererRoot,
  allocate: allocateEndpoint,
  spawn: spawnBackend,
  launch: launchForWatchdog,
  ping: pingHealth,
  output: (chunk, stream) => {
    backendLog?.write(chunk.toString());
    // A host the operating system runs has no terminal; backend.log has it all.
    if (level !== 'login') (stream === 'stderr' ? process.stderr : process.stdout).write(chunk);
  },
  log: note,
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  now: () => Date.now(),
  exit: (code) => process.exit(code),
  remote,
  restoreRemote: process.env['PI_KIT_SMOKE'] !== '1',
  sleepGuard: new CommandSleepGuard(sleepCommand(process.platform, process.pid), (line) => note(line)),
  // Tests and e2e name a scratch store in PI_KIT_SECRET_STORE; otherwise the OS credential store holds the wrapping key.
  hostSealing: new HostSealing(
    new KeyringWrappingKeys(
      () => (process.env['PI_KIT_SECRET_STORE'] ? selectSecretStore(process.env) : new KeyringSecretStore()),
      config.dataDir,
    ),
    new FileWrappingKeys(instanceKeyFile(config.dataDir)),
  ),
});

// A host the desktop app or its Windows supervisor started ends with it: the IPC channel closes when that process goes.
if (process.send) process.on('disconnect', () => void host.stop());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void host.stop());

void (async () => {
  note(`service host ${config.version} (${level}) started, pid ${process.pid}`);
  await host.open();
  const socket = hostSocketPath(config.dataDir);
  await listenHostChannel(socket, token, (peer) => host.accept(peer));
  writeDiscovery(config.dataDir, {
    pid: process.pid,
    version: config.version,
    level,
    socket,
    token,
    startedAt: new Date().toISOString(),
  });
  process.on('exit', () => {
    removeDiscovery(config.dataDir, process.pid);
    if (!socket.startsWith('\\\\'))
      try {
        unlinkSync(socket);
      } catch {
        // Already gone.
      }
  });
  note(`listening on ${socket}`);
  // Nobody is there to ask for the first start: agents, schedules and phones need the backend now. A failure waits for a desktop.
  if (level !== 'app') void host.start().catch((error: Error) => note(`backend did not start: ${error.message}`));
})().catch((error: Error) => {
  if (error instanceof HostAlreadyRunningError) {
    note(error.message);
    // A service manager would keep starting a host that exits with an error beside the owner.
    process.exit(level === 'login' ? 0 : HOST_ALREADY_RUNNING);
  }
  note(`service host could not open: ${error.message}`);
  process.exit(1);
});
