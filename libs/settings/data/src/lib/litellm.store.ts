import { inject } from '@angular/core';
import { signalStore, withMethods } from '@ngrx/signals';
import { ApiClient, liteLlmStatus, liteLlmDiscover, liteLlmSave, unwrap } from '@pi-kit/api';
import type { LiteLlmConnect, LiteLlmConnection } from '@pi-kit/protocol';
import { SettingsStore } from './settings.store';

/** Secrets stay in the form only; no root store retains a typed key. */
export const LiteLlmStore = signalStore(
  { providedIn: 'root' },
  withMethods(() => {
    const api = inject(ApiClient);
    const settings = inject(SettingsStore);
    return {
      load(signal?: AbortSignal): Promise<LiteLlmConnection> {
        return unwrap(liteLlmStatus({ client: api.client, signal }));
      },
      discover(body: LiteLlmConnect, signal?: AbortSignal): Promise<LiteLlmConnection> {
        return unwrap(liteLlmDiscover({ client: api.client, body, signal }));
      },
      async save(body: LiteLlmConnect, signal?: AbortSignal): Promise<LiteLlmConnection> {
        const connection = await unwrap(liteLlmSave({ client: api.client, body, signal }));
        await settings.load();
        return connection;
      },
    };
  }),
);
