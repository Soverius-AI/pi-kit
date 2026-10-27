import { Language } from '@pi-kit/i18n';
import { computed, DestroyRef, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  sessionCreateEntry,
  sessionDeleteEntry,
  sessionOpenInEditor,
  sessionRenameEntry,
  sessionRevealInFileManager,
  sessionWorkspaceFiles,
  sessionWorkspaceTree,
  unwrap,
  workspaceStatusStatus,
} from '@pi-kit/api';
import { ChatStore } from '@pi-kit/chat/api';
import {
  DialogStore,
  ToastStore,
  UiStore,
  readStorage,
  withLatestRequest,
  withPersistence,
  withRequestStatus,
  withSelection,
  writeStorage,
} from '@pi-kit/data-access';
import {
  type FileDecoration,
  type FileRow,
  baseName,
  decorator,
  enterAction,
  joinPath,
  menuItems,
  nameProblem,
  parentOf,
  typeAhead,
  visibleRows,
} from '@pi-kit/files/util';
import type { FileNode, WorkspaceStatus } from '@pi-kit/protocol';
import { ChangesStore } from '@pi-kit/review/api';
import { ThreadsStore } from '@pi-kit/threads/api';
import { FILES_POLICY } from './files-policy';

const IGNORED_KEY = 'pk.files.showIgnored';

export interface FilesConfirm {
  kind: 'delete' | 'revert';
  node: FileNode;
  deco: FileDecoration;
}

export interface FilesMenu {
  x: number;
  y: number;
  node: FileNode;
  items: ReturnType<typeof menuItems>;
}

interface FilesState {
  /** Whether the Files panel is open: the store follows the folder only while it is. */
  active: boolean;
  children: ReadonlyMap<string, FileNode[]>;
  expanded: ReadonlySet<string>;
  query: string;
  matches: FileNode[];
  searching: boolean;
  status: WorkspaceStatus | undefined;
  showIgnored: boolean;
  menu: FilesMenu | undefined;
  confirm: FilesConfirm | undefined;
  /** Counts requests to move the keyboard focus onto the selected row; the panel focuses it. */
  focusRequests: number;
}

/**
 * The Files panel's state and logic: the workspace folder as a tree that only lists what git does not
 * ignore (the same index `@` completion uses; "Show ignored" lists the rest), folders loaded when opened, git's badges, the filter, the context
 * menu and the file actions, the keyboard (arrows, type-ahead, F2, Delete). It follows the folder live through the threads store's one watch stream,
 * shared with the Changes panel. The panel renders these signals and forwards intent; the one DOM job left to it is moving the focus.
 */
export const FilesStore = signalStore(
  { providedIn: 'root' },
  withState<FilesState>({
    active: false,
    children: new Map<string, FileNode[]>(),
    expanded: new Set<string>(),
    query: '',
    matches: [],
    searching: false,
    status: undefined,
    showIgnored: false,
    menu: undefined,
    confirm: undefined,
    focusRequests: 0,
  }),
  withProps(() => ({ _policy: inject(FILES_POLICY) })),
  // "Show ignored" is remembered in the UI storage only (the desktop app's file, else localStorage; no backend copy): the persistence trait with a local half.
  withPersistence<FilesState>({
    readLocal: () => ({ showIgnored: readStorage(IGNORED_KEY) === '1' }),
    writeLocal: (state) => writeStorage(IGNORED_KEY, state.showIgnored ? '1' : '0'),
  }),
  withLatestRequest(),
  withRequestStatus(),
  withSelection(),
  withComputed((store) => {
    const threads = inject(ThreadsStore);
    return {
      cwd: threads.folder,
      /** Request state is the source of truth; an older read cannot clear a newer read's busy marker. */
      loadingDirs: computed<ReadonlySet<string>>(
        () =>
          new Set(
            Object.entries(store._requestStates())
              .filter(([key, request]) => key.startsWith('tree:') && request.status === 'loading')
              .map(([key]) => key.slice(5)),
          ),
      ),
      folderName: computed(() => threads.workspaceName() ?? ''),
      hasThread: computed(() => !!threads.selectedId()),
      decoration: computed(() => decorator(store.status())),
      changedCount: computed(() => store.status()?.entries.length ?? 0),
      /** The rows in view, in order: search results, or the open part of the tree. */
      rows: computed<FileRow[]>(() =>
        store.query().trim()
          ? store.matches().map((node) => ({ node, depth: 0 }))
          : visibleRows(store.children(), store.expanded()),
      ),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const threads = inject(ThreadsStore);
    const api = inject(ApiClient);
    const toasts = inject(ToastStore);
    const ui = inject(UiStore);
    const dialogs = inject(DialogStore);
    const changes = inject(ChangesStore);
    const destroyRef = inject(DestroyRef);

    let folderGeneration = 0;
    let buffer = '';
    let bufferTimer: ReturnType<typeof setTimeout> | undefined;

    destroyRef.onDestroy(() => clearTimeout(bufferTimer));
    // A path is not a view identity: returning to the same folder must not revive an old action's UI callbacks.
    const ownsFolder = (): (() => boolean) => {
      const generation = folderGeneration;
      const cwd = store.cwd();
      return () => !destroyRef.destroyed && generation === folderGeneration && cwd === store.cwd();
    };

    const decoOf = (node: FileNode): FileDecoration => store.decoration()(node.path, node.dir);
    const loadStatus = async (): Promise<void> => {
      const cwd = store.cwd();
      if (!cwd) return;
      const id = threads.selectedId();
      await store._request(
        'status',
        (signal) =>
          unwrap(
            workspaceStatusStatus({
              client: api.client,
              path: { id: cwd },
              query: { thread: id || undefined },
              signal,
            }),
          ),
        {
          valid: () => cwd === store.cwd() && id === threads.selectedId(),
          next: (status) => {
            if (JSON.stringify(status) !== JSON.stringify(store.status())) patchState(store, { status });
          },
        },
      );
    };

    const load = async (dir: string): Promise<void> => {
      const cwd = store.cwd();
      if (!cwd) return;
      const showIgnored = store.showIgnored();
      await store._request(
        `tree:${dir}`,
        (signal) =>
          unwrap(
            sessionWorkspaceTree({
              client: api.client,
              path: { id: cwd },
              query: { dir, ignored: showIgnored ? '1' : undefined },
              signal,
            }),
          ),
        {
          valid: () => cwd === store.cwd() && showIgnored === store.showIgnored(),
          next: (nodes) => {
            const known = store.children().get(dir);
            if (!known || JSON.stringify(known) !== JSON.stringify(nodes))
              patchState(store, (s) => ({ children: new Map(s.children).set(dir, nodes) }));
            if (dir === '') store.requestDone();
          },
          error: (error) => {
            if (dir === '') store.requestFailed(error);
            else if (!/not exist|ENOENT/i.test(errorMessage(error)))
              toasts.show(
                'error',
                translate('files.filesStore.couldNotRead', { value1: dir, value2: errorMessage(error) }),
              );
            else
              patchState(store, (s) => ({
                children: s.children.has(dir) ? new Map([...s.children].filter(([k]) => k !== dir)) : s.children,
              }));
          },
        },
      );
    };

    /** After an action of this panel: the folder and the badges, without waiting for the watcher. */
    const reloadNow = async (dir: string): Promise<void> => {
      await Promise.all([load(dir), loadStatus()]);
    };

    const focusSelected = (): void => patchState(store, (s) => ({ focusRequests: s.focusRequests + 1 }));
    /** Selects a row and asks the panel to put the keyboard focus on it. */
    const select = (path: string): void => {
      store.setSelected(path);
      focusSelected();
    };

    const toggle = (node: FileNode): void => {
      const next = new Set(store.expanded());
      if (next.delete(node.path)) {
        patchState(store, { expanded: next });
        return;
      }
      next.add(node.path);
      patchState(store, { expanded: next });
      if (!store.children().has(node.path)) void load(node.path);
    };

    const open = async (path: string): Promise<void> => {
      const cwd = store.cwd();
      if (!cwd) return;
      try {
        const result = await unwrap(sessionOpenInEditor({ client: api.client, path: { id: cwd }, body: { path } }));
        if (!result.opened) toasts.show('info', result.reason ?? translate('files.filesStore.couldNotOpenTheFile'));
      } catch (error) {
        toasts.show('error', translate('files.filesStore.couldNotOpen', { value1: path, value2: errorMessage(error) }));
      }
    };

    /** "Add to message": a `UiStore` request the composer answers by inserting `@path` at the caret. */
    const mention = (path: string, dir: boolean): void => {
      if (!threads.selectedId()) return void toasts.show('info', translate('files.filesStore.openAThreadToAddAFile'));
      ui.insertIntoComposer(`@${path}${dir ? '/' : ''}`);
    };

    /** Review mode on this file: from pi's edits if it is one of them, else git's working tree. */
    const showDiff = (path: string): void => {
      const inThread = store.status()?.thread.includes(path) ?? false;
      changes.openFile(path, inThread ? 'thread' : 'worktree');
    };

    const copy = async (text: string): Promise<void> => {
      try {
        await navigator.clipboard.writeText(text);
        toasts.show(
          'success',
          translate('files.filesStore.copied', { value1: text.length > 60 ? `…${text.slice(-58)}` : text }),
        );
      } catch {
        toasts.show('error', translate('files.filesStore.theClipboardIsNotAvailableHere'));
      }
    };

    const itemsFor = (node: FileNode) =>
      menuItems(translate, node, {
        decoration: decoOf(node),
        hasThread: !!threads.selectedId(),
        missing: node.missing,
        composerAvailable: !!threads.selectedId(),
      });

    const askConfirm = (kind: FilesConfirm['kind'], node: FileNode, deco = decoOf(node)): void =>
      patchState(store, { confirm: { kind, node, deco } });

    const create = async (near: FileNode, dir: boolean): Promise<void> => {
      const cwd = store.cwd();
      if (!cwd) return;
      const current = ownsFolder();
      const parent = near.dir ? near.path : parentOf(near.path);
      const answer = await dialogs.askName(
        '',
        dir
          ? translate('files.filesStore.newFolderIn', { value1: parent || baseName(cwd) })
          : translate('files.filesStore.newFileIn', { value1: parent || baseName(cwd) }),
        dir ? translate('files.filesStore.folderName') : translate('files.filesStore.fileNameEGNotesMd'),
      );
      if (answer === undefined) return;
      const problem = nameProblem(translate, answer);
      if (problem) {
        if (current()) toasts.show('error', problem);
        return;
      }
      const path = joinPath(parent, answer.trim());
      try {
        await unwrap(sessionCreateEntry({ client: api.client, path: { id: cwd }, body: { path, dir } }));
        if (!current()) return;
        if (parent && !store.expanded().has(parent))
          patchState(store, (s) => ({ expanded: new Set(s.expanded).add(parent) }));
        await reloadNow(parent);
        if (current()) select(path);
      } catch (error) {
        if (current()) toasts.show('error', errorMessage(error));
      }
    };

    const rename = async (node: FileNode): Promise<void> => {
      const cwd = store.cwd();
      if (!cwd) return;
      const current = ownsFolder();
      const answer = await dialogs.askName(
        node.name,
        translate('files.filesStore.rename', { value1: node.name }),
        translate('files.filesStore.newName'),
      );
      if (answer === undefined || answer === node.name) return;
      const problem = nameProblem(translate, answer);
      if (problem) {
        if (current()) toasts.show('error', problem);
        return;
      }
      const to = joinPath(parentOf(node.path), answer.trim());
      try {
        await unwrap(sessionRenameEntry({ client: api.client, path: { id: cwd }, body: { from: node.path, to } }));
        if (!current()) return;
        if (node.dir && store.expanded().has(node.path)) {
          patchState(store, (s) => ({
            expanded: new Set([...s.expanded].filter((p) => p !== node.path && !p.startsWith(`${node.path}/`))),
          }));
        }
        await reloadNow(parentOf(node.path));
        if (current()) select(to);
      } catch (error) {
        if (current())
          toasts.show(
            'error',
            translate('files.filesStore.couldNotRename', { value1: node.path, value2: errorMessage(error) }),
          );
      }
    };

    const methods = {
      select,
      toggle,
      open,
      showDiff,

      // ---- the panel opening and closing

      /** The panel opened: start from the folder's root. */
      activate(): void {
        patchState(store, { active: true });
        threads.want('files', true);
      },
      deactivate(): void {
        folderGeneration++;
        patchState(store, { active: false, menu: undefined, confirm: undefined });
        threads.want('files', false);
        store._cancelRequests();
        patchState(store, { searching: false });
        clearTimeout(bufferTimer);
      },
      /** A folder of its own: start from its root. */
      resetFolder(): void {
        folderGeneration++;
        store._cancelRequests();
        patchState(store, {
          children: new Map(),
          expanded: new Set(),
          selectedId: undefined,
          status: undefined,
          menu: undefined,
          confirm: undefined,
        });
        store.clearError();
        if (store.cwd()) {
          void load('');
          void loadStatus();
        }
      },
      loadStatus,

      // ---- loading

      reload(): void {
        const opened = [...store.expanded()];
        const cwd = store.cwd();
        const showIgnored = store.showIgnored();
        patchState(store, { children: new Map() });
        void load('').then(() =>
          cwd === store.cwd() && showIgnored === store.showIgnored()
            ? Promise.all(opened.map((dir) => load(dir)))
            : undefined,
        );
        void loadStatus();
      },

      setShowIgnored(on: boolean): void {
        void store.persist({ showIgnored: on });
      },

      async reloadLoaded(): Promise<void> {
        const loaded = [...store.children().keys()];
        await Promise.all((loaded.length ? loaded : ['']).map((dir) => load(dir)));
      },

      /** The folder changed (or the stream just opened): reload the folders it touched, and the badges. */
      async onChange(): Promise<void> {
        const last = threads.watchLast();
        const loaded = [...store.children().keys()];
        // A commit, checkout or `git add` (`.git/index`, `.git/HEAD`) can add or remove rows anywhere (a deleted file's row goes).
        const everything = !last || last.overflow || last.paths.some((p) => p.startsWith('.git/'));
        const touched = everything ? new Set(loaded) : new Set(last.paths.map(parentOf));
        await Promise.all([loadStatus(), ...loaded.filter((dir) => touched.has(dir)).map((dir) => load(dir))]);
      },

      setQuery(query: string): void {
        patchState(store, { query });
      },

      clearFilter(): boolean {
        if (!store.query()) return false;
        patchState(store, { query: '' });
        return true;
      },

      /** The filter searches the whole index (called a moment after typing stops). */
      async search(query: string, signal: AbortSignal): Promise<void> {
        const cwd = store.cwd();
        if (!cwd) return;
        await store._request(
          'search',
          (requestSignal) =>
            unwrap(
              sessionWorkspaceFiles({
                client: api.client,
                path: { id: cwd },
                query: { q: query, limit: 100 },
                signal: requestSignal,
              }),
            ),
          {
            signal,
            valid: () => cwd === store.cwd() && query === store.query().trim(),
            next: (found) =>
              patchState(store, {
                matches: found.map((m) => ({
                  name: baseName(m.path.replace(/\/$/, '')),
                  path: m.path.replace(/\/$/, ''),
                  dir: !!m.dir,
                })),
              }),
            settled: () => patchState(store, { searching: false }),
          },
        );
      },

      // ---- selection, opening

      onClick(event: MouseEvent, node: FileNode): void {
        // ⌘-click is the context menu on a Mac trackpad that has no right button.
        if (event.metaKey) return methods.openMenu(event, node);
        store.setSelected(node.path);
        if (node.dir && !store.query().trim()) toggle(node);
      },

      /** Enter: a folder opens or closes, a changed file opens its diff, anything else is inserted into the message as `@path`. */
      enter(node: FileNode, event: Event): void {
        event.preventDefault();
        const action = enterAction(node, decoOf(node));
        if (action === 'toggle') toggle(node);
        else if (action === 'diff') showDiff(node.path);
        else mention(node.path, false);
      },

      /** ↓ in the filter moves to the first row. */
      focusFirst(): void {
        const first = store.rows()[0]?.node.path;
        if (first) select(first);
      },

      // ---- keyboard

      onKey(event: KeyboardEvent): void {
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea') || event.altKey) return;
        const rows = store.rows();
        const at = rows.findIndex((r) => r.node.path === store.selectedId());
        const row = rows[at];
        const mod = event.metaKey || event.ctrlKey;
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            if (at < rows.length - 1) select(rows[at + 1].node.path);
            else if (at < 0 && rows[0]) select(rows[0].node.path);
            return;
          case 'ArrowUp':
            event.preventDefault();
            if (at > 0) select(rows[at - 1].node.path);
            return;
          case 'Home':
          case 'End':
            event.preventDefault();
            if (rows.length) select(rows[event.key === 'Home' ? 0 : rows.length - 1].node.path);
            return;
          case 'ArrowRight':
            if (!row?.node.dir || store.query().trim()) return;
            event.preventDefault();
            if (!store.expanded().has(row.node.path)) toggle(row.node);
            else if (rows[at + 1]?.depth > row.depth) select(rows[at + 1].node.path);
            return;
          case 'ArrowLeft':
            if (!row || store.query().trim()) return;
            event.preventDefault();
            if (row.node.dir && store.expanded().has(row.node.path)) toggle(row.node);
            else if (parentOf(row.node.path)) select(parentOf(row.node.path));
            return;
          case 'F2':
            if (row) {
              event.preventDefault();
              void rename(row.node);
            }
            return;
          case 'Delete':
            if (row) {
              event.preventDefault();
              askConfirm('delete', row.node);
            }
            return;
          case 'ContextMenu':
            if (row) {
              event.preventDefault();
              const box = (event.target as HTMLElement).getBoundingClientRect();
              patchState(store, {
                menu: { x: box.left + 40, y: box.bottom, node: row.node, items: itemsFor(row.node) },
              });
            }
            return;
          default:
            if (event.key.length === 1 && !mod && event.key !== ' ') {
              buffer += event.key;
              clearTimeout(bufferTimer);
              bufferTimer = setTimeout(() => (buffer = ''), store._policy.typeAheadMs);
              const found = typeAhead(rows, at, buffer);
              if (found >= 0) select(rows[found].node.path);
            }
        }
      },

      // ---- context menu

      openMenu(event: MouseEvent, node: FileNode): void {
        event.preventDefault();
        store.setSelected(node.path);
        patchState(store, { menu: { x: event.clientX, y: event.clientY, node, items: itemsFor(node) } });
      },

      closeMenu(): void {
        const node = store.menu()?.node;
        patchState(store, { menu: undefined });
        if (node) select(node.path);
      },

      chooseMenu(id: string): void {
        const node = store.menu()?.node;
        patchState(store, { menu: undefined });
        if (!node) return;
        const cwd = store.cwd();
        const deco = decoOf(node);
        switch (id) {
          case 'open':
            void open(node.path);
            break;
          case 'reveal':
            if (cwd)
              void unwrap(
                sessionRevealInFileManager({ client: api.client, path: { id: cwd }, body: { path: node.path } }),
              ).then(
                (r) =>
                  !r.opened && toasts.show('info', r.reason ?? translate('files.filesStore.couldNotRevealTheFile')),
                (e) => toasts.show('error', errorMessage(e)),
              );
            break;
          case 'copy-path':
            void copy(cwd ? `${cwd.replace(/[\\/]$/, '')}/${node.path}` : node.path);
            break;
          case 'copy-relative':
            void copy(node.path);
            break;
          case 'mention':
            mention(node.path, node.dir);
            break;
          case 'new-file':
            void create(node, false);
            break;
          case 'new-folder':
            void create(node, true);
            break;
          case 'rename':
            void rename(node);
            break;
          case 'delete':
            askConfirm('delete', node);
            break;
          case 'diff':
            showDiff(node.path);
            break;
          case 'revert':
            askConfirm('revert', node, deco);
            break;
        }
      },

      // ---- delete, revert

      cancelConfirm(): void {
        patchState(store, { confirm: undefined });
      },

      async confirmed(): Promise<void> {
        const c = store.confirm();
        const cwd = store.cwd();
        patchState(store, { confirm: undefined });
        if (!c || !cwd) return;
        const current = ownsFolder();
        try {
          if (c.kind === 'delete') {
            await unwrap(
              sessionDeleteEntry({ client: api.client, path: { id: cwd }, body: { path: c.node.path, confirm: true } }),
            );
            if (current()) toasts.show('success', translate('files.filesStore.deleted', { value1: c.node.path }));
          } else {
            await changes.revert(c.node.path, 'worktree');
          }
        } catch (error) {
          if (current())
            toasts.show(
              'error',
              `${c.kind === 'delete' ? translate('files.filesStore.couldNotDelete') : translate('files.filesStore.couldNotRevert')} ${c.node.path}: ${errorMessage(error)}`,
            );
        }
        if (current()) await reloadNow(parentOf(c.node.path));
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      const threads = inject(ThreadsStore);
      const chat = inject(ChatStore);
      let lastThread: string | undefined;
      let seenTick = 0;
      let seenIgnored = store.showIgnored();
      let wasRunning = false;

      // A folder of its own: start from its root. (Also when the panel opens.)
      effect(() => {
        const cwd = store.cwd();
        if (!store.active()) return;
        void cwd;
        untracked(() => {
          lastThread = threads.selectedId();
          seenTick = threads.watchTick();
          seenIgnored = store.showIgnored();
          wasRunning = chat.running();
          store.resetFolder();
        });
      });
      // Another thread in the same folder: its "changed in this thread" files.
      effect(() => {
        const id = threads.selectedId();
        if (!store.active() || id === lastThread) return;
        lastThread = id;
        untracked(() => void store.loadStatus());
      });
      // When pi's run ends, its edits are on disk and in the session.
      effect(() => {
        const running = chat.running();
        if (!store.active()) return;
        if (wasRunning && !running) untracked(() => void store.loadStatus());
        wasRunning = running;
      });
      // The folder changed (or the stream just opened): reload the folders it touched, and the badges.
      effect(() => {
        const tick = threads.watchTick();
        if (!store.active() || tick === seenTick) return;
        seenTick = tick;
        untracked(() => void store.onChange());
      });
      // "Show ignored" changes what every open folder lists.
      effect(() => {
        const on = store.showIgnored();
        if (!store.active() || on === seenIgnored) return;
        seenIgnored = on;
        untracked(() => void store.reloadLoaded());
      });
      // The filter searches the whole index a moment after typing stops.
      effect((onCleanup) => {
        const query = store.query().trim();
        const cwd = store.cwd();
        if (!store.active()) return;
        if (!query || !cwd) {
          untracked(() => patchState(store, { matches: [], searching: false }));
          return;
        }
        const abort = new AbortController();
        untracked(() => patchState(store, { searching: true }));
        const timer = setTimeout(() => void store.search(query, abort.signal), store._policy.searchDelayMs);
        onCleanup(() => {
          clearTimeout(timer);
          abort.abort();
        });
      });
    },
  }),
);
export type FilesStore = InstanceType<typeof FilesStore>;
