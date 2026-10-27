import { Language } from '@pi-kit/i18n';
import { DestroyRef, InjectionToken, computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  localRuntimeCancel,
  localRuntimeRetry,
  localRuntimeDismiss,
  localRuntimeStorage,
  localRuntimeCleanup,
  localRuntimeRemoveModel,
  localRuntimeRemoveFile,
  localRuntimeRegister,
  localRuntimeDownload,
  localRuntimeInstall,
  localRuntimeStatus,
  localRuntimeReloadModel,
  localRuntimeStart,
  localRuntimeStop,
  localRuntimeAutostart,
  localRuntimeDoctor,
  localRuntimeRepair,
  unwrap,
} from '@pi-kit/api';
import { ToastStore, withLatestRequest, withPolling } from '@pi-kit/data-access';
import type {
  LocalDoctor,
  LocalModelReload,
  LocalRuntimeJob,
  LocalRuntimeStatus,
  LocalStorage,
  LocalStorageChange,
  ManagedLlamaSwap,
} from '@pi-kit/protocol';
import { LocalModelCatalogStore } from './local-model-catalog.store';
import { SettingsStore } from './settings.store';

export const LOCAL_RUNTIME_POLL_MS = new InjectionToken<number>('LOCAL_RUNTIME_POLL_MS', {
  providedIn: 'root',
  factory: () => 1000,
});
const active = (job: LocalRuntimeJob | undefined): boolean => job?.state === 'running' || job?.state === 'cancelling';

/** Root lifetime keeps progress alive after the wizard closes. Reads never overwrite a newer accepted mutation. */
export const LocalRuntimeStore = signalStore(
  { providedIn: 'root' },
  withState({
    status: undefined as LocalRuntimeStatus | undefined,
    actionError: undefined as string | undefined,
    statusError: undefined as string | undefined,
    retryAvailable: false,
    storage: undefined as LocalStorage | undefined,
    /** What the doctor found about the selected llama-swap config. */
    doctor: undefined as LocalDoctor | undefined,
  }),
  withLatestRequest(),
  withPolling(),
  withComputed((store) => ({
    canRetry: computed(
      () =>
        store.retryAvailable() ||
        (!!store.status()?.job?.action &&
          store.status()?.job?.action?.kind !== 'start' &&
          ['cancelled', 'failed'].includes(store.status()?.job?.state ?? '')),
    ),
    storageLoading: computed(() => store._requestStates()['local-storage']?.status === 'loading'),
    /** The llama-swap pi-kit started (or could start) for the selected config. */
    managed: computed<ManagedLlamaSwap | undefined>(() => store.status()?.managed),
    checking: computed(() => store._requestStates()['local-doctor']?.status === 'loading'),
    active: computed(() => active(store.status()?.job)),
    submitting: computed(() => store._requestStates()['local-mutation']?.status === 'loading'),
    error: computed(() => store.actionError() || store.statusError() || store.status()?.error),
  })),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient),
      toasts = inject(ToastStore),
      catalog = inject(LocalModelCatalogStore),
      settings = inject(SettingsStore);
    const intervalMs = inject(LOCAL_RUNTIME_POLL_MS),
      destroyRef = inject(DestroyRef);
    let views = 0,
      revision = 0,
      polling = false;
    let retry: (() => Promise<void>) | undefined;
    let retryJobId: string | undefined;
    let reloadErrorToast: string | undefined;
    const loadStorage = async (): Promise<void> => {
      await store._request('local-storage', (signal) => unwrap(localRuntimeStorage({ client: api.client, signal })), {
        next: (storage) => patchState(store, { storage }),
        error: (error) => patchState(store, { actionError: errorMessage(error) }),
      });
    };
    const observed = new Set<string>();
    const stopPolling = (): void => {
      polling = false;
      store._stopPolling('local-runtime');
    };
    const publish = (status: LocalRuntimeStatus): void => {
      patchState(store, {
        status,
        statusError: undefined,
        ...(status.job?.id !== retryJobId ? { retryAvailable: false } : {}),
      });
      const job = status.job;
      if (job?.kind === 'reload' && active(job) && reloadErrorToast) {
        for (const toast of toasts.items()) if (toast.text === reloadErrorToast) toasts.dismiss(toast.id);
        reloadErrorToast = undefined;
      }
      if (job && active(job)) observed.add(job.id);
      if (job && !active(job) && observed.delete(job.id)) {
        if (job.state === 'complete') {
          if (job.kind === 'download' && job.model) catalog.rememberDownload(job.model.id);
          toasts.show(
            'success',
            job.kind === 'reload'
              ? job.detail
              : job.kind === 'benchmark'
                ? translate('settings.localRuntimeStore.localMeasurementComplete')
                : translate('settings.localRuntimeStore.localSetupComplete'),
          );
        } else if (job.state === 'failed') {
          const message =
            job.kind === 'reload'
              ? translate('settings.modelManagement.modelReloadFailed') + ': ' + (job.error ?? job.detail)
              : translate('settings.localRuntimeStore.localSetupFailed', { value1: job.error ?? job.detail });
          if (job.kind === 'reload') reloadErrorToast = message;
          toasts.show('error', message);
        } else toasts.show('info', translate('settings.localRuntimeStore.localSetupCancelled'));
        void Promise.all([catalog.detect(), settings.load(), loadStorage()]).catch(() => undefined);
      }
      if (!views && !active(job)) stopPolling();
    };
    const ensurePolling = (): void => {
      if (polling || destroyRef.destroyed) return;
      polling = true;
      store._startPolling('local-runtime', {
        intervalMs,
        run: async (signal) => {
          if (store.submitting()) return;
          const before = revision;
          await store._request('local-status', (signal) => unwrap(localRuntimeStatus({ client: api.client, signal })), {
            signal,
            valid: () => revision === before && !store.submitting(),
            next: publish,
            error: (error) => {
              patchState(store, { statusError: errorMessage(error) });
              if (!views && !store.active()) stopPolling();
            },
          });
        },
      });
    };
    const perform = async (
      request: (
        signal: AbortSignal,
      ) => Promise<LocalRuntimeJob | LocalRuntimeStatus | LocalStorageChange | ManagedLlamaSwap | LocalDoctor>,
      repeat?: () => Promise<void>,
      allowActive = false,
    ): Promise<void> => {
      if (store.submitting() || (store.active() && !allowActive)) return;
      revision++;
      store._cancelRequest('local-status');
      patchState(store, { actionError: undefined });
      if (repeat) {
        retry = repeat;
        patchState(store, { retryAvailable: true });
      }
      await store._request('local-mutation', request, {
        next: (result) => {
          if ('storage' in result) {
            patchState(store, { storage: result.storage });
            void catalog.detect().catch(() => undefined);
          } else if ('canStart' in result) {
            publish({ ...(store.status() ?? { autostart: false }), managed: result });
            void Promise.all([catalog.detect(), settings.load()]).catch(() => undefined);
          } else if ('issues' in result) {
            patchState(store, { doctor: result });
            void catalog.detect().catch(() => undefined);
          } else if ('kind' in result) {
            retryJobId = result.id;
            observed.add(result.id);
            publish({ ...(store.status() ?? { autostart: false }), job: result });
          } else publish(result);
        },
        error: (error) => patchState(store, { actionError: errorMessage(error) }),
      });
      revision++;
      ensurePolling();
    };
    const methods = {
      /** Starts llama-swap with the selected config; `autostart` saves whether it starts with the app. */
      start(autostart?: boolean): Promise<void> {
        return perform((signal) =>
          unwrap(localRuntimeStart({ client: api.client, body: autostart === undefined ? {} : { autostart }, signal })),
        );
      },
      stop(): Promise<void> {
        return perform((signal) => unwrap(localRuntimeStop({ client: api.client, signal })));
      },
      /** "Start llama-swap when pi-kit starts", saved at once. */
      setAutostart(enabled: boolean): Promise<void> {
        return perform((signal) => unwrap(localRuntimeAutostart({ client: api.client, body: { enabled }, signal })));
      },
      /** What keeps the selected config from running; Repair applies the fixable findings. */
      async loadDoctor(): Promise<void> {
        await store._request('local-doctor', (signal) => unwrap(localRuntimeDoctor({ client: api.client, signal })), {
          next: (doctor) => patchState(store, { doctor }),
          error: (error) => patchState(store, { actionError: errorMessage(error) }),
        });
      },
      repair(): Promise<void> {
        const doctor = store.doctor();
        if (!doctor?.version) return Promise.resolve();
        return perform((signal) =>
          unwrap(
            localRuntimeRepair({
              client: api.client,
              body: { configPath: doctor.configPath, version: doctor.version! },
              signal,
            }),
          ),
        );
      },
      reloadModel(input: LocalModelReload): Promise<void> {
        return perform((signal) => unwrap(localRuntimeReloadModel({ client: api.client, body: input, signal })));
      },
      /** Each open view leases observation; an active backend job keeps polling after the last view leaves. */
      observe(): () => void {
        views++;
        void loadStorage();
        ensurePolling();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          views--;
          if (!views && !store.active() && !store.submitting()) stopPolling();
        };
      },
      loadStorage,
      retry(): Promise<void> {
        const job = store.status()?.job;
        if (job?.action && job.action.kind !== 'start' && ['cancelled', 'failed'].includes(job.state))
          return perform((signal) => unwrap(localRuntimeRetry({ client: api.client, signal })));
        return job?.id === retryJobId ? (retry?.() ?? Promise.resolve()) : Promise.resolve();
      },
      dismiss(): Promise<void> {
        retry = undefined;
        retryJobId = undefined;
        patchState(store, { retryAvailable: false });
        return perform((signal) => unwrap(localRuntimeDismiss({ client: api.client, signal })));
      },
      cleanup(): Promise<void> {
        return perform((signal) => unwrap(localRuntimeCleanup({ client: api.client, signal })));
      },
      removeModel(modelId: string): Promise<void> {
        return perform((signal) =>
          unwrap(localRuntimeRemoveModel({ client: api.client, body: { modelId, accept: true }, signal })),
        );
      },
      removeFile(id: string): Promise<void> {
        return perform((signal) =>
          unwrap(localRuntimeRemoveFile({ client: api.client, body: { id, accept: true }, signal })),
        );
      },
      async register(modelId: string): Promise<void> {
        await perform((signal) => unwrap(localRuntimeRegister({ client: api.client, body: { modelId }, signal })));
        await Promise.all([catalog.detect(), settings.load()]);
      },
      install(tools: ('llama.cpp' | 'llama-swap')[]): Promise<void> {
        const chosen = [...tools];
        return perform(
          (signal) => unwrap(localRuntimeInstall({ client: api.client, body: { tools: chosen }, signal })),
          () => methods.install(chosen),
        );
      },
      download(selection: string): Promise<void> {
        return perform(
          (signal) => unwrap(localRuntimeDownload({ client: api.client, body: { selection, accept: true }, signal })),
          () => methods.download(selection),
        );
      },
      cancel(): Promise<void> {
        return perform((signal) => unwrap(localRuntimeCancel({ client: api.client, signal })), undefined, true);
      },
    };
    return methods;
  }),
);
