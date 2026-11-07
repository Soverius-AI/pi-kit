import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import {
  appFolders,
  connectHostChannel,
  type HostDiscovery,
  bundledVersion,
  loginShellPath,
  liveDiscovery,
  otherInstall,
  runCli,
  stopHost,
  serviceManager,
  serviceName,
  SUPERVISOR_FLAG,
} from '@pi-kit/service-host';

// pi-kit from a terminal: on the desktop app's binary run as Node, or on a server install's own Node runtime.

// A script run directly has its path in argv[1]; loaded with `-e` (the AppImage launcher) it has not.
const args = require.main === module ? process.argv.slice(2) : process.argv.slice(1);

// Packaged (the app's Resources/backend, a server install's backend/), this bundle sits beside the host; in a checkout it is dist/apps/cli.
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

// A checkout names what a packaged host finds beside itself; a development desktop started by `pnpm dev` names its dev server as the origin instead.
const devEnv: Record<string, string> | undefined = packaged
  ? undefined
  : {
      PI_KIT_BACKEND_ENTRY: join(__dirname, '..', 'backend', 'main.js'),
      PI_KIT_ORIGIN: 'app://pi-kit',
      PI_KIT_VERSION: process.versions['electron'] ?? 'development',
      PI_KIT_RENDERER_ROOT: join(__dirname, '..', 'renderer', 'browser'),
    };

/** A server install carries its runtime beside the backend; its package.json names its version and release feed. */
function serverInstall(): { root: string; version: string; target: string; releases: string } | undefined {
  const root = join(__dirname, '..');
  if (!packaged || !existsSync(join(root, 'runtime'))) return undefined;
  const { version: installed, releases } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version?: unknown;
    releases?: unknown;
  };
  if (typeof installed !== 'string' || typeof releases !== 'string') return undefined;
  return { root, version: installed, target: `${process.platform}-${process.arch}`, releases };
}

const discover = (): HostDiscovery | undefined => liveDiscovery(dataDir);
const connect = (host: HostDiscovery) => connectHostChannel(host.socket, host.token);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Windows registration starts the desktop app's windowless supervisor, which a server install's Node runtime does not have.
const manager =
  process.platform === 'win32' && !process.versions['electron']
    ? undefined
    : serviceManager({
        name,
        program: process.execPath,
        hostEntry,
        dataDir,
        logDir,
        ...(path ? { path } : {}),
        ...(process.env['APPIMAGE'] ? { appImage: process.env['APPIMAGE'] } : {}),
        ...(devEnv ? { devEnv } : {}),
        supervisorArgs: packaged ? [SUPERVISOR_FLAG] : [join(__dirname, '..', 'desktop', 'main.cjs'), SUPERVISOR_FLAG],
        stopHost: async () => {
          const host = discover();
          if (host) await stopHost({ connect, discover, sleep }, host);
        },
      });

/** A line from the terminal (the prompt on stderr, so stdout stays data) or from piped stdin. */
async function readLine(prompt: string): Promise<string | undefined> {
  const reader = createInterface({ input: process.stdin, terminal: false });
  if (process.stdin.isTTY) process.stderr.write(prompt);
  try {
    for await (const line of reader) return line;
    return undefined;
  } finally {
    reader.close();
  }
}

/** A line typed without echo, for keys and pasted codes; Ctrl+C gives none. Piped stdin is read as a plain line. */
async function readSecret(prompt: string): Promise<string | undefined> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readLine(prompt);
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let value = '';
    const done = (result: string | undefined) => {
      stdin.off('data', typed);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      resolve(result);
    };
    const typed = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done(value);
        if (char === '\u0003') return done(undefined);
        value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char;
      }
    };
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.on('data', typed);
    stdin.resume();
  });
}

/** `pi-kit serve`: the host in this process, with the environment a registered service gives it; it stops on SIGINT or SIGTERM. */
function serve(): Promise<number> {
  Object.assign(process.env, {
    PI_KIT_DATA_DIR: dataDir,
    PI_KIT_LOG_DIR: logDir,
    PI_KIT_SERVICE_LEVEL: 'serve',
    ...(path ? { PATH: path } : {}),
    ...devEnv,
  });
  createRequire(__filename)(hostEntry);
  return new Promise<number>(() => undefined);
}

/** This computer's browser, unless the command runs over SSH or without a display. */
function openUrl(url: string): boolean {
  if (process.env['SSH_CONNECTION'] || process.env['SSH_TTY']) return false;
  const opener: [string, string[]] | undefined =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : process.env['DISPLAY'] || process.env['WAYLAND_DISPLAY']
          ? ['xdg-open', [url]]
          : undefined;
  if (!opener) return false;
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' })
    .on('error', () => undefined)
    .unref();
  return true;
}

void runCli(
  args,
  {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    readLine,
    readSecret,
    interactive: !!process.stdin.isTTY,
  },
  {
    version,
    serviceName: name,
    dataDir,
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
    openUrl,
    serve,
    otherInstall: () => (manager ? otherInstall(manager, hostEntry) : undefined),
    ...(serverInstall() ? { serverInstall: serverInstall() } : {}),
  },
).then((code) => process.exit(code));
