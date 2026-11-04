import { Injectable } from '@nestjs/common';
import {
  EnvironmentNameSchema,
  InstanceKeyInfoSchema,
  PeerIdentitySchema,
  PeerOriginSchema,
  type InstanceKeyInfo,
  type PeerIdentity,
} from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

export interface PeerRecord {
  identity: PeerIdentity;
  pairId: string;
  alias?: string;
  confirmationCode?: string;
  state: 'pending' | 'active' | 'revoked';
  role: 'inviter' | 'joiner';
  allowRelay: boolean;
  remoteAllowRelay: boolean;
  shareDevices: boolean;
  revision: number;
  unpairPending: boolean;
}
interface PeerRow {
  peer_id: string;
  pair_id: string;
  identity_json: string;
  alias: string | null;
  confirmation_code: string | null;
  state: PeerRecord['state'];
  pair_role: PeerRecord['role'];
  allow_relay: number;
  remote_allow_relay: number;
  share_devices: number;
  revision: number;
  unpair_pending: number;
}

/** Public peer keys and directional consent only. Private instance keys never enter SQLite. */
@Injectable()
export class PeersRepository {
  constructor(private readonly database: DatabaseService) {}
  origin(): string | undefined {
    const row = this.database.db
      .prepare('SELECT public_origin FROM instance_peer_identity WHERE singleton = 1')
      .get() as { public_origin: string | null };
    return row.public_origin ? PeerOriginSchema.parse(row.public_origin) : undefined;
  }
  setOrigin(origin: string): void {
    this.durable(() =>
      this.database.db
        .prepare('UPDATE instance_peer_identity SET public_origin = ? WHERE singleton = 1')
        .run(PeerOriginSchema.parse(origin)),
    );
  }
  key(): InstanceKeyInfo | undefined {
    const row = this.database.db
      .prepare('SELECT public_key_json, fingerprint FROM instance_peer_identity WHERE singleton = 1')
      .get() as { public_key_json: string | null; fingerprint: string | null };
    return row.public_key_json
      ? InstanceKeyInfoSchema.parse({ publicKey: JSON.parse(row.public_key_json), fingerprint: row.fingerprint })
      : undefined;
  }
  bindKey(info: InstanceKeyInfo): void {
    const valid = InstanceKeyInfoSchema.parse(info),
      previous = this.key();
    if (previous && previous.fingerprint !== valid.fingerprint)
      throw new Error('The protected identity changed. Restore the original instance key.');
    this.durable(() =>
      this.database.db
        .prepare('UPDATE instance_peer_identity SET public_key_json = ?, fingerprint = ? WHERE singleton = 1')
        .run(JSON.stringify(valid.publicKey), valid.fingerprint),
    );
  }
  list(): PeerRecord[] {
    return (
      this.database.db.prepare('SELECT * FROM instance_peers ORDER BY created_at, peer_id').all() as PeerRow[]
    ).map((row) => this.decode(row));
  }
  get(peerId: string): PeerRecord | undefined {
    const row = this.database.db.prepare('SELECT * FROM instance_peers WHERE peer_id = ?').get(peerId) as
      PeerRow | undefined;
    return row && this.decode(row);
  }
  byPair(pairId: string): PeerRecord | undefined {
    return this.list().find((peer) => peer.pairId === pairId);
  }
  remember(
    identity: PeerIdentity,
    pairId: string,
    allowRelay: boolean,
    remoteAllowRelay: boolean,
    state: 'pending' | 'active',
    shareDevices: boolean,
    role: PeerRecord['role'],
    confirmationCode?: string,
  ): void {
    const valid = PeerIdentitySchema.parse(identity);
    const existing = this.get(valid.instanceId);
    if (
      existing &&
      existing.state !== 'revoked' &&
      (existing.identity.fingerprint !== valid.fingerprint || existing.identity.origin !== valid.origin)
    )
      throw new Error('Unpair before changing a pinned identity or endpoint.');
    if (existing?.state === 'revoked' && existing.pairId === pairId)
      throw new Error('A revoked pair cannot be reactivated.');
    if (existing && existing.state !== 'revoked' && existing.pairId !== pairId)
      throw new Error('Unpair the existing relationship before pairing again.');
    this.durable(() =>
      this.database.db
        .transaction(() => {
          this.database.db
            .prepare(
              `INSERT INTO instance_peers(peer_id, pair_id, identity_json, state, pair_role, allow_relay, remote_allow_relay, share_devices, created_at, confirmation_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(peer_id) DO UPDATE SET pair_id = excluded.pair_id, identity_json = excluded.identity_json,
        confirmation_code = CASE WHEN instance_peers.pair_id = excluded.pair_id THEN COALESCE(instance_peers.confirmation_code, excluded.confirmation_code) ELSE excluded.confirmation_code END,
        state = excluded.state, pair_role = excluded.pair_role, allow_relay = excluded.allow_relay, remote_allow_relay = excluded.remote_allow_relay, share_devices = excluded.share_devices,
        revision = revision + 1, revoked_at = NULL, unpair_pending = 0`,
            )
            .run(
              valid.instanceId,
              pairId,
              JSON.stringify(valid),
              state,
              role,
              Number(allowRelay),
              Number(remoteAllowRelay),
              Number(shareDevices),
              Date.now(),
              confirmationCode ?? null,
            );
          this.database.db.prepare('DELETE FROM instance_device_peers WHERE peer_id = ?').run(valid.instanceId);
          if (shareDevices)
            this.database.db
              .prepare(
                'INSERT INTO instance_device_peers(device_id, peer_id) SELECT id, ? FROM instance_device_grants WHERE revoked_at IS NULL',
              )
              .run(valid.instanceId);
        })
        .immediate(),
    );
  }
  confirmation(peerId: string, pairId: string, code: string): void {
    const peer = this.get(peerId);
    if (
      !/^\d{6}$/.test(code) ||
      !peer ||
      peer.pairId !== pairId ||
      peer.state === 'revoked' ||
      (peer.confirmationCode && peer.confirmationCode !== code)
    )
      throw new Error('Pairing confirmation changed.');
    this.durable(() =>
      this.database.db
        .prepare('UPDATE instance_peers SET confirmation_code = ? WHERE peer_id = ? AND pair_id = ?')
        .run(code, peerId, pairId),
    );
  }
  remoteRelay(peerId: string, pairId: string, allowed: boolean): void {
    this.durable(() =>
      this.database.db
        .prepare(
          "UPDATE instance_peers SET remote_allow_relay = ? WHERE peer_id = ? AND pair_id = ? AND state != 'revoked'",
        )
        .run(Number(allowed), peerId, pairId),
    );
  }
  activate(peerId: string, pairId: string): void {
    this.durable(() =>
      this.database.db
        .transaction(() => {
          this.database.db
            .prepare(
              "UPDATE instance_peers SET state = 'active' WHERE peer_id = ? AND pair_id = ? AND state = 'pending'",
            )
            .run(peerId, pairId);
          this.database.db
            .prepare(
              `INSERT OR IGNORE INTO instance_device_peers(device_id, peer_id)
        SELECT d.id, p.peer_id FROM instance_device_grants d, instance_peers p
        WHERE p.peer_id = ? AND p.pair_id = ? AND p.state = 'active' AND p.share_devices = 1 AND d.revoked_at IS NULL`,
            )
            .run(peerId, pairId);
        })
        .immediate(),
    );
  }
  revoke(peerId: string, notify: boolean): void {
    this.durable(() =>
      this.database.db
        .transaction(() => {
          this.database.db
            .prepare(
              "UPDATE instance_peers SET state = 'revoked', revoked_at = COALESCE(revoked_at, ?), revision = revision + 1, unpair_pending = ? WHERE peer_id = ?",
            )
            .run(Date.now(), Number(notify), peerId);
          this.database.db.prepare('DELETE FROM instance_device_peers WHERE peer_id = ?').run(peerId);
        })
        .immediate(),
    );
  }
  forget(peerId: string, pairId: string): void {
    this.durable(() =>
      this.database.db
        .prepare(
          "DELETE FROM instance_peers WHERE peer_id = ? AND pair_id = ? AND state = 'pending' AND pair_role = 'joiner'",
        )
        .run(peerId, pairId),
    );
  }
  notified(peerId: string, pairId: string): void {
    this.durable(() =>
      this.database.db
        .prepare('UPDATE instance_peers SET unpair_pending = 0 WHERE peer_id = ? AND pair_id = ?')
        .run(peerId, pairId),
    );
  }
  refreshIdentity(identity: PeerIdentity): void {
    const peer = this.get(identity.instanceId);
    if (!peer || peer.identity.fingerprint !== identity.fingerprint || peer.identity.origin !== identity.origin)
      throw new Error('Peer identity mismatch.');
    this.database.db
      .prepare('UPDATE instance_peers SET identity_json = ? WHERE peer_id = ?')
      .run(JSON.stringify(PeerIdentitySchema.parse(identity)), identity.instanceId);
  }
  rename(peerId: string, name: string): void {
    this.durable(() =>
      this.database.db
        .prepare('UPDATE instance_peers SET alias = ? WHERE peer_id = ?')
        .run(EnvironmentNameSchema.parse(name), peerId),
    );
  }
  deviceAllowed(deviceId: string, peerId: string): boolean {
    return !!this.database.db
      .prepare(
        `SELECT 1 FROM instance_device_peers p JOIN instance_device_grants d ON d.id = p.device_id
      WHERE p.device_id = ? AND p.peer_id = ? AND d.revoked_at IS NULL`,
      )
      .get(deviceId, peerId);
  }
  private decode(row: PeerRow): PeerRecord {
    return {
      identity: PeerIdentitySchema.parse(JSON.parse(row.identity_json)),
      pairId: row.pair_id,
      ...(row.alias ? { alias: row.alias } : {}),
      ...(row.confirmation_code ? { confirmationCode: row.confirmation_code } : {}),
      state: row.state,
      role: row.pair_role,
      allowRelay: !!row.allow_relay,
      remoteAllowRelay: !!row.remote_allow_relay,
      shareDevices: !!row.share_devices,
      revision: row.revision,
      unpairPending: !!row.unpair_pending,
    };
  }
  private durable<T>(write: () => T): T {
    return this.database.durable(write);
  }
}
