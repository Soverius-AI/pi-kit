import { Language } from '@pi-kit/i18n';
import { inject } from '@angular/core';
import { patchState, signalStoreFeature, type, withMethods, type SignalStoreFeatureType } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  sessionReload,
  settingsDiagnose,
  settingsListResources,
  settingsOverview,
  settingsPatch,
  settingsRevokeTrust,
  settingsSaveKeybindings,
  settingsToggleResource,
  settingsTrustList,
  settingsTrustState,
  unwrap,
} from '@pi-kit/api';
import { ChatStore, VoiceStore, type VoicePrefs } from '@pi-kit/chat/api';
import { ThemeStore, ToastStore, ViewPrefs, type PrefKey, type ThemePreference } from '@pi-kit/data-access';
import type { PatchPiSettings, PiSettings } from '@pi-kit/protocol';
import { ThreadsStore, TrustStore } from '@pi-kit/threads/api';
import {
  kitShortcuts,
  canonicalCombo,
  changedShortcuts,
  isValidPiKey,
  shortcutLabel,
  type SettingsSectionId,
} from '@pi-kit/ui';

import type { KeybindingsFile } from './settings-state';
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
      type Folder = ReturnType<typeof cwd>;
      let overviewFor: Folder;
      let nextEdit = 0;
      let mutations: Promise<unknown> = Promise.resolve();
      const revisions = new Map<Folder, number>();
      const confirmed = new Map<Folder, PiSettings>();
      const edits = new Map<number, { folder: Folder; patch: PatchPiSettings }>();
      const hasEdits = (folder: Folder): boolean => [...edits.values()].some((edit) => edit.folder === folder);
      const applyEdits = (folder: Folder, settings: PiSettings): PiSettings => {
        for (const edit of edits.values()) {
          if (edit.folder !== folder) continue;
          const { defaultModel, ...plain } = edit.patch;
          settings = {
            ...settings,
            ...plain,
            ...(defaultModel ? { defaultProvider: defaultModel.provider, defaultModel: defaultModel.modelId } : {}),
          };
        }
        return settings;
      };
      const publishSettings = (folder: Folder): void => {
        const settings = confirmed.get(folder);
        if (cwd() !== folder || overviewFor !== folder || !settings) return;
        patchState(store, (s) =>
          s.overview ? { overview: { ...s.overview, settings: applyEdits(folder, settings) } } : {},
        );
      };

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

        async load(): Promise<void> {
          store.requestStarted();
          const folder = cwd();
          const revision = revisions.get(folder);
          const pendingAtStart = hasEdits(folder);
          await store._request(
            'overview',
            (signal) => unwrap(settingsOverview({ client: api.client, signal, query: { cwd: folder || undefined } })),
            {
              valid: () => cwd() === folder,
              next: (overview) => {
                // A read begun before a save settled cannot replace its confirmed result or newer optimistic edits.
                const changed = pendingAtStart || revision !== revisions.get(folder);
                const settings = changed ? (confirmed.get(folder) ?? overview.settings) : overview.settings;
                confirmed.set(folder, settings);
                overviewFor = folder;
                patchState(store, { overview: { ...overview, settings: applyEdits(folder, settings) } });
                store.requestDone();
              },
              error: (error) => store.requestFailed(error),
            },
          );
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
        async loadFolders(): Promise<void> {
          for (const workspace of threads.workspaces()) {
            try {
              const state = await unwrap(settingsTrustState({ client: api.client, path: { id: workspace.cwd } }));
              patchState(store, (s) => ({ folders: { ...s.folders, [workspace.cwd]: state } }));
            } catch {
              // the folder is gone or not readable; the row says "unknown"
            }
          }
        },

        // ---- pi’s settings

        /** A change to pi’s `settings.json`: the dialog shows it at once, pi saves it, the tick follows. */
        async patch(patch: PatchPiSettings, reload?: string): Promise<void> {
          const folder = cwd();
          const version = ++nextEdit;
          revisions.set(folder, version);
          const overview = store.overview();
          if (overview && overviewFor === folder && !confirmed.has(folder)) confirmed.set(folder, overview.settings);
          edits.set(version, { folder, patch });
          store._cancelRequest('overview');
          if (store.loading()) store.requestDone();
          publishSettings(folder);
          // Keep server writes in invocation order and retain the original folder while they wait.
          const pending = mutations.then(() =>
            unwrap(settingsPatch({ client: api.client, query: { cwd: folder || undefined }, body: patch })),
          );
          mutations = pending.catch(() => undefined);
          const settings = await track(
            () => pending,
            translate('settings.withSettingsActions.piCouldNotSaveTheSetting'),
          );
          edits.delete(version);
          if (settings) confirmed.set(folder, settings);
          publishSettings(folder);
          if (cwd() !== folder || overviewFor !== folder) return;
          if (settings) {
            if (reload) needReload(reload);
          } else if (!hasEdits(folder)) await methods.load();
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
        async setProviderDefault(provider: string, modelId: string | null): Promise<void> {
          const next = { ...prefs.providerDefaults() };
          if (modelId) next[provider] = modelId;
          else delete next[provider];
          await methods.setPref('providerDefaults', next);
          // The provider that new threads start with has its default model in pi’s settings too.
          const settings = store.settings();
          if (modelId && settings?.defaultProvider === provider)
            await methods.patch({ defaultModel: { provider, modelId } });
        },

        // ---- scoped models

        /** The scoped models in cycling order; `null` puts every model in scope. */
        async setScope(patterns: string[] | null): Promise<void> {
          await methods.patch({ enabledModels: patterns && patterns.length > 0 ? patterns : null });
        },

        // ---- keybindings

        /** pi’s action gets these keys (an empty list switches it off); `null` goes back to pi’s default. Saved to `keybindings.json`. */
        async setPiKeys(id: string, keys: string[] | null): Promise<boolean> {
          const list = store.piBindings();
          const overrides: Record<string, string[]> = {};
          for (const b of list) if (b.custom && b.id !== id) overrides[b.id] = b.keys;
          if (keys !== null) overrides[id] = keys.map((k) => canonicalCombo(k) ?? k);
          const saved = await track(
            () => unwrap(settingsSaveKeybindings({ client: api.client, body: { overrides } })),
            translate('settings.withSettingsActions.piCouldNotSaveTheKeybinding'),
          );
          if (!saved) return false;
          patchState(store, (s) => (s.overview ? { overview: { ...s.overview, keybindings: saved } } : {}));
          needReload(translate('settings.withSettingsActions.piKeybindings'));
          return true;
        },
        /** A pi-kit shortcut gets this combination; `null` goes back to the default. */
        async setShortcut(id: string, combo: string | null): Promise<void> {
          const resolved = { ...store.kitCombos() };
          const fallback = kitShortcuts(translate).find((s) => s.id === id)?.default ?? '';
          resolved[id] = canonicalCombo(combo ?? fallback) ?? fallback;
          await methods.setPref('shortcuts', changedShortcuts(translate, resolved));
        },
        /** Both sets as JSON text (only what differs from the defaults). */
        exportKeybindings(): string {
          const pi: Record<string, string[]> = {};
          for (const b of store.piBindings()) if (b.custom) pi[b.id] = b.keys;
          const file: KeybindingsFile = {
            format: 'pi-kit-keybindings',
            version: 1,
            'pi-kit': changedShortcuts(translate, store.kitCombos()),
            pi,
          };
          return `${JSON.stringify(file, null, 2)}\n`;
        },
        /** Applies a file made by Export. Unknown ids and unusable keys are skipped and named; the rest is applied even if it clashes (the editor flags clashes). */
        async importKeybindings(text: string): Promise<{ applied: number; skipped: string[] }> {
          const skipped: string[] = [];
          let file: Partial<KeybindingsFile>;
          try {
            file = JSON.parse(text) as Partial<KeybindingsFile>;
          } catch {
            return { applied: 0, skipped: [translate('settings.withSettingsActions.theFileIsNotJSON')] };
          }
          if (file.format !== 'pi-kit-keybindings' || typeof file !== 'object')
            return { applied: 0, skipped: [translate('settings.withSettingsActions.thisIsNotAPiKitKeybindings')] };
          let applied = 0;
          const kit = { ...store.kitCombos() };
          for (const [id, combo] of Object.entries(file['pi-kit'] ?? {})) {
            if (
              !kitShortcuts(translate).some((s) => s.id === id) ||
              typeof combo !== 'string' ||
              !isValidPiKey(combo)
            ) {
              skipped.push(translate('settings.withSettingsActions.piKitShortcut', { value1: id }));
              continue;
            }
            kit[id] = canonicalCombo(combo) as string;
            applied++;
          }
          if (applied > 0) await methods.setPref('shortcuts', changedShortcuts(translate, kit));
          const known = new Set(store.piBindings().map((b) => b.id));
          const overrides: Record<string, string[]> = {};
          for (const b of store.piBindings()) if (b.custom) overrides[b.id] = b.keys;
          let piApplied = 0;
          for (const [id, keys] of Object.entries(file.pi ?? {})) {
            if (
              !known.has(id) ||
              !Array.isArray(keys) ||
              !keys.every((k) => typeof k === 'string' && (k === '' || isValidPiKey(k)))
            ) {
              skipped.push(translate('settings.withSettingsActions.piAction', { value1: id }));
              continue;
            }
            overrides[id] = keys.filter(Boolean);
            piApplied++;
          }
          if (piApplied > 0) {
            const saved = await track(
              () => unwrap(settingsSaveKeybindings({ client: api.client, body: { overrides } })),
              translate('settings.withSettingsActions.piCouldNotSaveTheKeybindings'),
            );
            if (saved) {
              patchState(store, (s) => (s.overview ? { overview: { ...s.overview, keybindings: saved } } : {}));
              needReload(translate('settings.withSettingsActions.piKeybindings'));
              applied += piApplied;
            }
          }
          return { applied, skipped };
        },
        shortcutName: shortcutLabel.bind(undefined, translate),

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

        async revokeTrust(path: string): Promise<void> {
          const result = await track(
            () => unwrap(settingsRevokeTrust({ client: api.client, body: { path } })),
            translate('settings.withSettingsActions.piCouldNotForgetTheAnswer'),
          );
          if (!result) return;
          patchState(store, { trustList: { file: result.file, entries: result.entries } });
          if (result.running > 0)
            toasts.show('info', translate('settings.withSettingsActions.aRunIsGoingInThatFolder'));
          void methods.loadFolders();
        },
        reviewFolder(cwdPath: string): Promise<void> {
          return trustGate.review(cwdPath).then(() => methods.loadFolders());
        },

        // ---- diagnostics

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
  );
}
