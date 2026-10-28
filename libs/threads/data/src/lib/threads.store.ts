import { DestroyRef, computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
  ApiClient,
  appSettingsSetSetting,
  appSettingsSettings,
  threadsClone,
  threadsCreate,
  threadsEvents,
  threadsFork,
  threadsList,
  threadsPatch,
  threadsRemove,
  threadsSeen,
  unwrap,
  workspacesAddWorkspace,
  workspacesForgetWorkspace,
  workspacesOrderWorkspaces,
  workspacesPatchWorkspace,
  workspacesWorkspaces,
} from '@pi-kit/api';
import { CONTEXT_POLICY, withLatestRequest, withRequestStatus, withSelection } from '@pi-kit/data-access';
import type {
  NewLocal,
  NewWorktree,
  PatchWorktreeSettings,
  ThreadDetail,
  ThreadState,
  ThreadSummary,
  ThreadsEvent,
  Workspace,
  WorktreeKeep,
} from '@pi-kit/protocol';
import {
  countStates,
  sortThreads,
  strongestKind,
  worstContext,
  type ProjectCounts,
  type StateKind,
} from '@pi-kit/threads/util';
import { pipe, switchMap, tap } from 'rxjs';
import { reconnectingEvents, type Dropped } from './reconnecting-events';
import { THREADS_POLICY } from './threads-policy';
import { withFolderChanges } from './with-folder-changes';
import { TrustStore } from './trust.store';

interface ThreadsState {
  /** Every known project (folder), in the order of the sidebar. */
  workspaces: Workspace[];
  /** The current project's folder (`cwd`): where the selected thread lives, else the last one picked. */
  workspace: string | undefined;
  /** The threads of every project. */
  threads: ThreadSummary[];
  showArchived: boolean;
  /** The status channel (`GET /api/threads/events`) is connected: thread states arrive pushed, so the list is not polled. */
  statusConnected: boolean;
}

/** A project of the sidebar with its threads in sidebar order and what a collapsed group shows. */
export interface Project {
  workspace: Workspace;
  threads: ThreadSummary[];
  counts: ProjectCounts;
  /** The strongest state among the threads (what a collapsed project shows), if any. */
  strongest: StateKind | undefined;
  /** The highest context share at or over the warning step, for the collapsed gauge. */
  context: number | undefined;
}

/** A thread's state as the summary's own flags carry it too (`running`, `waiting`, `lastRun` stay for the code that reads them). */
const withThreadState = (thread: ThreadSummary, state: ThreadState): ThreadSummary => ({
  ...thread,
  state,
  running: state.activity === 'running',
  waiting: state.activity === 'waiting',
  lastRun: state.lastRun,
});

/**
 * The projects, their threads and the current selection, backed by `/api/threads`. Every known
 * folder is a project with its threads; the selected thread's folder is the current project. Thread states (running, waiting with the
 * question, context share, unread, cli, the attendant's summary) arrive pushed over the status channel, one connection that is opened again
 * after a drop; the list itself is read again when the channel says it changed, and only as a slow safety net otherwise. The selected thread and
 * project are remembered in the backend's `settings`.
 * The live refresh of the folder the panels work in is its own feature, `withFolderChanges`.
 */
export const ThreadsStore = signalStore(
  { providedIn: 'root' },
  withState<ThreadsState>({
    workspaces: [],
    workspace: undefined,
    threads: [],
    showArchived: false,
    statusConnected: false,
  }),
  withProps(() => ({ _policy: inject(THREADS_POLICY) })),
  withRequestStatus(),
  withLatestRequest(),
  withSelection(),
  withComputed(({ threads, selectedId, workspaces, workspace }) => {
    const thresholds = inject(CONTEXT_POLICY);
    const selected = computed(() => threads().find((t) => t.id === selectedId()));
    const projects = computed<Project[]>(() => {
      const byCwd = new Map<string, ThreadSummary[]>();
      for (const thread of threads()) {
        const group = byCwd.get(thread.cwd);
        if (group) group.push(thread);
        else byCwd.set(thread.cwd, [thread]);
      }
      return workspaces().map((w) => {
        const list = sortThreads(byCwd.get(w.cwd) ?? []);
        return {
          workspace: w,
          threads: list,
          counts: countStates(list),
          strongest: strongestKind(list, selectedId(), thresholds),
          context: worstContext(list, thresholds),
        };
      });
    });
    return {
      selected,
      workspaceName: computed(() => workspaces().find((w) => w.cwd === workspace())?.name),
      /** The project's folder: the selected thread's (the main checkout for a thread in a worktree), else the selected workspace. */
      cwd: computed(() => selected()?.cwd ?? workspace()),
      /** The folder the panels and pi work in: the selected thread's worktree while it has one, else the project's folder. */
      folder: computed(() => {
        const thread = selected();
        return thread?.worktree?.exists ? thread.worktree.path : (thread?.cwd ?? workspace());
      }),
      projects,
      /** The projects the sidebar lists, in its order (⌘1 is the first). */
      visibleProjects: computed(() => projects().filter((p) => !p.workspace.hidden)),
      hiddenProjects: computed(() => projects().filter((p) => p.workspace.hidden)),
    };
  }),
  withFolderChanges(),
  withMethods((store) => {
    const api = inject(ApiClient);
    const trust = inject(TrustStore);
    const destroyRef = inject(DestroyRef);
    let selectToken = 0;
    let initialSelection: { threadId: string | undefined; token: number } | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let polls = 0;
    destroyRef.onDestroy(() => clearInterval(timer));

    /** A write that should not interrupt the user when it fails: the selection is remembered, or it is not. */
    const remember = async (key: string, value: unknown): Promise<void> => {
      try {
        await unwrap(appSettingsSetSetting({ client: api.client, path: { key }, body: { value } }));
      } catch {
        // Not remembering the selection is not worth interrupting the user for.
      }
    };

    /** A call whose failure the sidebar shows (and the caller sees). */
    const send = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        const result = await work();
        store.requestDone();
        return result;
      } catch (error) {
        store.requestFailed(error);
        throw error;
      }
    };

    const patchWorkspaceLocal = (cwd: string, change: Partial<Workspace>): void =>
      patchState(store, (s) => ({ workspaces: s.workspaces.map((w) => (w.cwd === cwd ? { ...w, ...change } : w)) }));

    const methods = {
      /** Loads the projects, restores the last project and thread, and starts the status channel and the safety poll. */
      async init(): Promise<void> {
        const token = selectToken;
        store.requestStarted();
        try {
          const [workspaces, saved] = await Promise.all([
            unwrap(workspacesWorkspaces({ client: api.client, signal: undefined })),
            unwrap(appSettingsSettings({ client: api.client })),
          ]);
          patchState(store, { workspaces });
          const savedWorkspace = typeof saved['workspace'] === 'string' ? saved['workspace'] : undefined;
          patchState(store, { workspace: workspaces.find((w) => w.cwd === savedWorkspace)?.cwd ?? workspaces[0]?.cwd });
          initialSelection = { threadId: typeof saved['thread'] === 'string' ? saved['thread'] : undefined, token };
          await methods.refresh();
          store.requestDone();
        } catch (error) {
          store.requestFailed(error);
        }
        timer ??= setInterval(() => {
          if (document.visibilityState !== 'visible') return;
          polls += 1;
          if (!store.statusConnected() || polls % store._policy.safetyRefreshPolls === 0) void methods.refresh();
        }, store._policy.listPollMs);
      },

      async refresh(): Promise<void> {
        const showArchived = store.showArchived();
        await store._request(
          'threads',
          (signal) =>
            Promise.all([
              unwrap(
                threadsList({
                  client: api.client,
                  signal,
                  query: { workspace: undefined, archived: showArchived ? '1' : undefined },
                }),
              ),
              unwrap(workspacesWorkspaces({ client: api.client, signal })),
            ]),
          {
            valid: () => showArchived === store.showArchived(),
            next: ([threads, workspaces]) => {
              patchState(store, { threads, workspaces });
              // Startup's read may be superseded by a status-channel refresh. Restore only after the winning read publishes the list.
              const restore = initialSelection;
              initialSelection = undefined;
              if (restore?.token === selectToken) {
                if (restore.threadId && threads.some((thread) => thread.id === restore.threadId))
                  methods.select(restore.threadId);
                else if (store.workspace()) void trust.ensure(store.workspace() as string);
              }
              store.requestDone();
              methods.noticeLooking();
            },
            error: (error) => store.requestFailed(error),
          },
        );
      },

      /** The project the next thread, the panels and the Files tree work in. Nothing is open in it until a thread is picked. */
      async selectWorkspace(cwd: string): Promise<void> {
        if (cwd === store.workspace() && !store.selectedId()) return;
        patchState(store, { workspace: cwd, selectedId: undefined });
        selectToken += 1;
        void remember('workspace', cwd);
        void remember('thread', null);
        void trust.ensure(cwd);
      },

      /** Opens a folder as a project: the backend adds it (and a hidden one is shown again), the trust question comes first. */
      async openWorkspace(cwd: string): Promise<void> {
        await send(() => unwrap(workspacesAddWorkspace({ client: api.client, body: { cwd } })));
        await methods.refresh();
        if (store.workspaces().find((w) => w.cwd === cwd)?.hidden) await methods.setHidden(cwd, false);
        await methods.setCollapsed(cwd, false);
        await methods.selectWorkspace(cwd);
      },

      /**
       * Opens a thread. The thread's folder is asked about project trust first when it has no answer (the trust dialog),
       * so the session that opens under the selection already knows whether project resources may load. The thread's folder becomes
       * the current project and its group opens; opening it counts as looking at it.
       */
      select(id: string | undefined): void {
        const token = ++selectToken;
        if (!id) {
          store.setSelected(undefined);
          void remember('thread', null);
          return;
        }
        const cwd = store.threads().find((t) => t.id === id)?.cwd ?? store.workspace();
        void (cwd ? trust.ensure(cwd) : Promise.resolve()).then(() => {
          if (token !== selectToken) return;
          store.setSelected(id);
          if (cwd && cwd !== store.workspace()) {
            patchState(store, { workspace: cwd });
            void remember('workspace', cwd);
          }
          if (cwd && store.workspaces().find((w) => w.cwd === cwd)?.collapsed)
            void methods.setCollapsed(cwd, false).catch(() => undefined);
          void remember('thread', id);
          methods.noticeLooking();
        });
      },

      /**
       * The user is looking at the selected thread, so what it finished or what changed in the pi command line is no news: the unread dot and the
       * "cli" badge are cleared (locally at once, and in the backend). Called when a thread is opened and whenever its state arrives.
       */
      noticeLooking(): void {
        const thread = store.selected();
        if (!thread) return;
        const s = thread.state;
        if (s.activity !== 'idle' || !(s.unseen || s.unread || s.cli)) return;
        patchState(store, (state) => ({
          threads: state.threads.map((t) =>
            t.id === thread.id ? withThreadState(t, { ...t.state, unseen: false, unread: false, cli: false }) : t,
          ),
        }));
        void unwrap(threadsSeen({ client: api.client, path: { id: thread.id } })).catch(() => undefined);
      },

      async toggleArchived(): Promise<void> {
        patchState(store, (s) => ({ showArchived: !s.showArchived }));
        await methods.refresh();
      },

      /** A new, empty thread in `cwd` (default: the current project), in a new git worktree of it when `worktree` is given; the caller selects it. */
      async create(
        cwd = store.workspace(),
        worktree?: NewWorktree,
        local?: NewLocal,
      ): Promise<ThreadDetail | undefined> {
        if (!cwd) return undefined;
        const thread = await send(() =>
          unwrap(
            threadsCreate({
              client: api.client,
              body: { cwd, ...(worktree ? { worktree } : {}), ...(local ? { local } : {}) },
            }),
          ),
        );
        await methods.refresh();
        return thread;
      },

      async rename(id: string, title: string): Promise<void> {
        await send(() => unwrap(threadsPatch({ client: api.client, path: { id }, body: { title } })));
        await methods.refresh();
      },

      async setPinned(id: string, pinned: boolean): Promise<void> {
        await send(() => unwrap(threadsPatch({ client: api.client, path: { id }, body: { pinned } })));
        await methods.refresh();
      },

      /** Archives or unarchives; `worktree` says what happens to the thread's worktree when archiving (default: kept). */
      async setArchived(id: string, archived: boolean, worktree?: WorktreeKeep): Promise<void> {
        await send(() =>
          unwrap(
            threadsPatch({
              client: api.client,
              path: { id },
              body: { archived, ...(archived && worktree ? { worktree } : {}) },
            }),
          ),
        );
        if (archived && store.selectedId() === id && !store.showArchived()) methods.select(undefined);
        await methods.refresh();
      },

      /** Deletes the thread; `worktree` says what happens to its worktree (default: kept). */
      async remove(id: string, worktree?: WorktreeKeep | 'force'): Promise<void> {
        await send(() =>
          unwrap(
            threadsRemove({
              client: api.client,
              path: { id },
              query: { worktree: worktree && worktree !== 'keep' ? worktree : undefined },
            }),
          ),
        );
        if (store.selectedId() === id) methods.select(undefined);
        await methods.refresh();
      },

      /** The whole history into a new thread, or, with `entryId`, the path from the root to that entry (the tree's "Fork to new thread"). */
      async fork(id: string, entryId?: string): Promise<ThreadDetail> {
        const thread = await send(() =>
          unwrap(threadsFork({ client: api.client, path: { id }, body: entryId ? { entryId } : {} })),
        );
        await methods.refresh();
        return thread;
      },

      async clone(id: string): Promise<ThreadDetail> {
        const thread = await send(() => unwrap(threadsClone({ client: api.client, path: { id }, body: {} })));
        await methods.refresh();
        return thread;
      },

      // ---- projects

      /** Folds or unfolds a project's group. The sidebar follows at once; the backend remembers it. */
      async setCollapsed(cwd: string, collapsed: boolean): Promise<void> {
        patchWorkspaceLocal(cwd, { collapsed });
        await send(() => unwrap(workspacesPatchWorkspace({ client: api.client, body: { cwd, collapsed } }))).then(
          (workspaces) => patchState(store, { workspaces }),
        );
      },

      /** Hides a project from the sidebar (it stays a known folder; the filter menu lists it) or shows it again. */
      async setHidden(cwd: string, hidden: boolean): Promise<void> {
        patchWorkspaceLocal(cwd, { hidden });
        await send(() => unwrap(workspacesPatchWorkspace({ client: api.client, body: { cwd, hidden } }))).then(
          (workspaces) => patchState(store, { workspaces }),
        );
      },

      /** Forgets a project: it leaves the sidebar and the list of projects, its threads and files stay (Settings › Projects). What was open in it closes. */
      async forgetWorkspace(cwd: string): Promise<void> {
        const workspaces = await send(() =>
          unwrap(workspacesForgetWorkspace({ client: api.client, path: { id: cwd } })),
        );
        const opened = store.selected();
        patchState(store, {
          workspaces,
          ...(opened && opened.cwd === cwd ? { selectedId: undefined } : {}),
          ...(store.workspace() === cwd ? { workspace: workspaces[0]?.cwd } : {}),
        });
        await methods.refresh();
      },

      /** The per-project opt-out of the attendant (`on: false` keeps it away from this project's threads). */
      async setAttendant(cwd: string, on: boolean): Promise<void> {
        patchWorkspaceLocal(cwd, { attendant: on });
        await send(() => unwrap(workspacesPatchWorkspace({ client: api.client, body: { cwd, attendant: on } }))).then(
          (workspaces) => patchState(store, { workspaces }),
        );
      },

      /** The per-project opt-out of background agents (`on: false` keeps them away from this project's threads). */
      async setAgents(cwd: string, on: boolean): Promise<void> {
        patchWorkspaceLocal(cwd, { agents: on });
        await send(() => unwrap(workspacesPatchWorkspace({ client: api.client, body: { cwd, agents: on } }))).then(
          (workspaces) => patchState(store, { workspaces }),
        );
      },

      /** A project's worktree settings (Settings › Projects): where worktrees go, the branch they are cut from, and the setup command; `null` or blank is the default. */
      async setWorktreeSettings(cwd: string, worktree: PatchWorktreeSettings): Promise<void> {
        await send(() => unwrap(workspacesPatchWorkspace({ client: api.client, body: { cwd, worktree } }))).then(
          (workspaces) => patchState(store, { workspaces }),
        );
      },

      /** Moves a project in the sidebar: before `beforeCwd`, or to the end when it is `undefined`. Used by drag and drop. */
      async moveProject(cwd: string, beforeCwd: string | undefined): Promise<void> {
        const order = store.workspaces().map((w) => w.cwd);
        const without = order.filter((c) => c !== cwd);
        const at = beforeCwd === undefined ? without.length : without.indexOf(beforeCwd);
        if (at < 0) return;
        const next = [...without.slice(0, at), cwd, ...without.slice(at)];
        if (next.every((c, i) => c === order[i])) return;
        await methods.setOrder(next);
      },

      /** Moves a project one place up or down among the ones the sidebar lists (the menu's Move up / Move down, for the keyboard). */
      async stepProject(cwd: string, offset: -1 | 1): Promise<void> {
        const visible = store.visibleProjects().map((p) => p.workspace.cwd);
        const from = visible.indexOf(cwd);
        const to = from + offset;
        if (from < 0 || to < 0 || to >= visible.length) return;
        // Next to the neighbour it passes, in the full order (hidden projects keep their places).
        await methods.moveProject(cwd, offset < 0 ? visible[to] : visible[to + 1]);
      },

      async setOrder(order: string[]): Promise<void> {
        const known = new Map(store.workspaces().map((w) => [w.cwd, w] as const));
        patchState(store, {
          workspaces: order.map((c) => known.get(c)).filter((w): w is Workspace => w !== undefined),
        });
        await send(() => unwrap(workspacesOrderWorkspaces({ client: api.client, body: { order } }))).then(
          (workspaces) => patchState(store, { workspaces }),
        );
      },

      // ---- keyboard (⌘1…⌘9, ⌘[ and ⌘])

      /** ⌘1…⌘9: the nth project of the sidebar opens (unfolded) with the thread you were last in, or, with none, becomes the current project. */
      jumpToProject(index: number): void {
        const project = store.visibleProjects()[index];
        if (!project) return;
        const last = [...project.threads].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0];
        if (last) methods.select(last.id);
        else {
          void methods.setCollapsed(project.workspace.cwd, false).catch(() => undefined);
          void methods.selectWorkspace(project.workspace.cwd);
        }
      },

      /** ⌘[ and ⌘]: the thread before or after the open one in the open project, in the order the sidebar lists them; it stops at the ends. */
      stepThread(offset: -1 | 1): void {
        const project = store.projects().find((p) => p.workspace.cwd === (store.selected()?.cwd ?? store.workspace()));
        if (!project || project.threads.length === 0) return;
        const ids = project.threads.map((t) => t.id);
        const at = ids.indexOf(store.selectedId() as string);
        const next = at < 0 ? (offset > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + offset));
        if (ids[next] && ids[next] !== store.selectedId()) methods.select(ids[next]);
      },
    };

    // ---- the status channel

    type StatusSignal = ThreadsEvent | Dropped;

    const statusEvents = () =>
      reconnectingEvents<ThreadsEvent>(
        (signal, onEvent) => api.stream(threadsEvents({ client: api.client, signal, parseAs: 'stream' }), onEvent),
        store._policy.retryMs,
        true,
      );

    const statusListeners = new Set<(event: ThreadsEvent) => void>();
    const onStatus = (event: StatusSignal): void => {
      if (event.type !== 'dropped') for (const listener of [...statusListeners]) listener(event);
      switch (event.type) {
        case 'dropped':
          patchState(store, { statusConnected: false });
          return;
        case 'snapshot': {
          const known = new Set(store.threads().map((t) => t.id));
          const missing =
            Object.keys(event.states).some((id) => !known.has(id)) || [...known].some((id) => !(id in event.states));
          patchState(store, (s) => ({
            statusConnected: true,
            threads: s.threads.map((t) => (event.states[t.id] ? withThreadState(t, event.states[t.id]) : t)),
          }));
          // The channel was away (or the app just started): what changed meanwhile is in the list, which is read again.
          if (missing || store.workspaces().length === 0) void methods.refresh();
          else methods.noticeLooking();
          return;
        }
        case 'state':
          patchState(store, (s) => ({
            threads: s.threads.map((t) => (t.id === event.id ? withThreadState(t, event.state) : t)),
          }));
          methods.noticeLooking();
          return;
        case 'gone':
          patchState(store, (s) => ({ threads: s.threads.filter((t) => t.id !== event.id) }));
          return;
        case 'list':
          void methods.refresh();
          return;
        case 'agents':
        case 'ping':
          return;
      }
    };

    const followStatus = rxMethod<true>(pipe(switchMap(() => statusEvents().pipe(tap(onStatus)))));

    return {
      ...methods,
      /** Every line of the status channel, for stores of other domains that live on it (the agents of a thread). */
      onStatusEvent(listener: (event: ThreadsEvent) => void): () => void {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      _followStatus: followStatus,
    };
  }),
  withHooks({
    onInit(store) {
      store._followFolder(store.folder);
      store._followStatus(true);
    },
  }),
);
export type ThreadsStore = InstanceType<typeof ThreadsStore>;
