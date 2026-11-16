import { Language } from '@pi-kit/i18n';
import { computed, inject, signal } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type,
  withComputed,
  withMethods,
  withProps,
  withState,
  type SignalStoreFeatureType,
} from '@ngrx/signals';
import { ApiClient, errorMessage, settingsPatch, settingsValues, unwrap } from '@pi-kit/api';
import { withLatestRequest } from '@pi-kit/data-access';
import type { PatchPiSettings } from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';
import { SettingsStore } from '../settings.store';
import { PiSettingsSlice } from './pi-settings-slice';
import { SettingsSlices } from './settings-slices';

export function withPiSettings<_>() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withLatestRequest>>(),
    withState<{ settingsError: string | undefined }>({ settingsError: undefined }),
    withProps(() => {
      const threads = inject(ThreadsStore);
      const slices = inject(SettingsSlices);
      const sliceOf = (folder: string | undefined): PiSettingsSlice =>
        slices.share(`settings:${folder ?? ''}`, () => new PiSettingsSlice());
      const folder = threads.selected()?.cwd ?? threads.workspace();
      return { _sliceOf: sliceOf, _piSettings: signal({ folder, slice: sliceOf(folder) }) };
    }),
    withComputed((store) => ({ settings: computed(() => store._piSettings().slice.settings()) })),
    withMethods((store) => {
      const translate = inject(Language).t;
      const api = inject(ApiClient);
      const threads = inject(ThreadsStore);
      const dialog = inject(SettingsStore);
      const methods = {
        async loadSettings(): Promise<void> {
          const current = threads.selected()?.cwd ?? threads.workspace();
          if (current !== store._piSettings().folder && store._piSettings().slice.edits().size === 0)
            store._piSettings.set({ folder: current, slice: store._sliceOf(current) });
          const { folder, slice } = store._piSettings();
          const started = slice.revision;
          const pendingAtStart = slice.edits().size > 0;
          await store._request(
            'settings',
            (signal) => unwrap(settingsValues({ client: api.client, signal, query: { cwd: folder || undefined } })),
            {
              valid: () => store._piSettings().slice === slice,
              next: (settings) => {
                const overtaken = pendingAtStart || started !== slice.revision;
                if (!overtaken || !slice.confirmed()) slice.confirmed.set(settings);
                patchState(store, { settingsError: undefined });
              },
              error: (error) => patchState(store, { settingsError: errorMessage(error) }),
            },
          );
        },
        async patch(patch: PatchPiSettings, reload?: string): Promise<void> {
          const { folder, slice } = store._piSettings();
          const version = ++slice.revision;
          slice.edit(version, patch);
          const pending = slice.mutations.then(() =>
            unwrap(settingsPatch({ client: api.client, query: { cwd: folder || undefined }, body: patch })),
          );
          slice.mutations = pending.catch(() => undefined);
          const saved = await dialog.save(
            () => pending,
            translate('settings.withSettingsActions.piCouldNotSaveTheSetting'),
          );
          if (saved) slice.confirmed.set(saved);
          slice.settle(version);
          if (saved && reload) dialog.markReload(reload);
          if (!saved && slice.edits().size === 0) await methods.loadSettings();
        },
      };
      return methods;
    }),
  );
}
