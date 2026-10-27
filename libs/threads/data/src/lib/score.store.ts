import { Language } from '@pi-kit/i18n';
import { computed, effect, inject, untracked } from '@angular/core';
import { patchState, signalStore, withComputed, withHooks, withMethods, withState } from '@ngrx/signals';
import { ApiClient, errorMessage, scoreGet, scoreOverview, scoreRelabel, scoreRequest, unwrap } from '@pi-kit/api';
import { ToastStore } from '@pi-kit/data-access';
import type { HunkLabel, OutcomeScoreView, ScoreOverview, ThreadSummary } from '@pi-kit/protocol';
import { OutcomeMenuStore } from './outcome-menu.store';

import { ThreadsStore } from './threads.store';

interface ScoreState {
  /** The score of each thread whose Outcome view was opened, with its hunk labels; `null`: asked, and there is none. */
  views: Record<string, OutcomeScoreView | null>;
  /** The thread being scored right now. */
  scoring: string | undefined;
  overview: ScoreOverview | undefined;
}

export const SCORE_RUN = 'score:run';
export const SCORE_LINE = 'score:line';

/**
 * The Meat Proxy Score as the renderer knows it. The thread state carries the badge's part (`state.outcome.score`: present while the `@pi-kit/meat-proxy` package is
 * installed, with the sentence once the thread is scored); this store reads the rest on demand: the score with the label of every hunk for the Outcome view, scoring a thread, relabelling
 * a hunk, and the per-project distribution for Settings. It adds "Score this thread" to the outcome badge's menu (`OutcomeMenuStore.extend`). Without the package the state carries no
 * score, so there is no menu entry, no labels and no histogram: nothing of the plugin is drawn.
 */
export const ScoreStore = signalStore(
  { providedIn: 'root' },
  withState<ScoreState>({ views: {}, scoring: undefined, overview: undefined }),
  withComputed((store) => {
    const threads = inject(ThreadsStore);
    return {
      /** The selected thread's score, once loaded. */
      current: computed(() => {
        const id = threads.selected()?.id;
        return id ? (store.views()[id] ?? undefined) : undefined;
      }),
    };
  }),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const toasts = inject(ToastStore);
    const threads = inject(ThreadsStore);

    const setView = (threadId: string, view: OutcomeScoreView | null): void =>
      patchState(store, (s) => ({ views: { ...s.views, [threadId]: view } }));

    const methods = {
      /** Reads the thread's score and hunk labels (the Outcome view's); a thread that has none is remembered as such. */
      async load(threadId: string): Promise<void> {
        try {
          setView(threadId, await unwrap(scoreGet({ client: api.client, path: { id: threadId } })));
        } catch {
          setView(threadId, null);
        }
      },

      /**
       * Score the thread now (the badge menu, `/score`). With the attendant off the first request answers `consent`; the toast carries the sentence and the button that agrees, and
       * nothing is sent before.
       */
      async score(thread: ThreadSummary, consent?: boolean): Promise<void> {
        if (store.scoring()) return;
        patchState(store, { scoring: thread.id });
        try {
          const result = await unwrap(
            scoreRequest({
              client: api.client,
              path: { id: thread.id },
              body: consent === undefined ? {} : { consent },
            }),
          );
          if (result.status === 'consent') {
            toasts.show(
              'info',
              result.message ?? translate('threads.scoreStore.thisSendsTheThreadToTheAttendant'),
              20_000,
              {
                label: translate('threads.scoreStore.sendAndScore'),
                run: () => void methods.score(thread, true),
              },
            );
            return;
          }
          if (result.score) setView(thread.id, result.score);
          toasts.show('success', result.score?.scores.line ?? translate('threads.scoreStore.scored'));
          await threads.refresh();
        } catch (error) {
          toasts.show('error', translate('threads.scoreStore.couldNotScoreTheThread', { value1: errorMessage(error) }));
        } finally {
          patchState(store, { scoring: undefined });
        }
      },

      /** The person says what a hunk is; the score moves with it (`null` takes the correction back). */
      async relabel(threadId: string, hunk: string, label: HunkLabel | null): Promise<void> {
        try {
          setView(
            threadId,
            await unwrap(scoreRelabel({ client: api.client, path: { id: threadId }, body: { hunk, label } })),
          );
          await threads.refresh();
        } catch (error) {
          toasts.show('error', translate('threads.scoreStore.couldNotRelabelTheHunk', { value1: errorMessage(error) }));
        }
      },

      async loadOverview(): Promise<void> {
        try {
          patchState(store, { overview: await unwrap(scoreOverview({ client: api.client })) });
        } catch {
          patchState(store, { overview: undefined });
        }
      },
    };
    return methods;
  }),
  withHooks({
    onInit(store) {
      const translate = inject(Language).t;
      const threads = inject(ThreadsStore);
      // "Score this thread" in the outcome badge's menu (the extension point), and the score's own sentence above it.
      inject(OutcomeMenuStore).extend({
        items: (thread) => {
          const score = thread.state.outcome?.score;
          if (!score) return [];
          return [
            ...(score.line ? [{ id: SCORE_LINE, label: score.line, disabled: true, separatorBefore: true }] : []),
            {
              id: SCORE_RUN,
              label: score.line
                ? translate('threads.scoreStore.scoreThisThreadAgain')
                : translate('threads.scoreStore.scoreThisThread'),
              disabled: store.scoring() !== undefined,
              separatorBefore: !score.line,
            },
          ];
        },
        run: (itemId, thread) => (itemId === SCORE_RUN ? store.score(thread) : undefined),
      });
      // The selected thread's labels follow its score: a new sentence (scored, relabelled, a later commit) is read again; a score that went away (the package was removed) is forgotten.
      effect(() => {
        const selected = threads.selected();
        const score = selected?.state.outcome?.score;
        if (!selected) return;
        const key = score?.line ? `${score.line}|${score.stale}` : '';
        untracked(() => {
          if (key) void store.load(selected.id);
          else if (store.views()[selected.id])
            patchState(store, (s) => ({ views: { ...s.views, [selected.id]: null } }));
        });
      });
    },
  }),
);
export type ScoreStore = InstanceType<typeof ScoreStore>;
