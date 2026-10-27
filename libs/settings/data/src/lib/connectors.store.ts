import { Language } from '@pi-kit/i18n';
import { DestroyRef, computed, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import {
  ApiClient,
  connectorsCatalog,
  connectorsConnect,
  connectorsDisconnect,
  connectorsExposure,
  errorMessage,
  mcpCancelSignIn,
  mcpChange,
  mcpCheck,
  mcpCreate,
  mcpDetail,
  mcpEnabled,
  mcpFile,
  mcpLogin,
  mcpLogout,
  mcpOpenFile,
  mcpOverview,
  mcpPasteSignIn,
  mcpReconnect,
  mcpReload,
  mcpRevealFile,
  mcpSaveFile,
  settingsDecide,
  unwrap,
} from '@pi-kit/api';
import { ToastStore, withLatestRequest, withRequestStatus } from '@pi-kit/data-access';
import {
  type ConnectRequest,
  type ConnectorCatalog,
  type ConnectorExposure,
  type CustomConnector,
  type McpActionResult,
  type McpCheckRequest,
  type McpCheckResult,
  type McpFile,
  type McpFileSaved,
  type McpOverview,
  type McpScope,
  type McpServer,
  type McpServerBody,
  type McpServerCreate,
  type McpServerDetail,
  connectorById,
} from '@pi-kit/protocol';
import { attentionText, connectorCards, connectorMenuGroups, mcpRows, onCount } from '@pi-kit/settings/util';
import { ThreadsStore } from '@pi-kit/threads/api';

import { SETTINGS_POLICY } from './settings-policy';

/** The result of a connector action, including any sign-in or trust choice it needs. */
export interface McpNotice {
  level: 'info' | 'error';
  text: string;
  /** A sign-in page to offer as a link when the system browser did not open it. */
  url?: string;
  /** The server the sign-in link is for (the gallery shows the notice under that card). */
  server?: string;
  /** The folder is not trusted, so a project-only connector cannot be written; the notice offers the trust. */
  trust?: boolean;
}

/** What a card remembers before its connector is connected: where it goes, which endpoint, how it reaches the model. */
export interface CardChoice {
  scope: 'user' | 'project';
  variant?: string;
  exposure?: ConnectorExposure;
}

/** The "Add a server" wizard is open; `id` is the catalog service whose details it opens on (a service that needs a token or a client id), or nothing for the gallery. */
export interface McpWizard {
  id?: string;
}

/** The edit dialog is open on this server, in the file of this scope. */
export interface McpEdit {
  name: string;
  scope: McpScope;
}

/** Until the backend's catalog arrives (a few KB, asked for when the store starts): the catalog lives in `libs/shared/protocol`, and keeping it out of the renderer's first chunk keeps its budget. */
const NO_CATALOG: ConnectorCatalog = { version: 1, updated: '', connectors: [] };

interface ConnectorsState {
  overview: McpOverview | undefined;
  /** Names of servers with an action in flight; `'*'` for the whole session. */
  busy: ReadonlySet<string>;
  notice: McpNotice | undefined;
  /** The catalog the gallery shows: the one the backend serves (the one built into this release until a signed update exists). */
  catalog: ConnectorCatalog;
  choices: Record<string, CardChoice>;
  wizard: McpWizard | undefined;
  /** The edit form of a server is open. */
  edit: McpEdit | undefined;
  /** The `mcp.json` editor is open on the file of this scope. */
  fileEditor: McpScope | undefined;
}

/**
 * The MCP servers of the selected thread's pi session and the connectors gallery over them: the overview behind the sidebar's "N MCP servers",
 * Settings › MCP servers, the cards (catalog entries with the state of their server), and the actions: connect, disconnect, exposure, sign in and out.
 * The backend reads `mcp.json` and asks pi for the connection states. Servers connect in the background, so while one is still connecting, or a sign-in waits for the browser, the
 * overview is asked again every two seconds (a sign-in takes as long as the person does). A token typed in the credential dialog goes from there to `connect` and to the backend; this
 * store does not keep it.
 */
export const ConnectorsStore = signalStore(
  { providedIn: 'root' },
  withState<ConnectorsState>({
    overview: undefined,
    busy: new Set<string>(),
    notice: undefined,
    catalog: NO_CATALOG,
    choices: {},
    wizard: undefined,
    edit: undefined,
    fileEditor: undefined,
  }),
  withProps(() => ({ _policy: inject(SETTINGS_POLICY) })),
  withRequestStatus(),
  withLatestRequest(),
  withComputed(({ overview, catalog }) => {
    const translate = inject(Language).t;
    const servers = computed<McpServer[]>(() => overview()?.servers ?? []);
    const enabledCount = computed(() => servers().filter((s) => s.enabled).length);
    return {
      servers,
      /** The servers that are on. */
      enabledCount,
      /** Something the user has to act on: a server that failed or needs a sign-in. */
      needsAttention: computed(() => servers().some((s) => s.state === 'failed' || s.state === 'needs-auth')),
      /** The sidebar footer's text. */
      label: computed(() => {
        if (!overview()) return translate('settings.connectorsStore.mCPServers');
        const n = enabledCount();
        return n === 0
          ? servers().length === 0
            ? translate('settings.connectorsStore.noMCPServers')
            : translate('settings.connectorsStore.mCPServersOff')
          : translate('settings.connectorsStore.mCP', {
              value1: n,
              value2:
                n === 1 ? translate('settings.connectorsStore.server') : translate('settings.connectorsStore.servers'),
            });
      }),
      /** One card per catalog entry, with its server's state. */
      cards: computed(() => connectorCards(catalog(), servers())),
      /** One row for every server, the list of Settings › MCP servers. */
      rows: computed(() => mcpRows(translate, catalog(), servers())),
      /** The nav's count ("4 on"): the servers that are on. */
      onCount: computed(() => onCount(servers())),
      connectedCount: computed(
        () => connectorCards(catalog(), servers()).filter((c) => c.state === 'connected').length,
      ),
      /** The `/` menu's groups: connected servers whose tools are declared to the model. */
      menuGroups: computed(() => connectorMenuGroups(translate, servers(), catalog())),
      /** The sidebar's second line when a server needs the person ("Linear needs you"). */
      attention: computed(() => attentionText(translate, servers(), catalog())),
      /** The servers that are not in the catalog (added by hand, or custom): the gallery lists them under "Your own". */
      ownServers: computed(() => {
        const matched = new Set(connectorCards(catalog(), servers()).flatMap((c) => (c.server ? [c.server.name] : [])));
        return servers().filter((s) => !matched.has(s.name) && s.scope !== 'extension');
      }),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const threads = inject(ThreadsStore);
    const toasts = inject(ToastStore);
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => clearTimeout(timer));

    const threadId = (): string | undefined => threads.selectedId() ?? undefined;
    const owner = (): (() => boolean) => {
      const thread = threadId();
      const started = generation;
      return () => !destroyRef.destroyed && started === generation && thread === threadId();
    };

    /** A sign-in was started and the server has not connected yet. */
    const signingIn = (overview: McpOverview): boolean =>
      overview.servers.some(
        (s) =>
          s.state === 'needs-auth' &&
          (s.signIn?.phase === 'waiting' || (store.notice()?.url !== undefined && s.signIn === undefined)),
      );

    const schedulePoll = (overview: McpOverview): void => {
      clearTimeout(timer);
      const connecting = overview.servers.some((s) => s.state === 'connecting');
      const waiting = signingIn(overview);
      if (!connecting && !waiting) return;
      timer = setTimeout(() => void methods.refresh(), store._policy.connectorPollMs);
    };

    const setBusy = (name: string, on: boolean): void =>
      patchState(store, (s) => {
        const next = new Set(s.busy);
        if (on) next.add(name);
        else next.delete(name);
        return { busy: next };
      });

    /** Runs one action: busy while it is in flight, its overview and message after it, its error as the notice. `thread` is optional for the actions that need no session. */
    const run = async (
      name: string,
      needsThread: boolean,
      call: (thread: string | undefined) => Promise<McpActionResult>,
      server?: string,
    ): Promise<boolean> => {
      const thread = threadId();
      const current = owner();
      if (!thread && needsThread) {
        patchState(store, {
          notice: { level: 'error', text: translate('settings.connectorsStore.openAThreadFirstMCPServersConnect') },
        });
        return false;
      }
      patchState(store, { notice: undefined });
      setBusy(name, true);
      try {
        const result = await call(thread);
        if (!current()) return false;
        store._cancelRequest('overview');
        store.requestDone();
        patchState(store, {
          overview: result.overview,
          notice:
            result.message || result.url
              ? {
                  level: 'info',
                  text: result.message ?? '',
                  ...(result.url ? { url: result.url } : {}),
                  ...(server ? { server } : {}),
                }
              : undefined,
        });
        schedulePoll(result.overview);
        return true;
      } catch (error) {
        if (!current()) return false;
        const text = errorMessage(error);
        // The backend answers "not trusted" for a folder nobody has answered for (a folder with nothing to trust yet looks trusted to the overview); the notice offers the trust.
        patchState(store, {
          notice: {
            level: 'error',
            text,
            ...(server ? { server } : {}),
            ...(server && /not trusted/i.test(text) ? { trust: true } : {}),
          },
        });
        void methods.refresh();
        return false;
      } finally {
        if (current()) setBusy(name, false);
      }
    };

    const act = (name: string, call: (thread: string) => Promise<McpActionResult>): Promise<boolean> =>
      run(name, true, (thread) => call(thread as string), name);

    const choiceOf = (id: string): CardChoice => store.choices()[id] ?? { scope: 'user' };

    const methods = {
      threadId,

      /** The thread decides the project servers and whose connections are meant: asked again from nothing. */
      restart(): void {
        generation++;
        store._cancelRequests();
        patchState(store, {
          overview: undefined,
          busy: new Set<string>(),
          notice: undefined,
          wizard: undefined,
          edit: undefined,
          fileEditor: undefined,
        });
        void methods.refresh();
      },

      async refresh(): Promise<void> {
        clearTimeout(timer);
        const thread = threadId();
        const current = owner();
        if (store.overview() === undefined) store.requestStarted();
        await store._request(
          'overview',
          (signal) => unwrap(mcpOverview({ client: api.client, query: { thread: thread || undefined }, signal })),
          {
            valid: current,
            next: (overview) => {
              patchState(store, { overview });
              schedulePoll(overview);
            },
            error: (error) => {
              if (store.overview() === undefined)
                patchState(store, { notice: { level: 'error', text: errorMessage(error) } });
            },
            settled: () => store.requestDone(),
          },
        );
      },

      setEnabled: (name: string, enabled: boolean): Promise<boolean> =>
        act(name, (thread) =>
          unwrap(mcpEnabled({ client: api.client, path: { name }, query: { thread }, body: { enabled } })),
        ),
      reconnect: (name: string): Promise<boolean> =>
        act(name, (thread) => unwrap(mcpReconnect({ client: api.client, path: { name }, query: { thread } }))),
      login(name: string): Promise<boolean> {
        return act(name, (thread) => unwrap(mcpLogin({ client: api.client, path: { name }, query: { thread } })));
      },
      logout: (name: string): Promise<boolean> =>
        act(name, (thread) => unwrap(mcpLogout({ client: api.client, path: { name }, query: { thread } }))),
      reload: (): Promise<boolean> =>
        act('*', (thread) => unwrap(mcpReload({ client: api.client, query: { thread } }))),

      // ---- the gallery

      /** The backend's catalog, which is where a signed update would arrive; asked for once. The cards and the `/` menu's titles wait for it (a server shows under its own name meanwhile). */
      async loadCatalog(): Promise<void> {
        if (store.catalog().connectors.length > 0) return;
        try {
          patchState(store, { catalog: await unwrap(connectorsCatalog({ client: api.client })) });
        } catch {
          // no catalog: the gallery is empty and says so, the servers still list under their own names
        }
      },

      choiceOf,
      choose(id: string, patch: Partial<CardChoice>): void {
        patchState(store, (s) => ({ choices: { ...s.choices, [id]: { ...choiceOf(id), ...patch } } }));
      },

      /** The "+" of the MCP servers list: the gallery, or the details of one service (a connect that needs a typed token or client id lands there). */
      openWizard(id?: string): void {
        patchState(store, { wizard: { ...(id ? { id } : {}) }, notice: undefined });
      },
      closeWizard(): void {
        patchState(store, { wizard: undefined });
      },

      // ---- the edit form and the file editor

      /** The pencil of a row: the form of the server in the file that defines it. */
      openEdit(name: string, scope: McpScope): void {
        patchState(store, { edit: { name, scope }, notice: undefined });
      },
      closeEdit(): void {
        patchState(store, { edit: undefined });
      },
      serverDetail: (name: string, scope: McpScope): Promise<McpServerDetail> =>
        unwrap(mcpDetail({ client: api.client, path: { name }, query: { thread: threadId() || undefined, scope } })),

      /** A server of your own from the wizard's form. The wizard closes when it went through; a typed secret is in `body` for this one request. */
      async addServer(body: McpServerCreate): Promise<boolean> {
        const ok = await run(
          body.name,
          false,
          (thread) => unwrap(mcpCreate({ client: api.client, query: { thread: thread || undefined }, body })),
          body.name,
        );
        if (ok) patchState(store, { wizard: undefined });
        return ok;
      },

      /** “Save and reconnect”: the form over the entry; a different name moves it. The dialog closes when it went through; it stays open, with the notice, when it did not. */
      async saveServer(name: string, scope: McpScope, body: McpServerBody): Promise<boolean> {
        const ok = await run(
          name,
          false,
          (thread) =>
            unwrap(
              mcpChange({ client: api.client, path: { name }, query: { thread: thread || undefined, scope }, body }),
            ),
          body.name,
        );
        if (ok) patchState(store, { edit: undefined });
        return ok;
      },

      openFileEditor(scope: McpScope): void {
        patchState(store, { fileEditor: scope });
      },
      closeFileEditor(): void {
        patchState(store, { fileEditor: undefined });
      },
      file: (scope: McpScope): Promise<McpFile> =>
        unwrap(mcpFile({ client: api.client, query: { thread: threadId() || undefined, scope } })),
      /** Saves the editor's text. The backend refuses text pi would not read and a file that changed; the error reaches the dialog. Afterwards the servers are read again. */
      async saveFile(scope: McpScope, text: string, mtime: number): Promise<McpFileSaved> {
        const current = owner();
        const saved = await unwrap(
          mcpSaveFile({ client: api.client, query: { thread: threadId() || undefined, scope }, body: { text, mtime } }),
        );
        if (current()) {
          store._cancelRequest('overview');
          store.requestDone();
          patchState(store, { overview: saved.overview });
          schedulePoll(saved.overview);
        }
        return saved;
      },

      /** The reachability check before "Add and connect": nothing is written; a token typed for it is used once. */
      async check(request: McpCheckRequest): Promise<McpCheckResult> {
        try {
          return await unwrap(mcpCheck({ client: api.client, body: request }));
        } catch (error) {
          return { ok: false, status: 'unreachable', message: errorMessage(error) };
        }
      },

      /** "Open in editor" / "Reveal in Finder" of The files group. Outside the desktop app the backend says so, and the person gets that as a toast. */
      async openFile(scope: 'user' | 'project', how: 'open' | 'reveal'): Promise<void> {
        try {
          const result =
            how === 'open'
              ? await unwrap(
                  mcpOpenFile({ client: api.client, query: { thread: threadId() || undefined }, body: { scope } }),
                )
              : await unwrap(
                  mcpRevealFile({ client: api.client, query: { thread: threadId() || undefined }, body: { scope } }),
                );
          if (!result.opened)
            toasts.show('info', result.reason ?? translate('settings.connectorsStore.theDesktopAppDoesThis'));
        } catch (error) {
          toasts.show('error', errorMessage(error));
        }
      },

      dismissNotice(): void {
        patchState(store, { notice: undefined });
      },

      /**
       * Connect: writes the entry, reloads the session and starts the sign-in (an OAuth connector) or just connects (a token). A connector that needs something typed (a token, a client id) opens
       * the dialog first; the dialog calls this again with what was typed. `server` is the name the card is under.
       */
      async connect(
        id: string,
        extra: Pick<ConnectRequest, 'token' | 'clientId' | 'clientSecret' | 'custom'> = {},
      ): Promise<boolean> {
        const connector = connectorById(id, store.catalog());
        const choice = choiceOf(id);
        const auth = connector?.auth.type;
        const needsInput = id === 'custom' || auth === 'bearer' || auth === 'oauth-client';
        if (needsInput && Object.keys(extra).length === 0) {
          methods.openWizard(id);
          return false;
        }
        return methods.add({
          id,
          scope: choice.scope,
          ...(choice.variant ? { variant: choice.variant } : {}),
          ...(choice.exposure ? { exposure: choice.exposure } : {}),
          ...extra,
        });
      },

      /**
       * Writes a server from a complete request (the wizard builds it) and starts what it needs: the sign-in of an OAuth service, the connection of a token. A project-only server in a
       * folder pi does not trust is refused here with the notice that offers the trust. The wizard closes when it went through; when it did not, it stays open and says why.
       */
      async add(request: ConnectRequest): Promise<boolean> {
        const name = request.custom?.name ?? request.id;
        if (request.scope === 'project' && threadId() && store.overview() && !store.overview()?.projectTrusted) {
          patchState(store, {
            notice: {
              level: 'error',
              text: translate('settings.connectorsStore.thisFolderIsNotTrustedSoPi'),
              trust: true,
              server: request.id,
            },
          });
          return false;
        }
        const ok = await run(
          name,
          false,
          (thread) =>
            unwrap(connectorsConnect({ client: api.client, query: { thread: thread || undefined }, body: request })),
          name,
        );
        if (ok) patchState(store, { wizard: undefined });
        return ok;
      },

      /** The trust the notice offers: remembered for this folder, then the connect is tried again. */
      async trustFolder(id: string, retry = true): Promise<void> {
        const current = owner();
        const cwd = threads.cwd();
        if (!cwd) return;
        try {
          await unwrap(settingsDecide({ client: api.client, path: { id: cwd }, body: { decision: 'remember' } }));
          if (!current()) return;
          await methods.refresh();
        } catch (error) {
          if (!current()) return;
          patchState(store, {
            notice: {
              level: 'error',
              text: translate('settings.connectorsStore.couldNotSaveTheAnswer', { value1: errorMessage(error) }),
            },
          });
          return;
        }
        if (retry && current()) await methods.connect(id);
      },

      disconnect: (name: string): Promise<boolean> =>
        run(
          name,
          false,
          (thread) =>
            unwrap(
              connectorsDisconnect({ client: api.client, path: { name }, query: { thread: thread || undefined } }),
            ),
          name,
        ),

      setExposure(name: string, exposure: ConnectorExposure): Promise<boolean> {
        return run(
          name,
          true,
          (thread) =>
            unwrap(
              connectorsExposure({
                client: api.client,
                path: { name },
                query: { thread: thread as string },
                body: { exposure },
              }),
            ),
          name,
        );
      },

      cancelSignIn: (name: string): Promise<boolean> =>
        act(name, (thread) => unwrap(mcpCancelSignIn({ client: api.client, path: { name }, query: { thread } }))),
      pasteSignIn: (name: string, url: string): Promise<boolean> =>
        act(name, (thread) =>
          unwrap(mcpPasteSignIn({ client: api.client, path: { name }, query: { thread }, body: { url } })),
        ),

      /** A custom server from the dialog. */
      connectCustom(custom: CustomConnector, token?: string): Promise<boolean> {
        return methods.connect('custom', { custom, ...(token ? { token } : {}) });
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      const threads = inject(ThreadsStore);
      effect(() => {
        threads.selectedId();
        untracked(() => store.restart());
      });
      void store.loadCatalog();
    },
  }),
);
export type ConnectorsStore = InstanceType<typeof ConnectorsStore>;
