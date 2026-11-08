import type { HostDiscovery } from './discovery';
import type { CliContext } from './service-cli';

const WAIT_MS = 60_000;

/** One call to the host that owns the data folder, as a command makes it; a clear error when none runs. */
export async function callHost<T>(ctx: CliContext, method: string, params?: unknown): Promise<T> {
  const host = ctx.discover();
  if (!host) throw new Error('the service is not running here; start it with "pi-kit service start".');
  const peer = await ctx.connect(host);
  try {
    return await peer.call<T>(method, params);
  } finally {
    peer.close();
  }
}

/** `find`'s first answer, polled for a minute at most. */
export async function waitFor<T>(ctx: Pick<CliContext, 'sleep'>, find: () => T | undefined): Promise<T | undefined> {
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
