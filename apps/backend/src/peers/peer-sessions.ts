import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PeerChallengeSchema, PeerSessionRequestSchema, PeerSessionSchema } from '@pi-kit/protocol';
import { randomUUID } from 'node:crypto';
import { InstanceRepository } from '../db/instance.repository';
import { PeersRepository, type PeerRecord } from '../db/peers.repository';
import { PeerHttp } from './peer-http';
import { PeerProofs } from './peer-proofs';

type Session = { peerId: string; pairId: string; revision: number; relay: boolean; actor?: string; expiresAt: number };
type Outbound = { peerId: string; token: string; expiresAt: number };

/** Short-lived sessions between mutually paired instances, in both directions; every one is bound to the grant revision it was opened under. */
@Injectable()
export class PeerSessions implements OnModuleDestroy {
  readonly bootId = randomUUID();
  private readonly challenges = new Map<string, { peerId: string; expiresAt: number }>();
  private readonly sessions = new Map<string, Session>();
  private readonly outbound = new Map<string, Outbound>();
  private readonly opening = new Map<string, Promise<string>>();
  private readonly streams = new Map<string, Set<() => void>>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly instances: InstanceRepository,
    private readonly peers: PeersRepository,
    private readonly network: PeerHttp,
    private readonly proofs: PeerProofs,
  ) {
    this.timer = setInterval(() => this.expire(), 10000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    for (const callbacks of this.streams.values()) for (const abort of callbacks) abort();
    this.streams.clear();
    this.sessions.clear();
    this.outbound.clear();
    this.challenges.clear();
  }

  async active(peerId: string): Promise<PeerRecord> {
    const peer = await this.peers.get(peerId);
    if (!peer || peer.state !== 'active') throw new ForbiddenException('Instance is not mutually paired.');
    return peer;
  }

  async canDevice(deviceId: string, peer: PeerRecord): Promise<boolean> {
    return (
      peer.state === 'active' &&
      peer.remoteAllowRelay &&
      peer.shareDevices &&
      (await this.peers.deviceAllowed(deviceId, peer.identity.instanceId))
    );
  }

  async target(peerId: string, deviceId?: string): Promise<PeerRecord> {
    const peer = await this.active(peerId);
    if (deviceId && !(await this.canDevice(deviceId, peer)))
      throw new ForbiddenException('This device may not use that environment.');
    return peer;
  }

  async challenge(peerId: string): Promise<{ nonce: string; bootId: string; expiresAt: number }> {
    await this.active(peerId);
    this.expire();
    if (this.challenges.size >= 500) throw new BadRequestException('Challenge limit reached.');
    const nonce = PeerProofs.secret(),
      expiresAt = Date.now() + 30000;
    this.challenges.set(nonce, { peerId, expiresAt });
    return { nonce, bootId: this.bootId, expiresAt };
  }

  async session(value: unknown): Promise<unknown> {
    this.expire();
    if (this.sessions.size >= 1024) throw new ServiceUnavailableException('Peer session limit reached.');
    const input = PeerSessionRequestSchema.parse(value),
      peer = await this.active(input.peerId);
    const challenge = this.challenges.get(input.nonce);
    if (
      !challenge ||
      challenge.peerId !== input.peerId ||
      challenge.expiresAt <= Date.now() ||
      (input.relay && !peer.allowRelay)
    )
      throw new UnauthorizedException('Peer session unavailable.');
    const claims = await this.proofs.verify(
      peer.identity,
      input.proof,
      'session',
      input.nonce,
      PeerProofs.digest(input.relay, input.actor ?? ''),
      this.bootId,
    );
    if (claims.relay !== input.relay || !this.challenges.delete(input.nonce))
      throw new UnauthorizedException('Challenge already used.');
    const token = PeerProofs.secret(),
      expiresAt = Date.now() + 5 * 60000;
    const proof = await this.proofs.sign({
      aud: input.peerId,
      purpose: 'session-confirm',
      nonce: input.nonce,
      bootId: this.bootId,
      relay: input.relay,
      binding: PeerProofs.digest(token, input.nonce, this.bootId, input.relay),
    });
    if ((await this.active(input.peerId)).revision !== peer.revision)
      throw new UnauthorizedException('Peer grant changed.');
    this.sessions.set(PeerProofs.digest(token), {
      peerId: input.peerId,
      pairId: peer.pairId,
      revision: peer.revision,
      relay: input.relay,
      actor: input.actor,
      expiresAt,
    });
    return { token, expiresAt, proof, bootId: this.bootId };
  }

  async authorize(token: string): Promise<Session> {
    const session = /^[A-Za-z0-9_-]{43}$/.test(token) ? this.sessions.get(PeerProofs.digest(token)) : undefined;
    if (!session || session.expiresAt <= Date.now()) throw new UnauthorizedException('Peer session renewal required.');
    const peer = await this.active(session.peerId);
    if (peer.pairId !== session.pairId || peer.revision !== session.revision || (session.relay && !peer.allowRelay))
      throw new UnauthorizedException('Peer grant revoked.');
    return session;
  }

  /** A session token for calling the peer, opened once per peer and device and reused until it nears expiry. */
  async access(peerId: string, deviceId?: string, renew = false): Promise<string> {
    const peer = await this.target(peerId, deviceId),
      key = JSON.stringify([peerId, deviceId ?? null]);
    const cached = this.outbound.get(key);
    if (!renew && cached && cached.expiresAt > Date.now() + 30000) return cached.token;
    const pending = this.opening.get(key);
    if (pending) return pending;
    const result = this.open(peer, deviceId, key);
    this.opening.set(key, result);
    try {
      return await result;
    } finally {
      if (this.opening.get(key) === result) this.opening.delete(key);
    }
  }

  private async open(peer: PeerRecord, deviceId: string | undefined, key: string): Promise<string> {
    const peerId = peer.identity.instanceId;
    const metadata = await this.proofs.readIdentity(peer.identity);
    const challenge = PeerChallengeSchema.parse(
      await this.network.json(peer.identity.origin, '/peer/challenge', { peerId: this.instances.instanceId }),
    );
    const relay = !!deviceId;
    const proof = await this.proofs.sign({
      aud: peerId,
      purpose: 'session',
      nonce: challenge.nonce,
      bootId: challenge.bootId,
      relay,
      binding: PeerProofs.digest(relay, deviceId ?? ''),
    });
    const result = PeerSessionSchema.parse(
      await this.network.json(peer.identity.origin, '/peer/session', {
        peerId: this.instances.instanceId,
        nonce: challenge.nonce,
        relay,
        ...(deviceId ? { actor: deviceId } : {}),
        proof,
      }),
    );
    const confirmed = await this.proofs.verify(
      peer.identity,
      result.proof,
      'session-confirm',
      challenge.nonce,
      PeerProofs.digest(result.token, challenge.nonce, challenge.bootId, relay),
      challenge.bootId,
    );
    if (confirmed.relay !== relay) throw new ForbiddenException('Peer session role changed.');
    if (result.bootId !== challenge.bootId || result.expiresAt > Date.now() + 6 * 60000)
      throw new ForbiddenException('Invalid peer session.');
    const current = await this.target(peerId, deviceId);
    if (current.pairId !== peer.pairId || current.revision !== peer.revision)
      throw new ForbiddenException('The instance grant changed.');
    await this.peers.refreshIdentity(metadata);
    this.outbound.set(key, { peerId, token: result.token, expiresAt: result.expiresAt });
    return result.token;
  }

  track(peerId: string, abort: () => void): () => void {
    const set = this.streams.get(peerId) ?? new Set<() => void>();
    this.streams.set(peerId, set);
    set.add(abort);
    return () => {
      set.delete(abort);
      if (!set.size) this.streams.delete(peerId);
    };
  }

  /** Drop every session and stream of a peer: the local grant is gone. */
  abort(peerId: string): void {
    for (const abort of this.streams.get(peerId) ?? []) abort();
    this.streams.delete(peerId);
    for (const [key, session] of this.sessions) if (session.peerId === peerId) this.sessions.delete(key);
    for (const [key, session] of this.outbound) if (session.peerId === peerId) this.outbound.delete(key);
  }

  private expire(): void {
    const now = Date.now();
    for (const [key, value] of this.challenges) if (value.expiresAt <= now) this.challenges.delete(key);
    for (const [key, value] of this.sessions) if (value.expiresAt <= now) this.sessions.delete(key);
  }
}
