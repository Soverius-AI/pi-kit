import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import {
  appFolders,
  type CliContext,
  FileLog,
  FINISH_UPDATE_FLAG,
  type FinishPlan,
  finishWindowsUpdate,
  removeStagingAfterExit,
  windowsFinishOps,
  connectHostChannel,
  type HostDiscovery,
  bundledVersion,
  loginShellPath,
  liveDiscovery,
  otherInstall,
  ownAppImage,
  runCli,
  stopHost,
  serviceManager,
  serviceName,
  SUPERVISOR_FLAG,
  spawnServiceHost,
  superviseServiceHost,
} from '@pi-kit/service-host';

// pi-kit from a terminal: on the desktop app's binary run as Node, or on a server install's own Node runtime.

// A script run directly has its path in argv[1]; loaded with `-e` (the AppImage launcher) it has not, and gets AppRun's
// --no-sandbox first (APPRUN_NO_SANDBOX).
const args =
  require.main === module
    ? process.argv.slice(2)
    : process.argv.slice(1).filter((arg, i) => i > 0 || arg !== '--no-sandbox');

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
function serverInstall(): CliContext['serverInstall'] {
  const root = join(__dirname, '..');
  if (!packaged || !existsSync(join(root, 'runtime'))) return undefined;
  const {
    version: installed,
    releases,
    npm,
  } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version?: unknown;
    releases?: unknown;
    npm?: unknown;
  };
  if (typeof installed !== 'string' || typeof releases !== 'string') return undefined;
  return {
    root,
    version: installed,
    target: `${process.platform}-${process.arch}`,
    releases,
    ...(typeof npm === 'string' ? { npm } : {}),
  };
}

const discover = (): HostDiscovery | undefined => liveDiscovery(dataDir);
const connect = (host: HostDiscovery) => connectHostChannel(host.socket, host.token);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registration = {
  name,
  program: process.execPath,
  hostEntry,
  dataDir,
  logDir,
  ...(path ? { path } : {}),
  ...(process.env['APPIMAGE'] ? { appImage: process.env['APPIMAGE'] } : {}),
  ...(devEnv ? { devEnv } : {}),
  // A server install's scheduled task runs this bundle as the supervisor; the desktop app's entry runs the app itself.
  supervisorArgs: !process.versions['electron']
    ? [__filename, SUPERVISOR_FLAG]
    : packaged
      ? [SUPERVISOR_FLAG]
      : [join(__dirname, '..', 'desktop', 'main.cjs'), SUPERVISOR_FLAG],
  stopHost: async () => {
    const host = discover();
    if (host) await stopHost({ connect, discover, sleep }, host);
  },
  // On its own Node, a server install registers a scheduled task on Windows, which runs the supervisor below.
  server: !process.versions['electron'],
};
const manager = serviceManager(registration);
const bootManager = process.platform === 'darwin' ? serviceManager({ ...registration, level: 'boot' }) : undefined;

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

/** Whether a `pi-kit` command is already reachable through PATH (npm's, the desktop's, an earlier install's). */
function commandOnPath(): boolean {
  const names = process.platform === 'win32' ? ['pi-kit.cmd', 'pi-kit.exe', 'pi-kit.bat'] : ['pi-kit'];
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .some((dir) => dir && names.some((name) => existsSync(join(dir, name))));
}

/**
 * A server install's `pi-kit` for new terminals: on Windows its bin folder on the user's PATH, elsewhere a link in ~/.local/bin
 * when that folder is on PATH.
 */
function putOnPath(): string | undefined {
  const install = serverInstall();
  // npm puts its own `pi-kit` on PATH, which survives npm's updates; the package's bin folder is npm's to place.
  if (!install || install.npm || commandOnPath()) return undefined;
  const bin = join(install.root, 'bin');
  if (process.platform === 'win32') {
    // The registry value as it is (REG_EXPAND_SZ, %USERPROFILE% entries unexpanded): .NET's SetEnvironmentVariable would
    // write it back expanded as REG_SZ. Setting and clearing a variable through it only announces the change to new shells.
    const script = [
      "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
      "$raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
      "if (($raw -split ';') -notcontains $env:PI_KIT_BIN) {",
      "  $kind = if ($raw) { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }",
      "  $key.SetValue('Path', ((@($raw.TrimEnd(';'), $env:PI_KIT_BIN) | Where-Object { $_ }) -join ';'), $kind)",
      "  [Environment]::SetEnvironmentVariable('PI_KIT_PATH_CHANGED', '1', 'User')",
      "  [Environment]::SetEnvironmentVariable('PI_KIT_PATH_CHANGED', $null, 'User')",
      '}',
    ].join('\n');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, PI_KIT_BIN: bin },
      stdio: 'ignore',
    });
    return `Added ${bin} to your PATH: "pi-kit" works in new terminals.`;
  }
  const dir = join(homedir(), '.local', 'bin');
  const link = join(dir, 'pi-kit');
  if (!(process.env['PATH'] ?? '').split(delimiter).includes(dir) || existsSync(link))
    return `To run "pi-kit" from anywhere, add ${bin} to your PATH.`;
  mkdirSync(dir, { recursive: true });
  symlinkSync(join(bin, 'pi-kit'), link);
  return `Linked ${link} to this install: "pi-kit" works from anywhere.`;
}

/**
 * Copies this runtime and bundle beside the download and starts them as the finisher. Through WMI, so that it leaves this
 * session's job object: Windows OpenSSH ends every process of a session that closes, which could stop the finisher halfway.
 */
function startFinisher(plan: FinishPlan): void {
  const dir = join(plan.staging, 'finisher');
  mkdirSync(dir);
  const node = join(dir, 'node.exe');
  const script = join(dir, 'pi-kit.cjs');
  const planFile = join(dir, 'plan.json');
  copyFileSync(process.execPath, node);
  copyFileSync(__filename, script);
  writeFileSync(planFile, JSON.stringify(plan));
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:PI_KIT_FINISHER }; exit $r.ReturnValue',
    ],
    {
      env: { ...process.env, PI_KIT_FINISHER: `"${node}" "${script}" ${FINISH_UPDATE_FLAG} "${planFile}"` },
      stdio: 'ignore',
    },
  );
}

if (args[0] === FINISH_UPDATE_FLAG) {
  const plan = JSON.parse(readFileSync(args[1] ?? '', 'utf8')) as FinishPlan;
  void finishWindowsUpdate(plan, windowsFinishOps(plan)).then((updated) => {
    removeStagingAfterExit(plan);
    process.exit(updated ? 0 : 1);
  });
} else if (args[0] === SUPERVISOR_FLAG) {
  const log = new FileLog(logDir, 'supervisor.log');
  log.line(`pi-kit ${version} supervising the service host`);
  void superviseServiceHost(
    () => spawnServiceHost(hostEntry, { ...process.env, PI_KIT_SERVICE_LEVEL: 'login' }),
    (line) => log.line(line),
  ).then(() => process.exit(0));
} else
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
      ...(bootManager ? { bootManager } : {}),
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
      otherInstall: () => (manager ? otherInstall(manager, ownAppImage(__dirname) ?? hostEntry) : undefined),
      ...(serverInstall() ? { serverInstall: serverInstall() } : {}),
      ...(process.platform === 'win32' ? { startFinisher } : {}),
      putOnPath,
    },
  ).then((code) => process.exit(code));
