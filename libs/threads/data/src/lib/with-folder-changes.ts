import { computed, DOCUMENT, inject, type Signal } from '@angular/core';
import { patchState, signalStoreFeature, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { ApiClient, sessionWatchWorkspace } from '@pi-kit/api';
import type { WatchEvent } from '@pi-kit/protocol';
import { EMPTY, fromEvent, map, type Observable, of, pipe, Subject, switchMap, tap, timer } from 'rxjs';
import { type Dropped, reconnectingEvents } from './reconnecting-events';
import { THREADS_POLICY } from './threads-policy';

/** The folder changed: the paths it says (relative to the folder), `overflow` for "read everything again", `headMoved` when git's `HEAD` moved. */
export interface FolderChange {
  paths: readonly string[];
  overflow: boolean;
  headMoved: boolean;
}

interface FolderWatchState {
  /** Panels that want the stream, by name (`files`, `changes`). */
  watchers: readonly string[];
  /** True while a panel wants the stream, and for a few seconds after the last one lets go (switching from Files to Changes keeps one stream). */
  watchHeld: boolean;
  watchConnected: boolean;
}

/** Everything may have changed: the stream (re)opened, or the window got the focus back. */
const EVERYTHING: FolderChange = { paths: [], overflow: true, headMoved: false };

/**
 * The live refresh of the folder the panels work in (the store hands it to `_followFolder`): one stream of `GET /api/workspaces/:id/watch` while any panel wants it, shared by
 * the Files and the Changes panel, opened again with a growing delay after a drop. The backend sends a `change` when a run in the folder ended or
 * its git `HEAD` moved; every `change`, `ready` and the window getting the focus back is one event of `folderChanges`. It is an event stream, not a
 * signal: two changes in a row must both arrive.
 */
export function withFolderChanges() {
  return signalStoreFeature(
    withState<FolderWatchState>({ watchers: [], watchHeld: false, watchConnected: false }),
    withProps(() => {
      const changes = new Subject<FolderChange>();
      return {
        _changes: changes,
        /** Every change of the folder the panels follow, in order. */
        folderChanges: changes.asObservable() as Observable<FolderChange>,
      };
    }),
    withMethods((store) => {
      const api = inject(ApiClient);
      const policy = inject(THREADS_POLICY);
      const onWatch = (event: WatchEvent | Dropped): void => {
        if (event.type === 'ready') {
          patchState(store, { watchConnected: true });
          store._changes.next(EVERYTHING);
        } else if (event.type === 'change')
          store._changes.next({ paths: event.paths, overflow: event.overflow, headMoved: event.headMoved });
        else if (event.type === 'dropped') patchState(store, { watchConnected: false });
      };
      const watchEvents = (cwd: string) =>
        reconnectingEvents<WatchEvent>(
          (signal, onEvent) =>
            api.stream(
              sessionWatchWorkspace({ client: api.client, path: { id: cwd }, signal, parseAs: 'stream' }),
              onEvent,
            ),
          policy.retryMs,
          false,
        );
      const follow = rxMethod<string | undefined>(
        pipe(switchMap((cwd) => (cwd ? watchEvents(cwd).pipe(tap(onWatch)) : EMPTY))),
      );
      return {
        /** A panel says whether it needs the live refresh stream right now. */
        want(owner: string, on: boolean): void {
          patchState(store, (s) => {
            if (s.watchers.includes(owner) === on) return s;
            return { watchers: on ? [...s.watchers, owner] : s.watchers.filter((w) => w !== owner) };
          });
        },
        /** Follows `folder` while the stream is held. */
        _followFolder(folder: Signal<string | undefined>): void {
          follow(computed(() => (store.watchHeld() ? folder() : undefined)));
        },
      };
    }),
    withHooks({
      onInit(store) {
        const policy = inject(THREADS_POLICY);
        // The hold: on while a panel wants the stream, off a few seconds after the last one lets go.
        rxMethod<number>(
          pipe(
            switchMap((wanted) => (wanted > 0 ? of(true) : timer(policy.watchGraceMs).pipe(map(() => false)))),
            tap((held) => patchState(store, { watchHeld: held })),
          ),
        )(computed(() => store.watchers().length));
        // Nothing watches the folder: what changed while the person was in another app (their editor, a terminal) is read when they come back.
        const view = inject(DOCUMENT).defaultView;
        if (view)
          rxMethod<Event>(
            tap(() => {
              if (store.watchHeld()) store._changes.next(EVERYTHING);
            }),
          )(fromEvent(view, 'focus'));
      },
    }),
  );
}
