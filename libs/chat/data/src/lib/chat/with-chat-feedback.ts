import { Language } from '@pi-kit/i18n';
import { DestroyRef, inject } from '@angular/core';
import {
  patchState,
  signalStoreFeature,
  type,
  withMethods,
  withState,
  type SignalStoreFeatureType,
} from '@ngrx/signals';
import { threadsListFeedback, threadsPutFeedback, unwrap } from '@pi-kit/api';
import type { FeedbackRating } from '@pi-kit/protocol';
import { initialFeedback } from './chat-state';
import { withChatState } from './with-chat-state';

type Base = SignalStoreFeatureType<typeof withChatState>;

/** Feedback owns its hydration and per-message optimistic writes; rollback never replaces another message's rating. */
export function withChatFeedback<_>() {
  return signalStoreFeature(
    {
      props: type<
        Pick<Base['props'], '_api' | '_threads' | '_toasts'> & {
          _internal: Pick<Base['props']['_internal'], 'threadEpoch'>;
        }
      >(),
      methods: type<Pick<Base['methods'], '_request' | '_cancelRequest'>>(),
    },
    withState(initialFeedback),
    withMethods((store) => {
      const translate = inject(Language).t;
      const destroyRef = inject(DestroyRef);
      const revisions = new Map<string, number>();
      const confirmed = new Map<string, FeedbackRating | undefined>();
      const writes = new Map<string, Promise<void>>();
      const setRating = (messageId: string, rating: FeedbackRating | undefined): void =>
        patchState(store, (s) => {
          const feedback = { ...s.feedback };
          if (rating) feedback[messageId] = rating;
          else delete feedback[messageId];
          return { feedback };
        });
      return {
        _resetFeedback(): void {
          store._cancelRequest('feedback');
          revisions.clear();
          confirmed.clear();
          patchState(store, initialFeedback);
        },
        async loadFeedback(id = store._threads.selectedId()): Promise<void> {
          if (!id) return;
          const epoch = store._internal.threadEpoch;
          const before = new Map(revisions);
          const pendingAtStart = new Set(writes.keys());
          await store._request(
            'feedback',
            (signal) => unwrap(threadsListFeedback({ client: store._api.client, signal, path: { id } })),
            {
              valid: () => id === store._threads.selectedId() && epoch === store._internal.threadEpoch,
              next: (entries) => {
                const saved = new Map(entries.map((e) => [e.messageId, e.rating]));
                for (const messageId of new Set([...Object.keys(store.feedback()), ...saved.keys()])) {
                  const key = `${epoch}:${id}:${messageId}`;
                  if (pendingAtStart.has(key) || writes.has(key) || before.get(key) !== revisions.get(key)) continue;
                  confirmed.set(key, saved.get(messageId));
                  setRating(messageId, saved.get(messageId));
                }
              },
            },
          );
        },
        async rate(messageId: string, rating: FeedbackRating): Promise<void> {
          const id = store._threads.selectedId();
          if (!id) return;
          const epoch = store._internal.threadEpoch;
          const key = `${epoch}:${id}:${messageId}`;
          const version = (revisions.get(key) ?? 0) + 1;
          revisions.set(key, version);
          if (!confirmed.has(key)) confirmed.set(key, store.feedback()[messageId]);
          const next = store.feedback()[messageId] === rating ? undefined : rating;
          setRating(messageId, next);
          const current = (): boolean =>
            !destroyRef.destroyed && id === store._threads.selectedId() && epoch === store._internal.threadEpoch;
          const write = async (): Promise<void> => {
            try {
              await unwrap(
                threadsPutFeedback({
                  client: store._api.client,
                  path: { id },
                  body: { messageId, rating: next ?? null },
                }),
              );
              if (current()) confirmed.set(key, next);
            } catch (error) {
              if (current() && revisions.get(key) === version) {
                setRating(messageId, confirmed.get(key));
                store._toasts.show(
                  'error',
                  translate('chat.withChatFeedback.rating', {
                    value1: error instanceof Error ? error.message : String(error),
                  }),
                );
              }
            }
          };
          const previous = writes.get(key);
          const pending = previous ? previous.then(write) : write();
          writes.set(key, pending);
          try {
            await pending;
          } finally {
            if (writes.get(key) === pending) writes.delete(key);
          }
        },
      };
    }),
  );
}
