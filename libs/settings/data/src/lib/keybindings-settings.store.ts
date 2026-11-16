import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withState } from '@ngrx/signals';
import { ApiClient, settingsKeybindings, settingsSaveKeybindings, unwrap } from '@pi-kit/api';
import { ViewPrefs, withLatestRequest, withRequestStatus } from '@pi-kit/data-access';
import type { KeybindingInfo } from '@pi-kit/protocol';
import {
  canonicalCombo,
  changedShortcuts,
  findConflicts,
  isValidPiKey,
  kitShortcuts,
  shortcutBindings,
} from '@pi-kit/ui';
import type { KeybindingsFile } from './settings/settings-state';
import { SettingsStore } from './settings.store';

export const KeybindingsSettingsStore = signalStore(
  withState<{ bindings: KeybindingInfo[] | undefined }>({ bindings: undefined }),
  withRequestStatus(),
  withLatestRequest(),
  withComputed((store) => {
    const translate = inject(Language).t;
    const prefs = inject(ViewPrefs);
    const piBindings = computed(() => store.bindings() ?? []);
    const kitCombos = computed(() => prefs.combos());
    return {
      piBindings,
      kitCombos,
      piConflicts: computed(() => findConflicts(piBindings())),
      kitConflicts: computed(() => findConflicts(shortcutBindings(translate, kitCombos()))),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const dialog = inject(SettingsStore);
    const show = (saved: KeybindingInfo[]): void => {
      patchState(store, { bindings: saved });
      dialog.showKeybindings(saved);
      dialog.markReload(translate('settings.withSettingsActions.piKeybindings'));
    };
    const methods = {
      async load(): Promise<void> {
        store.requestStarted();
        await store._request('keybindings', (signal) => unwrap(settingsKeybindings({ client: api.client, signal })), {
          next: (bindings) => {
            patchState(store, { bindings });
            store.requestDone();
          },
          error: (error) => store.requestFailed(error),
        });
      },
      /** pi’s action gets these keys (an empty list switches it off); `null` goes back to pi’s default. Saved to `keybindings.json`. */
      async setPiKeys(id: string, keys: string[] | null): Promise<boolean> {
        const list = store.piBindings();
        const overrides: Record<string, string[]> = {};
        for (const b of list) if (b.custom && b.id !== id) overrides[b.id] = b.keys;
        if (keys !== null) overrides[id] = keys.map((k) => canonicalCombo(k) ?? k);
        const saved = await dialog.save(
          () => unwrap(settingsSaveKeybindings({ client: api.client, body: { overrides } })),
          translate('settings.withSettingsActions.piCouldNotSaveTheKeybinding'),
        );
        if (!saved) return false;
        show(saved);
        return true;
      },
      /** A pi-kit shortcut gets this combination; `null` goes back to the default. */
      async setShortcut(id: string, combo: string | null): Promise<void> {
        const resolved = { ...store.kitCombos() };
        const fallback = kitShortcuts(translate).find((s) => s.id === id)?.default ?? '';
        resolved[id] = canonicalCombo(combo ?? fallback) ?? fallback;
        await dialog.setPref('shortcuts', changedShortcuts(translate, resolved));
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
          if (!kitShortcuts(translate).some((s) => s.id === id) || typeof combo !== 'string' || !isValidPiKey(combo)) {
            skipped.push(translate('settings.withSettingsActions.piKitShortcut', { value1: id }));
            continue;
          }
          kit[id] = canonicalCombo(combo) as string;
          applied++;
        }
        if (applied > 0) await dialog.setPref('shortcuts', changedShortcuts(translate, kit));
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
          const saved = await dialog.save(
            () => unwrap(settingsSaveKeybindings({ client: api.client, body: { overrides } })),
            translate('settings.withSettingsActions.piCouldNotSaveTheKeybindings'),
          );
          if (saved) {
            show(saved);
            applied += piApplied;
          }
        }
        return { applied, skipped };
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      void store.load();
    },
  }),
);
export type KeybindingsSettingsStore = InstanceType<typeof KeybindingsSettingsStore>;
