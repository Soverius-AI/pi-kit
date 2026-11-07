import type { HostDiscovery } from './discovery';
import type { RpcPeer } from './host-channel';
import type { HostStatus } from './host-protocol';
import type { ServiceManager } from './service-registration';

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CliContext {
  version: string;
  serviceName: string;
  logDir: string;
  manager: ServiceManager | undefined;
  /** The live host that owns the data folder, if one does. */
  discover(): HostDiscovery | undefined;
  connect(host: HostDiscovery): Promise<RpcPeer>;
  /** The last `lines` lines of a log file, or undefined when there is none. */
  tail(file: string, lines: number): string | undefined;
  sleep(ms: number): Promise<void>;
}

/** `status` exits with 3 when nothing runs, like `systemctl is-active` and LSB init scripts, so scripts can tell. */
export const NOT_RUNNING = 3;
const WAIT_MS = 60_000;

const USAGE = `Usage: pi-kit service <command>

Service commands (include "service" before the command):
  pi-kit service status     Whether the background service is installed and running (exit code 3: not running)
  pi-kit service install    Start pi-kit's backend at sign-in, and now
  pi-kit service uninstall  Stop it and no longer start it at sign-in
  pi-kit service start      Start it now
  pi-kit service stop       Stop it until the next sign-in or start
  pi-kit service restart    Stop it and start it again
  pi-kit service logs       Print the end of service.log and where the logs are

For example, use "pi-kit service logs", not "pi-kit logs".

pi-kit's backend runs as a service of this computer, so background agents and phone access keep working when the
pi-kit window is closed. Settings › General › Background in the app does the same as install and uninstall.
`;

/** `pi-kit service …`: the background service from a terminal, also over SSH. Returns the exit code. */
export async function runServiceCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  const [group, command, ...rest] = args;
  if (group === '--version' || group === '-v') {
    io.out(`pi-kit ${ctx.version}\n`);
    return 0;
  }
  const help = (word: string | undefined) => word === undefined || word === 'help' || word === '--help';
  if (help(group) || (group === 'service' && help(command))) {
    io.out(USAGE);
    return 0;
  }
  if (group !== 'service' || rest.length > 0) {
    io.err(USAGE);
    return 2;
  }
  try {
    switch (command) {
      case 'status':
        return await status(io, ctx);
      case 'install':
        return await install(io, ctx);
      case 'uninstall':
        return await uninstall(io, ctx);
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
    io.err(`pi-kit: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
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
  const manager = await supported(io, ctx);
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

async function status(io: CliIo, ctx: CliContext): Promise<number> {
  const installed = ctx.manager?.installed() ?? false;
  io.out(`Background service: ${installed ? `installed (${ctx.serviceName})` : 'not installed'}\n`);
  const host = ctx.discover();
  if (!host) {
    io.out('Host: not running\n');
    return NOT_RUNNING;
  }
  const owner = host.level === 'login' ? 'the background service' : 'the pi-kit app';
  io.out(`Host: running, pid ${host.pid}, run by ${owner}, version ${host.version}, since ${host.startedAt}\n`);
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

async function waitFor<T>(ctx: Pick<CliContext, 'sleep'>, find: () => T | undefined): Promise<T | undefined> {
  for (let waited = 0; waited < WAIT_MS; waited += 200) {
    const found = find();
    if (found) return found;
    await ctx.sleep(200);
  }
  return undefined;
}

/** Asks the host that owns the folder to stop and waits, a minute at most, until it has. */
export async function stopHost(
  ctx: Pick<CliContext, 'connect' | 'discover' | 'sleep'>,
  host: HostDiscovery,
): Promise<boolean> {
  const peer = await ctx.connect(host);
  await peer.call('stop').catch(() => undefined);
  peer.close();
  return !!(await waitFor(ctx, () => (ctx.discover()?.pid === host.pid ? undefined : true)));
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

async function install(io: CliIo, ctx: CliContext): Promise<number> {
  const manager = await supported(io, ctx);
  if (!manager) return 1;
  const changed = await manager.install();
  io.out(changed ? 'Installed: the backend now starts when you sign in.\n' : 'Already installed.\n');
  return reportStarted(io, await waitFor(ctx, () => ctx.discover()));
}

async function uninstall(io: CliIo, ctx: CliContext): Promise<number> {
  const manager = await supported(io, ctx);
  if (!manager) return 1;
  const host = ctx.discover();
  if (host?.level === 'login') await stopHost(ctx, host);
  await manager.uninstall();
  io.out('Uninstalled: the backend no longer starts at sign-in, and runs only while the pi-kit app is open.\n');
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
  io.out('Stopped. It starts again at the next sign-in, or with `pi-kit service start`.\n');
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
