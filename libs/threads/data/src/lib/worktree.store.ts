import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  unwrap,
  workspacesGit,
  worktreeAbort,
  worktreeHandoff,
  worktreeMerge,
  worktreeMessage,
  worktreeState,
  worktreeSync,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type {
  ProjectGit,
  WorktreeHandoffResult,
  WorktreeMergeResult,
  WorktreeStatus,
  WorktreeSyncResult,
} from '@pi-kit/protocol';
import { WorktreeReview } from './ports';

import { ThreadsStore } from './threads.store';

/** `handoff`: a worktree thread into the folder; `move`: a Local thread into a new worktree. */
export type WorktreeDialogMode = 'sync' | 'merge' | 'handoff' | 'move';

interface WorktreeState {
  /** The dialog that is open: which thread's worktree and which action. */
  dialog: { threadId: string; mode: WorktreeDialogMode } | undefined;
  status: WorktreeStatus | undefined;
  /** What a call is doing right now. */
  busy: 'loading' | 'sync' | 'abort' | 'merge' | 'handoff' | undefined;
  error: string | undefined;
  strategy: 'merge' | 'rebase';
  /** The commit message for the uncommitted changes (Merge back); proposed by pi-kit, edited by the person. */
  message: string;
  mergeMode: 'merge' | 'pr';
  remove: boolean;
  syncResult: WorktreeSyncResult | undefined;
  mergeResult: WorktreeMergeResult | undefined;
  /** The project's folder as the hand-off dialogs see it (changed files, branch). */
  folder: ProjectGit | undefined;
  /** Hand off to local: remove the worktree folder afterwards. Move into a worktree: take the folder's uncommitted changes along. */
  handoffRemove: boolean;
  handoffCarry: boolean;
  handoffResult: WorktreeHandoffResult | undefined;
}

const initial: WorktreeState = {
  dialog: undefined,
  status: undefined,
  busy: undefined,
  error: undefined,
  strategy: 'merge',
  message: '',
  mergeMode: 'merge',
  remove: true,
  syncResult: undefined,
  mergeResult: undefined,
  folder: undefined,
  handoffRemove: true,
  handoffCarry: true,
  handoffResult: undefined,
};

/**
 * The Sync with base and Merge back dialogs of a thread in a worktree: where the worktree stands, the strategy, the commit message the
 * person edits, and what the call answered. A conflict is routed to review mode (the "Working tree" source shows the files with their markers). The dialog
 * component is a lazy chunk; this store is small and stays.
 */
export const WorktreeStore = signalStore(
  { providedIn: 'root' },
  withState<WorktreeState>(initial),
  withComputed((store) => ({
    open: computed(() => store.dialog() !== undefined),
    /** Files with conflicts, from the last answer or the worktree's own state. */
    conflicts: computed<string[]>(() => {
      const merged = store.mergeResult()?.conflicts ?? [];
      const synced = store.syncResult()?.conflicts ?? [];
      return merged.length > 0 ? merged : synced.length > 0 ? synced : (store.status()?.conflicts ?? []);
    }),
    /** Merge back can be pressed: nothing is running, nothing waits to be resolved, and the main checkout is on the base. */
    /** Hand off to local can be pressed: nothing is running, nothing waits to be resolved, and the folder is clean (the 409 would say so, the dialog says it first). */
    canHandoff: computed(() => {
      const mode = store.dialog()?.mode;
      if (store.busy() || store.handoffResult()) return false;
      if (mode === 'handoff') {
        const s = store.status();
        return (
          !!s &&
          s.exists &&
          s.conflicts.length === 0 &&
          !s.operation &&
          s.sharedWith === 0 &&
          (store.folder()?.dirty ?? 1) === 0
        );
      }
      return mode === 'move' && !!store.folder()?.git;
    }),
    canMerge: computed(() => {
      const s = store.status();
      if (!s || !s.exists || store.busy()) return false;
      if (s.conflicts.length > 0) return false;
      if (store.mergeMode() === 'merge' && !s.baseCheckedOut) return false;
      if (store.mergeMode() === 'pr' && !(s.gh && s.remote)) return false;
      return true;
    }),
  })),
  withMethods((store) => {
    const api = inject(ApiClient);
    const threads = inject(ThreadsStore);
    const changes = inject(WorktreeReview);
    const toasts = inject(ToastStore);

    const fail = (error: unknown): void => patchState(store, { busy: undefined, error: errorMessage(error) });
    const reload = async (id: string): Promise<void> => {
      try {
        patchState(store, { status: await unwrap(worktreeState({ client: api.client, path: { id } })) });
      } catch (error) {
        patchState(store, { error: errorMessage(error) });
      }
    };

    const methods = {
      async openDialog(threadId: string, mode: WorktreeDialogMode): Promise<void> {
        patchState(store, { ...initial, dialog: { threadId, mode }, busy: 'loading' });
        try {
          if (mode === 'move') {
            // A Local thread has no worktree to read: the folder is what the dialog is about.
            const cwd = threads.threads().find((t) => t.id === threadId)?.cwd;
            const folder = cwd ? await unwrap(workspacesGit({ client: api.client, path: { id: cwd } })) : undefined;
            patchState(store, { folder, handoffCarry: (folder?.dirty ?? 0) > 0, busy: undefined });
            return;
          }
          const status = await unwrap(worktreeState({ client: api.client, path: { id: threadId } }));
          patchState(store, { status, busy: undefined });
          if (mode === 'handoff') {
            const cwd = threads.threads().find((t) => t.id === threadId)?.cwd;
            const folder = cwd
              ? await unwrap(workspacesGit({ client: api.client, path: { id: cwd } })).catch(() => undefined)
              : undefined;
            // The project's "Remove the folder" decides what the switch starts at: now and ask remove, never and after 7 days keep.
            patchState(store, {
              folder,
              handoffRemove: status.removeFolder === 'now' || status.removeFolder === 'ask',
            });
            return;
          }
          if (mode === 'merge' && (status.dirty > 0 || status.operation)) {
            try {
              const proposed = await unwrap(worktreeMessage({ client: api.client, path: { id: threadId } }));
              patchState(store, { message: proposed.message });
            } catch {
              // The person writes the message; nothing else depends on the proposal.
            }
          }
          // The project's "Remove the folder" sets the switch: now and ask remove the worktree afterwards, never and after 7 days leave it.
          if (mode === 'merge')
            patchState(store, { remove: status.removeFolder === 'now' || status.removeFolder === 'ask' });
          // Where the main checkout is not on the base, a pull request is the way when it can be.
          if (mode === 'merge' && !status.baseCheckedOut && status.gh && status.remote)
            patchState(store, { mergeMode: 'pr' });
        } catch (error) {
          fail(error);
        }
      },

      close(): void {
        patchState(store, initial);
      },

      setStrategy(strategy: 'merge' | 'rebase'): void {
        patchState(store, { strategy });
      },
      setMessage(message: string): void {
        patchState(store, { message });
      },
      setMergeMode(mergeMode: 'merge' | 'pr'): void {
        patchState(store, { mergeMode });
      },
      setRemove(remove: boolean): void {
        patchState(store, { remove });
      },
      setHandoffRemove(handoffRemove: boolean): void {
        patchState(store, { handoffRemove });
      },
      setHandoffCarry(handoffCarry: boolean): void {
        patchState(store, { handoffCarry });
      },

      /** Hand off to local, or move into a worktree (whichever the dialog is for): one request, then the list and the panels follow the thread's new folder. */
      async handoff(): Promise<void> {
        const dialog = store.dialog();
        if (!dialog || (dialog.mode !== 'handoff' && dialog.mode !== 'move')) return;
        patchState(store, { busy: 'handoff', error: undefined, handoffResult: undefined });
        try {
          const result = await unwrap(
            worktreeHandoff({
              client: api.client,
              path: { id: dialog.threadId },
              body:
                dialog.mode === 'handoff'
                  ? { to: 'local', remove: store.handoffRemove() }
                  : { to: 'worktree', carryChanges: store.handoffCarry() },
            }),
          );
          patchState(store, { handoffResult: result, busy: undefined });
          toasts.show('success', result.message);
          await threads.refresh();
        } catch (error) {
          fail(error);
        }
      },

      async sync(): Promise<void> {
        const id = store.dialog()?.threadId;
        if (!id) return;
        patchState(store, { busy: 'sync', error: undefined, syncResult: undefined });
        try {
          const syncResult = await unwrap(
            worktreeSync({ client: api.client, path: { id }, body: { strategy: store.strategy() } }),
          );
          patchState(store, { syncResult, busy: undefined });
          await reload(id);
          await threads.refresh();
        } catch (error) {
          fail(error);
        }
      },

      /** Gives up a merge or rebase that waits in the worktree. */
      async abort(): Promise<void> {
        const id = store.dialog()?.threadId;
        if (!id) return;
        patchState(store, { busy: 'abort', error: undefined });
        try {
          await unwrap(worktreeAbort({ client: api.client, path: { id } }));
          patchState(store, { busy: undefined, syncResult: undefined, mergeResult: undefined });
          await reload(id);
        } catch (error) {
          fail(error);
        }
      },

      async merge(): Promise<void> {
        const id = store.dialog()?.threadId;
        const status = store.status();
        if (!id || !status) return;
        patchState(store, { busy: 'merge', error: undefined, mergeResult: undefined });
        const message = store.message().trim();
        try {
          const result = await unwrap(
            worktreeMerge({
              client: api.client,
              path: { id },
              body: {
                mode: store.mergeMode(),
                remove: store.remove(),
                ...((status.dirty > 0 || status.operation) && message ? { message } : {}),
              },
            }),
          );
          patchState(store, { mergeResult: result, busy: undefined });
          if (result.status !== 'conflict') {
            toasts.show('success', result.message);
            if (result.removed) {
              // The worktree is gone: the thread carries on in the project folder; the panels follow.
              await threads.refresh();
            } else {
              await reload(id);
              await threads.refresh();
            }
          } else {
            await reload(id);
          }
        } catch (error) {
          fail(error);
        }
      },

      /** Conflicts open in review mode: the "Working tree" source lists the files with their markers. */
      reviewConflicts(): void {
        const id = store.dialog()?.threadId;
        patchState(store, initial);
        if (!id) return;
        if (threads.selectedId() !== id) threads.select(id);
        changes.setSource('worktree');
        changes.open();
        void changes.refresh('worktree');
      },

      /** From a merge-back conflict to Sync with base: the base goes into the worktree, where the conflicts can be resolved. */
      toSync(): void {
        const id = store.dialog()?.threadId;
        if (id) void methods.openDialog(id, 'sync');
      },
    };
    return methods;
  }),
);
export type WorktreeStore = InstanceType<typeof WorktreeStore>;
