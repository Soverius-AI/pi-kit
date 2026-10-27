import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { computed, linkedSignal } from '@angular/core';
import { type SignalStoreFeatureType, signalStoreFeature, type, withComputed, withLinkedState } from '@ngrx/signals';
import { fileRefsOf, percentLabel } from '@pi-kit/chat/util';
import type { PkMenuGroup } from '@pi-kit/design-system';
import { compactNumber } from '@pi-kit/ui';
import { type CompletionProvider, type CompletionToken, type ComposerSuggestion } from '../composer-extensions';
import { lastUserTextOf } from './chat-state';
import { withChatTranscript } from './with-chat-transcript';

/** Completion menus, composer hints and send availability. */
export function withChatComposerView<_>() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withChatTranscript>>(),
    withComputed((store) => {
      const translate = inject(Language).t;
      const extensions = store._extensions;
      // ---- the menus: the first provider that recognises the text before the caret decides what the menu shows
      const active = computed<{ provider: CompletionProvider; token: CompletionToken; key: string } | undefined>(() => {
        const text = store.draft();
        const caret = store.caret();
        for (const provider of extensions.completionProviders()) {
          const token = provider.match(text, caret);
          if (token) return { provider, token, key: `${provider.id}:${token.start}:${token.query}` };
        }
        return undefined;
      });
      const items = computed(() => {
        const a = active();
        const completion = store.completion();
        return a && completion.key === a.key ? completion.items : [];
      });
      const hasThread = computed(() => !!store.threadId());
      return {
        /** Advisory text for the main thread only. Attachments, drafts and pending work take precedence. */
        followUp: computed(() => {
          const selected = store._threads.selected();
          if (
            !store._agent.session ||
            !selected ||
            selected.id !== store.threadId() ||
            selected.state.activity !== 'idle' ||
            selected.state.lastRun !== 'finished' ||
            store.running() ||
            store.connecting() ||
            store.waitingForAnswer() ||
            store.proseQuestion() ||
            store.draft().length ||
            store.images().length ||
            store.chips().some((chip) => !chip.pinned) ||
            store.queue().steering.length ||
            store.queue().followUp.length ||
            store.acceptingFollowUp() !== undefined
          )
            return undefined;
          return selected.state.suggestions.find((s) => s.kind === 'prompt' && !store.hiddenFollowUps().includes(s.id));
        }),
        shellMode: computed(() => store.draft().startsWith('!')),
        menuActive: active,
        menuKey: computed(() => active()?.key),
        menuGroups: computed<PkMenuGroup[]>(() => {
          const a = active();
          if (!a) return [];
          const out: PkMenuGroup[] = [];
          for (const item of items()) {
            const title = item.group ?? a.provider.title;
            let group = out.find((g) => g.title === title);
            if (!group) out.push((group = { title, items: [] }));
            group.items.push(item);
          }
          return out;
        }),
        menuFlat: computed(() => items().filter((i) => !i.disabled)),
        menuOpen: computed(() => {
          const a = active();
          if (!a || store.dismissedFor() === a.key) return false;
          return a.provider.showEmpty === true || items().length > 0;
        }),
        menuHead: computed(() => {
          const a = active();
          if (!a) return '';
          return a.token.query && a.provider.id !== 'args'
            ? translate('chat.withChatComposerView.matching', { value1: a.provider.title, value2: a.token.query })
            : a.provider.title;
        }),
        menuEmpty: computed(() =>
          store.completion().loading
            ? translate('chat.withChatComposerView.loading')
            : store.commandsLoading()
              ? translate('chat.withChatComposerView.loadingCommands')
              : store.commandsError()
                ? translate('chat.withChatComposerView.commandsAreUnavailableRightNow')
                : translate('chat.withChatComposerView.noCommandMatches'),
        ),
        placeholder: computed(() =>
          !hasThread()
            ? translate('chat.withChatComposerView.openOrStartAThreadFirst')
            : store.placeholderOverride()
              ? store.placeholderOverride()!
              : store.proseQuestion()
                ? translate('chat.withChatComposerView.replyToPiOrPickAnAnswer')
                : translate('chat.withChatComposerView.messagePiTypeForCommandsForFiles'),
        ),
        // A pinned chip alone does not make a message: it rides along with the next one.
        canSend: computed(
          () =>
            hasThread() &&
            !store.waitingForAnswer() &&
            (store.draft().trim().length > 0 || store.images().length > 0 || store.chips().some((c) => !c.pinned)),
        ),
        /** The first line of the hint row: what pi is doing and what a change of model or effort waits for. */
        hint: computed(() => {
          if (store.waitingForAnswer()) return translate('chat.withChatComposerView.piIsWaitingForYourAnswerAbove');
          if (store.proseQuestion()) return translate('chat.withChatComposerView.piAskedAQuestionReplyBelow');
          if (store.draft().startsWith('!')) return translate('chat.withChatComposerView.runsInTheThreadSFolderThe');
          if (store.running()) {
            const queued = store.queue().steering.length + store.queue().followUp.length;
            const running =
              queued > 0
                ? translate('chat.withChatComposerView.agentIsRunningQueued', {
                    value1: queued,
                    value2:
                      queued === 1
                        ? translate('chat.withChatComposerView.message')
                        : translate('chat.withChatComposerView.messages'),
                  })
                : translate('chat.withChatComposerView.agentIsRunning');
            const changed = store.changedDuringRun();
            if (!changed) return running;
            const what = changed.model
              ? translate('chat.withChatComposerView.model', { value1: store.model()?.id ?? '' })
              : translate('chat.withChatComposerView.effort', { value1: store.effort() });
            return translate('chat.withChatComposerView.appliesToTheNextRequest', { value1: running, value2: what });
          }
          return '';
        }),
        /** The `@paths` in the draft, shown as chips beside the images. */
        fileChips: computed(() => [...new Set(fileRefsOf(store.draft()))]),
        /** The context meter: fill, the tick where pi compacts by itself, the percentage and what it counts. */
        meter: computed(() => {
          const window = store.contextWindow();
          if (!window) return undefined;
          const tokens = store.contextTokens();
          const percent = store.contextPercent();
          const at = store.compactionAtPercent();
          const known = tokens !== undefined && percent !== undefined;
          return {
            level: store.contextLevel(),
            percent: Math.min(100, percent ?? 0),
            tick: at === undefined ? undefined : Math.min(100, at),
            text: known
              ? translate('chat.withChatComposerView.of', {
                  value1: percentLabel(percent),
                  value2: compactNumber(tokens),
                  value3: compactNumber(window),
                })
              : translate('chat.withChatComposerView.unknownWindow', { value1: compactNumber(window) }),
            /** The context ring's popover: `52% of context` and `137k of 262k tokens`. */
            headline: known
              ? translate('chat.withChatComposerView.ofContext', { value1: percentLabel(percent) })
              : translate('chat.withChatComposerView.contextSizeUnknown'),
            tokens: known
              ? translate('chat.withChatComposerView.ofTokens', {
                  value1: compactNumber(tokens),
                  value2: compactNumber(window),
                })
              : translate('chat.withChatComposerView.tokens', { value1: compactNumber(window) }),
            /** Where pi compacts by itself (`94%, 246k`), or undefined when auto-compaction is off. */
            compactsAt:
              at === undefined
                ? undefined
                : `${percentLabel(at)}, ${compactNumber(store.stats()?.compactionThreshold ?? 0)}`,
            aria: known
              ? translate('chat.withChatComposerView.contextFullOfTokensOpensUsage', {
                  value1: percentLabel(percent),
                  value2: tokens.toLocaleString(),
                  value3: window.toLocaleString(),
                })
              : translate('chat.withChatComposerView.contextSizeUnknownUntilTheNextResponse'),
            detail: known
              ? translate('chat.withChatComposerView.ofTokensInUse', {
                  value1: tokens.toLocaleString(),
                  value2: window.toLocaleString(),
                  value3: percentLabel(percent),
                })
              : translate('chat.withChatComposerView.tokensTheSizeIsNotKnownUntil', {
                  value1: window.toLocaleString(),
                }),
            compaction:
              at === undefined
                ? translate('chat.withChatComposerView.autoCompactionIsOffRunCompactBefore')
                : translate('chat.withChatComposerView.piCompactsAutomaticallyAtTokensMarkedOn', {
                    value1: percentLabel(at),
                    value2: compactNumber(store.stats()?.compactionThreshold ?? 0),
                  }),
          };
        }),
        /** "Context nearly full" once 90 % is used or pi's compaction threshold is reached. */
        contextWarning: computed<{ level: 'warning' | 'error'; text: string } | undefined>(() => {
          if (!store.contextNearlyFull()) return undefined;
          const level = store.contextLevel() === 'error' || !store.stats()?.autoCompaction ? 'error' : 'warning';
          return {
            level,
            text: translate('chat.withChatComposerView.contextNearlyFull', { value1: store.contextAdvice() }),
          };
        }),
        aboveWidgets: computed(() => store.widgets().filter((w) => w.placement === 'aboveEditor')),
        belowWidgets: computed(() => store.widgets().filter((w) => w.placement === 'belowEditor')),
        /** A run is going but pi has not produced anything for it yet (the model is still reading the context). */
        working: computed(() => {
          const last = store.blocks().at(-1);
          return store.running() && !store.waitingForAnswer() && !!last && last.kind !== 'assistant';
        }),
        /** The composer's suggestion pills: "Rerun last" after a stop, prompt templates that ask for it, and what extensions registered. */
        suggestionItems: computed<ComposerSuggestion[]>(() => {
          if (!hasThread() || store.running() || store.waitingForAnswer() || store.draft().trim() || store.connecting())
            return [];
          const out: ComposerSuggestion[] = [];
          // A question in prose: "Reply" puts the cursor in the composer, a pill per listed option answers with one click.
          const asked = store.proseQuestion();
          if (asked) {
            out.push({ id: 'reply', title: translate('chat.withChatComposerView.reply'), text: '', source: 'app' });
            for (const option of asked.options)
              out.push({ id: `reply:${option}`, title: option, text: option, send: true, source: 'app' });
          }
          const last = lastUserTextOf(store.messages());
          if (store.lastAborted() && last)
            out.push({
              id: 'rerun',
              title: translate('chat.withChatComposerView.rerunLast'),
              text: last,
              send: true,
              source: 'app',
            });
          for (const command of store.commands()) {
            if (!command.suggested || command.disabled) continue;
            out.push({
              id: `template:${command.name}`,
              title: command.suggestionTitle ?? `/${command.name}`,
              text: `/${command.name}${command.argumentHint ? ' ' : ''}`,
              send: !command.argumentHint,
              source: 'template',
            });
          }
          return [...out, ...extensions.suggestions()];
        }),
      };
    }),
    withLinkedState((store) => ({
      menuSelected: linkedSignal({
        source: store.menuFlat,
        computation: (items, previous): string | undefined =>
          items.some((item) => item.id === previous?.value) ? previous?.value : items[0]?.id,
      }),
    })),
  );
}
