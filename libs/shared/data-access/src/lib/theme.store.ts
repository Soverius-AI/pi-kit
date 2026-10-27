import { computed, effect } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withState } from '@ngrx/signals';
import { readStorage, withPersistence, writeStorage } from './store';

export type PiTheme = 'pi-dark' | 'pi-light' | 'pi-soverius' | 'pi-copilotkit';
/** What the user chose: a theme, or "System" (follow the OS). */
export type ThemePreference = 'system' | PiTheme;

const KEY = 'pi-kit.theme';

interface ThemeState {
  preference: ThemePreference;
  /** What the OS prefers right now (`prefers-color-scheme`; Electron reports its `nativeTheme` the same way). */
  os: 'pi-dark' | 'pi-light';
}

const isPreference = (value: unknown): value is ThemePreference =>
  value === 'system' ||
  value === 'pi-dark' ||
  value === 'pi-light' ||
  value === 'pi-soverius' ||
  value === 'pi-copilotkit';

/**
 * Sets `data-theme` on <html> to a registered theme. The choice is `System` (follow the OS)
 * or an explicit standard or brand-inspired theme. It
 * is a UI preference kept in the backend's SQLite (`settings.theme`), so it survives a restart and a changed
 * origin; `localStorage` only holds a copy so the first paint is right before the backend has answered.
 * A SignalStore on `withPersistence`.
 */
export const ThemeStore = signalStore(
  { providedIn: 'root' },
  withState<ThemeState>({ preference: 'system', os: 'pi-dark' }),
  withPersistence<ThemeState>({
    readLocal: () => {
      const stored = readStorage(KEY);
      return isPreference(stored) ? { preference: stored } : {};
    },
    writeLocal: (state) => writeStorage(KEY, state.preference),
    remote: {
      keys: { preference: 'theme' },
      parse: (saved) => (isPreference(saved['theme']) ? { preference: saved['theme'] } : {}),
    },
  }),
  withComputed(({ preference, os }) => ({
    /** The theme in effect. */
    theme: computed<PiTheme>(() => (preference() === 'system' ? os() : (preference() as PiTheme))),
    isDark: computed(() => {
      const theme = preference() === 'system' ? os() : preference();
      return theme === 'pi-dark' || theme === 'pi-soverius';
    }),
  })),
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
      media.addEventListener('change', (event) => patchState(store, { os: event.matches ? 'pi-light' : 'pi-dark' }));
      const apply = (): void => {
        document.documentElement.setAttribute('data-theme', store.theme());
        // Electron: pin or release the window's colour scheme so `prefers-color-scheme` (and native chrome) agree.
        const source = store.preference() === 'system' ? 'system' : store.isDark() ? 'dark' : 'light';
        void window.piKit?.setThemeSource?.(source);
      };
      apply();
      effect(apply);
      void store.load();
    },
  }),
);
export type ThemeStore = InstanceType<typeof ThemeStore>;
