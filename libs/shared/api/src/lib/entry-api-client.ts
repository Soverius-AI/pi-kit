import { Injectable, inject } from '@angular/core';
import { ApiClient } from './api-client';
import { BACKEND_CONNECTION, type BackendConnection } from './backend.service';
import { createTypedClient, type TypedClient } from './typed-client';
import { ENTRY_CONNECTION, WORKBENCH, scopedBackendConnection } from './workbench';

/** Fixed controller/entry connection. Peer management never follows the currently viewed project. */
@Injectable({ providedIn: 'root' })
export class EntryApiClient {
  private readonly context = inject(WORKBENCH);
  private readonly entry = inject(ENTRY_CONNECTION, { optional: true }) ?? inject(BACKEND_CONNECTION);
  readonly client: TypedClient = this.context.remote ? this.connect(this.entry) : inject(ApiClient).client;
  forOwner(instanceId: string): TypedClient {
    return instanceId === this.context.entryId
      ? this.client
      : this.connect(scopedBackendConnection(this.entry, instanceId));
  }
  private connect(connection: BackendConnection): TypedClient {
    return createTypedClient(async (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${await connection.token()}`);
      const result = await fetch((await connection.url()) + path, {
        ...init,
        headers,
        ...(connection.mode === 'phone' ? { credentials: 'same-origin', redirect: 'error' } : {}),
      });
      if (result.status === 401 && connection.mode === 'phone') await connection.resume?.().catch(() => undefined);
      return result;
    });
  }
}
