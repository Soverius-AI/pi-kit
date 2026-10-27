import { Language } from '@pi-kit/i18n';
import { computed, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  terminalInput,
  terminalKill,
  terminalResize,
  terminalStart,
  terminalStream,
  unwrap,
} from '@pi-kit/api';
import { HealthStore } from '@pi-kit/data-access';
import type { TerminalInfo } from '@pi-kit/protocol';
import { TerminalEvent } from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';
import { TERMINAL_POLICY } from './terminal-policy';

/** What the panel gives the store: the screen the shell's output is written to. */
export interface TerminalSurface {
  cols: number;
  rows: number;
  write(data: string): void;
  focus(): void;
}

/** The panel's side of the terminal: it builds the xterm screen (a lazy chunk) and tears it down. */
export interface TerminalHost {
  open(): Promise<TerminalSurface>;
  close(): void;
}

interface TerminalState {
  /** A panel is showing the terminal. */
  mounted: boolean;
  info: TerminalInfo | undefined;
  error: string | undefined;
  starting: boolean;
  /** The shell ended: its exit code (`null` if a signal killed it). */
  exited: number | null | undefined;
}

/**
 * The Terminal side panel's session: one shell per workspace on the backend's pseudo-terminal, started and
 * attached for the folder in view, its output streamed (a dropped stream attaches again with a growing pause, the backend replays the screen),
 * keystrokes sent in order and resizes debounced. After a backend restart the shell is a new one (the old pty died with the process), so a new
 * health epoch attaches again. The panel only builds the xterm screen (`TerminalHost`) and forwards typing and size.
 */
export const TerminalStore = signalStore(
  { providedIn: 'root' },
  withState<TerminalState>({ mounted: false, info: undefined, error: undefined, starting: false, exited: undefined }),
  withProps(() => ({ _policy: inject(TERMINAL_POLICY) })),
  withComputed(({ info }) => {
    const threads = inject(ThreadsStore);
    return {
      cwd: threads.folder,
      folderName: computed(() => threads.workspaceName() ?? ''),
      shellName: computed(() => info()?.shell.split('/').pop() ?? 'shell'),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    let host: TerminalHost | undefined;
    let generation = 0;
    let abort: AbortController | undefined;
    let attachedCwd: string | undefined;
    let input = '';
    let sending = false;
    let attachRetries = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    const detach = (): void => {
      generation += 1;
      abort?.abort();
      abort = undefined;
      clearTimeout(resizeTimer);
      host?.close();
      input = '';
      patchState(store, { info: undefined, exited: undefined });
    };

    const attach = async (cwd: string | undefined): Promise<void> => {
      detach();
      patchState(store, { error: undefined });
      attachedCwd = cwd;
      if (!cwd || !host) return;
      const mine = generation;
      patchState(store, { starting: true });
      try {
        const surface = await host.open();
        if (mine !== generation) return;
        const info = await unwrap(
          terminalStart({ client: api.client, path: { id: cwd }, body: { cols: surface.cols, rows: surface.rows } }),
        );
        if (mine !== generation) return;
        patchState(store, { info });
        const stream = (abort = new AbortController());
        void api
          .stream<TerminalEvent>(
            terminalStream({ client: api.client, path: { id: cwd }, signal: stream.signal, parseAs: 'stream' }),
            (event) => {
              if (mine !== generation) return;
              if (event.type === 'data') {
                attachRetries = 0;
                surface.write(event.data);
              } else patchState(store, { exited: event.exitCode });
            },
          )
          .then(
            () => undefined,
            (streamError) => {
              if (stream.signal.aborted || mine !== generation) return;
              // A broken stream with the shell still alive is a network hiccup: attach again (the backend replays the screen)
              // after a pause, up to five times; a dead backend is picked up by the health epoch.
              if (attachRetries < store._policy.maxRetries && store.exited() === undefined) {
                const delay = store._policy.baseRetryMs * 2 ** attachRetries++;
                setTimeout(() => mine === generation && void attach(cwd), delay);
              } else {
                patchState(store, {
                  error: translate('terminal.terminalStore.theTerminalConnectionWasLost', {
                    value1: errorMessage(streamError),
                  }),
                });
              }
            },
          );
        surface.focus();
      } catch (error) {
        if (mine === generation)
          patchState(store, {
            error: translate('terminal.terminalStore.theTerminalCouldNotStart', { value1: errorMessage(error) }),
          });
      } finally {
        if (mine === generation) patchState(store, { starting: false });
      }
    };

    return {
      /** The panel is on screen: attach for the folder in view (and again when it or the backend process changes). */
      mount(terminalHost: TerminalHost): void {
        host = terminalHost;
        patchState(store, { mounted: true });
      },
      /** The panel closed: the shell keeps running on the backend; reopening replays its screen. */
      unmount(): void {
        patchState(store, { mounted: false });
        detach();
        host = undefined;
      },
      attach,

      /** End this shell and start a new one. */
      async restart(): Promise<void> {
        const cwd = store.cwd();
        if (!cwd) return;
        await unwrap(terminalKill({ client: api.client, path: { id: cwd } })).catch(() => undefined);
        await attach(cwd);
      },

      /** Keystrokes go out in order, one request at a time; what is typed meanwhile is sent together. */
      send(data: string): void {
        const cwd = attachedCwd;
        if (!cwd) return;
        input += data;
        if (sending) return;
        sending = true;
        void (async () => {
          while (input) {
            const chunk = input;
            input = '';
            try {
              await unwrap(terminalInput({ client: api.client, path: { id: cwd }, body: { data: chunk } }));
            } catch {
              // The shell is gone; the exit notice says so.
            }
          }
          sending = false;
        })();
      },

      resize(cols: number, rows: number): void {
        const cwd = attachedCwd;
        if (!cwd) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(
          () =>
            void unwrap(terminalResize({ client: api.client, path: { id: cwd }, body: { cols, rows } })).catch(
              () => undefined,
            ),
          store._policy.resizeDelayMs,
        );
      },
    };
  }),
  withHooks({
    onInit(store) {
      const health = inject(HealthStore);
      // One terminal per workspace: switching folders switches shells. After a backend restart the shell is a new one (the old pty died with the process): attach again.
      effect(() => {
        const cwd = store.cwd();
        health.epoch();
        if (!store.mounted()) return;
        untracked(() => void store.attach(cwd));
      });
    },
  }),
);
export type TerminalStore = InstanceType<typeof TerminalStore>;
