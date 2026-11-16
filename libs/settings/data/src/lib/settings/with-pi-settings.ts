import { Language } from '@pi-kit/i18n';
import { inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type,
  withMethods,
  withState,
  type SignalStoreFeatureType,
} from '@ngrx/signals';
import { ApiClient, errorMessage, settingsPatch, settingsValues, unwrap } from '@pi-kit/api';
import { withLatestRequest } from '@pi-kit/data-access';
import type { PatchPiSettings, PiSettings } from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';
import { SettingsStore } from '../settings.store';
import { SettingsSlices } from './settings-slices';

export function withPiSettings<_>() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withLatestRequest>>(),
    withState<{ settings: PiSettings | undefined; settingsError: string | undefined }>({
      settings: undefined,
      settingsError: undefined,
    }),
    withMethods((store) => {
      const translate = inject(Language).t;
      const api = inject(ApiClient);
      const threads = inject(ThreadsStore);
      const dialog = inject(SettingsStore);
      const slices = inject(SettingsSlices);
      let folder = threads.selected()?.cwd ?? threads.workspace();
      let key = `settings:${folder ?? ''}`;
      const edits = new Map<number, PatchPiSettings>();
      let revision = 0;
      let confirmed = slices.get<PiSettings>(key);
      let mutations: Promise<unknown> = Promise.resolve();
      const publish = (): void => {
        let settings = confirmed;
        if (!settings) return;
        for (const { defaultModel, ...plain } of edits.values())
          settings = {
            ...settings,
            ...plain,
            ...(defaultModel ? { defaultProvider: defaultModel.provider, defaultModel: defaultModel.modelId } : {}),
          };
        patchState(store, { settings });
      };
      publish();
      const methods = {
        async loadSettings(): Promise<void> {
          const current = threads.selected()?.cwd ?? threads.workspace();
          if (current !== folder && edits.size === 0) {
            folder = current;
            key = `settings:${folder ?? ''}`;
            confirmed = slices.get<PiSettings>(key);
            patchState(store, { settings: undefined });
            publish();
          }
          const started = revision;
          const target = folder;
          const slice = key;
          const pendingAtStart = edits.size > 0;
          await store._request(
            'settings',
            (signal) => unwrap(settingsValues({ client: api.client, signal, query: { cwd: target || undefined } })),
            {
              valid: () => slice === key,
              next: (settings) => {
                if (pendingAtStart || started !== revision) confirmed ??= settings;
                else confirmed = settings;
                slices.set(key, confirmed);
                patchState(store, { settingsError: undefined });
                publish();
              },
              error: (error) => patchState(store, { settingsError: errorMessage(error) }),
            },
          );
        },
        async patch(patch: PatchPiSettings, reload?: string): Promise<void> {
          const version = ++revision;
          const target = folder;
          const slice = key;
          confirmed ??= store.settings();
          edits.set(version, patch);
          publish();
          const pending = mutations.then(() =>
            unwrap(settingsPatch({ client: api.client, query: { cwd: target || undefined }, body: patch })),
          );
          mutations = pending.catch(() => undefined);
          const saved = await dialog.save(
            () => pending,
            translate('settings.withSettingsActions.piCouldNotSaveTheSetting'),
          );
          edits.delete(version);
          if (saved && slice === key) confirmed = saved;
          if (saved) slices.set(slice, saved);
          publish();
          if (saved && reload) dialog.markReload(reload);
          if (!saved && edits.size === 0) await methods.loadSettings();
        },
      };
      return methods;
    }),
  );
}
