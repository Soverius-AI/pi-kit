import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import { signalStoreFeature, withComputed, withProps, withState } from '@ngrx/signals';
import { ViewPrefs, withLatestRequest, withRequestStatus } from '@pi-kit/data-access';
import { groupProviders, type KeybindingInfo } from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';
import { settingsSections, findConflicts, matchCounts, searchSettings, shortcutBindings } from '@pi-kit/ui';
import { ConnectorsStore } from '../connectors.store';
import { SETTINGS_POLICY } from '../settings-policy';
import { type SettingsStoreState } from './settings-state';

import { withSettingsSave } from './with-settings-save';

export function withSettingsState() {
  return signalStoreFeature(
    withState<
      Omit<SettingsStoreState, 'saving' | 'saved' | 'reloadReasons' | 'flow' | 'keyWorkflow' | 'credentialsChanged'>
    >({
      section: 'general',
      project: undefined,
      search: '',
      overview: undefined,
      reloading: false,
      resources: undefined,
      resourcesBusy: [],
      diagnostics: undefined,
      trustList: undefined,
      folders: {},
    }),
    withProps(() => ({ _policy: inject(SETTINGS_POLICY) })),
    withRequestStatus(),
    withLatestRequest(),
    withSettingsSave(),
    withComputed((store) => {
      const translate = inject(Language).t;
      const prefs = inject(ViewPrefs);
      const threads = inject(ThreadsStore);
      const mcp = inject(ConnectorsStore);
      const matches = computed(() => searchSettings(translate, store.search()));
      const piBindings = computed<KeybindingInfo[]>(() => store.overview()?.keybindings ?? []);
      const kitCombos = computed(() => prefs.combos());
      return {
        settings: computed(() => store.overview()?.settings),
        /** The ids of the settings the search matches (all of them while it is empty). */
        matches,
        searching: computed(() => store.search().trim() !== ''),
        /** The sections to draw: the chosen one, or every section with a match while searching. */
        visibleSections: computed(() =>
          store.search().trim() === ''
            ? [store.section()]
            : settingsSections(translate)
                .map((s) => s.id)
                .filter((id) => matchCounts(translate, matches()).has(id)),
        ),
        matchCounts: computed(() => matchCounts(translate, matches())),
        workspaces: computed(() => threads.workspaces()),
        piBindings,
        kitCombos,
        piConflicts: computed(() => findConflicts(piBindings())),
        kitConflicts: computed(() => findConflicts(shortcutBindings(translate, kitCombos()))),
        providersSignedIn: computed(
          () => groupProviders((store.overview()?.providers ?? []).filter((p) => p.configured)).length,
        ),
        mcpCount: computed(() => mcp.servers().length),
        resourceCount: computed(() => store.resources()?.items.length),
        /** The pi sessions can be reloaded (a thread is open and no run is going is checked at the time). */
        canReload: computed(() => threads.selectedId() !== undefined),
      };
    }),
  );
}
