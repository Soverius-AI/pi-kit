import { Language } from '@pi-kit/i18n';
import { inject } from '@angular/core';
import { patchState, signalStore, withHooks, withMethods, withState } from '@ngrx/signals';
import { ApiClient, errorMessage, settingsDiagnose, settingsRevokeTrust, settingsTrustList, unwrap } from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { Diagnostics, TrustList } from '@pi-kit/protocol';
import { SettingsStore } from './settings.store';

export const AdvancedSettingsStore = signalStore(
  withState<{ diagnostics: Diagnostics | undefined; trustList: TrustList | undefined }>({
    diagnostics: undefined,
    trustList: undefined,
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const toasts = inject(ToastStore);
    const dialog = inject(SettingsStore);
    const methods = {
      async loadDiagnostics(): Promise<void> {
        try {
          patchState(store, { diagnostics: await unwrap(settingsDiagnose({ client: api.client })) });
        } catch (error) {
          toasts.show(
            'error',
            translate('settings.withSettingsActions.couldNotReadTheDiagnostics', { value1: errorMessage(error) }),
          );
        }
      },
      async loadTrustList(): Promise<void> {
        try {
          patchState(store, { trustList: await unwrap(settingsTrustList({ client: api.client })) });
        } catch (error) {
          toasts.show(
            'error',
            translate('settings.withSettingsActions.couldNotReadPiSTrustList', { value1: errorMessage(error) }),
          );
        }
      },
      async revokeTrust(path: string): Promise<void> {
        const result = await dialog.save(
          () => unwrap(settingsRevokeTrust({ client: api.client, body: { path } })),
          translate('settings.withSettingsActions.piCouldNotForgetTheAnswer'),
        );
        if (!result) return;
        patchState(store, { trustList: { file: result.file, entries: result.entries } });
        if (result.running > 0) toasts.show('info', translate('settings.withSettingsActions.aRunIsGoingInThatFolder'));
        void dialog.loadFolders();
      },
      async copyDiagnostics(): Promise<void> {
        if (!store.diagnostics()) await methods.loadDiagnostics();
        const d = store.diagnostics();
        if (!d) return;
        const lines = [
          translate('settings.withSettingsActions.piKitOnNode', {
            value1: d.app.version,
            value2: d.backend.desktop
              ? translate('settings.withSettingsActions.desktop')
              : translate('settings.withSettingsActions.browser'),
            value3: d.backend.dev ? translate('settings.withSettingsActions.development') : '',
            value4: d.app.platform,
            value5: d.app.arch,
            value6: d.app.node,
          }),
          translate('settings.withSettingsActions.piAt', {
            value1: d.pi.version,
            value2: d.pi.source,
            value3: d.pi.packageDir,
          }),
          translate('settings.withSettingsActions.backendPidBootIdStarted', {
            value1: d.backend.host,
            value2: d.backend.port,
            value3: d.backend.pid,
            value4: d.backend.bootId,
            value5: new Date(d.backend.startedAt).toISOString(),
          }),
          translate('settings.withSettingsActions.agentFolder', { value1: d.pi.agentDir }),
          translate('settings.withSettingsActions.dataFolder', { value1: d.paths.dataDir }),
          translate('settings.withSettingsActions.database', { value1: d.paths.database }),
          translate('settings.withSettingsActions.logFolder', { value1: d.paths.logDir }),
          ...d.logs.map((l) =>
            translate('settings.withSettingsActions.bytes', {
              value1: l.name,
              value2: l.size,
              value3: new Date(l.modified).toISOString(),
            }),
          ),
          ...(d.flags.length > 0
            ? [translate('settings.withSettingsActions.flags'), ...d.flags.map((f) => `  ${f.name}=${f.value}`)]
            : []),
        ];
        try {
          await navigator.clipboard.writeText(lines.join('\n'));
          toasts.show('success', translate('settings.withSettingsActions.diagnosticsCopied'), 2500);
        } catch {
          toasts.show('error', translate('settings.withSettingsActions.theBrowserDidNotAllowCopyingSelect'));
        }
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      void store.loadDiagnostics();
      void store.loadTrustList();
    },
  }),
);
export type AdvancedSettingsStore = InstanceType<typeof AdvancedSettingsStore>;
