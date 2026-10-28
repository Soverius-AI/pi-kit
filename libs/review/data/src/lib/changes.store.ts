import { Language } from '@pi-kit/i18n';
import { computed, DestroyRef, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { filter, pairwise, pipe, tap } from 'rxjs';
import {
  ApiClient,
  changesFile,
  changesList,
  changesRevert,
  changesStage,
  errorMessage,
  sessionOpenInEditor,
  unwrap,
  workspaceStatusInitGit,
} from '@pi-kit/api';
import { ChatStore } from '@pi-kit/chat/api';
import {
  coalescedRunner,
  OVERLAY_BELOW_PX,
  ToastStore,
  UiStore,
  withLatestRequest,
  withRequestStatus,
  withSelection,
} from '@pi-kit/data-access';
import type { ChangeSource, DiffModel } from '@pi-kit/protocol';
import { buildReviewMessage } from '@pi-kit/review/util';
import { type FolderChange, outcomeSummary, ThreadsStore } from '@pi-kit/threads/api';
import { REVIEW_POLICY } from './review-policy';
import { withChangeSource } from './with-change-source';
import { withChangesList } from './with-changes-list';
import { type CommentInput, withReviewComments } from './with-review-comments';

interface ChangesState {
  /** `review` swaps the transcript and the composer for the diff and the comment tray; the columns stay. */
  mode: 'chat' | 'review';
  layout: 'unified' | 'split';
  model: DiffModel | undefined;
  modelLoading: boolean;
  modelError: string | undefined;
  visited: ReadonlySet<string>;
  busy: string | undefined;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Review mode and the Changes panel, put together from features with one job each: the source (`withChangeSource`), the changed files
 * (`withChangesList`), the pending comment batch (`withReviewComments`), the selected file (`withSelection`), the latest list and diff reads
 * (`withLatestRequest`, `withRequestStatus`). What stays here is how they work together: the diff of the selected file, the actions on files,
 * sending the batch (one prompt built by `buildReviewMessage`, with the structured batch in `forwardedProps.review`, then back to the chat so the
 * user sees pi act on it), and following the thread, the panel and the folder's changes.
 */
export const ChangesStore = signalStore(
  { providedIn: 'root' },
  withState<ChangesState>({
    mode: 'chat',
    layout: 'unified',
    model: undefined,
    modelLoading: false,
    modelError: undefined,
    visited: new Set<string>(),
    busy: undefined,
  }),
  withProps(() => ({ _policy: inject(REVIEW_POLICY) })),
  withChangeSource(),
  withChangesList(),
  withReviewComments(),
  withRequestStatus(),
  withLatestRequest(),
  withSelection(),
  withComputed((store) => {
    const translate = inject(Language).t;
    const chat = inject(ChatStore);
    const threads = inject(ThreadsStore);
    const files = store.files;
    const selectedIndex = computed(() => files().findIndex((f) => f.path === store.selectedId()));
    /** How the open thread ended: the Outcome source exists only for a thread that has an outcome. */
    const outcome = computed(() => threads.selected()?.state.outcome ?? null);
    /** "in the outcome, merged as a1b2c3d". */
    const inOutcome = (): string => {
      const o = outcome();
      return o
        ? translate('review.changesStore.inTheOutcome', { value1: outcomeSummary(translate, o) })
        : translate('review.changesStore.inTheOutcomef4488');
    };
    return {
      threadId: chat.threadId,
      outcome,
      hasOutcome: computed(() => outcome() !== null),
      selectedFile: computed(() => files().find((f) => f.path === store.selectedId())),
      selectedIndex,
      /** Files looked at in this review (a file that was reverted no longer counts). */
      viewedCount: computed(() => files().filter((f) => store.visited().has(f.path)).length),
      /** The comments on the selected file. */
      selectedComments: computed(() => store.comments().filter((c) => c.file === store.selectedId())),
      /** The name of the file after the selected one, for the "Next file" button. */
      nextName: computed(() => {
        const next = files()[selectedIndex() + 1];
        return next ? basename(next.path) : undefined;
      }),
      /** The review header's line: `3 files, +12 −4, from this thread`. */
      summary: computed(() => {
        const { added, removed } = store.totals();
        const where =
          store.source() === 'thread'
            ? translate('review.changesStore.fromThisThread')
            : store.source() === 'worktree'
              ? translate('review.changesStore.inTheWorkingTree')
              : inOutcome();
        return `${files().length} ${files().length === 1 ? translate('common.words.file') : translate('common.words.files')}, +${added} −${removed}, ${where}`;
      }),
      /** The diff viewer's subtitle under the file name. */
      subtitle: computed(() => {
        const file = files().find((f) => f.path === store.selectedId());
        if (!file) return undefined;
        if (store.source() === 'worktree') return translate('review.changesStore.againstGitHEAD');
        if (store.source() === 'outcome') return inOutcome();
        return file.run ? translate('review.changesStore.changedInRun', { value1: file.run }) : undefined;
      }),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const threads = inject(ThreadsStore);
    const session = inject(ChatStore);
    const ui = inject(UiStore);
    const toasts = inject(ToastStore);

    const destroyRef = inject(DestroyRef);
    let threadEpoch = 0;
    let activeAction: symbol | undefined;
    let listReloadSelected = false;
    // A small LRU makes revisiting files immediate; each visit still checks the current contents.
    const models = new Map<string, DiffModel>();

    destroyRef.onDestroy(() => threadEpoch++);

    /** One read of the list; `refresh` makes sure only one runs at a time. */
    const loadList = async (id: string, source: ChangeSource): Promise<void> => {
      const selectedAtStart = store.selectedId();
      store.requestStarted();
      await store._request(
        'list',
        (signal) => unwrap(changesList({ client: api.client, path: { id }, query: { source }, signal })),
        {
          valid: () => id === store.threadId() && source === store.source(),
          next: (list) => {
            store._setList(list);
            store.requestDone();
            const reload = listReloadSelected;
            listReloadSelected = false;
            const current = store.selectedId();
            if (store.mode() === 'review' && (!current || !list.files.some((f) => f.path === current))) {
              const first = list.files[0]?.path;
              if (first) methods.select(first);
              else store.setSelected(undefined);
            } else if (current && !list.files.some((f) => f.path === current)) {
              patchState(store, { selectedId: undefined, model: undefined });
            } else if (current && current === selectedAtStart && reload) {
              // Selection changes load themselves. A refresh also checks same-size edits to the current file.
              void methods.loadModel(current);
            }
          },
          error: (error) => store.requestFailed(error),
          settled: () => {
            if (store.loading()) store.requestDone();
          },
        },
      );
    };
    // One list request at a time; the thread is read again for each run, so a switch while one ran loads the new thread's list.
    const refreshList = coalescedRunner(async (source: ChangeSource) => {
      const id = store.threadId();
      if (id) await loadList(id, source);
    });

    const methods = {
      // ---- navigation

      /** Enters review mode on `file` (default: the first, or the one already selected). */
      open(file?: string): void {
        if (!store.threadId()) return;
        patchState(store, { mode: 'review' });
        // Beside the page (1440 and up) the panel stays; where it overlays the page or fills the screen it would hide the diff.
        ui.setPanel(window.innerWidth >= OVERLAY_BELOW_PX ? 'changes' : null);
        if (file) methods.select(file);
        else if (!store.selectedId() && store.files().length > 0) methods.select(store.files()[0].path);
      },

      exit(): void {
        patchState(store, { mode: 'chat' });
      },

      select(path: string): void {
        if (path === store.selectedId()) return;
        store._cancelRequest('model');
        patchState(store, {
          model: models.get(`${store.source()}:${path}`),
          modelError: undefined,
          modelLoading: true,
        });
        store.setSelected(path);
        patchState(store, (s) => ({ visited: new Set(s.visited).add(path) }));
      },

      next(): void {
        const next = store.files()[store.selectedIndex() + 1];
        if (next) methods.select(next.path);
      },

      setLayout(layout: 'unified' | 'split'): void {
        patchState(store, { layout });
      },

      setSource(source: ChangeSource): void {
        if (store.source() === source) return;
        store._cancelRequests();
        listReloadSelected = false;
        store._source.set(source);
        store._setList(undefined);
        patchState(store, {
          selectedId: undefined,
          model: undefined,
          modelLoading: false,
          modelError: undefined,
        });
      },

      async refresh(source = store.source(), reloadSelected = true): Promise<void> {
        const id = store.threadId();
        if (!id) return;
        // A later unrelated change must not drop an earlier request to reload this file.
        listReloadSelected ||= reloadSelected;
        return refreshList(source);
      },

      // ---- comments

      /** A new comment on the selected file, or (with `id`) the new text of an existing one. */
      save(input: CommentInput): void {
        const file = store.selectedId();
        if (file) store._saveComment(file, input);
      },

      /** Builds the one message, sends it as the next prompt and goes back to the chat. */
      async send(): Promise<void> {
        const id = store.threadId();
        const epoch = threadEpoch;
        const comments = store.ordered();
        if (!id || comments.length === 0 || session.running()) return;
        const text = buildReviewMessage(comments);
        patchState(store, { mode: 'chat' });
        store._clearComments();
        try {
          await session.send({ text, images: [], fileRefs: [], review: comments });
        } catch (error) {
          // Restore the originating batch, retaining comments written while sending or after navigating away.
          store._restoreComments(id, comments);
          if (!destroyRef.destroyed && id === store.threadId() && epoch === threadEpoch)
            session.setRunError({ message: errorMessage(error) });
        }
      },

      // ---- actions on files

      /** Review mode on one file of the Files panel's "Open diff": from pi's edits if it is one of them, else the working tree. */
      openFile(path: string, source: ChangeSource): void {
        if (store.source() !== source) methods.setSource(source);
        methods.open(path);
      },

      async revert(path: string, source: ChangeSource = store.source()): Promise<boolean> {
        const id = store.threadId();
        // The outcome is history in git: there is nothing on disk to put back.
        if (!id || source === 'outcome') return false;
        const epoch = threadEpoch;
        const action = (activeAction = Symbol());
        const current = (): boolean => !destroyRef.destroyed && id === store.threadId() && epoch === threadEpoch;
        patchState(store, { busy: translate('review.changesStore.reverting', { value1: path }) });
        try {
          await unwrap(
            changesRevert({ client: api.client, path: { id }, body: { file: path, source, confirm: true } }),
          );
          // The changed lines and their comments belong to the original thread, even after navigation.
          const dropped = store._dropCommentsOn(id, path);
          if (current()) {
            toasts.show(
              'success',
              translate('review.changesStore.reverted', {
                value1: path,
                value2: dropped
                  ? translate('review.changesStore.andDroppedOnIt', {
                      value1: dropped,
                      value2:
                        dropped === 1
                          ? translate('review.changesStore.comment')
                          : translate('review.changesStore.comments'),
                    })
                  : '',
              }),
            );
            await methods.refresh();
          }
          return true;
        } catch (error) {
          if (current())
            toasts.show(
              'error',
              translate('review.changesStore.couldNotRevert', { value1: path, value2: errorMessage(error) }),
            );
          return false;
        } finally {
          if (current() && activeAction === action) patchState(store, { busy: undefined });
        }
      },

      /** "Initialise git": the diffs are built from git, so a folder without a repository gets one (the user asked for it). */
      async initGit(): Promise<void> {
        const cwd = threads.folder();
        if (!cwd || !store.notGit()) return;
        const epoch = threadEpoch;
        patchState(store, { busy: translate('review.changesStore.initialisingGit') });
        try {
          await unwrap(workspaceStatusInitGit({ client: api.client, path: { id: cwd } }));
          if (!destroyRef.destroyed && epoch === threadEpoch) await methods.refresh();
        } catch (error) {
          if (!destroyRef.destroyed)
            toasts.show(
              'error',
              translate('review.changesStore.couldNotInitialiseGit', { value1: errorMessage(error) }),
            );
        } finally {
          if (!destroyRef.destroyed) patchState(store, { busy: undefined });
        }
      },

      async stageAll(): Promise<void> {
        const id = store.threadId();
        if (!id || store.source() === 'outcome') return;
        const epoch = threadEpoch;
        const action = (activeAction = Symbol());
        const current = (): boolean => !destroyRef.destroyed && id === store.threadId() && epoch === threadEpoch;
        patchState(store, { busy: translate('review.changesStore.staging') });
        try {
          const files = store.source() === 'thread' ? store.files().map((f) => f.path) : undefined;
          const result = await unwrap(
            changesStage({
              client: api.client,
              path: { id },
              body: { source: store.source() as 'thread' | 'worktree', ...(files ? { files } : {}) },
            }),
          );
          if (current())
            toasts.show(
              'success',
              translate('review.changesStore.stagedWithGitAdd', {
                value1: result.staged,
                value2:
                  result.staged === 1 ? translate('review.changesStore.file') : translate('review.changesStore.files'),
              }),
            );
        } catch (error) {
          if (current())
            toasts.show('error', translate('review.changesStore.couldNotStage', { value1: errorMessage(error) }));
        } finally {
          if (current() && activeAction === action) patchState(store, { busy: undefined });
        }
      },

      async openInEditor(path: string): Promise<void> {
        const cwd = threads.folder();
        if (!cwd) return;
        try {
          const result = await unwrap(sessionOpenInEditor({ client: api.client, path: { id: cwd }, body: { path } }));
          if (!result.opened)
            toasts.show('info', result.reason ?? translate('review.changesStore.couldNotOpenTheFile'));
        } catch (error) {
          toasts.show(
            'error',
            translate('review.changesStore.couldNotOpen', { value1: path, value2: errorMessage(error) }),
          );
        }
      },

      // ---- internals (the hooks below call these)

      /** A thread of its own: its batch is loaded, the rest starts over. */
      reset(): void {
        threadEpoch++;
        activeAction = undefined;
        store._cancelRequests();
        models.clear();
        listReloadSelected = false;
        store._resetComments();
        store._setList(undefined);
        patchState(store, {
          mode: 'chat',
          selectedId: undefined,
          model: undefined,
          modelLoading: false,
          modelError: undefined,
          busy: undefined,
          visited: new Set<string>(),
        });
        store.clearError();
      },

      async loadModel(path: string | undefined): Promise<void> {
        const id = store.threadId();
        if (!path || !id) {
          store._cancelRequest('model');
          patchState(store, { model: undefined, modelLoading: false, modelError: undefined });
          return;
        }
        const source = store.source();
        const key = `${source}:${path}`;
        const cached = models.get(key);
        patchState(store, {
          model: store.model()?.path === path ? store.model() : cached,
          modelLoading: true,
          modelError: undefined,
        });
        await store._request(
          'model',
          (signal) => unwrap(changesFile({ client: api.client, path: { id, file: path }, query: { source }, signal })),
          {
            valid: () => id === store.threadId() && source === store.source() && path === store.selectedId(),
            next: (model) => {
              // An unchanged response must not rebuild thousands of rows or disturb a comment editor.
              const current = store.model();
              const stable = current && JSON.stringify(current) === JSON.stringify(model) ? current : model;
              models.delete(key);
              models.set(key, stable);
              const oldest = models.keys().next().value;
              if (models.size > 8 && oldest !== undefined) models.delete(oldest);
              patchState(store, { model: stable, modelError: undefined });
            },
            error: (error) => patchState(store, { model: undefined, modelError: errorMessage(error) }),
            settled: () => patchState(store, { modelLoading: false }),
          },
        );
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      const threads = inject(ThreadsStore);
      const ui = inject(UiStore);
      const shown = (): boolean => ui.panel() === 'changes' || store.mode() === 'review';

      // A thread of its own: its batch is loaded, the rest starts over.
      effect(() => {
        const id = store.threadId();
        untracked(() => {
          store.reset();
          if (id) void store.loadComments(id);
        });
      });
      // The list follows the panel (or review mode), the source and the thread.
      effect(() => {
        const open = shown();
        const id = store.threadId();
        const source = store.source();
        if (open && id) untracked(() => void store.refresh(source));
      });
      // The Changes panel and review mode follow the folder live: the stream is shared with the Files panel.
      effect(() => threads.want('changes', shown()));
      // Every change of the folder (a run that ended publishes the files it changed), each one: the selected file reloads when it is among them.
      rxMethod<FolderChange>(
        tap((change) => {
          if (!store.threadId() || !shown()) return;
          const selected = store.selectedId();
          const reload =
            change.overflow ||
            change.headMoved ||
            change.paths.some((path) => path === selected || selected?.startsWith(`${path}/`));
          void store.refresh(store.source(), reload);
        }),
      )(threads.folderChanges);
      // A commit that extends the outcome moves its head: the Outcome source reads it again.
      rxMethod<string | undefined>(
        pipe(
          pairwise(),
          filter(([before, now]) => before !== undefined && now !== undefined && before !== now),
          tap(() => {
            if (store.source() === 'outcome' && shown()) void store.refresh();
          }),
        ),
      )(computed(() => threads.selected()?.state.outcome?.head));
      // The selected file's diff.
      effect(() => {
        const path = store.selectedId();
        store.source();
        untracked(() => void store.loadModel(path));
      });
    },
  }),
);
export type ChangesStore = InstanceType<typeof ChangesStore>;
