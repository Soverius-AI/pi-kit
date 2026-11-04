import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable } from '@nestjs/common';
import {
  EnvironmentNameSchema,
  EnvironmentSchema,
  InstanceIdSchema,
  InstanceAccessPreferencesSchema,
  StoredDeviceGrantSchema,
  type Environment,
  type InstanceAccessPreferences,
  type StoredDeviceGrant,
} from '@pi-kit/protocol';
import { DatabaseService } from './database.service';

/** Owner-local metadata only. Does not initialize a keychain, publish a listener or rewrite cwd keys. */
@Injectable()
export class InstanceRepository {
  readonly instanceId: string;

  constructor(private readonly database: DatabaseService) {
    const candidate = EnvironmentNameSchema.safeParse(hostname());
    this.durable(() =>
      this.database.db
        .prepare(
          'INSERT OR IGNORE INTO instance_identity (singleton, instance_id, name, created_at) VALUES (1, ?, ?, ?)',
        )
        .run(randomUUID(), candidate.success ? candidate.data : 'pi-kit', Date.now()),
    );
    this.instanceId = InstanceIdSchema.parse(
      (
        this.database.db.prepare('SELECT instance_id FROM instance_identity WHERE singleton = 1').get() as {
          instance_id: string;
        }
      ).instance_id,
    );
  }

  identity(): Environment {
    const row = this.database.db
      .prepare('SELECT instance_id, name FROM instance_identity WHERE singleton = 1')
      .get() as { instance_id: string; name: string };
    return EnvironmentSchema.parse({ instanceId: row.instance_id, name: row.name, protocolVersion: 1 });
  }

  rename(name: string): Environment {
    const valid = EnvironmentNameSchema.parse(name);
    this.durable(() =>
      this.database.db.prepare('UPDATE instance_identity SET name = ? WHERE singleton = 1').run(valid),
    );
    return this.identity();
  }

  preferences(): InstanceAccessPreferences {
    const row = this.database.db
      .prepare('SELECT desired_enabled, https_port FROM instance_access_preferences WHERE singleton = 1')
      .get() as { desired_enabled: number; https_port: number };
    return InstanceAccessPreferencesSchema.parse({
      desiredEnabled: row.desired_enabled === 1,
      httpsPort: row.https_port,
    });
  }

  setPreferences(value: InstanceAccessPreferences): InstanceAccessPreferences {
    const input = InstanceAccessPreferencesSchema.parse(value);
    this.durable(() =>
      this.database.db
        .prepare('UPDATE instance_access_preferences SET desired_enabled = ?, https_port = ? WHERE singleton = 1')
        .run(Number(input.desiredEnabled), input.httpsPort),
    );
    return input;
  }

  devices(): StoredDeviceGrant[] {
    return this.database.db
      .prepare(
        'SELECT id, cookie_hash AS cookieHash, csrf, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM instance_device_grants WHERE revoked_at IS NULL',
      )
      .all()
      .map((row) => StoredDeviceGrantSchema.parse(row));
  }

  saveDevice(value: StoredDeviceGrant): void {
    const grant = StoredDeviceGrantSchema.parse(value);
    this.durable(() =>
      this.database.db
        .transaction(() => {
          const existing = this.database.db
            .prepare('SELECT cookie_hash, csrf, revoked_at FROM instance_device_grants WHERE id = ?')
            .get(grant.id) as { cookie_hash: string; csrf: string; revoked_at: number | null } | undefined;
          if (
            existing &&
            (existing.revoked_at !== null || existing.cookie_hash !== grant.cookieHash || existing.csrf !== grant.csrf)
          )
            throw new Error('Device identity cannot be replaced or reactivated.');
          const count = this.database.db
            .prepare('SELECT count(*) AS n FROM instance_device_grants WHERE revoked_at IS NULL')
            .get() as { n: number };
          if (!existing && count.n >= 20) throw new Error('Device limit reached.');
          this.database.db
            .prepare(
              `INSERT INTO instance_device_grants (id, cookie_hash, csrf, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
            )
            .run(grant.id, grant.cookieHash, grant.csrf, grant.name, grant.createdAt, grant.lastSeenAt);
          if (!existing)
            this.database.db
              .prepare(
                `INSERT INTO instance_device_peers(device_id, peer_id)
        SELECT ?, peer_id FROM instance_peers WHERE state = 'active' AND share_devices = 1`,
              )
              .run(grant.id);
        })
        .immediate(),
    );
  }

  revokeDevice(id: string): void {
    this.durable(() =>
      this.database.db
        .prepare('UPDATE instance_device_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
        .run(Date.now(), id),
    );
  }

  private durable<T>(write: () => T): T {
    return this.database.durable(write);
  }
}
