import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID, randomInt, timingSafeEqual } from 'node:crypto';
import {
  PeerIdentitySchema,
  PeerInvitationSchema,
  PeerManagerSchema,
  PeerPairRequestSchema,
  PeerPairStatusSchema,
  type PeerIdentity,
  type PeerManager,
  type InstanceKeyInfo,
} from '@pi-kit/protocol';
import { InstanceRepository } from '../db/instance.repository';
import { PeersRepository, type PeerRecord } from '../db/peers.repository';
import { DesktopBridge } from '../desktop/desktop-bridge';
import { PeerHttp, PeerHttpError } from './peer-http';
import { PeerProofs } from './peer-proofs';
import { PeerSessions } from './peer-sessions';

type Pending = {
  pairId: string;
  identity: PeerIdentity;
  remoteRelay: boolean;
  secretHash: string;
  expiresAt: number;
  code: string;
};

/** Instance pairing: invitations, mutual approval and unpairing. Cryptographic proofs never confer rights without the target's durable directional grant. */
@Injectable()
export class PeersService implements OnModuleDestroy {
  private readonly invitations = new Map<string, { secretHash: string; expiresAt: number }>();
  private readonly requests = new Map<string, Pending>();
  private readonly refreshingPeers = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly instances: InstanceRepository,
    private readonly peers: PeersRepository,
    private readonly desktop: DesktopBridge,
    private readonly network: PeerHttp,
    private readonly proofs: PeerProofs,
    private readonly sessions: PeerSessions,
  ) {
    this.timer = setInterval(() => {
      this.expire();
      void this.refresh();
    }, 10000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.invitations.clear();
    this.requests.clear();
  }
  private self(): PeerIdentity {
    const key = this.peers.key(),
      origin = this.peers.origin();
    if (!key || !origin)
      throw new ServiceUnavailableException(
        'Enable private remote access and initialize this instance identity first.',
      );
    return PeerIdentitySchema.parse({ ...this.instances.identity(), ...key, origin });
  }
  private async enable(): Promise<void> {
    if (!this.peers.origin())
      throw new ServiceUnavailableException('Enable private remote access before pairing instances.');
    try {
      const key: InstanceKeyInfo = await this.desktop.instanceKeyInfo(this.instances.instanceId, !this.peers.key());
      const { calculateJwkThumbprint } = await import('jose');
      if ((await calculateJwkThumbprint(key.publicKey)) !== key.fingerprint) throw new Error('Invalid key.');
      this.peers.bindKey(key);
    } catch {
      throw new ServiceUnavailableException(
        'The OS-protected instance key is unavailable. Unlock protected storage or restore the original key; no replacement or plaintext fallback was used.',
      );
    }
  }
  metadata(): { identity: PeerIdentity; bootId: string } {
    return { identity: this.self(), bootId: this.sessions.bootId };
  }
  manager(deviceId?: string): PeerManager {
    this.expire();
    if (!deviceId) void this.refresh();
    const records = this.peers.list().filter((peer) => !deviceId || this.sessions.canDevice(deviceId, peer));
    return PeerManagerSchema.parse({
      self: this.instances.identity(),
      keyInitialized: !!this.peers.key(),
      endpoint: this.peers.origin(),
      peers: records.map((peer) => ({
        peerId: peer.identity.instanceId,
        pairId: peer.pairId,
        name: peer.alias ?? peer.identity.name,
        origin: peer.identity.origin,
        fingerprint: peer.identity.fingerprint,
        state: peer.state,
        allowRelay: peer.allowRelay,
        remoteAllowRelay: peer.remoteAllowRelay,
        sharedWithPhones: peer.shareDevices,
        unpairPending: peer.unpairPending,
        ...(peer.state === 'pending' && peer.confirmationCode ? { confirmationCode: peer.confirmationCode } : {}),
      })),
      requests: deviceId
        ? []
        : [...this.requests.values()].map((pending) => ({
            pairId: pending.pairId,
            name: pending.identity.name,
            origin: pending.identity.origin,
            fingerprint: pending.identity.fingerprint,
            confirmationCode: pending.code,
            expiresAt: pending.expiresAt,
          })),
    });
  }
  async invitation(): Promise<{ invitation: string; expiresAt: number }> {
    this.expire();
    await this.enable();
    if (this.invitations.size >= 10) throw new BadRequestException('Too many pending invitations.');
    const pairId = randomUUID(),
      value = PeerProofs.secret(),
      expiresAt = Date.now() + 5 * 60000;
    this.invitations.set(pairId, { secretHash: PeerProofs.digest(value), expiresAt });
    const invitation = { kind: 'pi-kit-instance', version: 1, pairId, secret: value, identity: this.self(), expiresAt };
    return {
      invitation: 'PIKIT-INSTANCE-1.' + Buffer.from(JSON.stringify(invitation)).toString('base64url'),
      expiresAt,
    };
  }
  async connect(encoded: string, allowRelay: boolean): Promise<void> {
    if (encoded.length > 8192 || !encoded.startsWith('PIKIT-INSTANCE-1.'))
      throw new BadRequestException('This is not an instance invitation.');
    const invitation = PeerInvitationSchema.parse(JSON.parse(Buffer.from(encoded.slice(17), 'base64url').toString()));
    if (invitation.expiresAt <= Date.now()) throw new BadRequestException('Invitation expired.');
    await this.enable();
    const self = this.self();
    if (invitation.identity.instanceId === self.instanceId)
      throw new BadRequestException('Choose another instance, not this one.');
    const metadata = await this.proofs.readIdentity(invitation.identity);
    const previous = this.peers.get(metadata.instanceId);
    if (previous?.state === 'active') throw new BadRequestException('This instance is already paired.');
    if (previous && previous.state !== 'revoked' && previous.pairId !== invitation.pairId)
      throw new BadRequestException('Unpair the existing instance before pairing again.');
    this.remember(metadata, invitation.pairId, allowRelay, false, 'pending', allowRelay, 'joiner');
    const proof = await this.proofs.sign({
      aud: metadata.instanceId,
      purpose: 'pair-request',
      nonce: invitation.pairId,
      pairId: invitation.pairId,
      binding: PeerProofs.pairBinding(metadata, self, false, allowRelay),
    });
    await this.network.json(metadata.origin, '/peer/pair/request', {
      pairId: invitation.pairId,
      secret: invitation.secret,
      identity: self,
      allowRelay,
      proof,
    });
    await this.progress(this.peers.get(metadata.instanceId)!);
  }
  async request(value: unknown): Promise<unknown> {
    const input = PeerPairRequestSchema.parse(value);
    this.expire();
    const invitation = this.invitations.get(input.pairId),
      old = this.requests.get(input.pairId);
    const expected = invitation?.secretHash ?? old?.secretHash;
    if (!expected || !timingSafeEqual(Buffer.from(expected), Buffer.from(PeerProofs.digest(input.secret))))
      throw new ForbiddenException('Invitation unavailable.');
    if (input.identity.instanceId === this.instances.instanceId)
      throw new BadRequestException('Cannot pair with self.');
    await this.proofs.validateIdentity(input.identity);
    await this.proofs.verify(
      input.identity,
      input.proof,
      'pair-request',
      input.pairId,
      PeerProofs.pairBinding(this.self(), input.identity, false, input.allowRelay),
    );
    // Claim after verification, atomically: two concurrent requests cannot consume one invitation for different keys.
    this.expire();
    const current = this.requests.get(input.pairId);
    if (
      current &&
      (current.identity.fingerprint !== input.identity.fingerprint ||
        current.identity.instanceId !== input.identity.instanceId ||
        current.identity.origin !== input.identity.origin ||
        current.remoteRelay !== input.allowRelay)
    )
      throw new ForbiddenException('Invitation already used.');
    if (!current && !this.invitations.has(input.pairId)) throw new ForbiddenException('Invitation unavailable.');
    if (!current && this.requests.size >= 20) throw new BadRequestException('Pairing request limit reached.');
    this.invitations.delete(input.pairId);
    const pending = current ?? {
      pairId: input.pairId,
      identity: input.identity,
      remoteRelay: input.allowRelay,
      secretHash: expected,
      expiresAt: Date.now() + 5 * 60000,
      code: String(randomInt(100000, 1000000)),
    };
    this.requests.set(input.pairId, pending);
    return this.pendingStatus(pending);
  }
  approvePair(pairId: string, allowRelay: boolean): void {
    this.expire();
    const pending = this.requests.get(pairId);
    if (!pending) throw new NotFoundException('Pairing request expired.');
    if (this.peers.list().filter((peer) => peer.state !== 'revoked').length >= 20)
      throw new BadRequestException('Peer limit reached.');
    this.remember(
      pending.identity,
      pairId,
      allowRelay,
      pending.remoteRelay,
      'pending',
      allowRelay,
      'inviter',
      pending.code,
    );
    this.requests.delete(pairId);
  }
  reject(pairId: string): void {
    this.requests.delete(pairId);
  }
  async status(pairId: string, proof: string): Promise<unknown> {
    this.expire();
    const pending = this.requests.get(pairId),
      record = this.peers.byPair(pairId);
    const identity = pending?.identity ?? record?.identity;
    if (!identity || record?.state === 'revoked') throw new NotFoundException('Pairing unavailable.');
    await this.proofs.verify(identity, proof, 'pair-status', pairId);
    if (pending) return this.pendingStatus(pending);
    if (!record || !record.confirmationCode || record.role !== 'inviter')
      throw new ForbiddenException('Invalid pairing direction.');
    const receipt = await this.proofs.sign({
      aud: identity.instanceId,
      purpose: 'pair-confirm',
      nonce: pairId,
      pairId,
      binding: PeerProofs.pairBinding(
        this.self(),
        identity,
        record.allowRelay,
        record.remoteAllowRelay,
        record.confirmationCode,
      ),
    });
    return {
      status: 'approved',
      receipt,
      confirmationCode: record.confirmationCode,
      allowRelay: record.allowRelay,
      remoteAllowRelay: record.remoteAllowRelay,
    };
  }
  async acknowledge(pairId: string, proof: string): Promise<{ paired: true }> {
    const peer = this.peers.byPair(pairId);
    if (!peer || !peer.confirmationCode || peer.role !== 'inviter' || peer.state === 'revoked')
      throw new ForbiddenException('Pairing unavailable.');
    await this.proofs.verify(
      peer.identity,
      proof,
      'pair-ack',
      pairId,
      PeerProofs.pairBinding(this.self(), peer.identity, peer.allowRelay, peer.remoteAllowRelay, peer.confirmationCode),
    );
    this.peers.activate(peer.identity.instanceId, pairId);
    return { paired: true };
  }
  async unpair(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) throw new NotFoundException('Unknown instance.');
    this.peers.revoke(peerId, true);
    this.sessions.abort(peerId);
    await this.notify(this.peers.get(peerId)!);
  }
  async remoteUnpair(pairId: string, proof: string): Promise<{ unpaired: true }> {
    const peer = this.peers.byPair(pairId);
    if (!peer) {
      const pending = this.requests.get(pairId);
      if (pending) {
        await this.proofs.verify(pending.identity, proof, 'unpair', pairId);
        this.requests.delete(pairId);
      }
      return { unpaired: true }; // Idempotent acknowledgement: no grant for this pair exists.
    }
    await this.proofs.verify(peer.identity, proof, 'unpair', pairId);
    this.peers.revoke(peer.identity.instanceId, false);
    this.sessions.abort(peer.identity.instanceId);
    return { unpaired: true };
  }
  private remember(...args: Parameters<PeersRepository['remember']>): void {
    try {
      this.peers.remember(...args);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Pairing unavailable.');
    }
  }
  private async pendingStatus(pending: Pending): Promise<unknown> {
    const proof = await this.proofs.sign({
      aud: pending.identity.instanceId,
      purpose: 'pair-pending',
      nonce: pending.pairId,
      pairId: pending.pairId,
      binding: PeerProofs.pairBinding(this.self(), pending.identity, false, pending.remoteRelay, pending.code),
    });
    return { status: 'pending', confirmationCode: pending.code, proof };
  }
  private async progress(peer: PeerRecord): Promise<void> {
    if (peer.state !== 'pending' || peer.role !== 'joiner') return;
    const proof = await this.proofs.sign({
      aud: peer.identity.instanceId,
      purpose: 'pair-status',
      nonce: peer.pairId,
      pairId: peer.pairId,
    });
    let status: ReturnType<typeof PeerPairStatusSchema.parse>;
    try {
      status = PeerPairStatusSchema.parse(
        await this.network.json(peer.identity.origin, '/peer/pair/status', { pairId: peer.pairId, proof }),
      );
    } catch (error) {
      if (error instanceof PeerHttpError && error.status === 404)
        this.peers.forget(peer.identity.instanceId, peer.pairId);
      throw error;
    }
    if (status.status === 'pending') {
      await this.proofs.verify(
        peer.identity,
        status.proof,
        'pair-pending',
        peer.pairId,
        PeerProofs.pairBinding(peer.identity, this.self(), false, peer.allowRelay, status.confirmationCode),
      );
      this.peers.confirmation(peer.identity.instanceId, peer.pairId, status.confirmationCode);
      return;
    }
    if (
      status.remoteAllowRelay !== peer.allowRelay ||
      (peer.confirmationCode && peer.confirmationCode !== status.confirmationCode)
    )
      throw new ForbiddenException('Pairing permissions or confirmation changed.');
    const binding = PeerProofs.pairBinding(
      peer.identity,
      this.self(),
      status.allowRelay,
      peer.allowRelay,
      status.confirmationCode,
    );
    await this.proofs.verify(peer.identity, status.receipt, 'pair-confirm', peer.pairId, binding);
    this.peers.confirmation(peer.identity.instanceId, peer.pairId, status.confirmationCode);
    this.peers.remoteRelay(peer.identity.instanceId, peer.pairId, status.allowRelay);
    const ack = await this.proofs.sign({
      aud: peer.identity.instanceId,
      purpose: 'pair-ack',
      nonce: peer.pairId,
      pairId: peer.pairId,
      binding,
    });
    await this.network.json(peer.identity.origin, '/peer/pair/ack', { pairId: peer.pairId, proof: ack });
    this.peers.activate(peer.identity.instanceId, peer.pairId);
  }
  private refresh(): Promise<void> {
    const started: Promise<void>[] = [];
    for (const peer of this.peers.list()) {
      const key = peer.identity.instanceId;
      if (
        this.refreshingPeers.has(key) ||
        !(peer.unpairPending || (peer.state === 'pending' && peer.role === 'joiner'))
      )
        continue;
      this.refreshingPeers.add(key);
      started.push(
        (peer.unpairPending ? this.notify(peer) : this.progress(peer))
          .catch(() => undefined)
          .finally(() => this.refreshingPeers.delete(key)),
      );
    }
    return Promise.all(started).then(() => undefined);
  }
  private async notify(peer: PeerRecord): Promise<void> {
    try {
      const proof = await this.proofs.sign({
        aud: peer.identity.instanceId,
        purpose: 'unpair',
        nonce: peer.pairId,
        pairId: peer.pairId,
      });
      await this.network.json(peer.identity.origin, '/peer/unpair', { pairId: peer.pairId, proof });
      this.peers.notified(peer.identity.instanceId, peer.pairId);
    } catch {
      /* Tombstone/notification remains durable for retry. Local access is already denied. */
    }
  }
  private expire(): void {
    const now = Date.now();
    for (const [key, value] of this.invitations) if (value.expiresAt <= now) this.invitations.delete(key);
    for (const [key, value] of this.requests) if (value.expiresAt <= now) this.requests.delete(key);
  }
}
