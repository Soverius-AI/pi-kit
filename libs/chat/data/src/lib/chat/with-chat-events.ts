import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { type AgentSubscriber, type Message } from '@ag-ui/client';
import { effect } from '@angular/core';
import { type SignalStoreFeatureType, patchState, signalStoreFeature, type, withHooks } from '@ngrx/signals';
import { readPinnedChips } from '@pi-kit/chat/util';
import { ProviderUsageStore, readStorage } from '@pi-kit/data-access';
import { parsePiCustomEvent, THREAD_HYDRATION_EVENT, REPLAY_RESET_EVENT, type ThreadHydration } from '@pi-kit/protocol';
import { RADIUS_FUNDS_URL, isCredentialRejection, isOutOfFunds } from '@pi-kit/ui';
import { PINNED_KEY, type ThinkTiming, errorText } from './chat-state';
import { withChatTools } from './with-chat-tools';

/** Subscribes to AG-UI events and applies pi custom events. */
export function withChatEvents<_>() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withChatTools>>(),
    withHooks({
      onInit(store) {
        const translate = inject(Language).t;
        const bus = store._bus;
        const threads = store._threads;

        // The built-ins are the thread's (its commands, its folder, its `!shell`): a background agent's store, with a registry of its own, adds none.
        if (store._agent.session) store._registerBuiltIns();
        // The chips pinned to threads in earlier launches.
        const pinned = readPinnedChips(readStorage(PINNED_KEY));
        if (Object.keys(pinned).length > 0) patchState(store, { chipsByThread: pinned });

        const time = (id: string, patch: ThinkTiming) =>
          patchState(store, (s) => ({ thinkTimes: { ...s.thinkTimes, [id]: { ...s.thinkTimes[id], ...patch } } }));

        /**
         * The history snapshot that ends a run names the reasoning messages by their session entries, not by the ids they streamed under, so
         * "Thought for 8s" would fall back to "Thought". Reasoning that carries the same text is the same block; a replay (where the deltas
         * were compacted away) is matched by order when the counts agree.
         */
        const carryThinkTimes = (before: ReadonlyArray<Readonly<Message>>, after: readonly Message[]): void => {
          const times = store.thinkTimes();
          const timed = before.filter((m) => m.role === 'reasoning' && times[m.id]?.end !== undefined);
          const reasoning = after.filter((m) => m.role === 'reasoning');
          if (timed.length === 0 || reasoning.length === 0) return;
          const text = (m: Readonly<Message>): string => (typeof m.content === 'string' ? m.content : '');
          const next = { ...times };
          const byText = new Map(timed.filter((m) => text(m)).map((m) => [text(m), m.id] as const));
          const orderly = timed.length === reasoning.length;
          reasoning.forEach((m, index) => {
            const from = (text(m) && byText.get(text(m))) || (orderly ? timed[index].id : undefined);
            const timing = from ? times[from] : undefined;
            if (timing) next[m.id] = timing;
          });
          patchState(store, { thinkTimes: next });
        };

        let runProvider: string | undefined;
        const refreshRadius = (): void => {
          if ((runProvider ?? store.model()?.provider) === 'radius')
            void store._injector.get(ProviderUsageStore).refresh(['radius'], true);
          runProvider = undefined;
        };
        const subscriber: AgentSubscriber = {
          onToolCallStartEvent: ({ event }) => {
            if (event.toolCallName === 'pi_browser') bus.setPanel('artifacts');
          },
          onRunStartedEvent: (started) => {
            if (started?.event?.runId) {
              const seen = store._internal.seenRuns;
              seen.add(started.event.runId);
              // The channel only ever names the current run: a short memory is enough, and it must not grow for the life of the app.
              while (seen.size > 50) seen.delete(seen.values().next().value as string);
            }
            runProvider = store.model()?.provider;
            patchState(store, { runError: undefined, retry: undefined, lastAborted: false, promptActive: true });
          },
          onRunFinishedEvent: ({ event }) => {
            const result = event.result as { aborted?: boolean } | undefined;
            patchState(store, {
              lastAborted: result?.aborted === true,
              promptActive: event.outcome?.type === 'interrupt',
            });
            // Radius bills settled requests: reconcile credits after spending, even while the picker is closed.
            refreshRadius();
          },
          onRunErrorEvent: ({ event }) => {
            refreshRadius();
            patchState(store, { runError: { message: event.message, code: event.code }, promptActive: false });
            // A provider that stops accepting its credential (HTTP 401): a toast with the way back in.
            const provider = store.model()?.provider;
            if (provider && isCredentialRejection(event.message)) {
              store._toasts.show(
                'error',
                translate('chat.withChatEvents.didNotAcceptItsCredential401It', { value1: provider }),
                20_000,
                {
                  label: translate('chat.withChatEvents.signInAgain'),
                  run: () => store._bus.openSettings('providers', provider),
                },
              );
            }
            // A gateway account with no balance left (HTTP 402): a toast that goes straight to adding funds.
            if (isOutOfFunds(event.message)) {
              store._toasts.show('error', translate('chat.withChatEvents.yourRadiusBalanceIsEmptyAddFunds'), 20_000, {
                label: translate('chat.withChatEvents.addFunds'),
                run: () => window.open(RADIUS_FUNDS_URL, '_blank', 'noopener,noreferrer'),
              });
            }
          },
          onRunFailed: ({ error }) => patchState(store, { runError: { message: errorText(error) } }),
          // A background agent's spawn or report: its envelope names it; the id before the slash is the agent's. Kept by
          // thread, so a reconnect (a report's run is one) and a switch back to the thread keep the names.
          onSubagentStartedEvent: ({ event }) => {
            const threadId = threads.selectedId();
            if (!threadId) return;
            patchState(store, (s) => ({
              agentNames: {
                ...s.agentNames,
                [threadId]: { ...s.agentNames[threadId], [event.subagentRunId.split('/')[0]]: event.name },
              },
            }));
          },
          onMessagesSnapshotEvent: ({ event, messages }) => {
            carryThinkTimes(messages, event.messages);
            // pi's history is the order of the transcript. AG-UI's own handling keeps the messages it already holds where they are and appends the new
            // ones, so after a replay (where the log's raw activities arrive before the snapshot) a tool's or a review's activity could sit above the
            // message it belongs to; the snapshot replaces the list instead.
            return { messages: event.messages, stopPropagation: true };
          },
          onReasoningStartEvent: ({ event }) => time(event.messageId, { start: event.timestamp ?? Date.now() }),
          onReasoningEndEvent: ({ event }) => time(event.messageId, { end: event.timestamp ?? Date.now() }),
          onCustomEvent: ({ event }) => {
            if (event.name === REPLAY_RESET_EVENT && (event.value as { reset?: boolean })?.reset === false) {
              if ((event.value as { running?: boolean }).running === true) {
                store.requestDone();
                store._settleConnect();
              }
              return;
            }
            if (event.name === THREAD_HYDRATION_EVENT) {
              const snapshot = event.value as ThreadHydration;
              patchState(store, {
                ...snapshot.view,
                retry: snapshot.view.retry,
                runError: snapshot.view.runError,
                liveContextTokens: snapshot.view.liveContextTokens,
                promptActive: snapshot.view.promptActive ?? snapshot.running ?? false,
                liveCost: 0,
                liveTokens: 0,
                liveTurns: 0,
              });
              store._extensions.forgetPi();
              for (const registration of snapshot.composers) store._applyRegistration(registration);
              if (snapshot.title !== undefined)
                document.title = snapshot.title ? `${snapshot.title} · pi-kit` : 'pi-kit';
              return;
            }
            const parsed = parsePiCustomEvent({ name: event.name, value: event.value });
            if (!parsed) return;
            switch (parsed.name) {
              case 'pi.queue': {
                // A log written before the texts were carried replays with counts only: the rows say what they can.
                const q = parsed.value;
                const texts = (list: string[] | undefined, count: number) =>
                  list ?? Array.from({ length: count }, () => translate('chat.withChatEvents.queuedMessage'));
                patchState(store, {
                  queue: { steering: texts(q.steerTexts, q.steer), followUp: texts(q.followUpTexts, q.followUp) },
                });
                break;
              }
              case 'pi.compaction':
                patchState(store, { compacting: parsed.value.phase === 'start' });
                if (parsed.value.phase === 'end') void store.refreshStats();
                break;
              case 'pi.retry':
                patchState(store, { retry: parsed.value });
                break;
              case 'pi.usage': {
                const u = parsed.value;
                patchState(store, (s) => ({
                  liveContextTokens: u.contextTokens !== undefined ? u.contextTokens : s.liveContextTokens,
                  liveCost: s.liveCost + u.cost,
                  liveTokens: s.liveTokens + u.input + u.output + u.cacheRead + u.cacheWrite,
                }));
                break;
              }
              case 'pi.status': {
                const { key = 'status', text } = parsed.value;
                patchState(store, (s) => {
                  const next = { ...s.statuses };
                  if (text) next[key] = text;
                  else delete next[key];
                  return { statuses: next };
                });
                break;
              }
              case 'pi.notify':
                // Replayed events carry their old timestamp (older logs none at all); only news is shown.
                if (typeof event.timestamp !== 'number' || Date.now() - event.timestamp > store._policy.eventFreshMs)
                  break;
                store.say(parsed.value.level, parsed.value.text);
                break;
              case 'pi.title':
                document.title = parsed.value.title ? `${parsed.value.title} · pi-kit` : 'pi-kit';
                break;
              case 'pi.tree':
                bus.markTreeStale();
                break;
              case 'pi.session_info':
                void threads.refresh();
                break;
              case 'pi.model':
                void store.refreshStats();
                break;
              case 'pi.composer':
                store._applyRegistration(parsed.value);
                break;
              default:
                break;
            }
          },
        };

        // Follow the agent: subscribe to the events the store does not surface.
        effect((onCleanup) => {
          const subscription = store._agentStore().agent.subscribe(subscriber);
          onCleanup(() => subscription.unsubscribe());
        });
      },
    }),
  );
}
