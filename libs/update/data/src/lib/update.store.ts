import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
  ApiClient,
  errorMessage,
  unwrap,
  updateCancel,
  updateCheck,
  updateEvents,
  updateInstallApp,
  updateInstallCommand,
  updatePin,
  updateReleases,
  updateRestart,
  updateStart,
} from '@pi-kit/api';
import { ToastStore, withRequestStatus } from '@pi-kit/data-access';
import type { PiResolution, UpdateRow, UpdateStatus, UpdateTarget } from '@pi-kit/protocol';
import { UpdateEvent } from '@pi-kit/protocol';
import { EMPTY, Observable, catchError, concat, ignoreElements, pipe, repeat, switchMap, tap, timer } from 'rxjs';
import { UPDATE_POLICY } from './update-policy';

export interface UpdateLine {
  target?: UpdateTarget;
  text: string;
  at: number;
}

interface UpdateState {
  status: UpdateStatus | undefined;
  /** The newest output lines of the job, for the progress block and the log view. */
  lines: UpdateLine[];
  connected: boolean;
  /** "Use previous release" choices (Settings › Advanced). */
  releases: { release: string; label: string }[];
  /** The restart notice was dismissed for this version. */
  dismissedRestart: string | undefined;
}

/**
 * Updates from inside the app: the status of pi, its packages, the model catalogs and pi-kit, the running job and
 * its output. The store owns the stream (`GET /api/update/events`, reopened when it drops) and every call; the Versions block, the
 * progress toast and the sidebar's dot only read its signals and forward intent.
 */
export const UpdateStore = signalStore(
  { providedIn: 'root' },
  withState<UpdateState>({ status: undefined, lines: [], connected: false, releases: [], dismissedRestart: undefined }),
  withProps(() => ({ _policy: inject(UPDATE_POLICY) })),
  withRequestStatus(),
  withComputed(({ status, dismissedRestart }) => {
    const row = (target: UpdateTarget) =>
      computed<UpdateRow | undefined>(() => status()?.rows.find((r) => r.target === target));
    return {
      pi: row('pi'),
      packages: row('packages'),
      models: row('models'),
      app: row('app'),
      /** Anything is outdated or waits for a restart: the dot in the sidebar footer. */
      attention: computed(() => !!status() && (status()?.outdated || (status()?.restart.length ?? 0) > 0)),
      running: computed(() => status()?.job?.state === 'running'),
      restart: computed(() => status()?.restart ?? []),
      piRestart: computed(() => status()?.restart.find((r) => r.kind === 'pi')),
      appRestart: computed(() => status()?.restart.find((r) => r.kind === 'app')),
      resolution: computed<PiResolution | undefined>(() => status()?.resolution),
      /** What the toast says while a restart waits, unless it was dismissed. */
      restartNotice: computed(() => {
        const wait = status()?.restart.find((r) => `${r.kind}:${r.version}` !== dismissedRestart());
        return wait;
      }),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const toasts = inject(ToastStore);

    const apply = (event: unknown): void => {
      const e = event as
        { type: 'status'; status: UpdateStatus } | { type: 'line'; target?: UpdateTarget; text: string; at: number };
      if (e.type === 'status') patchState(store, { status: e.status, connected: true });
      else
        patchState(store, (s) => ({
          lines: [...s.lines, { text: e.text, at: e.at, ...(e.target ? { target: e.target } : {}) }].slice(
            -store._policy.maxLines,
          ),
        }));
    };

    // A request is in flight (starting, cancelling, restarting): `loading` from `withRequestStatus`.
    const call = async <T>(run: () => Promise<T>, failure: string): Promise<T | undefined> => {
      store.requestStarted();
      try {
        const result = await run();
        store.requestDone();
        return result;
      } catch (error) {
        store.requestFailed(error);
        toasts.show('error', `${failure}: ${errorMessage(error)}`);
        return undefined;
      }
    };

    // One stream for the life of the app; a dropped one is opened again after a pause (the backend may be restarting).
    const connect = rxMethod<void>(
      pipe(
        switchMap(() =>
          concat(
            new Observable<UpdateEvent>((subscriber) => {
              const abort = new AbortController();
              api
                .stream<UpdateEvent>(
                  updateEvents({ client: api.client, signal: abort.signal, parseAs: 'stream' }),
                  (event) => subscriber.next(event),
                )
                .then(
                  () => subscriber.error(new Error(translate('update.updateStore.theUpdateStreamEnded'))),
                  (error: unknown) => {
                    if (!abort.signal.aborted) subscriber.error(error);
                  },
                );
              return () => abort.abort();
            }).pipe(
              tap((event) => apply(event)),
              catchError(() => {
                patchState(store, { connected: false });
                return EMPTY;
              }),
            ),
            timer(store._policy.retryMs).pipe(ignoreElements()),
          ).pipe(repeat()),
        ),
      ),
    );

    return {
      connect: (): void => void connect(),
      /** Looks again for newer releases (the backend also does on launch and every 6 hours). */
      async check(): Promise<void> {
        const status = await call(
          () => unwrap(updateCheck({ client: api.client })),
          translate('update.updateStore.couldNotCheckForUpdates'),
        );
        if (status) patchState(store, { status });
      },
      /** `Update all` passes every target; a row passes its own. */
      async update(targets: UpdateTarget[]): Promise<void> {
        patchState(store, { lines: [], dismissedRestart: undefined });
        const status = await call(
          () => unwrap(updateStart({ client: api.client, body: { targets } })),
          translate('update.updateStore.couldNotStartTheUpdate'),
        );
        if (status) patchState(store, { status });
      },
      async cancel(): Promise<void> {
        const status = await call(
          () => unwrap(updateCancel({ client: api.client })),
          translate('update.updateStore.couldNotCancelTheUpdate'),
        );
        if (status) patchState(store, { status });
      },
      /** "Restart to use …": the backend ends and the desktop watchdog starts it again; the threads replay. */
      async restartBackend(): Promise<void> {
        const done = await call(
          () => unwrap(updateRestart({ client: api.client })),
          translate('update.updateStore.couldNotRestart'),
        );
        if (done) toasts.show('info', translate('update.updateStore.restartingPiKitSBackend'), 4000);
      },
      /** "Restart to update pi-kit": Electron main installs the downloaded update and relaunches. */
      async installApp(): Promise<void> {
        const done = await call(
          () => unwrap(updateInstallApp({ client: api.client })),
          translate('update.updateStore.couldNotInstallThePiKitUpdate'),
        );
        if (done) toasts.show('info', translate('update.updateStore.piKitIsRestartingToInstallThe'), 4000);
      },
      async installCommand(): Promise<void> {
        const status = await call(
          () => unwrap(updateInstallCommand({ client: api.client })),
          translate('update.updateStore.couldNotInstallThePiCommand'),
        );
        if (status) {
          patchState(store, { status });
          toasts.show('success', translate('update.updateStore.thePiCommandNowRunsPiS'), 4000);
        }
      },
      async loadReleases(): Promise<void> {
        const list = await call(
          () => unwrap(updateReleases({ client: api.client })),
          translate('update.updateStore.couldNotListThePiReleases'),
        );
        if (list) patchState(store, { releases: list.choices });
      },
      /** "Use previous release": a managed version or `bundled`; `null` follows the newest again. Takes effect after a restart. */
      async pin(release: string | null): Promise<void> {
        const status = await call(
          () => unwrap(updatePin({ client: api.client, body: { release } })),
          translate('update.updateStore.couldNotChangeThePiRelease'),
        );
        if (status) {
          patchState(store, { status });
          const list = await unwrap(updateReleases({ client: api.client })).catch(() => undefined);
          if (list) patchState(store, { releases: list.choices });
        }
      },
      dismissRestart(): void {
        const wait = store.restartNotice();
        if (wait) patchState(store, { dismissedRestart: `${wait.kind}:${wait.version}` });
      },
    };
  }),
  withHooks({
    onInit(store) {
      store.connect();
    },
  }),
);
