import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PeerMetadataSchema, PeerProofClaimsSchema, type PeerIdentity, type PeerProofClaims } from '@pi-kit/protocol';
import { createHash, randomBytes } from 'node:crypto';
import { InstanceRepository } from '../db/instance.repository';
import { DesktopBridge } from '../desktop/desktop-bridge';
import { PeerHttp } from './peer-http';

/** Ed25519 proofs between instances: signed by the OS-sealed instance key, verified against a peer's published identity. */
@Injectable()
export class PeerProofs {
  constructor(
    private readonly instances: InstanceRepository,
    private readonly desktop: DesktopBridge,
    private readonly network: PeerHttp,
  ) {}

  static secret(): string {
    return randomBytes(32).toString('base64url');
  }

  static digest(...value: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
  }

  /** What both sides commit to when pairing: who, where, with which relay rights and confirmation code. */
  static pairBinding(a: PeerIdentity, b: PeerIdentity, relayA: boolean, relayB: boolean, code = ''): string {
    const parts = (identity: PeerIdentity) => [identity.instanceId, identity.origin, identity.fingerprint];
    return PeerProofs.digest(parts(a), parts(b), relayA, relayB, code);
  }

  sign(claims: PeerProofClaims): Promise<string> {
    return this.desktop.instanceSign(this.instances.instanceId, claims);
  }

  async verify(
    identity: PeerIdentity,
    proof: string,
    purpose: PeerProofClaims['purpose'],
    nonce: string,
    binding?: string,
    bootId?: string,
  ): Promise<PeerProofClaims> {
    try {
      const { jwtVerify, importJWK } = await import('jose');
      const verified = await jwtVerify(proof, await importJWK(identity.publicKey, 'EdDSA'), {
        algorithms: ['EdDSA'],
        issuer: identity.instanceId,
        audience: this.instances.instanceId,
        typ: 'JWT',
        maxTokenAge: '35s',
        clockTolerance: 5,
      });
      const { iss: _iss, iat, exp, ...payload } = verified.payload;
      const claims = PeerProofClaimsSchema.parse(payload);
      if (
        typeof exp !== 'number' ||
        typeof iat !== 'number' ||
        exp - iat > 35 ||
        claims.purpose !== purpose ||
        claims.nonce !== nonce ||
        ((purpose.startsWith('pair-') || purpose === 'unpair') && claims.pairId !== nonce) ||
        (binding !== undefined && claims.binding !== binding) ||
        (bootId !== undefined && claims.bootId !== bootId)
      )
        throw new Error();
      return claims;
    } catch {
      throw new UnauthorizedException('Peer proof unavailable, expired or invalid.');
    }
  }

  async validateIdentity(identity: PeerIdentity): Promise<void> {
    const { calculateJwkThumbprint } = await import('jose');
    if ((await calculateJwkThumbprint(identity.publicKey)) !== identity.fingerprint)
      throw new ForbiddenException('Invalid peer identity.');
  }

  /** The identity a peer publishes now; it must still be the one that was paired. */
  async readIdentity(expected: PeerIdentity): Promise<PeerIdentity> {
    const metadata = PeerMetadataSchema.parse(await this.network.json(expected.origin, '/peer/identity'));
    await this.validateIdentity(metadata.identity);
    if (
      metadata.identity.instanceId !== expected.instanceId ||
      metadata.identity.fingerprint !== expected.fingerprint ||
      metadata.identity.origin !== expected.origin
    )
      throw new ForbiddenException(
        'The environment identity changed. Re-enroll explicitly; no stored credential was sent.',
      );
    return metadata.identity;
  }
}
