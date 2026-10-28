import { Language } from '@pi-kit/i18n';
import { computed, DestroyRef, inject } from '@angular/core';
import { patchState, signalStoreFeature, withComputed, withMethods, withState } from '@ngrx/signals';
import { ApiClient, changesComments, changesPutComments, errorMessage, unwrap } from '@pi-kit/api';
import { ChatStore } from '@pi-kit/chat/api';
import { ToastStore } from '@pi-kit/data-access';
import type { ReviewComment } from '@pi-kit/protocol';
import { orderComments } from '@pi-kit/review/util';
import { countByFile } from '@pi-kit/ui';
import { REVIEW_POLICY } from './review-policy';

/** What a new comment says and where; `id` edits the text of an existing one. */
export interface CommentInput {
  id?: string;
  side: 'old' | 'new';
  line: number;
  endLine?: number;
  snippet: string;
  text: string;
}

/**
 * The pending comment batch of the open thread. The comments live in the renderer's state and are mirrored to the backend (`review_comments`) a
 * moment after every change, so a reload keeps the batch. Each thread keeps its own draft and the order of its writes, so an action that ends after
 * the person moved to another thread still lands in the right batch.
 */
export function withReviewComments() {
  return signalStoreFeature(
    withState<{ comments: ReviewComment[] }>({ comments: [] }),
    withComputed(({ comments }) => {
      const translate = inject(Language).t;
      return {
        counts: computed(() => countByFile(comments())),
        ordered: computed(() => orderComments(comments())),
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
      };
    }),
    withMethods((store) => {
      const translate = inject(Language).t;
      const api = inject(ApiClient);
      const chat = inject(ChatStore);
      const toasts = inject(ToastStore);
      const policy = inject(REVIEW_POLICY);
      const destroyRef = inject(DestroyRef);
      const drafts = new Map<string, ReviewComment[]>();
      const dirty = new Set<string>();
      const hydrated = new Set<string>();
      const revisions = new Map<string, number>();
      const writes = new Map<string, Promise<void>>();
      /** The thread whose saved batch is shown: until it is read, changes are kept as a draft and not written. */
      let loadedFor: string | undefined;
      let mirror: ReturnType<typeof setTimeout> | undefined;
      let epoch = 0;

      const persist = (id: string, comments: ReviewComment[]): void => {
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

      const changed = (id: string, comments: ReviewComment[]): void => {
        drafts.set(id, comments);
        dirty.add(id);
        revisions.set(id, (revisions.get(id) ?? 0) + 1);
      };

      /** The shown batch changed: it is written a moment later. */
      const mirrorSoon = (): void => {
        const id = chat.threadId();
        if (!id) return;
        const comments = store.comments();
        changed(id, comments);
        if (loadedFor !== id) return;
        clearTimeout(mirror);
        mirror = setTimeout(() => {
          mirror = undefined;
          persist(id, comments);
        }, policy.mirrorDelayMs);
      };

      const set = (update: (comments: ReviewComment[]) => ReviewComment[]): void => {
        patchState(store, (s) => ({ comments: update(s.comments) }));
        mirrorSoon();
      };

      /** Changes the batch of `id`, shown or not: a thread in the background has its draft written at once. */
      const updateOf = (id: string, update: (comments: ReviewComment[]) => ReviewComment[]): void => {
        if (!destroyRef.destroyed && id === chat.threadId() && loadedFor === id) return set(update);
        const comments = update(drafts.get(id) ?? []);
        changed(id, comments);
        persist(id, comments);
      };

      destroyRef.onDestroy(() => {
        epoch++;
        if (mirror && loadedFor) persist(loadedFor, store.comments());
        clearTimeout(mirror);
      });

      return {
        commentsOf(file: string): ReviewComment[] {
          return store.comments().filter((c) => c.file === file);
        },

        /** A new comment on `file`, or (with `input.id`) the new text of an existing one. */
        _saveComment(file: string, input: CommentInput): void {
          if (input.id) return set((all) => all.map((c) => (c.id === input.id ? { ...c, text: input.text } : c)));
          const range = input.endLine !== undefined && input.endLine > input.line ? { endLine: input.endLine } : {};
          set((all) => [
            ...all,
            {
              id: crypto.randomUUID(),
              file,
              side: input.side,
              line: input.line,
              ...range,
              snippet: input.snippet,
              text: input.text,
            },
          ]);
        },

        remove(id: string): void {
          set((all) => all.filter((c) => c.id !== id));
        },

        discardAll(): void {
          set(() => []);
        },

        /** Empties the shown batch, as it is being sent. */
        _clearComments(): void {
          set(() => []);
        },

        /** Puts `comments` back into the batch of `id` (a send failed), keeping what was written meanwhile. */
        _restoreComments(id: string, comments: ReviewComment[]): void {
          updateOf(id, (current) => [...new Map([...comments, ...current].map((c) => [c.id, c])).values()]);
        },

        /** Drops the comments on `path` from the batch of `id` (the file was reverted); returns how many went. */
        _dropCommentsOn(id: string, path: string): number {
          const batch = id === chat.threadId() && loadedFor === id ? store.comments() : (drafts.get(id) ?? []);
          const dropped = batch.filter((c) => c.file === path).length;
          if (dropped > 0) updateOf(id, (all) => all.filter((c) => c.file !== path));
          return dropped;
        },

        /** Another thread opens: a change typed a moment ago still belongs to the one that was open, so it is written now. */
        _resetComments(): void {
          epoch++;
          if (mirror && loadedFor) persist(loadedFor, drafts.get(loadedFor) ?? store.comments());
          clearTimeout(mirror);
          mirror = undefined;
          loadedFor = undefined;
          patchState(store, { comments: [] });
        },

        /** Reads the saved batch of the thread, keeping pending edits and rollbacks, and other windows' changes on a clean revisit. */
        async loadComments(threadId: string): Promise<void> {
          const at = epoch;
          const revision = revisions.get(threadId);
          const pendingAtStart = dirty.has(threadId);
          try {
            const saved = await unwrap(changesComments({ client: api.client, path: { id: threadId } }));
            if (destroyRef.destroyed || threadId !== chat.threadId() || at !== epoch) return;
            const local = drafts.get(threadId);
            const edited = pendingAtStart || dirty.has(threadId) || revision !== revisions.get(threadId);
            const comments =
              !edited || !local
                ? saved
                : hydrated.has(threadId)
                  ? local
                  : [...new Map([...saved, ...local].map((comment) => [comment.id, comment])).values()];
            drafts.set(threadId, comments);
            hydrated.add(threadId);
            loadedFor = threadId;
            patchState(store, { comments });
            if (edited) mirrorSoon();
          } catch {
            if (!destroyRef.destroyed && threadId === chat.threadId() && at === epoch) loadedFor = threadId;
          }
        },
      };
    }),
  );
}
