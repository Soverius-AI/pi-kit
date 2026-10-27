import type { Translate } from '@pi-kit/i18n';
import { DestroyRef, inject } from '@angular/core';
import type { StateSignals, WritableStateSource } from '@ngrx/signals';
import { patchState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  settingsAnswer,
  settingsCancel,
  settingsEvents,
  settingsLogout,
  settingsRemoveProvider,
  settingsStartLogin,
  settingsValidate,
  unwrap,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { LoginEvent } from '@pi-kit/protocol';
import type { SettingsPolicy } from '../settings-policy';

import { type KeyWorkflow, type LoginFlow, type SettingsStoreState } from './settings-state';
export type CredentialsState = Pick<SettingsStoreState, 'overview' | 'flow' | 'keyWorkflow' | 'credentialsChanged'>;
type CredentialsContextState = StateSignals<CredentialsState> & WritableStateSource<CredentialsState>;
interface CredentialsContext {
  api: ApiClient;
  toasts: ToastStore;
  policy: SettingsPolicy;
  track: <T>(work: () => Promise<T>, failure: string) => Promise<T | undefined>;
  load: () => Promise<void>;
  showSaved: () => void;
}
/** Provider sign-in and API-key workflow, with an owned stream lifecycle. */
export function createSettingsCredentials(
  translate: Translate,
  store: CredentialsContextState,
  context: CredentialsContext,
) {
  const { api, toasts, track, load, showSaved, policy } = context;
  let loginAbort: AbortController | undefined;
  inject(DestroyRef).onDestroy(() => loginAbort?.abort());
  const updateFlow = (patch: Partial<LoginFlow>): void =>
    patchState(store, (s) => ({ flow: s.flow ? { ...s.flow, ...patch } : s.flow }));
  const addNote = (note: LoginFlow['notes'][number]): void =>
    patchState(store, (s) => ({ flow: s.flow ? { ...s.flow, notes: [...s.flow.notes, note] } : s.flow }));
  const updateKeyWorkflow = (patch: Partial<KeyWorkflow>): void =>
    patchState(store, (s) => ({ keyWorkflow: s.keyWorkflow ? { ...s.keyWorkflow, ...patch } : s.keyWorkflow }));

  const methods = {
    // ---- sign-in (OAuth inline; API keys in the workflow)

    /** `/login <provider>`: starts the provider’s only method, or opens the key workflow, or asks which one when it has two. */
    async signInTo(query: string): Promise<void> {
      const wanted = query.trim().toLowerCase();
      const provider = store
        .overview()
        ?.providers.find((p) => p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted);
      if (!provider)
        return void toasts.show(
          'warning',
          translate('settings.settingsCredentials.piHasNoProviderCalledPickOne', { value1: query }),
        );
      // A provider with both ways signs in again the way it was signed in before ("Sign in again" after a 401); with a choice still open, the card shows both buttons.
      const method = provider.methods.length === 1 ? provider.methods[0] : provider.storedType;
      if (!method) return;
      if (method === 'api_key') methods.openKeyWorkflow(provider.id);
      else await methods.login(provider.id, 'oauth');
    },

    async login(provider: string, type: 'api_key' | 'oauth'): Promise<void> {
      methods.cancelLogin();
      const name = store.overview()?.providers.find((p) => p.id === provider)?.name ?? provider;
      patchState(store, { flow: { provider, providerName: name, type, status: 'starting', notes: [] } });
      const abort = (loginAbort = new AbortController());
      try {
        const id = await unwrap(settingsStartLogin({ client: api.client, body: { provider, type } })).then(
          ({ id }) => id,
        );
        if (abort.signal.aborted) {
          void unwrap(settingsCancel({ client: api.client, path: { id } })).catch(() => undefined);
          return;
        }
        updateFlow({ id, status: 'running' });
        await api.stream<LoginEvent>(
          settingsEvents({ client: api.client, path: { id }, signal: abort.signal, parseAs: 'stream' }),
          (event) => {
            if (!abort.signal.aborted) methods.onLoginEvent(event);
          },
        );
      } catch (error) {
        if (!abort.signal.aborted) updateFlow({ status: 'error', error: errorMessage(error), prompt: undefined });
      }
    },

    /** The answer leaves the caller’s field and goes to the backend; the prompt (and any typed key with it) is gone from the state before the request leaves. */
    async answer(value: string): Promise<void> {
      const flow = store.flow();
      const prompt = flow?.prompt;
      if (!flow?.id || !prompt) return;
      updateFlow({ prompt: undefined });
      try {
        await unwrap(
          settingsAnswer({ client: api.client, path: { id: flow.id }, body: { promptId: prompt.promptId, value } }),
        );
      } catch (error) {
        if (store.flow()?.id === flow.id) updateFlow({ status: 'error', error: errorMessage(error) });
      }
    },

    cancelLogin(): void {
      const flow = store.flow();
      loginAbort?.abort();
      loginAbort = undefined;
      if (flow?.id && (flow.status === 'running' || flow.status === 'starting'))
        void unwrap(settingsCancel({ client: api.client, path: { id: flow.id } })).catch(() => undefined);
      patchState(store, { flow: undefined });
    },

    dismissFlow(): void {
      patchState(store, { flow: undefined });
    },

    async logout(provider: string): Promise<void> {
      const done = await track(async () => {
        await unwrap(settingsLogout({ client: api.client, body: { provider } }));
        return true;
      }, translate('settings.settingsCredentials.couldNotSignOut'));
      if (!done) return;
      toasts.show('success', translate('settings.settingsCredentials.signedOutPiRemovedTheStoredCredential'));
      patchState(store, (s) => ({ credentialsChanged: s.credentialsChanged + 1 }));
      await load();
    },

    async removeProvider(provider: string): Promise<boolean> {
      const done = await track(async () => {
        await unwrap(settingsRemoveProvider({ client: api.client, body: { provider } }));
        return true;
      }, translate('settings.providersSection.removeFailed'));
      if (!done) return false;
      toasts.show('success', translate('settings.providersSection.removed'));
      patchState(store, (s) => ({ credentialsChanged: s.credentialsChanged + 1 }));
      await load();
      return true;
    },

    onLoginEvent(event: LoginEvent): void {
      switch (event.type) {
        case 'info':
          addNote({
            text: event.message,
            ...(event.links?.[0] ? { url: event.links[0].url, label: event.links[0].label } : {}),
          });
          break;
        case 'progress':
          addNote({ text: event.message });
          break;
        case 'auth_url':
          updateFlow({
            authUrl: { url: event.url, ...(event.instructions ? { instructions: event.instructions } : {}) },
          });
          // The sign-in page opens in the system browser (the desktop app routes new windows there); the link stays in the box for a browser that blocks the pop-up.
          try {
            window.open(event.url, '_blank', 'noopener,noreferrer');
          } catch {
            // no window to open: the link is there
          }
          break;
        case 'device_code':
          updateFlow({ device: { userCode: event.userCode, verificationUri: event.verificationUri } });
          break;
        case 'prompt':
          updateFlow({
            prompt: {
              promptId: event.promptId,
              kind: event.kind,
              message: event.message,
              placeholder: event.placeholder,
              options: event.options,
            },
          });
          break;
        case 'prompt_end':
          if (store.flow()?.prompt?.promptId === event.promptId) updateFlow({ prompt: undefined });
          break;
        case 'done':
          updateFlow({ status: 'done', prompt: undefined });
          patchState(store, (s) => ({ credentialsChanged: s.credentialsChanged + 1 }));
          void load();
          break;
        case 'error':
          updateFlow({ status: 'error', error: event.message, prompt: undefined });
          break;
      }
    },

    // ---- the API-key workflow

    openKeyWorkflow(provider?: string, embedded = false): void {
      methods.cancelLogin();
      patchState(store, {
        keyWorkflow: {
          step: provider ? 2 : 1,
          ...(provider ? { provider } : {}),
          ...(embedded ? { embedded } : {}),
          phase: 'editing',
        },
      });
    },
    keyChooseProvider(provider: string): void {
      updateKeyWorkflow({ provider });
    },
    /** Step 1 → 2 → 3. Entering step 3 starts pi’s login so its secret prompt is waiting when the user pastes. */
    async keyNext(): Promise<void> {
      const wf = store.keyWorkflow();
      if (!wf?.provider) return;
      if (wf.step === 1) updateKeyWorkflow({ step: 2 });
      else if (wf.step === 2) {
        updateKeyWorkflow({ step: 3, phase: 'editing', error: undefined });
        await methods.login(wf.provider, 'api_key');
      }
    },
    /** After a failure or a rejected key: back to the paste step with a fresh sign-in from pi. */
    async keyRetry(): Promise<void> {
      const provider = store.keyWorkflow()?.provider;
      if (!provider) return;
      updateKeyWorkflow({ step: 3, phase: 'editing', error: undefined, validation: undefined });
      await methods.login(provider, 'api_key');
    },
    keyBack(): void {
      const wf = store.keyWorkflow();
      if (!wf || wf.step === 1) return;
      if (wf.step === 3) methods.cancelLogin();
      updateKeyWorkflow({
        step: (wf.step - 1) as 1 | 2 | 3,
        phase: 'editing',
        error: undefined,
        validation: undefined,
      });
    },
    closeKeyWorkflow(): void {
      methods.cancelLogin();
      patchState(store, { keyWorkflow: undefined });
    },
    /**
     * “Validate and save”: hands the key to pi’s login (which writes `auth.json`), waits for it to finish, then asks the provider once whether it
     * accepts the credential. The key is a parameter of this call only.
     */
    async submitKey(key: string): Promise<void> {
      const wf = store.keyWorkflow();
      if (!wf?.provider || !store.flow()?.prompt) return;
      updateKeyWorkflow({ phase: 'saving', error: undefined });
      await methods.answer(key);
      // pi finishes the login after it has the key; the stream says `done` or `error`.
      const deadline = Date.now() + policy.loginWaitMs;
      while (Date.now() < deadline && store.flow()?.status === 'running')
        await new Promise((resolve) => setTimeout(resolve, policy.loginPollMs));
      const flow = store.flow();
      if (flow?.status !== 'done') {
        updateKeyWorkflow({
          phase: 'failed',
          error: flow?.error ?? translate('settings.settingsCredentials.piDidNotConfirmTheSignIn'),
        });
        return;
      }
      patchState(store, { flow: undefined });
      showSaved();
      updateKeyWorkflow({ phase: 'validating', step: 4 });
      try {
        updateKeyWorkflow({
          validation: await unwrap(settingsValidate({ client: api.client, body: { provider: wf.provider } })),
          phase: 'done',
        });
      } catch (error) {
        updateKeyWorkflow({
          phase: 'done',
          validation: {
            status: 'unchecked',
            message: translate('settings.settingsCredentials.theKeyCouldNotBeTried', { value1: errorMessage(error) }),
            models: 0,
            sample: [],
          },
        });
      }
      await load();
    },
    /** The result card’s “Remove”: signs out of the provider again. */
    async removeKey(): Promise<void> {
      const provider = store.keyWorkflow()?.provider;
      if (!provider) return;
      await methods.logout(provider);
      patchState(store, { keyWorkflow: undefined });
    },
  };
  return methods;
}
