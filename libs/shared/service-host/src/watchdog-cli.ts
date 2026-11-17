import { callHost } from './cli-host';
import type { CliContext, CliIo } from './service-cli';
import { WatchdogSettings } from './watchdog-settings';

export const WATCHDOG_USAGE = `Backend watchdog (off by default):
  pi-kit watchdog status    Show whether automatic backend recovery is enabled
  pi-kit watchdog enable    Enable health checks and automatic crash recovery for this profile
  pi-kit watchdog disable   Disable them without stopping a running backend
`;

/** Applies online through the host; offline it remembers the preference for the next start. */
export async function runWatchdogCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  const command = args[0] ?? 'status';
  if (args.length > 1 || !['status', 'enable', 'disable'].includes(command)) {
    io.err(WATCHDOG_USAGE);
    return 2;
  }
  let enabled: boolean;
  const running = !!ctx.discover();
  if (running) {
    const settings = await callHost<{ enabled: boolean }>(
      ctx,
      command === 'status' ? 'watchdog.status' : 'watchdog.set',
      command === 'status' ? undefined : command === 'enable',
    );
    enabled = settings.enabled;
  } else {
    enabled = command === 'status' ? WatchdogSettings.read(ctx.dataDir) : command === 'enable';
    if (command !== 'status') WatchdogSettings.write(ctx.dataDir, enabled);
  }
  io.out(`Backend watchdog: ${enabled ? 'enabled' : 'disabled'}${running ? '' : ' (applies when the host starts)'}\n`);
  return 0;
}
