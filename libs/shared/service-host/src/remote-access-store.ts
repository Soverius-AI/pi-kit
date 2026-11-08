import {
  EnvironmentSchema,
  InstanceAccessPreferencesSchema,
  StoredDeviceGrantsSchema,
  type InstanceAccessPreferences,
  type RemoteAccessDevice,
  type StoredDeviceGrant,
} from '@pi-kit/protocol';
import type { Backend } from './remote-gateway-proxy';

export class RemoteStorageError extends Error {
  constructor() {
    super('Phone approval storage unavailable');
  }
}

export interface RemoteGrantStore {
  load(): Promise<StoredDeviceGrant[]>;
  save(grant: StoredDeviceGrant): Promise<void>;
  revoke(id: string): Promise<void>;
}
export interface RemotePreferenceStore {
  load(): Promise<InstanceAccessPreferences>;
  save(value: InstanceAccessPreferences): Promise<void>;
}

/** Private loopback adapter. Captures URL/token together and never follows redirects or logs credentials. */
export class RemoteAccessStores {
  constructor(private readonly backend: () => Backend | undefined) {}

  static publicDevice({ id, name, createdAt, lastSeenAt }: StoredDeviceGrant): RemoteAccessDevice {
    return { id, name, createdAt, lastSeenAt };
  }

  readonly grants: RemoteGrantStore = {
    load: () => this.call('/devices', 'GET', undefined, StoredDeviceGrantsSchema),
    save: async (grant) => {
      await this.call('/devices', 'PUT', grant);
    },
    revoke: async (id) => {
      await this.call(`/devices/${encodeURIComponent(id)}`, 'DELETE');
    },
  };

  readonly preferences: RemotePreferenceStore = {
    load: () => this.call('/access', 'GET', undefined, InstanceAccessPreferencesSchema),
    save: async (value) => {
      await this.call('/access', 'PUT', value);
    },
  };

  readonly cookieScope = async (): Promise<string> =>
    (await this.call('', 'GET', undefined, EnvironmentSchema)).instanceId;

  readonly published = async (origin: string): Promise<void> => {
    await this.call('/endpoint', 'PUT', { origin });
  };

  private async call<T = unknown>(
    path: string,
    method = 'GET',
    body?: unknown,
    schema?: { parse(value: unknown): T },
  ): Promise<T> {
    try {
      const endpoint = this.backend();
      if (!endpoint || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(endpoint.url)) throw new Error();
      const response = await fetch(`${endpoint.url}/api/instance${path}`, {
        method,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error();
      const value: unknown = await response.json();
      return schema ? schema.parse(value) : (value as T);
    } catch {
      throw new RemoteStorageError();
    }
  }
}
