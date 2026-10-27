import { DestroyRef, inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { HttpAgent } from '@ag-ui/client';
import { effect, untracked } from '@angular/core';
import { type SignalStoreFeatureType, patchState, signalStoreFeature, type, withHooks } from '@ngrx/signals';
import { withChatTools } from './with-chat-tools';
import { ThreadReplayAgent } from '../thread-replay-agent';

/** Owns replay connections, retries, completion requests and composer bus effects. */
export function withChatSession<_>() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withChatTools>>(),
    withHooks({
      onInit(store) {
        const translate = inject(Language).t;
        const bus = store._bus;
        const threads = store._threads;
        const health = store._health;
        const internal = store._internal;
        const copilotKit = store._copilotKit;
        const ext = store._extensions;
        const replay = store._replayCache;
        const replayAgent = store._agentStore().agent;
        if (replayAgent instanceof ThreadReplayAgent) {
          replayAgent.cache = {
            get: (id) => replay.entries()[id],
            prepare: (id, messages) =>
              store._redaction.enabledFor(threads.selected()?.cwd)
                ? store._redaction.prepare(messages, () => threads.selectedId() === id)
                : Promise.resolve(),
            forget: (id) => {
              replay.forget(id);
              // A full replay replaces derived run state as well as messages; otherwise old usage/status events would be counted twice.
              if (threads.selectedId() === id) {
                store.interrupt.setThreadId('');
                store.interrupt.setThreadId(id);
                patchState(store, {
                  thinkTimes: {},
                  queue: { steering: [], followUp: [] },
                  compacting: false,
                  retry: undefined,
                  runError: undefined,
                  lastAborted: false,
                  optimisticIds: [],
                  dismissedFor: undefined,
                  promptActive: undefined,
                  statuses: {},
                  liveContextTokens: undefined,
                  liveCost: 0,
                  liveTokens: 0,
                  liveTurns: 0,
                });
              }
            },
            record: (id, value) => {
              replay.record(id, {
                ...value,
                view: {
                  thinkTimes: store.thinkTimes(),
                  queue: store.queue(),
                  compacting: store.compacting(),
                  retry: store.retry(),
                  runError: store.runError(),
                  lastAborted: store.lastAborted(),
                  promptActive: store.promptActive(),
                  statuses: store.statuses(),
                  liveContextTokens: store.liveContextTokens(),
                  liveCost: store.liveCost(),
                  liveTokens: store.liveTokens(),
                  liveTurns: store.liveTurns(),
                  stats: store.stats(),
                },
              });
            },
            ready: (id) => {
              // Following an actual live run is ready at its snapshot checkpoint. Idle connections
              // must finish Core's connect lifecycle first, or the next send can be mistaken for steering.
              if (threads.selectedId() === id) {
                store.requestDone();
                store._settleConnect();
              }
            },
          };
        }

        const resetThread = (): void => {
          internal.threadEpoch++;
          internal.pendingRun = undefined;
          store._cancelRequests();
          store._resetModels();
          store._resetFeedback();
          patchState(store, {
            thinkTimes: {},
            queue: { steering: [], followUp: [] },
            compacting: false,
            retry: undefined,
            runError: undefined,
            lastAborted: false,
            optimisticIds: [],
            dismissedFor: undefined,
            promptActive: undefined,
            statuses: {},
            notices: [],
            liveContextTokens: undefined,
            liveCost: 0,
            liveTokens: 0,
            liveTurns: 0,
            stats: undefined,
            commands: [],
            commandsLoading: false,
            commandsError: undefined,
          });
          ext.forgetPi();
        };

        const retryConnect = (): void => {
          clearTimeout(internal.retryTimer);
          if (health.state() === 'error' || internal.connectRetries >= store._policy.connectRetries) return;
          const delay = store._policy.connectRetryMs * 2 ** internal.connectRetries++;
          internal.retryTimer = setTimeout(() => store.reconnect(), delay);
        };

        // Connect the agent to the selected thread: empty it, then replay the stored log.
        effect((onCleanup) => {
          const threadId = threads.selectedId();
          const agent = store._agentStore().agent;
          store.reconnects();
          // The backend restarted (or was unreachable and is back): the replay stream that was open is gone, open it again.
          health.epoch();
          untracked(() => {
            if (internal.selectionThreadId !== threadId) {
              internal.selectionThreadId = threadId;
              internal.selectionEpoch++;
            }
            clearTimeout(internal.retryTimer);
            replay.activate(threadId);
            resetThread();
            const cached = threadId ? replay.entries()[threadId] : undefined;
            if (cached?.view) patchState(store, cached.view);
            agent.setMessages([]);
            agent.setState({});
            agent.pendingInterrupts = [];
            if (!threadId) return store._settleConnect();
            store.interrupt.setThreadId(threadId);
            agent.threadId = threadId;
            let detached = false;
            const abort = new AbortController();
            if (agent instanceof HttpAgent) agent.abortController = abort;
            store.requestStarted();
            let failed = false;
            void copilotKit.core
              .connectAgent({ agent })
              .catch(() => (failed = true))
              .finally(() => {
                // A replay that was cut short by a newer one must not release a caller that waits for the newer one.
                if (detached) return;
                if (failed) store.requestFailed(translate('chat.withChatSession.theReplayOfTheThreadBroke'));
                else store.requestDone();
                // After a reload the bar shows pi's queue, not what the replayed log last said about it.
                if (store._agent.session) void store.loadQueue(threadId);
                store._settleConnect();
                // The stream broke while the thread is still on screen (the network, a sleeping laptop): open it again after a pause.
                // A dead backend is handled by the health epoch, which reconnects as soon as it answers again.
                if (failed) retryConnect();
                else {
                  internal.connectRetries = 0;
                  // A run started while this replay was going: it is joined now that the replay is over.
                  if (internal.rejoinWanted) {
                    internal.rejoinWanted = false;
                    if (store.threadId() === threadId) store.reconnect();
                  }
                }
              });
            // Replay cancellation also cancels command hydration: restart it for this connection, even when the id is unchanged.
            if (store._agent.session) {
              void store.loadCommands(threadId);
              void store.refreshStats(threadId);
              void store.loadFeedback(threadId);
            }
            onCleanup(() => {
              detached = true;
              abort.abort();
              agent.detachActiveRun().catch(() => undefined);
            });
          });
        });

        // A run pi-kit did not start (an extension's turn in an idle thread, an agent's report): the status channel
        // says the thread runs while nothing here follows it, so the replay is opened again and joins the run (or, when the run is
        // already over, its events come as the delta). The channel's events are taken as they come: a turn of a few milliseconds
        // pushes "running" and "idle" within one tick, which a signal would fold into no change at all.
        const stopStatus = threads.onStatusEvent((event) => {
          if (event.type !== 'state' || event.id !== store.threadId() || event.state.activity !== 'running') return;
          // A run of our own, or one already joined, announces itself too (its push can even come after it ended): no news.
          const run = event.state.run;
          if (run && internal.seenRuns.has(run)) return;
          // Another run is going here: pi may start the next turn the moment the last one ends (an agent's question right after the
          // answer to the one before), before this transcript saw that end. It is joined once the run here is over.
          if (store.running()) {
            if (run) internal.pendingRun = run;
            return;
          }
          if (store.loading()) internal.rejoinWanted = true;
          else store.reconnect();
        });
        inject(DestroyRef).onDestroy(stopStatus);

        // The meter and the status bar are exact again once a run ended.
        let wasRunning = false;
        effect(() => {
          const running = store.running();
          if (wasRunning && !running) {
            untracked(() => {
              const id = store.threadId();
              if (id && store._agent.session) void store.refreshStats(id);
              // The list shows the outcome, message count and preview of the run that just ended.
              void threads.refresh();
              bus.markTreeStale();
              const pending = internal.pendingRun;
              internal.pendingRun = undefined;
              if (pending && id && !internal.seenRuns.has(pending)) {
                if (store.loading()) internal.rejoinWanted = true;
                else store.reconnect();
              }
            });
          }
          wasRunning = running;
        });

        // Model menus follow both the thread and its current model.
        effect(() => {
          const id = store.threadId();
          store.model();
          untracked(() => {
            if (id && store._agent.session) void store.loadModels(id);
            else patchState(store, { modelList: undefined });
          });
        });
        effect(() => {
          if (!store.running()) untracked(() => store._clearModelChange());
        });

        // Menus: the active provider's entries. A sync provider answers at once; an async one after its debounce, and a newer token cancels it.
        effect((onCleanup) => {
          const active = store.menuActive();
          if (!active) {
            untracked(() => patchState(store, { completion: { key: '', items: [], loading: false } }));
            return;
          }
          const { provider, token, key } = active;
          const abort = new AbortController();
          const ctx = { text: store.draft(), caret: store.caret(), signal: abort.signal };
          onCleanup(() => abort.abort());
          const run = (): void => {
            const result = provider.complete(token, ctx);
            if (Array.isArray(result)) {
              patchState(store, { completion: { key, items: result, loading: false } });
              return;
            }
            patchState(store, (s) => ({
              completion: {
                key: s.completion.key === key ? key : s.completion.key,
                items: s.completion.items,
                loading: true,
              },
            }));
            result
              .then((items) => {
                if (!abort.signal.aborted) patchState(store, { completion: { key, items, loading: false } });
              })
              .catch(() => undefined);
          };
          if (provider.debounceMs) {
            const timer = setTimeout(() => untracked(run), provider.debounceMs);
            onCleanup(() => clearTimeout(timer));
          } else {
            run();
          }
        });

        // The command palette, ↑ and `/` shortcuts hand text over through the bus.
        effect(() => {
          const request = bus.composerText();
          if (!request) return;
          untracked(() => store.setDraft(request.text, request.text.length));
        });
        // "Add to message" in the Files panel asks for an insert at the caret.
        effect(() => {
          const request = bus.composerInsert();
          if (!request || !untracked(() => store.threadId())) return;
          untracked(() => {
            store.insertAt(request.text.endsWith('/') ? request.text : `${request.text} `);
            bus.focusComposer();
          });
        });
      },
    }),
  );
}
