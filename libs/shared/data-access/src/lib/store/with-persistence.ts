import { inject } from '@angular/core';
import { getState, patchState, signalStoreFeature, type, withHooks, withMethods, withProps } from '@ngrx/signals';
import { ApiClient, appSettingsSetSetting, appSettingsSettings, unwrap } from '@pi-kit/api';

let nativeStorage: Map<string, string> | undefined;

/** Await before Angular bootstrap so its synchronous preference selectors only consult memory on desktop. */
export async function prepareUiStorage(): Promise<void> {
  const values = await window.piKit?.getUiStorage?.().catch(() => ({}));
  nativeStorage = values ? new Map(Object.entries(values)) : undefined;
}

/** `localStorage` that never throws (a private window, blocked site data): reads give `null`, writes do nothing. */
export function readStorage(key: string): string | null {
  if (nativeStorage) return nativeStorage.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  if (nativeStorage) {
    nativeStorage.set(key, value);
    void window.piKit?.setUiStorage?.(key, value).catch(() => undefined);
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice then lasts until the page is closed.
  }
}

export interface PersistenceConfig<S extends object> {
  /** The first-paint copy in `localStorage`, read once when the store is created. */
  readLocal?: () => Partial<S>;
  /** Writes that copy; called after every change that goes through `persist` and after the backend's values arrive. */
  writeLocal?: (state: S) => void;
  /** The backend's SQLite (`settings` table, the source of truth): which state key is which setting, and how to read the saved object back (validating it). */
  remote?: { keys: { [K in keyof S]?: string }; parse: (saved: Record<string, unknown>) => Partial<S> };
}

/**
 * Preferences that outlive the window: a copy in `localStorage` so the first paint is right, and the backend's SQLite as the source of
 * truth (`PUT /api/settings/:key`). `persist` changes state, copy and backend in one call and resolves to whether the backend took it;
 * `loadPersisted` reads the saved values once the backend answers. A store with only a local copy leaves `remote` out.
 */
export function withPersistence<S extends object>(config: PersistenceConfig<S>) {
  return signalStoreFeature(
    { state: type<S>() },
    withProps(() => ({ _uiSettings: config.remote ? inject(ApiClient) : undefined })),
    withMethods((store) => {
      const revisions = new Map<keyof S, number>();
      const writes = new Map<keyof S, Promise<boolean>>();
      let loading: Promise<void> | undefined;
      return {
        async persist(patch: Partial<S>): Promise<boolean> {
          const keys = Object.keys(patch) as (keyof S)[];
          for (const key of keys) revisions.set(key, (revisions.get(key) ?? 0) + 1);
          patchState(store, patch);
          config.writeLocal?.(getState(store) as unknown as S);
          const remote = config.remote;
          if (!remote) return true;
          const results = await Promise.all(
            keys.map(async (key) => {
              const name = remote.keys[key];
              if (!name) return true;
              const write = async (): Promise<boolean> => {
                try {
                  await unwrap(
                    appSettingsSetSetting({
                      client: store._uiSettings!.client,
                      path: { key: name },
                      body: { value: patch[key] },
                    }),
                  );
                  return true;
                } catch {
                  return false;
                }
              };
              // Preserve invocation order per setting; unrelated settings can still save together.
              const previous = writes.get(key);
              const pending = previous ? previous.then(write) : write();
              writes.set(key, pending);
              try {
                return await pending;
              } finally {
                if (writes.get(key) === pending) writes.delete(key);
              }
            }),
          );
          return results.every(Boolean);
        },
        /** Hydration never overwrites an edit made or still being saved during the read. */
        loadPersisted(): Promise<void> {
          if (!config.remote) return Promise.resolve();
          if (loading) return loading;
          const remote = config.remote;
          const before = new Map(revisions);
          const pendingAtStart = new Set(writes.keys());
          const read = async (): Promise<void> => {
            try {
              const saved = await unwrap(appSettingsSettings({ client: store._uiSettings!.client }));
              const parsed = remote.parse(saved);
              for (const key of Object.keys(parsed) as (keyof S)[]) {
                if (pendingAtStart.has(key) || writes.has(key) || before.get(key) !== revisions.get(key))
                  delete parsed[key];
              }
              patchState(store, parsed);
              config.writeLocal?.(getState(store) as unknown as S);
            } catch {
              // The backend is not up yet; the cached choices stay.
            }
          };
          loading = read().finally(() => {
            loading = undefined;
          });
          return loading;
        },
      };
    }),
    withHooks({
      onInit(store) {
        const local = config.readLocal?.();
        if (local) patchState(store, local);
      },
    }),
  );
}
