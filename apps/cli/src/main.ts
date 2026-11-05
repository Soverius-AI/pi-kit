import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  appFolders,
  connectHostChannel,
  type HostDiscovery,
  bundledVersion,
  loginShellPath,
  liveDiscovery,
  runServiceCli,
  stopHost,
  serviceManager,
  serviceName,
  SUPERVISOR_FLAG,
} from '@pi-kit/service-host';

// pi-kit: the background service from a terminal, on the app's binary run as Node.

// A script run directly has its path in argv[1]; loaded with `-e` (the AppImage launcher) it has not.
const args = require.main === module ? process.argv.slice(2) : process.argv.slice(1);

// Packaged, this bundle sits beside the host in Resources/backend; in a checkout it is dist/apps/cli.
const packaged = existsSync(join(__dirname, 'service-host.cjs'));
const hostEntry = packaged ? join(__dirname, 'service-host.cjs') : join(__dirname, '..', 'desktop', 'service-host.cjs');
const folders = appFolders();
const scratch = process.env['PI_KIT_DATA_DIR'];
const dataDir = scratch || folders.dataDir;
const logDir = process.env['PI_KIT_LOG_DIR'] || (scratch ? join(dataDir, 'logs') : folders.logDir);
const version = packaged
  ? bundledVersion(__dirname)
  : `${process.versions['electron'] ?? process.versions.node} (development)`;
const name = serviceName(dataDir, packaged && !scratch && !process.env['PI_KIT_SMOKE']);
const path = (packaged ? loginShellPath() : undefined) ?? process.env['PATH'];

const discover = (): HostDiscovery | undefined => liveDiscovery(dataDir);
const connect = (host: HostDiscovery) => connectHostChannel(host.socket, host.token);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const manager = serviceManager({
  name,
  program: process.execPath,
  hostEntry,
  dataDir,
  logDir,
  ...(path ? { path } : {}),
  ...(process.env['APPIMAGE'] ? { appImage: process.env['APPIMAGE'] } : {}),
  ...(packaged
    ? {}
    : {
        // A development desktop started by `pnpm dev` names its dev server as the origin instead.
        devEnv: {
          PI_KIT_BACKEND_ENTRY: join(__dirname, '..', 'backend', 'main.js'),
          PI_KIT_ORIGIN: 'app://pi-kit',
          PI_KIT_VERSION: process.versions['electron'] ?? 'development',
          PI_KIT_RENDERER_ROOT: join(__dirname, '..', 'renderer', 'browser'),
        },
      }),
  supervisorArgs: packaged ? [SUPERVISOR_FLAG] : [join(__dirname, '..', 'desktop', 'main.cjs'), SUPERVISOR_FLAG],
  stopHost: async () => {
    const host = discover();
    if (host) await stopHost({ connect, discover, sleep }, host);
  },
});

void runServiceCli(
  args,
  { out: (text) => void process.stdout.write(text), err: (text) => void process.stderr.write(text) },
  {
    version,
    serviceName: name,
    logDir,
    manager,
    discover,
    connect,
    tail: (file, lines) => {
      const at = join(logDir, file);
      if (!existsSync(at)) return undefined;
      return readFileSync(at, 'utf8')
        .split('\n')
        .slice(-lines - 1)
        .join('\n');
    },
    sleep,
  },
).then((code) => process.exit(code));
