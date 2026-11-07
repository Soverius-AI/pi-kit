import {
  type PeerManager,
  peersApprove,
  peersConnect,
  peersInvite,
  peersList,
  peersReject,
  peersUnpair,
} from '@pi-kit/api/generated';
import type { BackendEndpoint } from './backend';
import { FileWrappingKeys, instanceKeyFile } from './instance-key-sealing';
import type { CliContext, CliIo } from './service-cli';

export const PEERS_USAGE = `Instance commands (include "peers" before the command):
  pi-kit peers                      This instance, its paired instances and the requests waiting for you
  pi-kit peers invite               A short-lived invitation for another pi-kit instance
  pi-kit peers connect              Pair with the instance whose invitation you paste
  pi-kit peers approve <pair-id>    Approve a request once its confirmation code matches the other side
                                    (--allow-relay also lets this instance's approved phones reach the other one)
  pi-kit peers reject <pair-id>     Reject a request
  pi-kit peers unpair <peer-id>     Stop a pairing
  pi-kit peers key-file --yes       Seal the instance key with an owner-only file, for machines without a keychain
`;

/** `pi-kit peers …`: instance-to-instance pairing (ADR-0035) through the backend's own routes. */
export async function runPeersCli(args: string[], io: CliIo, ctx: CliContext): Promise<number> {
  const [command = 'list', ...rest] = args;
  const flags = rest.filter((arg) => arg.startsWith('--'));
  const [target, extra] = rest.filter((arg) => !arg.startsWith('--'));
  const allowRelay = flags.includes('--allow-relay');
  const unknown = flags.filter((flag) => !['--allow-relay', '--yes'].includes(flag));
  if (unknown.length > 0 || extra !== undefined) {
    io.err(`pi-kit: unexpected ${unknown[0] ?? extra}.\n\n${PEERS_USAGE}`);
    return 2;
  }
  if (command === 'key-file') return keyFile(io, ctx, flags.includes('--yes'));
  const needsTarget = ['approve', 'reject', 'unpair'].includes(command);
  if (needsTarget !== (target !== undefined) || !COMMANDS.includes(command)) {
    io.err(`${COMMANDS.includes(command) ? '' : `pi-kit: unknown command "peers ${command}".\n\n`}${PEERS_USAGE}`);
    return 2;
  }
  const id = target ?? '';
  const auth = await backend(ctx);
  const call = { baseUrl: auth.url, auth: auth.token, throwOnError: true } as const;
  switch (command) {
    case 'list':
      print(io, (await peersList(call)).data);
      return 0;
    case 'invite': {
      const { invitation, expiresAt } = (await peersInvite(call)).data;
      io.out(`${invitation}\n`);
      io.err(
        `Valid for ${minutes(expiresAt)}. On the other instance run "pi-kit peers connect" and paste it; it is a secret until then.\n`,
      );
      return 0;
    }
    case 'connect': {
      const invitation = (await io.readLine?.('Invitation: '))?.trim();
      if (!invitation) {
        io.err('pi-kit: paste the invitation from "pi-kit peers invite" on the other instance.\n');
        return 2;
      }
      const manager = (await peersConnect({ ...call, body: { invitation, allowRelay } })).data;
      print(io, manager);
      io.out('Compare the confirmation code with the other instance, where its owner approves it.\n');
      return 0;
    }
    case 'approve':
      print(io, (await peersApprove({ ...call, path: { pairId: id }, body: { allowRelay } })).data);
      return 0;
    case 'reject':
      print(io, (await peersReject({ ...call, path: { pairId: id } })).data);
      return 0;
    default:
      print(io, (await peersUnpair({ ...call, path: { peerId: id } })).data);
      return 0;
  }
}

const COMMANDS = ['list', 'invite', 'connect', 'approve', 'reject', 'unpair'];

async function backend(ctx: CliContext): Promise<BackendEndpoint> {
  const host = ctx.discover();
  if (!host) throw new Error('the service is not running here; start it with "pi-kit service start".');
  const peer = await ctx.connect(host);
  try {
    return await peer.call<BackendEndpoint>('backend');
  } finally {
    peer.close();
  }
}

async function keyFile(io: CliIo, ctx: CliContext, consent: boolean): Promise<number> {
  const path = instanceKeyFile(ctx.dataDir);
  const meaning =
    `The instance key would then be sealed with ${path}, readable only by you. Like an SSH key, those permissions\n` +
    'are its only protection, so use it only where no keychain works (a server without a Secret Service, a Mac\n' +
    'nobody signs in to). A new instance key is sealed with it; an existing one keeps its seal.\n';
  if (!consent) {
    io.err(`${meaning}Run "pi-kit peers key-file --yes" to turn it on.\n`);
    return 2;
  }
  await new FileWrappingKeys(path).create();
  io.out(`On: ${path}\n`);
  return 0;
}

function print(io: CliIo, manager: PeerManager): void {
  io.out(`This instance: ${manager.self.name} (${manager.self.instanceId})\n`);
  if (!manager.keyInitialized) io.out('Instance key: made at the first invitation or connection\n');
  for (const peer of manager.peers)
    io.out(
      `Peer ${peer.name}: ${peer.state}${peer.unpairPending ? ', unpairing' : ''}, ${peer.origin}, id ${peer.peerId}` +
        `${peer.confirmationCode ? `, code ${peer.confirmationCode}` : ''}${peer.allowRelay ? ', phones relay' : ''}\n`,
    );
  for (const request of manager.requests)
    io.out(
      `Request from ${request.name} at ${request.origin}: code ${request.confirmationCode}, ` +
        `pair id ${request.pairId}, ${minutes(request.expiresAt)} left\n`,
    );
}

const minutes = (expiresAt: number): string => `${Math.max(1, Math.round((expiresAt - Date.now()) / 60_000))} min`;
