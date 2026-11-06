import { computed, DestroyRef, effect, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withState } from '@ngrx/signals';
import type { OmarchyTheme } from '@pi-kit/api';
import { readStorage, withPersistence, writeStorage } from './store';
import { createThemeTransition } from './theme-transition';

export type PiTheme = 'pi-dark' | 'pi-light' | 'pi-soverius' | 'pi-copilotkit' | 'pi-omarchy';
/** What the user chose: a theme, or "System" (follow the OS). */
export type ThemePreference = 'system' | PiTheme;
/** What `data-theme` can be: a theme the user can choose, or the desktop's own, which only "System" on an Omarchy desktop gives. */
export type AppliedTheme = PiTheme | 'pi-desktop';

const KEY = 'pi-kit.theme';

interface ThemeState {
  preference: ThemePreference;
  /** What the OS prefers right now (`prefers-color-scheme`; Electron reports its `nativeTheme` the same way). */
  os: 'pi-dark' | 'pi-light';
  /** The Omarchy desktop's theme, from the desktop app; `undefined` on any other desktop, in a browser and on a phone. */
  omarchy: OmarchyTheme | undefined;
}

const isPreference = (value: unknown): value is ThemePreference =>
  value === 'system' ||
  value === 'pi-dark' ||
  value === 'pi-light' ||
  value === 'pi-soverius' ||
  value === 'pi-copilotkit' ||
  value === 'pi-omarchy';

/**
 * Sets `data-theme` on <html> to a registered theme. The choice is `System` (follow the OS)
 * or an explicit standard or brand-inspired theme. On an Omarchy desktop `System` is the desktop's own theme (`pi-desktop`): its
 * colours come from the desktop app as tokens, are written to <html>'s style, and change when the user switches the desktop's
 * theme (the `pi-omarchy` skin is a fixed palette and something else). The saved choice stays `system`, so a phone paired with that desktop follows its own OS. It
 * is a UI preference kept in the backend's SQLite (`settings.theme`), so it survives a restart and a changed
 * origin; `localStorage` only holds a copy so the first paint is right before the backend has answered.
 * A SignalStore on `withPersistence`.
 */
export const ThemeStore = signalStore(
  { providedIn: 'root' },
  withState<ThemeState>({ preference: 'system', os: 'pi-dark', omarchy: undefined }),
  withPersistence<ThemeState>({
    readLocal: () => {
      const stored = readStorage(KEY, 'controller');
      return isPreference(stored) ? { preference: stored } : {};
    },
    writeLocal: (state) => writeStorage(KEY, state.preference, 'controller'),
    remote: {
      scope: 'controller',
      keys: { preference: 'theme' },
      parse: (saved) => (isPreference(saved['theme']) ? { preference: saved['theme'] } : {}),
    },
  }),
  withComputed(({ preference, os, omarchy }) => {
    /** The theme in effect. */
    const theme = computed<AppliedTheme>(() => {
      const chosen = preference();
      if (chosen !== 'system') return chosen;
      return omarchy() ? 'pi-desktop' : os();
    });
    return {
      theme,
      isDark: computed(() => {
        const applied = theme();
        if (applied === 'pi-desktop') return omarchy()?.mode !== 'light';
        return applied === 'pi-dark' || applied === 'pi-soverius' || applied === 'pi-omarchy';
      }),
      /**
       * Changes whenever the colours on screen do: with the theme, and with each theme of the desktop while `pi-desktop` stays
       * in effect. Read it in an effect that copies token values out of the page (the terminal, an embedded MCP app).
       */
      palette: computed<AppliedTheme | OmarchyTheme>(() => {
        const applied = theme();
        return (applied === 'pi-desktop' && omarchy()) || applied;
      }),
    };
  }),
  withMethods((store) => ({
    /** Asks the backend for the saved choice (the source of truth). */
    load: (): Promise<void> => store.loadPersisted(),
    /** The choice applies at once; the backend is told. */
    async set(preference: ThemePreference): Promise<void> {
      await store.persist({ preference });
    },
    /** Flips between dark and light (the command palette's "Switch theme"). */
    toggle(): void {
      void store.persist({ preference: store.isDark() ? 'pi-light' : 'pi-dark' });
    },
  })),
  withHooks({
    onInit(store) {
      const media = matchMedia('(prefers-color-scheme: light)');
      patchState(store, { os: media.matches ? 'pi-light' : 'pi-dark' });
      const onSchemeChange = (event: MediaQueryListEvent): void =>
        patchState(store, { os: event.matches ? 'pi-light' : 'pi-dark' });
      media.addEventListener('change', onSchemeChange);
      const bridge = window.piKit;
      patchState(store, { omarchy: bridge?.omarchyTheme });
      const unfollow = bridge?.onOmarchyTheme?.((omarchy) => patchState(store, { omarchy }));
      // A switch between the window's creation and the subscription above would otherwise be missed.
      void bridge
        ?.getOmarchyTheme?.()
        .then((omarchy) => patchState(store, { omarchy }))
        .catch(() => undefined);
      const transition = createThemeTransition(document);
      inject(DestroyRef).onDestroy(() => {
        transition.destroy();
        media.removeEventListener('change', onSchemeChange);
        unfollow?.();
      });
      const root = document.documentElement;
      // The tokens on <html>'s style: public/theme.js wrote the first ones before the first paint.
      let written = Object.keys(bridge?.omarchyTheme?.tokens ?? {});
      const apply = (): void => {
        const theme = store.theme();
        const scheme = store.isDark() ? 'dark' : 'light';
        const tokens = (theme === 'pi-desktop' && store.omarchy()?.tokens) || {};
        // Together with `data-theme`, so a transition's snapshots show each theme whole.
        transition.apply(theme, () => {
          root.setAttribute('data-scheme', scheme);
          for (const name of written) if (!(name in tokens)) root.style.removeProperty(name);
          for (const [name, color] of Object.entries(tokens)) root.style.setProperty(name, color);
          written = Object.keys(tokens);
        });
        // Electron: pin or release the window's colour scheme so `prefers-color-scheme` (and native chrome) agree.
        const followsOs = store.preference() === 'system' && theme !== 'pi-desktop';
        void window.piKit?.setThemeSource?.(followsOs ? 'system' : store.isDark() ? 'dark' : 'light');
      };
      apply();
      effect(apply);
      void store.load();
    },
  }),
);
export type ThemeStore = InstanceType<typeof ThemeStore>;
