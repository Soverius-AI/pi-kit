import { callHost } from './cli-host';
import type { CliContext, CliIo } from './service-cli';

export const OPEN_USAGE = `Browser commands:
  pi-kit open                       Open pi-kit in this computer's browser with a one-time link (over SSH it prints it)
  pi-kit open --revoke              Sign out every browser "pi-kit open" signed in
`;

/** `pi-kit open`: the owner's browser door, through a one-time link the host makes. */
export async function runOpenCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  const unexpected = args.find((arg) => arg !== '--revoke');
  if (unexpected !== undefined) {
    io.err(`pi-kit: unexpected ${unexpected}.\n\n${OPEN_USAGE}`);
    return 2;
  }
  if (args.includes('--revoke')) {
    await callHost(ctx, 'owner.revoke');
    io.out('Every browser is signed out.\n');
    return 0;
  }
  const { url } = await callHost<{ url: string }>(ctx, 'owner.link');
  io.out(`${url}\n`);
  if (ctx.openUrl?.(url)) io.err('Opened in your browser. The link works once, within two minutes.\n');
  else {
    const port = new URL(url).port;
    io.err(
      `Open the link within two minutes; it works once. From another computer, forward the port first:\n` +
        `  ssh -L ${port}:127.0.0.1:${port} <this computer>\n`,
    );
  }
  return 0;
}
