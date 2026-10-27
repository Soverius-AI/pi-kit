import { Language } from '@pi-kit/i18n';
import { computed, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withState } from '@ngrx/signals';
import {
  ApiClient,
  errorMessage,
  settingsDecide,
  threadsList,
  unwrap,
  workspacesDefaults,
  workspacesGit,
  workspacesPatchDefaults,
  worktreeRemove,
  worktreeState,
} from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type {
  PatchWorktreeDefaults,
  PatchWorktreeSettings,
  ProjectGit,
  ThreadSummary,
  WorktreeDefaults,
  WorktreeStatus,
} from '@pi-kit/protocol';
import {
  type ScriptDraft,
  baseOptions,
  dirtyPatch,
  draftOf,
  draftProblem,
  newDraft,
  openWorktreeRows,
  withDefault,
  withScript,
  withoutScript,
} from '@pi-kit/settings/util';
import { ThreadsStore, WorktreeStore } from '@pi-kit/threads/api';
import { SettingsStore } from './settings.store';

interface ProjectPageState {
  /** The folder the loaded facts are about. */
  loadedFor: string | undefined;
  /** The folder as git sees it: branches (for “Cut from”) and the checked-out one. */
  git: ProjectGit | undefined;
  /** The defaults for every project (Settings › Projects, second group). */
  defaults: WorktreeDefaults | undefined;
  /** The project's threads with a worktree, archived ones included, and what each worktree answered. */
  threads: ThreadSummary[];
  status: Record<string, WorktreeStatus | undefined>;
  worktreesLoading: boolean;
  /** The setup script being edited (a new one has `id: null`). */
  editing: ScriptDraft | undefined;
  editError: string | undefined;
  /** “Forget” and “Remove folder” ask once before they act; `message` is why a removal was refused (then it offers to force). */
  confirming: { kind: 'forget' } | { kind: 'remove'; threadId: string; force: boolean; message?: string } | undefined;
}

const initial: ProjectPageState = {
  loadedFor: undefined,
  git: undefined,
  defaults: undefined,
  threads: [],
  status: {},
  worktreesLoading: false,
  editing: undefined,
  editError: undefined,
  confirming: undefined,
};

/**
 * A project's page in Settings › Projects and the defaults group of the list: what the page needs besides the workspace itself (the
 * branches, the open worktrees with their status, the setup script being edited) and the changes it makes. `SettingsStore.project` says which project is open; this
 * store loads its facts when that changes and drops them on Back. Every change goes through `PATCH /api/workspaces` and sends only the fields that differ from what the
 * project has (`dirtyPatch`), so a blur on an unchanged field is no request.
 */
export const ProjectPageStore = signalStore(
  { providedIn: 'root' },
  withState<ProjectPageState>(initial),
  withComputed((store) => {
    const translate = inject(Language).t;
    const settings = inject(SettingsStore);
    const threads = inject(ThreadsStore);
    const cwd = computed(() => settings.project());
    const workspace = computed(() => threads.workspaces().find((w) => w.cwd === cwd()));
    return {
      cwd,
      workspace,
      worktree: computed(() => workspace()?.worktree),
      trust: computed(() => (cwd() ? settings.folders()[cwd() as string] : undefined)),
      scripts: computed(() => workspace()?.worktree?.setupScripts ?? []),
      baseOptions: computed(() => baseOptions(translate, store.git(), workspace()?.worktree?.base ?? null)),
      rows: computed(() => openWorktreeRows(translate, store.threads(), cwd() ?? '', store.status())),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const settings = inject(SettingsStore);
    const threads = inject(ThreadsStore);
    const api = inject(ApiClient);
    const worktrees = inject(WorktreeStore);
    const toasts = inject(ToastStore);

    const current = (): string | undefined => settings.project();

    const methods = {
      // ---- loading

      /** Reads what the page needs for the project that is open; a call that was overtaken by another project or by Back is dropped. */
      async load(cwd: string): Promise<void> {
        patchState(store, { ...initial, defaults: store.defaults(), loadedFor: cwd, worktreesLoading: true });
        void settings.loadFolders();
        const git = await unwrap(workspacesGit({ client: api.client, path: { id: cwd } })).catch(() => undefined);
        if (current() !== cwd) return;
        patchState(store, { git });
        await methods.loadWorktrees();
      },

      /** The worktrees of the project (archived threads too) and, for each folder that exists, its status (commits ahead of the base). */
      async loadWorktrees(): Promise<void> {
        const cwd = current();
        if (!cwd) return;
        patchState(store, { worktreesLoading: true });
        try {
          const all = await unwrap(
            threadsList({
              client: api.client,
              signal: undefined,
              query: { workspace: cwd || undefined, archived: '1' },
            }),
          );
          const open = all.filter((t) => t.cwd === cwd && t.worktree?.exists);
          const status: Record<string, WorktreeStatus | undefined> = {};
          await Promise.all(
            open.map(async (t) => {
              status[t.id] = await unwrap(worktreeState({ client: api.client, path: { id: t.id } })).catch(
                () => undefined,
              );
            }),
          );
          if (current() !== cwd) return;
          patchState(store, { threads: open, status, worktreesLoading: false });
        } catch {
          if (current() === cwd) patchState(store, { threads: [], status: {}, worktreesLoading: false });
        }
      },

      async loadDefaults(): Promise<void> {
        try {
          patchState(store, { defaults: await unwrap(workspacesDefaults({ client: api.client })) });
        } catch (error) {
          toasts.show(
            'error',
            translate('settings.projectPageStore.couldNotReadTheDefaults', { value1: errorMessage(error) }),
          );
        }
      },

      reset(): void {
        patchState(store, { ...initial, defaults: store.defaults() });
      },

      // ---- the defaults for every project

      async saveDefaults(patch: PatchWorktreeDefaults): Promise<void> {
        const now = store.defaults();
        const unchanged =
          (patch.root === undefined || (patch.root?.trim() || null) === now?.root) &&
          (patch.start === undefined || patch.start === now?.start);
        if (now && unchanged) return;
        const saved = await settings.save(
          () => unwrap(workspacesPatchDefaults({ client: api.client, body: patch })),
          translate('settings.projectPageStore.couldNotSaveTheDefault'),
        );
        if (saved) {
          patchState(store, { defaults: saved });
          // Every project that has no setting of its own shows the new default.
          void threads.refresh();
        }
      },

      // ---- the project's settings

      /** Saves the fields of `patch` that differ from the project's settings (nothing is sent when none does). */
      async save(patch: PatchWorktreeSettings): Promise<void> {
        const cwd = current();
        if (!cwd) return;
        const dirty = dirtyPatch(store.worktree(), patch);
        if (Object.keys(dirty).length === 0) return;
        await settings.save(
          () => threads.setWorktreeSettings(cwd, dirty),
          translate('settings.projectPageStore.couldNotSaveTheProjectSettings'),
        );
      },

      async setShown(shown: boolean): Promise<void> {
        const cwd = current();
        if (!cwd || store.workspace()?.hidden === !shown) return;
        await settings.save(
          () => threads.setHidden(cwd, !shown),
          translate('settings.projectPageStore.couldNotChangeTheProject'),
        );
      },

      /** Background agents for this project's threads: opt-in, off by default. */
      async setAgents(on: boolean): Promise<void> {
        const cwd = current();
        if (!cwd || store.workspace()?.agents === on) return;
        await settings.save(
          () => threads.setAgents(cwd, on),
          translate('settings.projectPageStore.couldNotChangeTheProject'),
        );
      },

      /** The Run project resources switch: trust and remember, or never trust; pi saves it in `trust.json`. */
      async setTrusted(on: boolean): Promise<void> {
        const cwd = current();
        if (!cwd) return;
        const result = await settings.save(
          () =>
            unwrap(
              settingsDecide({ client: api.client, path: { id: cwd }, body: { decision: on ? 'remember' : 'never' } }),
            ),
          translate('settings.projectPageStore.piCouldNotSaveTheAnswer'),
        );
        if (result && result.running > 0)
          toasts.show('info', translate('settings.projectPageStore.aRunIsGoingInThisFolder'));
        await settings.loadFolders();
      },

      // ---- setup scripts

      addScript(): void {
        patchState(store, { editing: newDraft(), editError: undefined });
      },
      editScript(id: string): void {
        const script = store.scripts().find((s) => s.id === id);
        if (script) patchState(store, { editing: draftOf(script), editError: undefined });
      },
      cancelScript(): void {
        patchState(store, { editing: undefined, editError: undefined });
      },
      setDraft(part: Partial<Omit<ScriptDraft, 'id'>>): void {
        patchState(store, (s) => (s.editing ? { editing: { ...s.editing, ...part }, editError: undefined } : {}));
      },
      /** Saves the draft into the list (a new script goes last); the list is saved whole, which also keeps the suggested one from being derived again. */
      async saveScript(): Promise<boolean> {
        const draft = store.editing();
        if (!draft) return false;
        const problem = draftProblem(translate, draft);
        if (problem) {
          patchState(store, { editError: problem });
          return false;
        }
        await methods.save({ setupScripts: withScript(store.scripts(), draft) });
        patchState(store, { editing: undefined, editError: undefined });
        return true;
      },
      async makeDefaultScript(id: string): Promise<void> {
        await methods.save({ setupScripts: withDefault(store.scripts(), id) });
      },
      async removeScript(id: string): Promise<void> {
        if (store.editing()?.id === id) patchState(store, { editing: undefined });
        await methods.save({ setupScripts: withoutScript(store.scripts(), id) });
      },

      // ---- open worktrees

      /** Hand off to local, Merge back: the dialogs of the thread menu, opened from the row. The rows are read again when the dialog closes. */
      handoff(threadId: string): void {
        void worktrees.openDialog(threadId, 'handoff');
      },
      mergeBack(threadId: string): void {
        void worktrees.openDialog(threadId, 'merge');
      },
      askRemove(threadId: string): void {
        patchState(store, { confirming: { kind: 'remove', threadId, force: false } });
      },
      /** Removes the worktree folder; the project's threads carry on in its folder. A refusal (uncommitted changes, another thread in it) is shown and offers “Remove anyway”. */
      async removeFolder(): Promise<void> {
        const asking = store.confirming();
        if (asking?.kind !== 'remove') return;
        try {
          await unwrap(
            worktreeRemove({ client: api.client, path: { id: asking.threadId }, body: { force: asking.force } }),
          );
          patchState(store, { confirming: undefined });
          toasts.show('success', translate('settings.projectPageStore.theWorktreeFolderIsRemovedTheThread'));
          await threads.refresh();
          await methods.loadWorktrees();
        } catch (error) {
          patchState(store, {
            confirming: { kind: 'remove', threadId: asking.threadId, force: true, message: errorMessage(error) },
          });
        }
      },

      // ---- forget

      askForget(): void {
        patchState(store, { confirming: { kind: 'forget' } });
      },
      cancelConfirm(): void {
        patchState(store, { confirming: undefined });
      },
      /** Forgets the project and returns to the list. */
      async forget(): Promise<void> {
        const cwd = current();
        if (!cwd) return;
        const done = await settings.save(async () => {
          await threads.forgetWorkspace(cwd);
          return true;
        }, translate('settings.projectPageStore.couldNotForgetTheProject'));
        patchState(store, { confirming: undefined });
        if (done) settings.closeProject();
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      const settings = inject(SettingsStore);
      const worktrees = inject(WorktreeStore);
      let wasOpen = false;
      // The page loads its facts when a project opens and lets go of them on Back.
      effect(() => {
        const cwd = settings.project();
        untracked(() => {
          if (cwd) void store.load(cwd);
          else store.reset();
        });
      });
      // After a hand off or a merge back the worktree is not what it was.
      effect(() => {
        const open = worktrees.open();
        untracked(() => {
          if (wasOpen && !open && settings.project()) void store.loadWorktrees();
          wasOpen = open;
        });
      });
    },
  }),
);
export type ProjectPageStore = InstanceType<typeof ProjectPageStore>;
