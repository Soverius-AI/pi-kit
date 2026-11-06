import type { AppliedTheme } from './theme.store';

interface NativeTransition {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition(): void;
}

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => NativeTransition;
};

/**
 * A store-local coordinator: native callbacks may arrive after a newer theme was requested.
 * `paint` writes what belongs to the theme besides `data-theme` (its scheme, the desktop's colour tokens); it runs with the
 * attribute, and at once when the theme stays and only its colours change.
 */
export function createThemeTransition(document: Document): {
  apply(theme: AppliedTheme, paint?: () => void): void;
  destroy(): void;
} {
  const root = document.documentElement;
  let previous: AppliedTheme | undefined;
  let generation = 0;
  let destroyed = false;
  let active: { transition?: NativeTransition } | undefined;

  const cancel = (): void => {
    const pending = active;
    active = undefined;
    root.removeAttribute('data-pk-theme-transition');
    try {
      pending?.transition?.skipTransition();
    } catch {
      // A browser that already finished the transition may reject a skip.
    }
  };

  return {
    apply(theme, paint) {
      if (destroyed) return;
      if (previous === theme) {
        paint?.();
        return;
      }
      const from = previous;
      previous = theme;
      const current = ++generation;
      cancel();
      const commit = (): void => {
        if (destroyed || current !== generation) return;
        root.setAttribute('data-theme', theme);
        paint?.();
      };
      const nativeDocument = document as TransitionDocument;
      const startTransition = nativeDocument.startViewTransition;
      let animate = false;
      try {
        animate =
          from !== undefined &&
          (from === 'pi-omarchy' || theme === 'pi-omarchy') &&
          document.visibilityState !== 'hidden' &&
          !!document.defaultView?.matchMedia &&
          !document.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches &&
          typeof startTransition === 'function';
      } catch {
        // Media-query or browser capability checks must never block theme application.
      }
      if (!animate || !startTransition) {
        commit();
        return;
      }

      const pending: { transition?: NativeTransition } = {};
      active = pending;
      const cleanup = (): void => {
        if (active !== pending) return;
        active = undefined;
        root.removeAttribute('data-pk-theme-transition');
      };
      root.setAttribute('data-pk-theme-transition', 'omarchy');
      try {
        const transition = startTransition.call(document, commit);
        pending.transition = transition;
        // ready rejects when skipped; every native promise needs a rejection handler.
        void transition.ready.catch(() => undefined);
        void transition.updateCallbackDone.catch(() => {
          commit();
          cleanup();
        });
        void transition.finished.then(cleanup, () => {
          commit();
          cleanup();
        });
      } catch {
        commit();
        cleanup();
      }
    },
    destroy() {
      destroyed = true;
      generation++;
      cancel();
    },
  };
}
