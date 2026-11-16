import { Language } from '@pi-kit/i18n';
import { inject } from '@angular/core';
import { patchState, signalStoreFeature, type, withMethods, type SignalStoreFeatureType } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  sessionReload,
  settingsKeybindings,
  settingsListResources,
  settingsProviders,
  settingsToggleResource,
  settingsTrustState,
  unwrap,
} from '@pi-kit/api';
import { ChatStore, VoiceStore, type VoicePrefs } from '@pi-kit/chat/api';
import { ThemeStore, ToastStore, ViewPrefs, type PrefKey, type ThemePreference } from '@pi-kit/data-access';
import type { KeybindingInfo, ProviderInfo } from '@pi-kit/protocol';
import { ThreadsStore, TrustStore } from '@pi-kit/threads/api';
import type { SettingsSectionId } from '@pi-kit/ui';

import { withSettingsState } from './with-settings-state';
export function withSettingsActions<_>() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withSettingsState>>(),
    withMethods((store) => {
      const translate = inject(Language).t;
      const api = inject(ApiClient);
      const prefs = inject(ViewPrefs);
      const theme = inject(ThemeStore);
      const threads = inject(ThreadsStore);
      const toasts = inject(ToastStore);
      const trustGate = inject(TrustStore);
      const chat = inject(ChatStore);
      const voice = inject(VoiceStore);

      const cwd = (): string | undefined => threads.selected()?.cwd ?? threads.workspace();
      const track = store._trackSave;
      const needReload = store._needReload;
      const refreshers = new Set<() => Promise<void>>();
      let sweeping: Promise<void> | undefined;
      let sweepAgain = false;
      const methods = {
        /** Runs a save for a section that keeps its own state (the attendant): the spinner and the "Saved" tick, a toast when it fails. */
        save: <T>(work: () => Promise<T>, failure: string): Promise<T | undefined> => track(work, failure),

        // ---- navigation

        select(section: SettingsSectionId): void {
          patchState(store, { section, search: '', project: undefined });
        },
        /** Opens the page of a project (it slides in over the list); Back and `select` of any section close it. */
        openProject(cwd: string): void {
          patchState(store, { section: 'projects', project: cwd, search: '' });
        },
        closeProject(): void {
          patchState(store, { project: undefined });
        },
        setSearch(search: string): void {
          patchState(store, { search });
        },
        /** Is any of these settings shown, given the search? Groups hide themselves when none of their rows is. */
        shows(...ids: string[]): boolean {
          const matches = store.matches();
          return ids.some((id) => matches.has(id));
        },

        // ---- loading

        async loadProviders(): Promise<void> {
          await store._request('providers', (signal) => unwrap(settingsProviders({ client: api.client, signal })), {
            next: (providers) => patchState(store, { providers }),
          });
        },
        onProvidersChanged(refresh: () => Promise<void>): () => void {
          refreshers.add(refresh);
          return () => refreshers.delete(refresh);
        },
        async providersChanged(): Promise<void> {
          await Promise.all([methods.loadProviders(), ...[...refreshers].map((refresh) => refresh())]);
        },
        async loadResources(): Promise<void> {
          const folder = cwd();
          await store._request(
            'resources',
            (signal) =>
              unwrap(settingsListResources({ client: api.client, signal, query: { cwd: folder || undefined } })),
            {
              valid: () => cwd() === folder,
              next: (resources) => patchState(store, { resources }),
              error: (error) =>
                patchState(store, { resources: { items: [], projectSkipped: false, errors: [errorMessage(error)] } }),
            },
          );
        },
        async loadKeybindings(): Promise<void> {
          await store._request('keybindings', (signal) => unwrap(settingsKeybindings({ client: api.client, signal })), {
            next: (keybindings) => patchState(store, { keybindings }),
          });
        },
        showKeybindings(keybindings: KeybindingInfo[]): void {
          patchState(store, { keybindings });
        },
        showProviders(providers: ProviderInfo[]): void {
          patchState(store, { providers });
        },
        loadFolders(): Promise<void> {
          if (sweeping) {
            sweepAgain = true;
            return sweeping;
          }
          sweeping = (async () => {
            do {
              sweepAgain = false;
              for (const workspace of threads.workspaces()) {
                try {
                  const state = await unwrap(settingsTrustState({ client: api.client, path: { id: workspace.cwd } }));
                  patchState(store, (s) => ({ folders: { ...s.folders, [workspace.cwd]: state } }));
                } catch {
                  // the folder is gone or not readable; the row says "unknown"
                }
              }
            } while (sweepAgain);
          })().finally(() => (sweeping = undefined));
          return sweeping;
        },

        // ---- pi-kit’s preferences (ViewPrefs, ThemeStore)

        async setPref(key: PrefKey, value: unknown): Promise<void> {
          const ok = await track(async () => {
            if (!(await prefs.set(key, value as never)))
              throw new Error(translate('settings.withSettingsActions.piKitSDatabaseDidNotTake'));
            return true;
          }, translate('settings.withSettingsActions.couldNotSaveTheSetting'));
          if (!ok) await prefs.load();
        },
        /** Settings › Voice: language, how the push-to-talk key behaves, live words, send when done. */
        async setVoice<K extends keyof VoicePrefs>(key: K, value: VoicePrefs[K]): Promise<void> {
          await track(async () => {
            if (!(await voice.set(key, value)))
              throw new Error(translate('settings.withSettingsActions.piKitSDatabaseDidNotTake'));
            return true;
          }, translate('settings.withSettingsActions.couldNotSaveTheSetting'));
        },
        async setTheme(preference: ThemePreference): Promise<void> {
          await track(() => theme.set(preference), translate('settings.withSettingsActions.couldNotSaveTheTheme'));
        },
        // ---- extensions, skills, prompt templates

        async toggleResource(key: string, enabled: boolean): Promise<void> {
          patchState(store, (s) => ({ resourcesBusy: [...s.resourcesBusy, key] }));
          const resources = await track(
            () =>
              unwrap(
                settingsToggleResource({
                  client: api.client,
                  query: { cwd: cwd() || undefined },
                  body: { key, enabled },
                }),
              ),
            translate('settings.withSettingsActions.piCouldNotChangeTheSetting'),
          );
          patchState(store, (s) => ({
            resourcesBusy: s.resourcesBusy.filter((k) => k !== key),
            ...(resources ? { resources } : {}),
          }));
          if (resources) needReload(translate('settings.withSettingsActions.extensionsAndSkills'));
        },

        // ---- reload

        /** `/reload` for the open thread: keybindings, extensions, skills, prompts and context files are read again. */
        async reload(): Promise<void> {
          const thread = threads.selectedId();
          if (!thread)
            return void toasts.show(
              'warning',
              translate('settings.withSettingsActions.openAThreadFirstTheReloadApplies'),
            );
          if (chat.running())
            return void toasts.show('warning', translate('settings.withSettingsActions.stopTheRunFirstPiCannotReload'));
          patchState(store, { reloading: true });
          try {
            await unwrap(sessionReload({ client: api.client, path: { id: thread } }));
            patchState(store, { reloadReasons: [] });
            toasts.show(
              'success',
              translate('settings.withSettingsActions.reloadedPiReadItsKeybindingsExtensionsSkills'),
              3000,
            );
            void methods.loadResources();
          } catch (error) {
            toasts.show(
              'error',
              translate('settings.withSettingsActions.couldNotReload', { value1: errorMessage(error) }),
            );
          } finally {
            patchState(store, { reloading: false });
          }
        },
        dismissReload(): void {
          patchState(store, { reloadReasons: [] });
        },
        /** Another store changed something the open sessions read only at a reload (a package switched off, a skill saved): the banner says so and offers the reload. */
        markReload(reason: string): void {
          needReload(reason);
        },

        // ---- trust

        reviewFolder(cwdPath: string): Promise<void> {
          return trustGate.review(cwdPath).then(() => methods.loadFolders());
        },
      };
      return methods;
    }),
  );
}
