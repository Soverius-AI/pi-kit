import { inject, type Type } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import type { SessionStats, ThreadUsage } from '@pi-kit/protocol';

export type DialogState =
  | { kind: 'component'; component: Type<unknown>; inputs?: Record<string, unknown>; canClose?: () => boolean }
  | { kind: 'session'; stats: SessionStats }
  | { kind: 'usage'; usage: ThreadUsage }
  | { kind: 'hotkeys' }
  | { kind: 'changelog'; version: string; text: string }
  | { kind: 'name'; current: string; title: string; placeholder: string; resolve: (name: string | undefined) => void };

/** The small modal dialogs the built-in commands open (`/session`, `/cost`, `/hotkeys`, `/changelog`, `/name`) and the tree's label prompt. */
export const DialogStore = signalStore(
  { providedIn: 'root' },
  withState<{ current: DialogState | undefined }>({ current: undefined }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const canClose = () => {
      const dialog = store.current();
      return dialog?.kind !== 'component' || dialog.canClose?.() !== false;
    };
    return {
      show(state: Exclude<DialogState, { kind: 'name' }>): void {
        if (!canClose()) return;
        patchState(store, { current: state });
      },

      /** A one-line text prompt: the thread's name by default, or a label for a turn (the tree). `undefined` if cancelled, an empty string if left empty. */
      askName(
        current: string,
        title = translate('shared.dialogStore.nameThisThread'),
        placeholder = translate('shared.dialogStore.nameThisThread'),
      ): Promise<string | undefined> {
        if (!canClose()) return Promise.resolve(undefined);
        return new Promise((resolve) =>
          patchState(store, { current: { kind: 'name', current, title, placeholder, resolve } }),
        );
      },

      submitName(name: string): void {
        if (!canClose()) return;
        const dialog = store.current();
        if (dialog?.kind === 'name') dialog.resolve(name.trim());
        patchState(store, { current: undefined });
      },

      close(): void {
        if (!canClose()) return;
        const dialog = store.current();
        if (dialog?.kind === 'name') dialog.resolve(undefined);
        patchState(store, { current: undefined });
      },
    };
  }),
);
export type DialogStore = InstanceType<typeof DialogStore>;
