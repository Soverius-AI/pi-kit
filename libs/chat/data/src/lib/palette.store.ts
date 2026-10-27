import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { computed, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withState } from '@ngrx/signals';
import type { PkMenuGroup, PkMenuItem } from '@pi-kit/design-system';
import { fuzzyFilter } from '@pi-kit/protocol';
import { ThemeStore, ViewPrefs, UiStore } from '@pi-kit/data-access';
import { chipOfCommand } from '@pi-kit/chat/util';
import { ChatStore } from './chat.store';
import { CommandRegistry } from './commands';

interface AppAction {
  id: string;
  name: string;
  description: string;
  hint: string;
}

const appActions = (translate: Translate): AppAction[] => [
  {
    id: 'app:new',
    name: translate('chat.paletteStore.newThread'),
    description: translate('chat.paletteStore.startAThreadInThisFolder'),
    hint: '⌘N',
  },
  {
    id: 'app:theme',
    name: translate('chat.paletteStore.switchTheme'),
    description: translate('chat.paletteStore.lightOrDark'),
    hint: '',
  },
  {
    id: 'app:usage',
    name: translate('chat.paletteStore.showOrHideUsageUnderTurns'),
    description: translate('chat.paletteStore.inOutCacheCostAndTimeOf'),
    hint: '',
  },
];

interface PaletteState {
  query: string;
  selectedId: string | undefined;
}

/**
 * ⌘K: the same command registry as the composer's `/` menu in a dialog, plus the app's own actions.
 * Built-ins run; skills and templates become chips of the composer, extension commands go into it as text to be completed with their arguments. The query, the selected
 * entry, the keyboard and what choosing an entry does are here; the dialog renders them.
 */
export const PaletteStore = signalStore(
  { providedIn: 'root' },
  withState<PaletteState>({ query: '', selectedId: undefined }),
  withComputed(({ query }) => {
    const translate = inject(Language).t;
    const registry = inject(CommandRegistry);
    const groups = computed<PkMenuGroup[]>(() => {
      const q = query();
      const actions = fuzzyFilter(appActions(translate), q, (a) => a.name).map((a): PkMenuItem => ({
        id: a.id,
        name: a.name,
        description: a.description,
        badge: a.hint || 'app',
        badgeClass: 'badge-ghost',
      }));
      return [
        ...(actions.length ? [{ title: translate('chat.paletteStore.app'), items: actions }] : []),
        ...registry.groups(q),
      ];
    });
    return {
      groups,
      /** The selectable entries in order (disabled ones are shown but skipped). */
      flat: computed(() =>
        groups()
          .flatMap((g) => g.items)
          .filter((i) => !i.disabled),
      ),
    };
  }),
  withMethods((store) => {
    const registry = inject(CommandRegistry);
    const chat = inject(ChatStore);
    const ui = inject(UiStore);
    const theme = inject(ThemeStore);
    const prefs = inject(ViewPrefs);

    const methods = {
      setQuery(query: string): void {
        patchState(store, { query });
      },
      hover(id: string): void {
        patchState(store, { selectedId: id });
      },
      close(): void {
        ui.closePalette();
        ui.focusComposer();
      },
      onKey(event: KeyboardEvent): void {
        const flat = store.flat();
        const index = flat.findIndex((i) => i.id === store.selectedId());
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (flat.length)
            patchState(store, {
              selectedId: flat[(index + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length].id,
            });
        } else if (event.key === 'Enter') {
          event.preventDefault();
          const item = flat[Math.max(index, 0)];
          if (item) methods.pick(item);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          methods.close();
        }
      },
      pick(item: PkMenuItem): void {
        if (item.disabled) return;
        ui.closePalette();
        if (item.id === 'app:new') return void registry.newThread();
        if (item.id === 'app:theme') return theme.toggle();
        if (item.id === 'app:usage') return void prefs.setShowUsage(!prefs.showUsage());
        const command = registry.find(item.id);
        if (!command) return;
        if (command.kind === 'action' && !command.argumentHint) return void registry.run(command);
        // A skill or prompt template is a chip of the composer, anything else text to complete.
        const chip = chipOfCommand(command);
        if (chip) {
          chat.addChip(chip);
          return ui.focusComposer();
        }
        ui.setComposerText(`/${command.name} `);
        ui.focusComposer();
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      const ui = inject(UiStore);
      // Every time the palette opens it starts from an empty query.
      effect(() => {
        if (!ui.palette()) return;
        untracked(() => store.setQuery(''));
      });
      // The selection stays on a real entry as the list changes.
      effect(() => {
        const flat = store.flat();
        if (!flat.some((i) => i.id === untracked(() => store.selectedId())))
          untracked(() => patchState(store, { selectedId: flat[0]?.id }));
      });
    },
  }),
);
export type PaletteStore = InstanceType<typeof PaletteStore>;
