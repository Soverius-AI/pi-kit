import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type HostDiscovery, isNewerVersion } from './discovery';
import type { RpcPeer } from './host-channel';
import { stopHost, waitFor } from './cli-host';
import { HOST_ALREADY_RUNNING } from './host-process';
import type { HostStatus } from './host-protocol';
import { OPEN_USAGE, runOpenCli } from './open-cli';
import { PEERS_USAGE, runPeersCli } from './peers-cli';
import { bundledVersion } from './service-host';
import { REMOTE_USAGE, runDevicesCli, runPairCli, runRemoteCli } from './remote-cli';
import type { ServiceManager } from './service-registration';
import { installOf } from './service-spec';
import { DESKTOP_USAGE, type DesktopApp, runDesktopCli } from './desktop-cli';
import { runLoginCli, runLogoutCli, runModelCli, SETTINGS_USAGE } from './settings-cli';
import { type FinishPlan, runUpdateCli, UPDATE_USAGE } from './update-cli';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  /** One line from the terminal or stdin, for input that must not be a command argument. */
  readLine?(prompt: string): Promise<string | undefined>;
  /** One line from the terminal without echo, for keys and pasted codes. */
  readSecret?(prompt: string): Promise<string | undefined>;
  /** A person at a terminal can answer questions; otherwise commands print what to run instead of asking. */
  interactive?: boolean;
}

export interface CliContext {
  version: string;
  serviceName: string;
  dataDir: string;
  logDir: string;
  manager: ServiceManager | undefined;
  /** macOS's registration for starting at boot with nobody signed in (a LaunchDaemon); elsewhere `manager` covers boot. */
  bootManager?: ServiceManager;
  /** The live host that owns the data folder, if one does. */
  discover(): HostDiscovery | undefined;
  connect(host: HostDiscovery): Promise<RpcPeer>;
  /** The last `lines` lines of a log file, or undefined when there is none. */
  tail(file: string, lines: number): string | undefined;
  sleep(ms: number): Promise<void>;
  /** Opens a URL in this computer's browser; false where there is none to open (SSH, no display). */
  openUrl?(url: string): boolean;
  /** Runs the host in this process until it stops (`pi-kit serve`). */
  serve?(): Promise<number>;
  /** Another install the service registration starts, with its version (`otherInstall`). */
  otherInstall?(): { entry: string; version: string } | undefined;
  /** This server install (a tarball with its own runtime): where it is, its version, target and release feed. */
  /** `npm`: the npm package that installed it, which npm updates instead of `pi-kit update`. */
  serverInstall?: { root: string; version: string; target: string; releases: string; npm?: string };
  /** Windows: starts the finisher that swaps the install once this command has exited (`pi-kit update`). */
  startFinisher?: (plan: FinishPlan) => void;
  /** A server install: makes `pi-kit` reachable from new terminals unless one already is, and says what it did. */
  putOnPath?: () => string | undefined;
  /** The pi-kit app on this computer: where it is installed, how to install it, how to start it. */
  desktop?: DesktopApp;
  /** npm on this computer, for an install npm made. */
  npm?: {
    /** The version the registry serves for a spec (a name for its latest), or undefined when it serves none. */
    view(spec: string): string | undefined;
    /** Installs a spec globally under `prefix`, npm's output in this terminal; false when npm failed. */
    install(prefix: string, spec: string): boolean;
  };
}

const GROUPS: Record<string, (args: string[], io: CliIo, ctx: CliContext) => Promise<number>> = {
  desktop: runDesktopCli,
  devices: runDevicesCli,
  login: runLoginCli,
  logout: runLogoutCli,
  model: runModelCli,
  open: runOpenCli,
  pair: runPairCli,
  peers: runPeersCli,
  remote: runRemoteCli,
  serve,
  update: runUpdateCli,
};

/** `status` exits with 3 when nothing runs, like `systemctl is-active` and LSB init scripts, so scripts can tell. */
export const NOT_RUNNING = 3;

const USAGE = `Usage: pi-kit <command>. On a server, the setup is: service install (or serve), login, remote enable, pair.

Service commands (include "service" before the command):
  pi-kit service status     Whether the background service is installed and running (exit code 3: not running;
                            --json for scripts)
  pi-kit service install    Start pi-kit's backend at sign-in, and now (--level boot: at boot, with nobody signed in)
  pi-kit service uninstall  Stop it and no longer start it at sign-in
  pi-kit service start      Start it now
  pi-kit service stop       Stop it until the next sign-in or start
  pi-kit service restart    Stop it and start it again
  pi-kit service logs       Print the end of service.log and where the logs are
  pi-kit serve              Run it in this terminal instead, for a container or another supervisor
${UPDATE_USAGE}
For example, use "pi-kit service logs", not "pi-kit logs".

${SETTINGS_USAGE}
${OPEN_USAGE}
${DESKTOP_USAGE}
${REMOTE_USAGE}
${PEERS_USAGE}
pi-kit's backend runs as a service of this computer, so background agents and phone access keep working when the
pi-kit window is closed. Settings › General › Background in the app does the same as install and uninstall.
`;

/** `pi-kit …` from a terminal, also over SSH. Returns the exit code. */
export async function runCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  const [group, command, ...rest] = args;
  if (group === '--version' || group === '-v') {
    io.out(`pi-kit ${ctx.version}\n`);
    return 0;
  }
  const asked = (word: string | undefined) => word === 'help' || word === '--help';
  const run = group !== undefined && Object.hasOwn(GROUPS, group) ? GROUPS[group] : undefined;
  if (
    group === undefined ||
    asked(group) ||
    (group === 'service' && (command === undefined || asked(command))) ||
    (run && asked(command))
  ) {
    io.out(USAGE);
    return 0;
  }
  const json = group === 'service' && command === 'status' && rest.length === 1 && rest[0] === '--json';
  const boot =
    group === 'service' &&
    (command === 'install' || command === 'uninstall') &&
    rest.length === 2 &&
    rest[0] === '--level' &&
    rest[1] === 'boot';
  if (!run && (group !== 'service' || (rest.length > 0 && !json && !boot))) {
    io.err(USAGE);
    return 2;
  }
  try {
    if (run) return await run(args.slice(1), io, ctx);
    switch (command) {
      case 'status':
        return await status(io, ctx, json);
      case 'install':
        return await install(io, ctx, boot);
      case 'uninstall':
        return await uninstall(io, ctx, boot);
      case 'start':
        return await start(io, ctx);
      case 'stop':
        return await stop(io, ctx);
      case 'restart':
        return await restart(io, ctx);
      case 'logs':
        return logs(io, ctx);
      default:
        io.err(`pi-kit: unknown command "${command}".\n\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    io.err(`pi-kit: ${reason(error)}\n`);
    return 1;
  }
}

/** A thrown Error, or the error body a backend route answered with. */
function reason(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' ? message : String(error);
}

async function supported(io: CliIo, ctx: CliContext): Promise<ServiceManager | undefined> {
  if (!ctx.manager) {
    io.err('pi-kit: this system has no supported service manager.\n');
    return undefined;
  }
  const reason = await ctx.manager.unsupported();
  if (reason) {
    io.err(`pi-kit: ${reason}\n`);
    return undefined;
  }
  return ctx.manager;
}

async function installed(io: CliIo, ctx: CliContext): Promise<ServiceManager | undefined> {
  const manager = ctx.bootManager?.installed() ? ctx.bootManager : await supported(io, ctx);
  if (manager && !manager.installed()) {
    io.err('pi-kit: the background service is not installed; run `pi-kit service install`.\n');
    return undefined;
  }
  return manager;
}

async function hostStatus(ctx: CliContext, host: HostDiscovery): Promise<HostStatus | undefined> {
  try {
    const peer = await ctx.connect(host);
    try {
      return await Promise.race([peer.call<HostStatus>('status'), ctx.sleep(5_000).then(() => undefined)]);
    } finally {
      peer.close();
    }
  } catch {
    return undefined;
  }
}

/** With `json`, one object for scripts: `installed`, the `host` discovery without its token, and the host's own status. */
async function status(io: CliIo, ctx: CliContext, json = false): Promise<number> {
  const installed = ctx.manager?.installed() ?? false;
  if (json) {
    const host = ctx.discover();
    const state = host && (await hostStatus(ctx, host));
    const { token: _token, ...running } = host ?? { token: '' };
    io.out(`${JSON.stringify({ installed, ...(host ? { host: running } : {}), ...state })}\n`);
    return !host ? NOT_RUNNING : state ? 0 : 1;
  }
  const atBoot = ctx.bootManager?.installed() ?? false;
  // On Windows each install registers its own way: a desktop's sign-in entry is not a server's task, yet runs the service.
  const registered = ctx.otherInstall?.();
  const registration = atBoot
    ? `installed at boot (${ctx.serviceName})`
    : installed
      ? `installed (${ctx.serviceName})`
      : registered
        ? `installed by another pi-kit (${installOf(registered.entry)})`
        : 'not installed';
  io.out(`Background service: ${registration}\n`);
  const host = ctx.discover();
  if (!host) {
    io.out('Host: not running\n');
    return NOT_RUNNING;
  }
  const owner =
    host.level === 'login' ? 'the background service' : host.level === 'serve' ? '"pi-kit serve"' : 'the pi-kit app';
  io.out(
    `Host: running, pid ${host.pid}, run by ${owner}, version ${host.version}, since ${host.startedAt}` +
      `${host.install ? `, from ${host.install}` : ''}\n`,
  );
  // npm and `pi-kit update` replace an install in place: the running host is then older than its folder. An AppImage's
  // files are not on disk to read.
  const install = host.install && statSync(host.install, { throwIfNoEntry: false })?.isDirectory() ? host.install : '';
  const onDisk = install ? bundledVersion(join(install, 'backend')) : 'unknown';
  if (onDisk !== 'unknown' && onDisk !== host.version)
    io.out(`  ${host.install} now holds ${onDisk}; run "pi-kit service restart" to run it.\n`);
  if (registered && !existsSync(registered.entry))
    io.out(
      `  The registered install (${installOf(registered.entry)}) is gone; run "pi-kit service install" to register this one.\n`,
    );
  const state = await hostStatus(ctx, host);
  if (!state) {
    io.out('Backend: unknown (the host did not answer)\n');
    return 1;
  }
  const backend = [
    state.status.state,
    ...(state.backendPid ? [`pid ${state.backendPid}`] : []),
    ...(state.backendUrl ? [state.backendUrl] : []),
    `restarts: ${state.status.restarts}`,
  ].join(', ');
  io.out(`Backend: ${backend}${state.status.reason ? ` (${state.status.reason})` : ''}\n`);
  io.out(`Desktop: ${state.desktopAttached ? 'attached' : 'not attached'}\n`);
  return 0;
}

function reportStarted(io: CliIo, host: HostDiscovery | undefined): number {
  if (!host) {
    io.err('pi-kit: the service did not start in time; see `pi-kit service logs`.\n');
    return 1;
  }
  if (host.level === 'app') {
    io.out(
      `The pi-kit app is open and runs its own backend (pid ${host.pid}); the service takes over when the app next starts.\n`,
    );
    return 0;
  }
  io.out(`Running, pid ${host.pid}.\n`);
  return 0;
}

async function install(io: CliIo, ctx: CliContext, boot = false): Promise<number> {
  if (boot && ctx.bootManager) return installAtBoot(io, ctx, ctx.bootManager);
  if (ctx.bootManager?.installed()) {
    io.out('Already installed: pi-kit starts at boot on this Mac.\n');
    return 0;
  }
  const manager = await supported(io, ctx);
  if (!manager || newerRegistered(io, ctx)) return 1;
  const changed = await manager.install();
  const when = manager.startsAtBoot ? 'at boot, whether anyone is signed in or not' : 'when you sign in';
  io.out(changed ? `Installed: the backend now starts ${when}.\n` : 'Already installed.\n');
  putOnPath(io, ctx);
  const code = reportStarted(io, await waitFor(ctx, () => ctx.discover()));
  const note = await manager.bootNote?.();
  if (note) io.out(`${note}\n`);
  return code;
}

/** The newest install runs the service: an older one never takes its registration back. */
function newerRegistered(io: CliIo, ctx: CliContext): boolean {
  const other = ctx.otherInstall?.();
  if (!other || !isNewerVersion(other.version, ctx.version)) return false;
  io.err(
    `pi-kit: the service starts a newer install, ${other.version} in ${installOf(other.entry)}; this ${ctx.version} changes nothing.\n`,
  );
  return true;
}

/** A server zip or tarball has no installer to put `pi-kit` on PATH; npm and the desktop app do it themselves. */
function putOnPath(io: CliIo, ctx: CliContext): void {
  const command = ctx.serverInstall ? ctx.putOnPath?.() : undefined;
  if (command) io.out(`${command}\n`);
}

/** macOS: the LaunchDaemon replaces the sign-in LaunchAgent, which goes first so that its host does not keep the folder. */
async function installAtBoot(io: CliIo, ctx: CliContext, daemon: ServiceManager): Promise<number> {
  if (newerRegistered(io, ctx)) return 1;
  const host = ctx.discover();
  if (ctx.manager?.installed()) {
    if (host?.level === 'login') await stopHost(ctx, host);
    await ctx.manager.uninstall();
  }
  io.out(
    (await daemon.install())
      ? 'Installed: the backend now starts at boot, as you, before anyone signs in. The login keychain stays locked then: ' +
          'for instance pairing, run "pi-kit peers key-file --yes".\n'
      : 'Already installed: pi-kit starts at boot on this Mac.\n',
  );
  putOnPath(io, ctx);
  return reportStarted(io, await waitFor(ctx, () => ctx.discover()));
}

async function uninstall(io: CliIo, ctx: CliContext, boot = false): Promise<number> {
  const atBoot = !!ctx.bootManager && (boot || ctx.bootManager.installed());
  const manager = atBoot ? ctx.bootManager : await supported(io, ctx);
  if (!manager) return 1;
  const host = ctx.discover();
  if (host?.level === 'login') await stopHost(ctx, host);
  await manager.uninstall();
  io.out(
    `Uninstalled: the backend no longer starts at ${atBoot ? 'boot' : 'sign-in'}, and runs only while the pi-kit app is open.\n`,
  );
  return 0;
}

async function start(io: CliIo, ctx: CliContext): Promise<number> {
  const manager = await installed(io, ctx);
  if (!manager) return 1;
  const running = ctx.discover();
  if (running) return reportStarted(io, running);
  await manager.start();
  return reportStarted(io, await waitFor(ctx, () => ctx.discover()));
}

async function stop(io: CliIo, ctx: CliContext): Promise<number> {
  const host = ctx.discover();
  if (!host) {
    io.out('Not running.\n');
    return 0;
  }
  if (host.level === 'app') {
    io.err(`pi-kit: the pi-kit app runs this backend (pid ${host.pid}); quit the app to stop it.\n`);
    return 1;
  }
  if (!(await stopHost(ctx, host))) {
    io.err(`pi-kit: the host (pid ${host.pid}) did not stop in time.\n`);
    return 1;
  }
  const atBoot = ctx.bootManager?.installed() || (ctx.manager?.startsAtBoot && ctx.manager.installed());
  io.out(`Stopped. It starts again at the next ${atBoot ? 'boot' : 'sign-in'}, or with \`pi-kit service start\`.\n`);
  return 0;
}

async function restart(io: CliIo, ctx: CliContext): Promise<number> {
  const manager = await installed(io, ctx);
  if (!manager) return 1;
  const before = ctx.discover();
  if (before?.level === 'app') {
    io.err(`pi-kit: the pi-kit app runs this backend (pid ${before.pid}); quit the app first.\n`);
    return 1;
  }
  await manager.restart();
  return reportStarted(
    io,
    await waitFor(ctx, () => {
      const host = ctx.discover();
      return host && host.pid !== before?.pid ? host : undefined;
    }),
  );
}

function logs(io: CliIo, ctx: CliContext): number {
  const text = ctx.tail('service.log', 40);
  if (text) io.out(text.endsWith('\n') ? text : `${text}\n`);
  else io.out('No service.log yet.\n');
  io.out(`\nLogs are in ${ctx.logDir} (service.log, backend.log, main.log).\n`);
  return 0;
}

/** `pi-kit serve`: the host in this terminal, which stops it; refused while another host owns the data folder. */
async function serve(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  if (args.length > 0 || !ctx.serve) {
    io.err(USAGE);
    return 2;
  }
  const running = ctx.discover();
  if (running) {
    io.err(`pi-kit: a host already runs this profile (pid ${running.pid}, version ${running.version}).\n`);
    return HOST_ALREADY_RUNNING;
  }
  return ctx.serve();
}
