import { Language } from '@pi-kit/i18n';
import { computed, effect, inject, untracked } from '@angular/core';
import { signalStoreFeature, type, withHooks } from '@ngrx/signals';
import { UiStore } from '@pi-kit/data-access';
import { ThreadsStore } from '@pi-kit/threads/api';
import { sectionOfTab } from './settings-state';
import type { SettingsSectionId } from '@pi-kit/ui';
export function withSettingsLifecycle<_>() {
  return signalStoreFeature(
    {
      state: type<{ section: SettingsSectionId }>(),
      methods: type<{
        cancelLogin: () => void;
        closeKeyWorkflow: () => void;
        setSearch: (value: string) => void;
        closeProject: () => void;
        select: (section: SettingsSectionId) => void;
        loadProviders: () => Promise<void>;
        loadResources: () => Promise<void>;
        loadKeybindings: () => Promise<void>;
        loadFolders: () => Promise<void>;
        signInTo: (provider: string) => Promise<void>;
      }>(),
    },
    withHooks({
      onInit(store) {
        const translate = inject(Language).t;
        const bus = inject(UiStore);
        const threads = inject(ThreadsStore);
        let wasOpen = false;

        // `UiStore.openSettings(tab, login)` (the sidebar, `/settings`, `/login`, the model chips) opens the dialog; the bus stays the switch because
        // the chat code calls it. Opening reads what the sidebar shows fresh, since the CLI may have changed it; closing ends a sign-in in progress.
        effect((onCleanup) => {
          let active = true;
          onCleanup(() => {
            active = false;
          });
          const open = bus.settings();
          untracked(() => {
            if (!open) {
              if (wasOpen) {
                store.cancelLogin();
                store.closeKeyWorkflow();
                store.setSearch('');
                store.closeProject();
              }
              wasOpen = false;
              return;
            }
            wasOpen = true;
            store.select(sectionOfTab(translate, open.tab));
            void store.loadProviders().then(() => {
              if (active && bus.settings() === open && open.login) void store.signInTo(open.login);
            });
            void store.loadResources();
            void store.loadKeybindings();
          });
        });

        // The folders' trust state is read when the Projects section is open and the set of project folders changes, not on every read of the list.
        const folders = computed(() =>
          threads
            .workspaces()
            .map((workspace) => workspace.cwd)
            .join('\n'),
        );
        effect(() => {
          if (bus.settings() && store.section() === 'projects' && folders()) untracked(() => void store.loadFolders());
        });
      },
    }),
  );
}
