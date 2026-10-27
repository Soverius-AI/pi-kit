import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withProps, withState } from '@ngrx/signals';
import { ApiClient, unwrap, usageGet } from '@pi-kit/api';
import type { ProviderInfo, ProviderUsage } from '@pi-kit/protocol';
import { RENDERER_POLICY } from './renderer-policy';

interface ProviderUsageState {
  /** The last answer per provider id; `null` is "this provider has no source", absent is "not asked yet". */
  usage: Record<string, ProviderUsage | null>;
  askedAt: Record<string, number>;
}

/**
 * What the providers say about their usage, shared by the model picker (a section heading) and Settings › Providers (a row): both call `refresh` while they are
 * open and read `usage()`. Nothing polls on its own; completed Radius runs also reconcile their credits. `withUsage` puts the answers on `ProviderInfo.usage`.
 */
export const ProviderUsageStore = signalStore(
  { providedIn: 'root' },
  withState<ProviderUsageState>({ usage: {}, askedAt: {} }),
  withProps(() => ({ _policy: inject(RENDERER_POLICY) })),
  withMethods((store) => {
    const api = inject(ApiClient);
    const inflight = new Map<string, Promise<void>>();

    async function ask(id: string, refresh: boolean): Promise<void> {
      patchState(store, (s) => ({ askedAt: { ...s.askedAt, [id]: Date.now() } }));
      try {
        const usage = await unwrap(
          usageGet({ client: api.client, path: { id }, query: { refresh: refresh ? '1' : undefined } }),
        );
        const answer = usage && 'windows' in usage ? usage : null;
        patchState(store, (s) => ({ usage: { ...s.usage, [id]: answer } }));
      } catch {
        // A provider that does not answer shows nothing; the next refresh tries again.
        patchState(store, (s) => ({ usage: { ...s.usage, [id]: null } }));
      }
    }

    return {
      /** Asks for these providers unless an answer is fresh; resolves when every answer is in. */
      async refresh(ids: readonly string[], force = false): Promise<void> {
        const now = Date.now();
        await Promise.all(
          [...new Set(ids)].map((id) => {
            const pending = inflight.get(id);
            if (pending) return pending;
            if (!force && id in store.askedAt() && now - store.askedAt()[id] < store._policy.providerUsageFreshMs)
              return Promise.resolve();
            const running = ask(id, force).finally(() => inflight.delete(id));
            inflight.set(id, running);
            return running;
          }),
        );
      },
      /** `providers` with `usage` filled in from the answers so far (absent for a provider not asked yet). */
      withUsage<T extends Pick<ProviderInfo, 'id'>>(
        providers: readonly T[],
      ): Array<T & { usage?: ProviderUsage | null }> {
        const usage = store.usage();
        return providers.map((p) => (p.id in usage ? { ...p, usage: usage[p.id] } : p));
      },
    };
  }),
);
export type ProviderUsageStore = InstanceType<typeof ProviderUsageStore>;
