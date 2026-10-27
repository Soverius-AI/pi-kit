import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withProps, withState } from '@ngrx/signals';
import { RENDERER_POLICY } from './renderer-policy';

export interface Toast {
  id: number;
  level: 'info' | 'warning' | 'error' | 'success';
  text: string;
  /** One button beside Dismiss ("Sign in again"); running it dismisses the toast. */
  action?: { label: string; run: () => void };
}

/** Short messages that belong to the window rather than to a thread's transcript (an action that cannot happen here, a save that failed). */
export const ToastStore = signalStore(
  { providedIn: 'root' },
  withState<{ items: Toast[] }>({ items: [] }),
  withProps(() => ({ _policy: inject(RENDERER_POLICY) })),
  withMethods((store) => {
    let next = 0;
    const methods = {
      /** `ms` shortens the stay for a confirmation that needs no reading time (1.5 s for a cycled model). */
      show(level: Toast['level'], text: string, ms = store._policy.toastMs, action?: Toast['action']): void {
        const id = ++next;
        patchState(store, (s) => ({
          items: [...s.items, { id, level, text, ...(action ? { action } : {}) }].slice(
            -Math.max(1, store._policy.maxToasts),
          ),
        }));
        setTimeout(() => methods.dismiss(id), ms);
      },
      /** The toast's own button: runs the action, then the toast goes. */
      act(id: number): void {
        const toast = store.items().find((t) => t.id === id);
        methods.dismiss(id);
        toast?.action?.run();
      },
      dismiss(id: number): void {
        patchState(store, (s) => ({ items: s.items.filter((t) => t.id !== id) }));
      },
    };
    return methods;
  }),
);
export type ToastStore = InstanceType<typeof ToastStore>;
