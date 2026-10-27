import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { ApiClient, errorMessage, threadsPlace, unwrap, workspacesGit } from '@pi-kit/api';
import type { PatchWorktreeSettings, ProjectGit, ThreadSummary, Workspace } from '@pi-kit/protocol';
import {
  type WhereMode,
  type WherePlan,
  type WhereWords,
  initialPlan,
  placementOf,
  sendBlocker,
  whereWords,
} from '@pi-kit/threads/util';

import { ThreadsStore } from './threads.store';

const without = (plans: Record<string, WherePlan>, id: string): Record<string, WherePlan> =>
  Object.fromEntries(Object.entries(plans).filter(([key]) => key !== id));

interface NewThreadState {
  /** What was chosen for each thread that has no message yet, by thread id. A plan lives until the first Send or until its thread goes. */
  plans: Record<string, WherePlan>;
  /** What the folders look like (branches, changed files), by project folder. */
  git: Record<string, ProjectGit>;
  /** A request is running (the Send that places the thread, a branch switch). */
  applying: boolean;
  error: string | undefined;
}

/**
 * A thread whose page shows the Where row: the app made it, no message was sent, and it does not run in a worktree yet (a worktree thread has its folder
 * fixed already, the same as one that has begun).
 */
export const isNewThread = (thread: ThreadSummary | undefined): thread is ThreadSummary =>
  !!thread && thread.messageCount === 0 && thread.origin === 'app' && !thread.worktree?.exists;

/**
 * The Where row of the new-thread page: the choice per empty thread (Local or Worktree, the branch, the base, carried changes, the setup script), the
 * look of the project's folder it is made against, and the Send that applies it. The empty thread exists already when its page opens; applying the plan is one
 * request (`POST /api/threads/:id/placement`) just before the first message goes, so a refusal (a dirty folder, a held branch) keeps the draft.
 */
export const NewThreadStore = signalStore(
  { providedIn: 'root' },
  withState<NewThreadState>({ plans: {}, git: {}, applying: false, error: undefined }),
  withComputed(() => {
    const threads = inject(ThreadsStore);
    const selected = computed(() => threads.selected());
    return {
      /** The selected thread, when it is one that has not begun. */
      thread: computed(() => (isNewThread(selected()) ? selected() : undefined)),
    };
  }),
  withComputed((store) => {
    const threads = inject(ThreadsStore);
    const workspace = computed<Workspace | undefined>(() => {
      const thread = store.thread();
      return thread ? threads.workspaces().find((w) => w.cwd === thread.cwd) : undefined;
    });
    return {
      workspace,
      plan: computed(() => {
        const thread = store.thread();
        return thread ? store.plans()[thread.id] : undefined;
      }),
      projectGit: computed(() => {
        const thread = store.thread();
        return thread ? store.git()[thread.cwd] : undefined;
      }),
    };
  }),
  withComputed((store) => {
    const translate = inject(Language).t;
    return {
      /** The sentences the crumb line and the hint under the well show; none for a folder that is not a repository (there is nothing to choose). */
      words: computed<WhereWords | undefined>(() => {
        const thread = store.thread();
        const plan = store.plan();
        const look = store.projectGit();
        return thread && plan && look?.git
          ? whereWords(translate, plan, look, store.workspace()?.worktree, thread.cwd)
          : undefined;
      }),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const threads = inject(ThreadsStore);
    const loading = new Map<string, Promise<ProjectGit | undefined>>();

    const setPlan = (id: string, plan: WherePlan): void =>
      patchState(store, (s) => ({ plans: { ...s.plans, [id]: plan } }));

    const methods = {
      /** Reads the look of a project's folder (branches, changed files); again when `force`. */
      async loadGit(cwd: string, force = false): Promise<ProjectGit | undefined> {
        if (!force && store.git()[cwd]) return store.git()[cwd];
        // A read that is under way answers for everyone who asks meanwhile (the row and the chevron menu both ask when a page opens).
        const running = loading.get(cwd);
        if (running) return running;
        const read = (async (): Promise<ProjectGit | undefined> => {
          try {
            const git = await unwrap(workspacesGit({ client: api.client, path: { id: cwd } }));
            patchState(store, (s) => ({ git: { ...s.git, [cwd]: git } }));
            return git;
          } catch (error) {
            patchState(store, { error: errorMessage(error) });
            return undefined;
          } finally {
            loading.delete(cwd);
          }
        })();
        loading.set(cwd, read);
        return read;
      },

      /** The page of a new thread opened: its folder is read and the plan starts from the project's defaults (or from `mode`, when the chevron menu chose one). */
      async ensure(thread: ThreadSummary, mode?: WhereMode): Promise<void> {
        const git = await methods.loadGit(thread.cwd, !store.plans()[thread.id]);
        const existing = store.plans()[thread.id];
        if (existing) {
          if (mode && existing.mode !== mode) setPlan(thread.id, { ...existing, mode });
          return;
        }
        const settings = threads.workspaces().find((w) => w.cwd === thread.cwd)?.worktree;
        const plan = initialPlan(settings, git);
        setPlan(
          thread.id,
          mode && git?.git !== false ? { ...plan, mode, carry: mode === 'worktree' ? plan.carry : false } : plan,
        );
      },

      /** The chevron menu: a new thread whose row already shows `mode`. */
      async preset(thread: ThreadSummary, mode: WhereMode): Promise<void> {
        await methods.ensure(thread, mode);
      },

      patch(threadId: string, change: Partial<WherePlan>): void {
        const plan = store.plans()[threadId];
        if (plan) setPlan(threadId, { ...plan, ...change });
      },

      /** The Local | Worktree switch. */
      setMode(threadId: string, mode: WhereMode): void {
        methods.patch(threadId, { mode });
      },

      /** Local: switch to `branch` (the checked-out one is "stay"). */
      pickLocalBranch(threadId: string, branch: string): void {
        methods.patch(threadId, { localBranch: branch, newBranch: null });
      },

      clearError(): void {
        patchState(store, { error: undefined });
      },

      /**
       * Applies the plan to the thread just before its first message is sent: one request when there is something to apply (another branch, a worktree, a setup script),
       * then the project's defaults when Remember is on. Throws the backend's sentence when it cannot (the draft stays and the row stays).
       */
      async apply(threadId: string, message: string): Promise<void> {
        const plan = store.plans()[threadId];
        const thread = threads.threads().find((t) => t.id === threadId);
        if (!plan || !thread) return;
        const blocker = sendBlocker(translate, plan);
        if (blocker) throw new Error(blocker);
        const git = store.git()[thread.cwd];
        const placement = placementOf(plan, git, message);
        patchState(store, { applying: true, error: undefined });
        try {
          if (placement) await unwrap(threadsPlace({ client: api.client, path: { id: threadId }, body: placement }));
          if (plan.remember) await methods.remember(thread.cwd, plan, git);
        } catch (error) {
          patchState(store, { error: errorMessage(error) });
          throw error;
        } finally {
          patchState(store, { applying: false });
        }
        patchState(store, (s) => ({ plans: without(s.plans, threadId) }));
        // The thread moved (a worktree, another branch): the list, the crumbs and the folder's look are read again.
        await threads.refresh();
        void methods.loadGit(thread.cwd, true);
      },

      /** Remember: the choice becomes the project's default (Settings › Projects › New threads and Worktrees). */
      async remember(cwd: string, plan: WherePlan, git: ProjectGit | undefined): Promise<void> {
        if (plan.mode === 'ask') return;
        const settings = threads.workspaces().find((w) => w.cwd === cwd)?.worktree;
        const patch: PatchWorktreeSettings = { start: plan.mode };
        if (plan.mode === 'worktree') {
          if (plan.naming !== 'typed') patch.branchMode = plan.naming;
          if ((git?.dirty ?? 0) > 0) {
            if (plan.carry && settings?.carryChanges !== 'always') patch.carryChanges = 'always';
            else if (!plan.carry && settings?.carryChanges === 'always') patch.carryChanges = 'ask';
          }
          if (plan.from && plan.from !== git?.branch) patch.base = plan.from;
          else if (!plan.from && settings?.base) patch.base = null;
          // The first script is the default: the one chosen moves to the front.
          const scripts = settings?.setupScripts ?? [];
          if (
            typeof plan.setup === 'string' &&
            scripts[0]?.id !== plan.setup &&
            scripts.some((s) => s.id === plan.setup)
          ) {
            patch.setupScripts = [
              ...scripts.filter((s) => s.id === plan.setup),
              ...scripts.filter((s) => s.id !== plan.setup),
            ];
          }
        }
        await threads.setWorktreeSettings(cwd, patch);
      },

      /** A plan is dropped with its thread. */
      forget(threadId: string): void {
        patchState(store, (s) => ({ plans: without(s.plans, threadId) }));
      },
    };
    return methods;
  }),
);
export type NewThreadStore = InstanceType<typeof NewThreadStore>;
