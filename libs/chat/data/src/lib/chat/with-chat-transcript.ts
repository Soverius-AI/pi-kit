import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { type Message } from '@ag-ui/client';
import { computed } from '@angular/core';
import { type SignalStoreFeatureType, signalStoreFeature, type, withComputed } from '@ngrx/signals';
import {
  activityMap,
  buildTranscript,
  contextLevel,
  contextPercent,
  indexTurns,
  percentLabel,
} from '@pi-kit/chat/util';
import { type ComposerChip, type QueueItem, endsWithQuestion, queueItems, replyOptions } from '@pi-kit/protocol';
import { withChatDomainState } from './with-chat-domain-state';

/** Transcript, model and context projections. */
export function withChatTranscript<_>() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withChatDomainState>>(),
    withComputed((store) => {
      const translate = inject(Language).t;
      const messages = computed<Message[]>(() => {
        const cached = store._replayCache.entries()[store._threads.selectedId() ?? ''];
        // During synchronization the agent is reset by Core; keep drawing the signal-store snapshot. Live/optimistic
        // updates outside synchronization still come straight from the agent's signals, before their next persisted checkpoint.
        return store.loading() && cached ? cached.messages : store._agentStore().messages();
      });
      // Key shapes are masked as the transcript is drawn: the messages that are drawn and the blocks built from them. `messages` itself stays what the agent holds, so
      // branching and copying work on the originals. A message that holds nothing to mask is returned as the very same object, so the transcript re-renders only what changed.
      const shown = computed<Message[]>(() => {
        const all = messages();
        const redaction = store._redaction;
        return redaction.enabledFor(store._threads.selected()?.cwd) ? all.map((m) => redaction.message(m)) : all;
      });
      const blocks = computed(() => buildTranscript(translate, shown()));
      const stats = store.stats;
      const contextTokens = computed(() => store.liveContextTokens() ?? stats()?.contextTokens ?? undefined);
      const contextWindow = computed(() => stats()?.contextWindow ?? undefined);
      const ctxPercent = computed(() => {
        const tokens = contextTokens();
        const window = contextWindow();
        return tokens === undefined || !window ? undefined : contextPercent(tokens, window);
      });
      const compactionDue = computed(() => {
        const limit = stats()?.compactionThreshold;
        const tokens = contextTokens();
        return limit != null && tokens !== undefined && tokens > limit;
      });
      const compactionAtPercent = computed(() => {
        const limit = stats()?.compactionThreshold;
        const window = contextWindow();
        return limit && window ? (limit / window) * 100 : undefined;
      });
      const running = computed(() => store._agentStore().isRunning());
      const activities = computed(() => activityMap(messages()));
      const chips = computed<readonly ComposerChip[]>(
        () => store.chipsByThread()[store._threads.selectedId() ?? ''] ?? [],
      );
      return {
        /** The skill and prompt-template chips of the open thread's composer, in the order they were added. */
        chips,
        /** The stored log of the selected thread is being replayed. */
        connecting: computed(() => store.loading()),
        /** The shared AG-UI agent, for the components of generated UI that run requests through it (MCP Apps, A2UI actions). */
        agent: computed(() => store._agentStore().agent),
        threadId: computed(() => store._threads.selectedId()),
        messages,
        /** Complete redacted transcript; the viewport controls which rows are mounted. */
        transcriptMessages: shown,
        /** True while a run streams (or the stored log of a running thread is replayed). */
        running,
        blocks,
        turns: computed(() => indexTurns(blocks(), store._policy.collapseAboveCalls)),
        activities,
        /** Tool results by tool call id; `error` is set for a failed or interrupted call. */
        results: computed(() => {
          const map = new Map<string, { content: string; error?: string }>();
          for (const m of messages()) {
            if (m.role === 'tool')
              map.set(m.toolCallId, {
                content: typeof m.content === 'string' ? m.content : '',
                ...(m.error ? { error: m.error } : {}),
              });
          }
          return map;
        }),
        /** Extension widgets (`pi.widget`) that currently have lines. */
        widgets: computed(() => {
          const out: { key: string; lines: string[]; placement: 'aboveEditor' | 'belowEditor' }[] = [];
          for (const activity of activities().values()) {
            if (activity.activityType !== 'pi.widget') continue;
            const c = activity.content as { key: string; lines: string[]; placement?: 'aboveEditor' | 'belowEditor' };
            if (c.lines?.length) out.push({ key: c.key, lines: c.lines, placement: c.placement ?? 'aboveEditor' });
          }
          return out;
        }),
        waitingForAnswer: computed(() => store.interrupt.hasInterrupt()),
        /** The rows of the queue bar: steering first, then follow-ups, the order pi delivers them in. */
        queueRows: computed<QueueItem[]>(() => queueItems(store.queue())),
        /**
         * A question in prose: the newest answer ends in one, nothing is running and no dialog is open. `options` are the
         * choices it lists ("A, B or C?"), offered as reply pills.
         */
        proseQuestion: computed<{ text: string; options: string[] } | undefined>(() => {
          if (running() || store.interrupt.hasInterrupt() || store.lastAborted() || store.loading()) return undefined;
          const all = messages();
          for (let i = all.length - 1; i >= 0; i--) {
            const m = all[i];
            if (m.role === 'user' || m.role === 'tool') return undefined;
            if (m.role !== 'assistant') continue;
            const text = typeof m.content === 'string' ? m.content : '';
            if (!text.trim()) continue;
            return endsWithQuestion(text) ? { text, options: replyOptions(text) } : undefined;
          }
          return undefined;
        }),
        // ---- the context meter
        contextTokens,
        contextWindow,
        contextPercent: ctxPercent,
        contextLevel: computed(() => contextLevel(ctxPercent() ?? 0, store._contextPolicy)),
        compactionAtPercent,
        compactionDue,
        totalCost: computed(() => (stats()?.cost ?? 0) + store.liveCost()),
        totalTokens: computed(() => (stats()?.tokens.total ?? 0) + store.liveTokens()),
        totalTurns: computed(() => (stats()?.userMessages ?? 0) + store.liveTurns()),
        /** What pi does about a full window, in words. */
        contextAdvice: computed(() => {
          if (!stats()?.autoCompaction) return translate('chat.withChatTranscript.runCompactToMakeRoom');
          if (compactionDue()) return translate('chat.withChatTranscript.piWillCompactOnTheNextTurn');
          return translate('chat.withChatTranscript.piCompactsAt', {
            value1: percentLabel(compactionAtPercent() ?? 100),
          });
        }),
        /** 90 % or more of the window is in use (the transcript marker and the composer warning). */
        contextNearlyFull: computed(() => (ctxPercent() ?? 0) >= store._contextPolicy.error || compactionDue()),
      };
    }),
  );
}
