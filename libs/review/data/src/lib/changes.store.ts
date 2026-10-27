import { Language } from '@pi-kit/i18n';
import { computed, DestroyRef, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withProps, withState } from '@ngrx/signals';
import {
  ApiClient,
  changesComments,
  changesFile,
  changesList,
  changesPutComments,
  changesRevert,
  changesStage,
  errorMessage,
  sessionOpenInEditor,
  unwrap,
} from '@pi-kit/api';
import { ChatStore } from '@pi-kit/chat/api';
import {
  OVERLAY_BELOW_PX,
  ToastStore,
  UiStore,
  withLatestRequest,
  withRequestStatus,
  withSelection,
} from '@pi-kit/data-access';
import type { ChangedFile, ChangesList, ChangeSource, DiffModel, ReviewComment } from '@pi-kit/protocol';
import { buildReviewMessage, orderComments } from '@pi-kit/review/util';
import { outcomeSummary, ThreadsStore } from '@pi-kit/threads/api';
import { countByFile } from '@pi-kit/ui';
import { REVIEW_POLICY } from './review-policy';

/** A folder of changed files, as the Changes panel groups them. */
export interface ChangeGroup {
  dir: string;
  files: ChangedFile[];
}

interface ChangesState {
  /** `review` swaps the transcript and the composer for the diff and the comment tray; the columns stay. */
  mode: 'chat' | 'review';
  source: ChangeSource;
  layout: 'unified' | 'split';
  list: ChangesList | undefined;
  model: DiffModel | undefined;
  modelLoading: boolean;
  modelError: string | undefined;
  comments: ReviewComment[];
  visited: ReadonlySet<string>;
  busy: string | undefined;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/**
 * Review mode and the Changes panel: the source (thread, working tree, outcome), the changed files, the diff of the selected
 * file, and the pending comment batch. The comments live here, in the renderer's state, and are mirrored to the
 * backend (`review_comments`) a moment after every change, so a reload keeps the batch. Sending builds one prompt
 * from them (`buildReviewMessage`), hands it to the conversation with the structured batch in `forwardedProps.review`,
 * and returns to the chat so the user sees pi act on it. Latest file-list and diff reads use `withLatestRequest`; `withRequestStatus` presents list status and `withSelection` owns the selected file.
 * It follows the folder live through the threads store's shared watch stream.
 */
export const ChangesStore = signalStore(
  { providedIn: 'root' },
  withState<ChangesState>({
    mode: 'chat',
    source: 'thread',
    layout: 'unified',
    list: undefined,
    model: undefined,
    modelLoading: false,
    modelError: undefined,
    comments: [],
    visited: new Set<string>(),
    busy: undefined,
  }),
  withProps(() => ({ _policy: inject(REVIEW_POLICY) })),
  withRequestStatus(),
  withLatestRequest(),
  withSelection(),
  withComputed((store) => {
    const translate = inject(Language).t;
    const chat = inject(ChatStore);
    const threads = inject(ThreadsStore);
    const files = computed<ChangedFile[]>(() => store.list()?.files ?? []);
    const selectedIndex = computed(() => files().findIndex((f) => f.path === store.selectedId()));
    const comments = store.comments;
    const totals = computed(() =>
      files().reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), {
        added: 0,
        removed: 0,
      }),
    );
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
      /** Revert and Stage act on the files on disk; the Outcome is committed history. */
      editable: computed(() => store.source() !== 'outcome'),
      files,
      totals,
      counts: computed(() => countByFile(comments())),
      ordered: computed(() => orderComments(comments())),
      selectedFile: computed(() => files().find((f) => f.path === store.selectedId())),
      selectedIndex,
      /** Files looked at in this review (a file that was reverted no longer counts). */
      viewedCount: computed(() => files().filter((f) => store.visited().has(f.path)).length),
      commentFiles: computed(() => new Set(comments().map((c) => c.file)).size),
      commentCount: computed(() => comments().length),
      sendLabel: computed(() =>
        comments().length === 0
          ? translate('review.changesStore.sendCommentsToPi')
          : translate('review.changesStore.sendToPi', {
              value1: comments().length,
              value2:
                comments().length === 1
                  ? translate('review.changesStore.comment')
                  : translate('review.changesStore.comments'),
            }),
      ),
      /** The comments on the selected file. */
      selectedComments: computed(() => comments().filter((c) => c.file === store.selectedId())),
      /** The changed files grouped by folder, folders in order. */
      groups: computed<ChangeGroup[]>(() => {
        const groups = new Map<string, ChangedFile[]>();
        for (const file of files()) {
          const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
          groups.set(dir, [...(groups.get(dir) ?? []), file]);
        }
        return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([dir, list]) => ({ dir, files: list }));
      }),
      /** The name of the file after the selected one, for the "Next file" button. */
      nextName: computed(() => {
        const next = files()[selectedIndex() + 1];
        return next ? basename(next.path) : undefined;
      }),
      /** The review header's line: `3 files, +12 −4, from this thread`. */
      summary: computed(() => {
        const { added, removed } = totals();
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
        return file.turn ? translate('review.changesStore.editedInTurn', { value1: file.turn }) : undefined;
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
    // A pending action may finish after navigation. Keep each thread's draft and order its backend writes independently.
    const drafts = new Map<string, ReviewComment[]>();
    const dirty = new Set<string>();
    const hydrated = new Set<string>();
    const revisions = new Map<string, number>();
    const writes = new Map<string, Promise<void>>();
    let loadedFor: string | undefined;
    let mirror: ReturnType<typeof setTimeout> | undefined;
    let listReloadSelected = false;
    // A small LRU makes revisiting files immediate; each visit still checks the current contents.
    const models = new Map<string, DiffModel>();

    const persistComments = (id: string, comments: ReviewComment[]): void => {
      const write = async (): Promise<void> => {
        try {
          await unwrap(changesPutComments({ client: api.client, path: { id }, body: { comments } }));
          if (drafts.get(id) === comments) dirty.delete(id);
        } catch (error) {
          if (!destroyRef.destroyed)
            toasts.show(
              'error',
              translate('review.changesStore.yourCommentsCouldNotBeSaved', { value1: errorMessage(error) }),
            );
        }
      };
      const previous = writes.get(id);
      const pending = previous ? previous.then(write) : write();
      writes.set(id, pending);
      void pending.finally(() => {
        if (writes.get(id) === pending) writes.delete(id);
      });
    };

    const mirrorSoon = (): void => {
      const id = store.threadId();
      if (!id) return;
      const comments = store.comments();
      drafts.set(id, comments);
      dirty.add(id);
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
      if (loadedFor !== id) return;
      clearTimeout(mirror);
      mirror = setTimeout(() => {
        mirror = undefined;
        persistComments(id, comments);
      }, store._policy.mirrorDelayMs);
    };

    const updateComments = (id: string, update: (comments: ReviewComment[]) => ReviewComment[]): void => {
      const visible = !destroyRef.destroyed && id === store.threadId() && loadedFor === id;
      const comments = update(visible ? store.comments() : (drafts.get(id) ?? []));
      drafts.set(id, comments);
      if (visible) {
        patchState(store, { comments });
        mirrorSoon();
      } else {
        dirty.add(id);
        revisions.set(id, (revisions.get(id) ?? 0) + 1);
        persistComments(id, comments);
      }
    };
    destroyRef.onDestroy(() => {
      threadEpoch++;
      if (mirror && loadedFor) persistComments(loadedFor, store.comments());
      clearTimeout(mirror);
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
        patchState(store, {
          source,
          list: undefined,
          selectedId: undefined,
          model: undefined,
          modelLoading: false,
          modelError: undefined,
        });
      },

      async refresh(source = store.source(), reloadSelected = true): Promise<void> {
        const id = store.threadId();
        if (!id) return;
        // A later unrelated watcher batch must not drop an earlier request to refresh this file.
        listReloadSelected ||= reloadSelected;
        const selectedAtStart = store.selectedId();
        store.requestStarted();
        await store._request(
          'list',
          (signal) => unwrap(changesList({ client: api.client, path: { id }, query: { source }, signal })),
          {
            valid: () => id === store.threadId() && source === store.source(),
            next: (list) => {
              // The same list again (a watcher batch for an unrelated file): keep the signal, so nothing below reloads or flickers.
              if (JSON.stringify(list) !== JSON.stringify(store.list())) patchState(store, { list });
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
      },

      // ---- comments

      commentsOf(file: string): ReviewComment[] {
        return store.comments().filter((c) => c.file === file);
      },

      /** A new comment, or (with `id`) the new text of an existing one. */
      save(input: {
        id?: string;
        side: 'old' | 'new';
        line: number;
        endLine?: number;
        snippet: string;
        text: string;
      }): void {
        const file = store.selectedId();
        if (!file) return;
        if (input.id) {
          patchState(store, (s) => ({
            comments: s.comments.map((c) => (c.id === input.id ? { ...c, text: input.text } : c)),
          }));
        } else {
          const range = input.endLine !== undefined && input.endLine > input.line ? { endLine: input.endLine } : {};
          patchState(store, (s) => ({
            comments: [
              ...s.comments,
              {
                id: crypto.randomUUID(),
                file,
                side: input.side,
                line: input.line,
                ...range,
                snippet: input.snippet,
                text: input.text,
              },
            ],
          }));
        }
        mirrorSoon();
      },

      remove(id: string): void {
        patchState(store, (s) => ({ comments: s.comments.filter((c) => c.id !== id) }));
        mirrorSoon();
      },

      discardAll(): void {
        patchState(store, { comments: [] });
        mirrorSoon();
      },

      /** Builds the one message, sends it as the next prompt and goes back to the chat. */
      async send(): Promise<void> {
        const id = store.threadId();
        const epoch = threadEpoch;
        const comments = store.ordered();
        if (!id || comments.length === 0 || session.running()) return;
        const text = buildReviewMessage(comments);
        patchState(store, { mode: 'chat', comments: [] });
        mirrorSoon();
        try {
          await session.send({ text, images: [], fileRefs: [], review: comments });
        } catch (error) {
          // Restore the originating batch, retaining comments written while sending or after navigating away.
          updateComments(id, (current) => [
            ...new Map([...comments, ...current].map((comment) => [comment.id, comment])).values(),
          ]);
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
          const comments = id === store.threadId() && loadedFor === id ? store.comments() : (drafts.get(id) ?? []);
          const dropped = comments.filter((c) => c.file === path).length;
          if (dropped > 0) updateComments(id, (batch) => batch.filter((c) => c.file !== path));
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
        // A change typed a moment ago still belongs to the thread that was open: save it now instead of dropping it.
        if (mirror && loadedFor) persistComments(loadedFor, drafts.get(loadedFor) ?? store.comments());
        clearTimeout(mirror);
        mirror = undefined;
        loadedFor = undefined;
        patchState(store, {
          mode: 'chat',
          list: undefined,
          selectedId: undefined,
          model: undefined,
          modelLoading: false,
          modelError: undefined,
          busy: undefined,
          comments: [],
          visited: new Set<string>(),
        });
        store.clearError();
      },

      async loadComments(threadId: string): Promise<void> {
        const epoch = threadEpoch;
        const revision = revisions.get(threadId);
        const pendingAtStart = dirty.has(threadId);
        try {
          const saved = await unwrap(changesComments({ client: api.client, path: { id: threadId } }));
          if (destroyRef.destroyed || threadId !== store.threadId() || epoch !== threadEpoch) return;
          // Keep pending edits and rollbacks, while still reading other windows' changes on a clean revisit.
          const local = drafts.get(threadId);
          const changed = pendingAtStart || dirty.has(threadId) || revision !== revisions.get(threadId);
          const comments =
            !changed || !local
              ? saved
              : hydrated.has(threadId)
                ? local
                : [...new Map([...saved, ...local].map((comment) => [comment.id, comment])).values()];
          drafts.set(threadId, comments);
          hydrated.add(threadId);
          loadedFor = threadId;
          patchState(store, { comments });
          if (changed) mirrorSoon();
        } catch {
          if (!destroyRef.destroyed && threadId === store.threadId() && epoch === threadEpoch) loadedFor = threadId;
        }
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
      const session = inject(ChatStore);
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
      let seenTick = threads.watchTick();
      effect(() => {
        const tick = threads.watchTick();
        if (tick === seenTick) return;
        seenTick = tick;
        if (store.threadId() && shown()) {
          const change = untracked(() => threads.watchLast());
          const selected = untracked(() => store.selectedId());
          const reload =
            !change ||
            change.overflow ||
            change.paths.some(
              (path) =>
                path === selected || selected?.startsWith(`${path}/`) || path === '.git' || path.startsWith('.git/'),
            );
          untracked(() => void store.refresh(store.source(), reload));
        }
      });
      // Whatever pi did is on disk once its run has ended.
      let wasRunning = false;
      effect(() => {
        const running = session.running();
        if (wasRunning && !running && shown()) untracked(() => void store.refresh());
        wasRunning = running;
      });
      // The Outcome source follows the open thread: a thread without an outcome has none to show, and a commit that extends the outcome moves its head.
      effect(() => {
        const thread = threads.selected();
        const source = store.source();
        if (source === 'outcome' && thread && !thread.state.outcome) untracked(() => store.setSource('thread'));
      });
      let outcomeHead: string | undefined;
      effect(() => {
        const head = threads.selected()?.state.outcome?.head;
        const changed = outcomeHead !== undefined && head !== undefined && head !== outcomeHead;
        outcomeHead = head;
        if (changed && store.source() === 'outcome' && shown()) untracked(() => void store.refresh());
      });
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
