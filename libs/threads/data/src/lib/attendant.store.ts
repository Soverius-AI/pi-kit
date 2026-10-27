import { computed, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import {
  ApiClient,
  attendantAccept,
  attendantDismiss,
  attendantPatch,
  attendantRun,
  attendantStatus,
  unwrap,
} from '@pi-kit/api';
import { withLatestRequest, withPolling, withRequestStatus } from '@pi-kit/data-access';
import type { AttendantSettings, AttendantStatus, PatchAttendantSettings, ThreadSuggestion } from '@pi-kit/protocol';

import { THREADS_POLICY } from './threads-policy';
import { ThreadsStore } from './threads.store';

interface AttendantState {
  status: AttendantStatus | undefined;
  /** The Settings › Attendant page is open: the activity list is read again every few seconds while it is. */
  watching: boolean;
}

/**
 * The attendant as the renderer knows it: its settings, what it did and what it cost, and the suggestions it made. The
 * backend runs it; this store reads `GET /api/attendant` while Settings › Attendant is open (every four seconds, so a new action appears while
 * you watch) and writes the settings. Accepting a suggestion of a thread is `accept` here; an answer is first given by the user in the
 * approval, this only closes the suggestion.
 */
export const AttendantStore = signalStore(
  { providedIn: 'root' },
  withState<AttendantState>({ status: undefined, watching: false }),
  withProps(() => ({ _policy: inject(THREADS_POLICY) })),
  withRequestStatus(),
  withLatestRequest(),
  withPolling(),
  withComputed(({ status }) => ({
    settings: computed(() => status()?.settings),
    enabled: computed(() => status()?.settings.enabled ?? false),
    actions: computed(() => status()?.actions ?? []),
    today: computed(() => status()?.today),
  })),
  withMethods((store) => {
    const api = inject(ApiClient);
    const threads = inject(ThreadsStore);
    let mutationVersion = 0;
    let mutations: Promise<unknown> = Promise.resolve();
    let confirmed: AttendantSettings | undefined;
    const edits = new Map<number, PatchAttendantSettings>();
    const applyEdits = (): void => {
      const status = store.status();
      if (!status || !confirmed) return;
      let settings = confirmed;
      for (const patch of edits.values())
        settings = { ...settings, ...patch, when: { ...settings.when, ...patch.when } };
      patchState(store, { status: { ...status, settings } });
    };

    const methods = {
      async load(signal?: AbortSignal): Promise<void> {
        if (edits.size > 0) return;
        const version = mutationVersion;
        await store._request(
          'status',
          (requestSignal) => unwrap(attendantStatus({ client: api.client, signal: requestSignal })),
          {
            signal,
            valid: () => version === mutationVersion,
            next: (status) => {
              confirmed = status.settings;
              patchState(store, { status });
              store.requestDone();
            },
            error: (error) => store.requestFailed(error),
          },
        );
      },

      /** The page opens or closes. */
      watch(on: boolean): void {
        patchState(store, { watching: on });
      },

      /** Changes the settings; the page follows at once, the backend's answer replaces it. Throws when the backend refuses. */
      async patch(patch: PatchAttendantSettings): Promise<AttendantSettings> {
        const version = ++mutationVersion;
        store._cancelRequest('status');
        confirmed ??= store.status()?.settings;
        edits.set(version, patch);
        applyEdits();
        // Preserve server order while keeping every outstanding edit visible.
        const pending = mutations.then(() => unwrap(attendantPatch({ client: api.client, body: patch })));
        mutations = pending.catch(() => undefined);
        try {
          const settings = await pending;
          confirmed = settings;
          return settings;
        } finally {
          edits.delete(version);
          applyEdits();
          if (edits.size === 0) await methods.load();
        }
      },

      /** Look at the threads that changed now (or one thread). Returns how many were queued. */
      async run(threadId?: string): Promise<number> {
        const { queued } = await unwrap(attendantRun({ client: api.client, body: threadId ? { threadId } : {} }));
        await methods.load();
        return queued;
      },

      async accept(suggestion: ThreadSuggestion): Promise<void> {
        await unwrap(attendantAccept({ client: api.client, path: { id: suggestion.id } }));
        await threads.refresh();
      },

      async dismiss(suggestion: ThreadSuggestion): Promise<void> {
        await unwrap(attendantDismiss({ client: api.client, path: { id: suggestion.id } }));
        await threads.refresh();
      },

      /** `/attendant`: the attendant for the current project on or off (the per-project opt-out). Returns the new state, `undefined` without a project. */
      async toggleForProject(cwd: string | undefined = threads.cwd()): Promise<boolean | undefined> {
        if (!cwd) return undefined;
        const on = !(threads.workspaces().find((w) => w.cwd === cwd)?.attendant ?? true);
        await threads.setAttendant(cwd, on);
        return on;
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      // The activity is read while its page is open, and only then.
      effect((onCleanup) => {
        if (!store.watching()) return;
        untracked(() =>
          store._startPolling('attendant', {
            intervalMs: store._policy.attendantPollMs,
            run: (signal) => store.load(signal),
          }),
        );
        onCleanup(() => store._stopPolling('attendant'));
      });
    },
  }),
);
export type AttendantStore = InstanceType<typeof AttendantStore>;
