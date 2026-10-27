import { Language } from '@pi-kit/i18n';
import { inject } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { ApiClient, errorMessage, settingsDecide, settingsTrustState, unwrap } from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { TrustDecision, TrustState } from '@pi-kit/protocol';

export interface TrustPrompt {
  state: TrustState;
  /** `first`: the first time this folder is opened; `review`: `/trust` on a folder that may already have an answer. */
  mode: 'first' | 'review';
  done: () => void;
}

interface TrustStoreState {
  prompt: TrustPrompt | undefined;
  busy: boolean;
  /** Counts answers; the command list and the stats reload when it moves. */
  answered: number;
}

/**
 * The project-trust dialog's state. Opening a thread goes through
 * `ensure(cwd)`: while pi has no answer for the folder it resolves only after the user answered, so the backend opens
 * the session (and with it the folder's extensions, skills and MCP servers) after the answer and not before.
 */
export const TrustStore = signalStore(
  { providedIn: 'root' },
  withState<TrustStoreState>({ prompt: undefined, busy: false, answered: 0 }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const toasts = inject(ToastStore);
    const inflight = new Map<string, Promise<void>>();

    const show = (state: TrustState, mode: TrustPrompt['mode']): Promise<void> =>
      new Promise((done) => patchState(store, { prompt: { state, mode, done } }));

    const check = async (cwd: string): Promise<void> => {
      let state: TrustState;
      try {
        state = await unwrap(settingsTrustState({ client: api.client, path: { id: cwd } }));
      } catch {
        return;
      }
      if (state.status !== 'ask') return;
      await show(state, 'first');
    };

    return {
      /**
       * Resolves when the folder has an answer (or the state could not be read, which must not lock the user out). Callers
       * that ask for the same folder while the dialog is up wait for the same answer.
       */
      ensure(cwd: string): Promise<void> {
        let pending = inflight.get(cwd);
        if (!pending) {
          pending = check(cwd).finally(() => inflight.delete(cwd));
          inflight.set(cwd, pending);
        }
        return pending;
      },

      /** `/trust`: shows the dialog for the folder whatever it has answered before. */
      async review(cwd: string): Promise<void> {
        try {
          const state = await unwrap(settingsTrustState({ client: api.client, path: { id: cwd } }));
          if (!state.hasResources) {
            toasts.show('info', translate('threads.trustStore.thisFolderHasNoProjectResourcesPi'));
            return;
          }
          await show(state, 'review');
        } catch (error) {
          toasts.show(
            'error',
            translate('threads.trustStore.couldNotReadTheTrustState', { value1: errorMessage(error) }),
          );
        }
      },

      async answer(decision: TrustDecision): Promise<void> {
        const prompt = store.prompt();
        if (!prompt || store.busy()) return;
        patchState(store, { busy: true });
        try {
          const result = await unwrap(
            settingsDecide({ client: api.client, path: { id: prompt.state.cwd }, body: { decision } }),
          );
          if (decision === 'remember')
            toasts.show('success', translate('threads.trustStore.trustedAndRememberedForThisFolder'));
          if (decision === 'never')
            toasts.show('info', translate('threads.trustStore.thisFolderWillNotLoadProjectResources'));
          if (result.running > 0) toasts.show('info', translate('threads.trustStore.aRunIsGoingInThisFolder'));
        } catch (error) {
          toasts.show('error', translate('threads.trustStore.couldNotSaveTheAnswer', { value1: errorMessage(error) }));
        } finally {
          patchState(store, (s) => ({ busy: false, prompt: undefined, answered: s.answered + 1 }));
          prompt.done();
        }
      },
    };
  }),
);
export type TrustStore = InstanceType<typeof TrustStore>;
