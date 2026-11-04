import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateJwkThumbprint, SignJWT } from 'jose';
import { InstanceKeyInfoSchema, isReviewedRemoteApi, type PeerProofClaims } from '@pi-kit/protocol';
import { DatabaseService } from '../db/database.service';
import { InstanceRepository } from '../db/instance.repository';
import { PeersRepository, type PeerRecord } from '../db/peers.repository';
import type { DesktopBridge } from '../desktop/desktop-bridge';
import { PeerHttp, PeerHttpError } from './peer-http';
import { PeerProofs } from './peer-proofs';
import { PeerSessions } from './peer-sessions';
import { PeersService } from './peers.service';

type Node = Awaited<ReturnType<typeof node>>;
const owned: { dir: string; db: DatabaseService; service?: PeersService; sessions?: PeerSessions }[] = [];
const nodes = new Map<string, Node>();
const offline = new Set<string>();
const calls: { origin: string; path: string; body: Record<string, unknown> }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.service?.onModuleDestroy();
    item.sessions?.onModuleDestroy();
    item.db.onApplicationShutdown();
    rmSync(item.dir, { recursive: true, force: true });
  }
  nodes.clear();
  offline.clear();
  calls.length = 0;
});
const network = {
  async json(origin: string, path: string, body: Record<string, unknown> = {}): Promise<unknown> {
    calls.push({ origin, path, body });
    if (offline.has(origin)) throw new Error('Offline');
    const target = nodes.get(origin);
    if (!target) throw new Error('Unreachable');
    try {
      switch (path) {
        case '/peer/identity':
          return target.service.metadata();
        case '/peer/pair/request':
          return await target.service.request(body);
        case '/peer/pair/status':
          return await target.service.status(String(body.pairId), String(body.proof));
        case '/peer/pair/ack':
          return await target.service.acknowledge(String(body.pairId), String(body.proof));
        case '/peer/challenge':
          return target.sessions.challenge(String(body.peerId));
        case '/peer/session':
          return await target.sessions.session(body);
        case '/peer/unpair':
          return await target.service.remoteUnpair(String(body.pairId), String(body.proof));
        default:
          throw new Error('Unexpected route');
      }
    } catch (error) {
      if ((error as { getStatus?: () => number }).getStatus?.() === 404) throw new PeerHttpError(404);
      throw error;
    }
  },
} as PeerHttp;
async function node(label: string) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-kit-peer-'));
  const db = new DatabaseService({ dataDir: dir }),
    instance = new InstanceRepository(db),
    records = new PeersRepository(db);
  const holder: (typeof owned)[number] = { dir, db };
  owned.push(holder);
  instance.rename(label);
  const origin = `https://${label.toLowerCase()}.fixture.ts.net`;
  records.setOrigin(origin);
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'jwk' });
  const info = InstanceKeyInfoSchema.parse({ publicKey, fingerprint: await calculateJwkThumbprint(publicKey) });
  const signer = {
    locked: false,
    instanceKeyInfo: vi.fn(async (_id: string, _create: boolean) => {
      if (signer.locked) throw new Error('Locked');
      return info;
    }),
    instanceSign: vi.fn(async (_id: string, claims: PeerProofClaims) => {
      if (signer.locked) throw new Error('Locked');
      return new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
        .setIssuer(instance.instanceId)
        .setIssuedAt()
        .setExpirationTime('30s')
        .sign(keys.privateKey);
    }),
  };
  const build = () => {
    const proofs = new PeerProofs(instance, signer as unknown as DesktopBridge, network),
      sessions = new PeerSessions(instance, records, network, proofs);
    holder.sessions = sessions;
    holder.service = new PeersService(instance, records, signer as unknown as DesktopBridge, network, proofs, sessions);
  };
  build();
  const result = {
    db,
    instance,
    records,
    signer,
    origin,
    id: instance.instanceId,
    get service() {
      return holder.service!;
    },
    get sessions() {
      return holder.sessions!;
    },
    restart() {
      holder.service!.onModuleDestroy();
      holder.sessions!.onModuleDestroy();
      build();
    },
  };
  nodes.set(origin, result);
  return result;
}
async function progress(target: Node, from: Node) {
  await (target.service as unknown as { progress(peer: PeerRecord): Promise<void> }).progress(
    target.records.get(from.id)!,
  );
}
async function pair(a: Node, b: Node, relay = true) {
  const invite = await a.service.invitation();
  await b.service.connect(invite.invitation, relay);
  const pending = a.service.manager().requests[0];
  expect(b.records.get(a.id)?.confirmationCode).toBe(pending.confirmationCode);
  a.service.approvePair(pending.pairId, relay);
  await progress(b, a);
  return pending.pairId;
}
const phone = () => ({
  id: randomUUID(),
  name: 'Phone',
  cookieHash: 'a'.repeat(64),
  csrf: 'b'.repeat(43),
  createdAt: 100,
  lastSeenAt: 100,
});

describe('reciprocal instance control plane', () => {
  it('does not initialize OS keys for ordinary local use or name edits', async () => {
    const a = await node('Alpha');
    expect(a.service.manager().peers).toEqual([]);
    a.instance.rename('Arbeits-Mac 日本語');
    expect(a.signer.instanceKeyInfo).not.toHaveBeenCalled();
    expect(() => a.service.metadata()).toThrow();
    await a.service.invitation();
    expect(a.signer.instanceKeyInfo).toHaveBeenCalledWith(a.id, true);
    expect(a.service.metadata().identity.name).toBe('Arbeits-Mac 日本語');
  });
  it('requires both owners, confirms the same random signed code, and approves both directions', async () => {
    const a = await node('Alpha'),
      b = await node('Beta');
    const invite = await a.service.invitation();
    await b.service.connect(invite.invitation, true);
    expect(a.records.list()).toEqual([]);
    expect(b.records.get(a.id)?.state).toBe('pending');
    expect(() => b.sessions.target(a.id)).toThrow();
    expect(() => a.sessions.challenge(b.id)).toThrow();
    const request = a.service.manager().requests[0];
    expect(request.confirmationCode).toMatch(/^\d{6}$/);
    expect(b.records.get(a.id)?.confirmationCode).toBe(request.confirmationCode);
    a.service.approvePair(request.pairId, true);
    expect(a.records.get(b.id)?.state).toBe('pending');
    await progress(b, a);
    expect(a.records.get(b.id)?.state).toBe('active');
    expect(b.records.get(a.id)?.state).toBe('active');
    const toB = await a.sessions.access(b.id),
      toA = await b.sessions.access(a.id);
    expect(b.sessions.authorize(toB)).toMatchObject({ peerId: a.id, relay: false });
    expect(a.sessions.authorize(toA)).toMatchObject({ peerId: b.id, relay: false });
    const count = calls.filter((call) => call.path === '/peer/session').length;
    await Promise.all(Array.from({ length: 10 }, () => a.sessions.access(b.id, undefined, true)));
    expect(calls.filter((call) => call.path === '/peer/session')).toHaveLength(count + 1);
  });
  it('recovers a half-confirmed durable pair after the inviter restarts', async () => {
    const a = await node('Alpha'),
      b = await node('Beta');
    await b.service.connect((await a.service.invitation()).invitation, true);
    const request = a.service.manager().requests[0];
    a.service.approvePair(request.pairId, true);
    a.restart();
    await progress(b, a);
    expect(a.records.get(b.id)).toMatchObject({
      pairId: request.pairId,
      state: 'active',
      confirmationCode: request.confirmationCode,
    });
    expect(b.records.get(a.id)?.state).toBe('active');
  });
  it('consumes an invitation once even when different valid requests race', async () => {
    const a = await node('Alpha'),
      b = await node('Beta'),
      c = await node('Gamma');
    const invitation = (await a.service.invitation()).invitation;
    const results = await Promise.allSettled([
      b.service.connect(invitation, true),
      c.service.connect(invitation, true),
    ]);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(a.service.manager().requests).toHaveLength(1);
  });
  it('rejects session-proof replay, wrong audiences and mode substitution', async () => {
    const a = await node('Alpha'),
      b = await node('Beta');
    await pair(a, b);
    await a.sessions.access(b.id);
    const original = calls.find((call) => call.origin === b.origin && call.path === '/peer/session')!.body;
    await expect(b.sessions.session(original)).rejects.toThrow();
    const challenge = b.sessions.challenge(a.id);
    const claims: PeerProofClaims = {
      aud: a.id,
      purpose: 'session',
      nonce: challenge.nonce,
      bootId: challenge.bootId,
      relay: false,
      binding: PeerProofs.digest(false, ''),
    };
    const wrongAudience = await a.signer.instanceSign(a.id, claims);
    await expect(
      b.sessions.session({ peerId: a.id, nonce: challenge.nonce, relay: false, proof: wrongAudience }),
    ).rejects.toThrow();
    const wrongMode = await a.signer.instanceSign(a.id, { ...claims, aud: b.id, relay: true });
    await expect(
      b.sessions.session({ peerId: a.id, nonce: challenge.nonce, relay: false, proof: wrongMode }),
    ).rejects.toThrow();
  });
  it('survives backend restart and a locked key without replacing identity or re-pairing', async () => {
    const a = await node('Alpha'),
      b = await node('Beta');
    const pairId = await pair(a, b);
    const old = await a.sessions.access(b.id),
      fingerprint = b.service.metadata().identity.fingerprint;
    b.restart();
    expect(() => b.sessions.authorize(old)).toThrow();
    b.signer.locked = true;
    await expect(a.sessions.access(b.id, undefined, true)).rejects.toThrow();
    expect(b.records.get(a.id)).toMatchObject({ state: 'active', pairId });
    b.signer.locked = false;
    const renewed = await a.sessions.access(b.id, undefined, true);
    expect(b.sessions.authorize(renewed).peerId).toBe(a.id);
    expect(b.service.metadata().identity.fingerprint).toBe(fingerprint);
  });
  it('intersects phone scope with both directional grants and retains actor attribution', async () => {
    const a = await node('Alpha'),
      b = await node('Beta'),
      c = await node('Gamma');
    const device = phone();
    a.instance.saveDevice(device);
    await pair(a, b);
    const token = await a.sessions.access(b.id, device.id);
    expect(b.sessions.authorize(token)).toMatchObject({ peerId: a.id, relay: true, actor: device.id });
    expect(a.service.manager(device.id).peers.map((peer) => peer.peerId)).toEqual([b.id]);
    expect(() => a.sessions.target(c.id, device.id)).toThrow();
    a.instance.revokeDevice(device.id);
    expect(() => a.sessions.target(b.id, device.id)).toThrow();
    const nativeOnlyA = await node('Delta'),
      nativeOnlyB = await node('Epsilon');
    await pair(nativeOnlyA, nativeOnlyB, false);
    const other = phone();
    nativeOnlyA.instance.saveDevice(other);
    await expect(nativeOnlyA.sessions.access(nativeOnlyB.id, other.id)).rejects.toThrow();
    for (const method of ['GET', 'POST', 'DELETE'])
      expect(isReviewedRemoteApi('/api/instances/' + c.id + '/proxy/api/workspaces', method)).toBe(false);
  });
  it('immediately aborts revoked streams and durably retries unpair while the other instance is offline', async () => {
    const a = await node('Alpha'),
      b = await node('Beta');
    const pairId = await pair(a, b);
    const token = await a.sessions.access(b.id),
      abort = vi.fn();
    b.sessions.track(a.id, abort);
    offline.add(a.origin);
    await b.service.unpair(a.id);
    expect(abort).toHaveBeenCalledOnce();
    expect(() => b.sessions.authorize(token)).toThrow();
    expect(b.records.get(a.id)).toMatchObject({ state: 'revoked', unpairPending: true });
    const proof = await a.signer.instanceSign(a.id, { aud: b.id, purpose: 'pair-ack', nonce: pairId, pairId });
    await expect(b.service.acknowledge(pairId, proof)).rejects.toThrow();
    b.restart();
    offline.delete(a.origin);
    await (b.service as unknown as { refresh(): Promise<void> }).refresh();
    expect(b.records.get(a.id)?.unpairPending).toBe(false);
    expect(a.records.get(b.id)?.state).toBe('revoked');
  });
  it('updates advertised names without changing references, local aliases or grants', async () => {
    const a = await node('Alpha'),
      b = await node('Beta');
    const pairId = await pair(a, b);
    a.records.rename(b.id, 'My work machine');
    b.instance.rename('日本語 Work');
    await a.sessions.access(b.id, undefined, true);
    expect(a.records.get(b.id)).toMatchObject({
      alias: 'My work machine',
      pairId,
      identity: { instanceId: b.id, name: '日本語 Work' },
    });
    expect(a.service.manager().peers[0].name).toBe('My work machine');
  });
  it('does not accept a replacement identity at an enrolled endpoint', async () => {
    const a = await node('Alpha'),
      b = await node('Beta');
    await pair(a, b);
    const replacement = await node('Gamma');
    await replacement.service.invitation();
    nodes.set(b.origin, replacement);
    await expect(a.sessions.access(b.id, undefined, true)).rejects.toThrow(/identity changed/i);
    expect(a.records.get(b.id)?.state).toBe('active');
    const sent = calls.filter((call) => call.origin === b.origin);
    expect(sent.at(-1)?.path).toBe('/peer/identity');
  });
});
