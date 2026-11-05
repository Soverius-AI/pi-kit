// The service host: plain Node on the Electron binary (ELECTRON_RUN_AS_NODE), never Electron's own APIs (ADR-0036).
import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import {
  allocateEndpoint,
  FileLog,
  HOST_ALREADY_RUNNING,
  HostAlreadyRunningError,
  hostConfigFromEnv,
  hostSocketPath,
  launchForWatchdog,
  listenHostChannel,
  pingHealth,
  CommandSleepGuard,
  RemoteAccess,
  RemoteAccessStores,
  removeDiscovery,
  ServiceHost,
  sleepCommand,
  spawnBackend,
  writeDiscovery,
} from '@pi-kit/service-host';

const { rendererRoot, level, ...config } = hostConfigFromEnv(process.env, __dirname);
const logDir = process.env['PI_KIT_LOG_DIR'];
const serviceLog = logDir ? new FileLog(logDir, 'service.log') : undefined;
const backendLog = logDir ? new FileLog(logDir, 'backend.log') : undefined;
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
const host: ServiceHost = new ServiceHost(config, {
  allocate: allocateEndpoint,
  spawn: spawnBackend,
  launch: launchForWatchdog,
  ping: pingHealth,
  output: (chunk, stream) => {
    backendLog?.write(chunk.toString());
    // A host the operating system runs has no terminal; backend.log has it all.
    if (level === 'app') (stream === 'stderr' ? process.stderr : process.stdout).write(chunk);
  },
  log: (line) => serviceLog?.line(line),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  now: () => Date.now(),
  exit: (code) => process.exit(code),
  remote,
  restoreRemote: process.env['PI_KIT_SMOKE'] !== '1',
  sleepGuard: new CommandSleepGuard(sleepCommand(process.platform, process.pid), (line) => serviceLog?.line(line)),
});

// A host the desktop app or its Windows supervisor started ends with it: the IPC channel closes when that process goes.
if (process.send) process.on('disconnect', () => void host.stop());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void host.stop());

void (async () => {
  serviceLog?.line(`service host ${config.version} (${level}) started, pid ${process.pid}`);
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
  serviceLog?.line(`listening on ${socket}`);
  // Nobody is there to ask for the first start: agents, schedules and phones need the backend now. A failure waits for a desktop.
  if (level === 'login')
    void host.start().catch((error: Error) => serviceLog?.line(`backend did not start: ${error.message}`));
})().catch((error: Error) => {
  if (error instanceof HostAlreadyRunningError) {
    serviceLog?.line(error.message);
    // A service manager would keep starting a host that exits with an error beside the owner.
    process.exit(level === 'login' ? 0 : HOST_ALREADY_RUNNING);
  }
  serviceLog?.line(`service host could not open: ${error.message}`);
  process.exit(1);
});
