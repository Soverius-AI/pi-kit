import type { RemoteAccessPairing, RemoteAccessRequest, RemoteAccessStatus } from '@pi-kit/protocol';
import { toString as qrCode } from 'qrcode';
import { callHost } from './cli-host';
import type { CliContext, CliIo } from './service-cli';

export const REMOTE_USAGE = `Phone and tailnet commands:
  pi-kit remote status              Whether this pi-kit is reachable on your tailnet (exit code 3: it is not)
  pi-kit remote enable [--port N]   Publish it on your tailnet with Tailscale Serve (the HTTPS port it used last, else 8443)
  pi-kit remote disable             Stop publishing it
  pi-kit pair                       A pairing link and QR code for a phone; you approve it after comparing codes
  pi-kit devices                    Paired devices and the requests waiting for you
  pi-kit devices approve <request>  Approve a request whose confirmation code matches the device's
  pi-kit devices reject <request>   Reject a request
  pi-kit devices revoke <device>    Sign a paired device out
`;

/** `pi-kit remote …`: Tailscale Serve publication, run by the host (ADR-0035). */
export async function runRemoteCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  const [command = 'status', ...rest] = args;
  if (command === 'status' && rest.length === 0) return report(io, await callHost(ctx, 'remote.status'));
  if (command === 'disable' && rest.length === 0) {
    await callHost(ctx, 'remote.stop');
    io.out('Remote access is off.\n');
    return 0;
  }
  if (command === 'enable') {
    const port = rest[0] === '--port' && rest.length === 2 ? Number(rest[1]) : rest.length === 0 ? undefined : NaN;
    if (Number.isNaN(port)) return usage(io);
    const status = await callHost<RemoteAccessStatus>(ctx, 'remote.start', port);
    const code = report(io, status);
    // Tailscale wants Serve or HTTPS approved for this machine once; the owner opens that link anywhere.
    const approval = code === 0 ? undefined : await callHost<string | undefined>(ctx, 'remote.setupUrl');
    if (approval) io.out(`Approve it in Tailscale: ${approval}\nThen run "pi-kit remote enable" again.\n`);
    return code;
  }
  return usage(io);
}

/** `pi-kit pair`: one pairing link; the owner approves the device that uses it after comparing confirmation codes. */
export async function runPairCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  if (args.length > 0) return usage(io);
  const pairing = await callHost<RemoteAccessPairing>(ctx, 'remote.beginPairing');
  io.out(`${pairing.url}\n`);
  io.err(
    `${await qrCode(pairing.url, { type: 'terminal', small: true })}\nOpen the link on the phone, or scan the code.\n`,
  );
  for (; Date.now() < pairing.expiresAt; await ctx.sleep(1000)) {
    const [request] = (await callHost<RemoteAccessStatus>(ctx, 'remote.status')).requests ?? [];
    if (!request) continue;
    io.out(`${request.name} asks to pair. Its confirmation code is ${request.confirmationCode}.\n`);
    if (!io.interactive) {
      io.out(
        `Compare the code, then run "pi-kit devices approve ${request.id}" or "pi-kit devices reject ${request.id}".\n`,
      );
      return 0;
    }
    const answer = (await io.readLine?.('Does the phone show the same code? Approve it [y/N]: '))?.trim().toLowerCase();
    const approve = answer === 'y' || answer === 'yes';
    await callHost(ctx, approve ? 'remote.approvePairing' : 'remote.rejectPairing', request.id);
    io.out(approve ? `Approved ${request.name}.\n` : `Rejected ${request.name}.\n`);
    return 0;
  }
  io.err('pi-kit: the pairing link expired; run "pi-kit pair" again.\n');
  return 1;
}

/** `pi-kit devices …`: paired devices and pending requests, by their ids. */
export async function runDevicesCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  const [command = 'list', id, ...rest] = args;
  const method = { approve: 'remote.approvePairing', reject: 'remote.rejectPairing', revoke: 'remote.revokeDevice' }[
    command
  ];
  if (command === 'list' && id === undefined) {
    const { devices = [], requests = [] } = await callHost<RemoteAccessStatus>(ctx, 'remote.status');
    for (const device of devices)
      io.out(`Device ${device.name}: id ${device.id}, last seen ${new Date(device.lastSeenAt).toISOString()}\n`);
    for (const request of requests) io.out(waiting(request));
    if (!devices.length && !requests.length) io.out('No paired devices.\n');
    return 0;
  }
  if (!method || id === undefined || rest.length > 0) return usage(io);
  await callHost(ctx, method, id);
  io.out(`${command === 'approve' ? 'Approved' : command === 'reject' ? 'Rejected' : 'Revoked'} ${id}.\n`);
  return 0;
}

function report(io: CliIo, status: RemoteAccessStatus): number {
  const serving = status.state === 'serving';
  io.out(`Remote access: ${status.state}${serving && status.url ? ` at ${status.url}` : ''}\n`);
  if (status.message) io.out(`${status.message}\n`);
  return serving ? 0 : 3;
}

const waiting = (request: RemoteAccessRequest) =>
  `Request from ${request.name}: id ${request.id}, confirmation code ${request.confirmationCode}\n`;

function usage(io: CliIo): number {
  io.err(REMOTE_USAGE);
  return 2;
}
