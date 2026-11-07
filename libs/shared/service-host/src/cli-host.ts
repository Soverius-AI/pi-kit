import type { CliContext } from './service-cli';

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
