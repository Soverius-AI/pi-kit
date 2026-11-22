import { Injectable } from '@nestjs/common';
import {
  defaultEnvironmentLook,
  EnvironmentLookSchema,
  EnvironmentNameSchema,
  EnvironmentSchema,
  type EnvironmentLook,
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
  get instanceId(): string {
    return this.database.instanceId;
  }

  constructor(private readonly database: DatabaseService) {}

  async identity(): Promise<Environment> {
    const row = (await this.database.db
      .prepare('SELECT instance_id, name FROM instance_identity WHERE singleton = 1')
      .get()) as { instance_id: string; name: string };
    return EnvironmentSchema.parse({ instanceId: row.instance_id, name: row.name, protocolVersion: 1 });
  }

  async rename(name: string): Promise<Environment> {
    const valid = EnvironmentNameSchema.parse(name);
    return this.durable(() =>
      this.database.db
        .transaction(async () => {
          await this.database.db.prepare('UPDATE instance_identity SET name = ? WHERE singleton = 1').run(valid);
          return this.identity();
        })
        .immediate(),
    );
  }

  /** Kept out of `identity()`: the pairing identity is strict and signed. */
  async look(): Promise<EnvironmentLook> {
    const row = (await this.database.db.prepare('SELECT look FROM instance_identity WHERE singleton = 1').get()) as {
      look: string | null;
    };
    const stored = row.look ? EnvironmentLookSchema.safeParse(JSON.parse(row.look)) : undefined;
    return stored?.success ? stored.data : defaultEnvironmentLook(this.instanceId);
  }

  async setLook(look: EnvironmentLook): Promise<EnvironmentLook> {
    const valid = EnvironmentLookSchema.parse(look);
    await this.durable(
      async () =>
        await this.database.db
          .prepare('UPDATE instance_identity SET look = ? WHERE singleton = 1')
          .run(JSON.stringify(valid)),
    );
    return valid;
  }

  async preferences(): Promise<InstanceAccessPreferences> {
    const row = (await this.database.db
      .prepare('SELECT desired_enabled, https_port FROM instance_access_preferences WHERE singleton = 1')
      .get()) as { desired_enabled: number; https_port: number };
    return InstanceAccessPreferencesSchema.parse({
      desiredEnabled: row.desired_enabled === 1,
      httpsPort: row.https_port,
    });
  }

  async setPreferences(value: InstanceAccessPreferences): Promise<InstanceAccessPreferences> {
    const input = InstanceAccessPreferencesSchema.parse(value);
    await this.durable(
      async () =>
        await this.database.db
          .prepare('UPDATE instance_access_preferences SET desired_enabled = ?, https_port = ? WHERE singleton = 1')
          .run(Number(input.desiredEnabled), input.httpsPort),
    );
    return input;
  }

  async devices(): Promise<StoredDeviceGrant[]> {
    return (
      await this.database.db
        .prepare(
          'SELECT id, cookie_hash AS cookieHash, csrf, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM instance_device_grants WHERE revoked_at IS NULL',
        )
        .all()
    ).map((row) => StoredDeviceGrantSchema.parse(row));
  }

  async saveDevice(value: StoredDeviceGrant): Promise<void> {
    const grant = StoredDeviceGrantSchema.parse(value);
    await this.durable(
      async () =>
        await this.database.db
          .transaction(async () => {
            const existing = (await this.database.db
              .prepare('SELECT cookie_hash, csrf, revoked_at FROM instance_device_grants WHERE id = ?')
              .get(grant.id)) as { cookie_hash: string; csrf: string; revoked_at: number | null } | undefined;
            if (
              existing &&
              (existing.revoked_at !== null ||
                existing.cookie_hash !== grant.cookieHash ||
                existing.csrf !== grant.csrf)
            )
              throw new Error('Device identity cannot be replaced or reactivated.');
            const count = (await this.database.db
              .prepare('SELECT count(*) AS n FROM instance_device_grants WHERE revoked_at IS NULL')
              .get()) as { n: number };
            if (!existing && count.n >= 20) throw new Error('Device limit reached.');
            await this.database.db
              .prepare(
                `INSERT INTO instance_device_grants (id, cookie_hash, csrf, name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
              )
              .run(grant.id, grant.cookieHash, grant.csrf, grant.name, grant.createdAt, grant.lastSeenAt);
            if (!existing)
              await this.database.db
                .prepare(
                  `INSERT INTO instance_device_peers(device_id, peer_id)
        SELECT ?, peer_id FROM instance_peers WHERE state = 'active' AND share_devices = 1`,
                )
                .run(grant.id);
          })
          .immediate(),
    );
  }

  async revokeDevice(id: string): Promise<void> {
    await this.durable(
      async () =>
        await this.database.db
          .prepare('UPDATE instance_device_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
          .run(Date.now(), id),
    );
  }

  private durable<T>(write: () => Promise<T>): Promise<T> {
    return this.database.durable(write);
  }
}
