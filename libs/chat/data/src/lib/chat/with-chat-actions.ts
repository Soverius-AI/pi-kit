import { Language } from '@pi-kit/i18n';
import { type Message } from '@ag-ui/client';
import { DestroyRef, inject } from '@angular/core';
import { type SignalStoreFeatureType, patchState, signalStoreFeature, type, withMethods } from '@ngrx/signals';
import {
  composerComposer,
  attendantAccept,
  attendantDismiss,
  failureText,
  queueClear,
  queueMerge,
  queuePromote,
  queueQueue,
  queueRemove,
  sessionBash,
  sessionListCommands,
  sessionStats,
  treeNavigate,
  unwrap,
} from '@pi-kit/api';
import { fileRefsOf, pinnedChips, withPinToggled, withoutChip, withoutFileRef } from '@pi-kit/chat/util';
import {
  type Command,
  type ComposerChip,
  PiActivityContent,
  type QueueItem,
  type QueueSnapshot,
  type ReviewComment,
  type SessionStats,
  parsePiCustomEvent,
} from '@pi-kit/protocol';
import type { PiDialogAnswer } from '@pi-kit/protocol';
import { type ComposerSuggestion, type SubmitInput } from '../composer-extensions';
import { ChatTree } from '../ports';
import { registerChatBuiltIns } from './chat-built-ins';
import { createChatComposerActions } from './chat-composer-actions';
import { type ChatStoreState, type Notice, adaptCommand, errorText, lastUserTextOf, userContent } from './chat-state';
import { withChatComposerView } from './with-chat-composer-view';

/** Orchestrates sending, queue edits, models and feedback. */
export function withChatActions<_>() {
  return signalStoreFeature(
    type<SignalStoreFeatureType<typeof withChatComposerView>>(),
    withMethods((store) => {
      const translate = inject(Language).t;
      const destroyRef = inject(DestroyRef);
      const api = store._api;
      const bus = store._bus;
      const internal = store._internal;
      const tree = () => store._injector.get(ChatTree);
      const queuedSends = new Map<string, Promise<void>>();

      function say(level: Notice['level'], text: string): void {
        const id = ++internal.noticeId;
        patchState(store, (s) => ({ notices: [...s.notices.slice(-2), { id, level, text }] }));
        setTimeout(
          () => patchState(store, (s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
          store._policy.noticeMs,
        );
      }

      async function refreshStats(threadId = store.threadId()): Promise<void> {
        if (!threadId) return;
        await store._request(
          'stats',
          (signal) => unwrap(sessionStats({ client: api.client, signal, path: { id: threadId } })),
          {
            valid: () => store.threadId() === threadId,
            next: (stats) =>
              patchState(store, { stats, liveContextTokens: undefined, liveCost: 0, liveTokens: 0, liveTurns: 0 }),
          },
        );
      }

      const { setDraft, clearDraft, insertAt, insertText, addImages, setChips, addChip, addCommandChip } =
        createChatComposerActions(translate, store, say);
      // ---- the queue

      /** Runs one queue action; the answer is pi's queue afterwards. A stale click (409) or a failure shows a notice and re-reads the queue. */
      async function queueEdit(run: (threadId: string) => Promise<QueueSnapshot>): Promise<boolean> {
        const threadId = store.threadId();
        if (!threadId) return false;
        try {
          const queue = await run(threadId);
          if (store.threadId() === threadId) patchState(store, { queue });
          return true;
        } catch (error) {
          say('error', translate('chat.withChatActions.queue', { value1: errorText(error) }));
          void loadQueueOf(threadId);
          return false;
        }
      }

      async function loadQueueOf(threadId: string): Promise<void> {
        try {
          const queue = await unwrap(queueQueue({ client: api.client, path: { id: threadId } }));
          if (store.threadId() === threadId) patchState(store, { queue });
        } catch {
          // The bar keeps what the events said.
        }
      }

      // ---- sending

      /** Adds an activity message that never went through a run (a `!command`'s output). */
      function addLocalActivity(id: string, activityType: string, content: Record<string, unknown>): void {
        const agent = store._agentStore().agent;
        const existing = agent.messages.findIndex((m) => m.id === id);
        const message = { id, role: 'activity', activityType, content } as Message;
        if (existing >= 0) agent.setMessages(agent.messages.map((m, i) => (i === existing ? message : m)));
        else agent.setMessages([...agent.messages, message]);
      }

      /**
       * Sends a message. While pi is running it is queued (`steer` or `followUp`) with the run that is going; otherwise it starts
       * a run. `fileRefs` are the `@paths` of the text; the backend expands the ones that name files in the thread's folder.
       */
      async function send(input: {
        text: string;
        images: { mimeType: string; data: string }[];
        fileRefs: string[];
        behavior?: 'steer' | 'followUp';
        review?: ReviewComment[];
        skills?: ComposerChip[];
      }): Promise<void> {
        const threadId = store.threadId();
        if (!threadId) return;
        const selectionEpoch = internal.selectionEpoch;
        const message: Message = {
          id: crypto.randomUUID(),
          role: 'user',
          content:
            input.images.length === 0
              ? input.text
              : [
                  ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
                  ...input.images.map((i) => ({
                    type: 'image' as const,
                    source: { type: 'data' as const, value: i.data, mimeType: i.mimeType },
                  })),
                ],
        };
        patchState(store, { runError: undefined, lastAborted: false });
        if (store.running() || (store.promptActive() ?? store.stats()?.streaming)) {
          // A background agent records a queued message only when it picks it up (its next step); the transcript shows it from now on and
          // drops this copy once the recorded one arrives. The thread's own queue is drawn by its queue bar instead.
          if (!store._agent.session) {
            store._agentStore().agent.addMessage(message);
            patchState(store, (s) => ({ optimisticIds: [...s.optimisticIds, message.id].slice(-50) }));
          }
          // pi processes input handlers asynchronously. Keep requests in submission order so a later steer cannot overtake one in flight.
          const write = async (): Promise<void> => {
            try {
              const res = await store._backend.fetch(`/api/copilotkit/agent/${store._agent.agentId}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
                body: JSON.stringify({
                  threadId,
                  runId: crypto.randomUUID(),
                  state: {},
                  tools: [],
                  context: [],
                  messages: [message],
                  forwardedProps: {
                    streamingBehavior: input.behavior ?? 'steer',
                    ...(input.fileRefs.length ? { fileRefs: input.fileRefs } : {}),
                    ...(input.skills?.length ? { skills: input.skills } : {}),
                  },
                }),
              });
              if (!res.ok) throw new Error(await failureText(res));
              await res.text();
            } catch (error) {
              if (store.threadId() !== threadId || internal.selectionEpoch !== selectionEpoch || destroyRef.destroyed)
                return;
              patchState(store, { runError: { message: errorText(error) } });
            }
          };
          const previous = queuedSends.get(threadId);
          const pending = previous ? previous.then(write) : write();
          queuedSends.set(threadId, pending);
          try {
            await pending;
          } finally {
            if (queuedSends.get(threadId) === pending) queuedSends.delete(threadId);
          }
          return;
        }
        const agent = store._agentStore().agent;
        agent.addMessage(message);
        patchState(store, (s) => ({ liveTurns: s.liveTurns + 1 }));
        // A review batch travels beside its text: the backend records it in the session before prompting.
        // Skill and prompt-template chips travel the same way; the backend expands them and records them as a `pi-kit.skills` entry.
        const forwardedProps = {
          // A background agent takes the Deliver choice on an idle run too: its runner turns the message into a follow-up or a steer.
          ...(!store._agent.session && input.behavior ? { streamingBehavior: input.behavior } : {}),
          ...(input.fileRefs.length ? { fileRefs: input.fileRefs } : {}),
          ...(input.review?.length ? { review: { comments: input.review } } : {}),
          ...(input.skills?.length ? { skills: input.skills } : {}),
        };
        await store._copilotKit.core.runAgent({ agent, forwardedProps });
      }

      /** The send pipeline: the composer's text goes through the ordered input transforms, then `send`. */
      async function submit(): Promise<void> {
        if (!store.canSend()) return;
        const threadId = store.threadId();
        const selectionEpoch = internal.selectionEpoch;
        const current = (): boolean =>
          !destroyRef.destroyed && store.threadId() === threadId && internal.selectionEpoch === selectionEpoch;
        const draft = store.draft();
        const images = store.images();
        const chips = store.chips();
        let input: SubmitInput = {
          text: draft.trim(),
          images: images.map(({ mimeType, data }) => ({ mimeType, data })),
          fileRefs: [],
          behavior: store.behavior(),
          skills: chips.map((c) => ({ ...c })),
        };
        for (const step of store._extensions.pipeline()) {
          try {
            input = await step.transform(input);
          } catch (error) {
            if (!current()) return;
            return say('error', `${step.id}: ${errorText(error)}`);
          }
          if (!current()) return;
          if (input.refuse) return say('error', input.refuse);
          if (input.handled) return;
        }
        if (!current()) return;
        // An asynchronous transform may finish after the user started the next draft. Consume only the composer snapshot that was submitted.
        if (store.draft() === draft && store.images() === images && store.chips() === chips) {
          clearDraft();
          if (chips.some((c) => !c.pinned)) setChips(pinnedChips(chips));
        }
        try {
          await send(input);
        } catch (error) {
          if (!current()) return;
          patchState(store, { runError: { message: errorText(error) } });
        }
      }

      async function runShell(threadId: string, command: string, exclude: boolean): Promise<void> {
        const id = `bash:user:${crypto.randomUUID()}`;
        const show = (content: Record<string, unknown>) => addLocalActivity(id, 'pi.bash', content);
        show({ command, output: '', running: true, user: true });
        try {
          let received = false;
          await api.stream<PiActivityContent<'pi.bash'>>(
            sessionBash({
              client: api.client,
              path: { id: threadId },
              body: { command, ...(exclude ? { excludeFromContext: true } : {}) },
              parseAs: 'stream',
            }),
            (update) => {
              received = true;
              show({ ...update });
            },
          );
          if (!received) throw new Error(translate('chat.withChatActions.theShellCommandProducedNoResult'));
        } catch (error) {
          show({ command, output: errorText(error), running: false, exitCode: 1, user: true });
        }
        void refreshStats(threadId);
      }

      function settleConnect(): void {
        const waiters = internal.connectWaiters;
        internal.connectWaiters = [];
        for (const done of waiters) done();
      }

      const reconnect = (): void => patchState(store, (s) => ({ reconnects: s.reconnects + 1 }));

      function reconnectAndWait(): Promise<void> {
        return new Promise((resolve) => {
          const timer = setTimeout(done, store._policy.reconnectWaitMs);
          function done(): void {
            clearTimeout(timer);
            resolve();
          }
          internal.connectWaiters.push(done);
          reconnect();
        });
      }

      /** Menus: chooses an entry (replaces the token with it, or runs it). */
      function pickMenuItem(id: string): void {
        const item = store.menuFlat().find((i) => i.id === id);
        if (!item) return;
        const result = item.apply();
        if ('run' in result) result.run();
        else setDraft(result.text, result.caret);
      }

      /** Menu keys, Enter to send, ↑ to bring the last message back. Returns true when the key was dealt with. */
      function handleKey(event: KeyboardEvent): boolean {
        if (event.isComposing) return false;
        if (store.menuOpen()) {
          const flat = store.menuFlat();
          const index = flat.findIndex((i) => i.id === store.menuSelected());
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (flat.length === 0) return true;
            const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length;
            patchState(store, { menuSelected: flat[next].id });
            return true;
          }
          if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
            const item = flat[Math.max(index, 0)];
            if (item) {
              event.preventDefault();
              pickMenuItem(item.id);
              return true;
            }
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            patchState(store, { dismissedFor: store.menuKey() });
            return true;
          }
        }
        if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && store.followUp()) {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            void acceptFollowUp();
            return true;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            dismissFollowUp();
            return true;
          }
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          void submit();
          return true;
        }
        // Backspace in an empty composer takes the last chip back, the way it would take back a character.
        if (event.key === 'Backspace' && store.draft() === '' && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const last = store.chips().at(-1);
          if (last) {
            event.preventDefault();
            setChips(withoutChip(store.chips(), last));
            return true;
          }
        }
        if (event.key === 'ArrowUp' && store.draft() === '' && store.images().length === 0) {
          // Bring the last message back to edit it; sending it branches from that turn.
          const fallback = lastUserTextOf(store.messages());
          if (fallback || store.threadId()) {
            event.preventDefault();
            void tree()
              .recallLast()
              .then((recalled) => {
                if (!recalled && fallback) bus.setComposerText(fallback);
              });
            return true;
          }
        }
        return false;
      }

      async function acceptFollowUp(): Promise<void> {
        const suggestion = store.followUp();
        if (!suggestion) return;
        const threadId = store.threadId();
        const epoch = internal.selectionEpoch;
        const threadEpoch = internal.threadEpoch;
        const draftVersion = internal.draftVersion;
        patchState(store, (s) => ({
          acceptingFollowUp: suggestion.id,
          hiddenFollowUps: [...s.hiddenFollowUps.slice(-59), suggestion.id],
        }));
        try {
          await unwrap(attendantAccept({ client: api.client, path: { id: suggestion.id } }));
          // The network roundtrip cannot replace something typed, attached or selected in the meantime.
          if (
            store.threadId() === threadId &&
            internal.selectionEpoch === epoch &&
            internal.threadEpoch === threadEpoch &&
            internal.draftVersion === draftVersion &&
            !store.draft().length &&
            !store.images().length &&
            !store.chips().some((chip) => !chip.pinned) &&
            !store.running() &&
            store._threads.selected()?.state.activity === 'idle'
          )
            setDraft(suggestion.text, suggestion.text.length);
        } catch (error) {
          if (store.threadId() === threadId) say('warning', errorText(error));
        } finally {
          if (store.acceptingFollowUp() === suggestion.id) patchState(store, { acceptingFollowUp: undefined });
        }
      }

      function dismissFollowUp(): void {
        const suggestion = store.followUp();
        if (!suggestion) return;
        patchState(store, (s) => ({ hiddenFollowUps: [...s.hiddenFollowUps.slice(-59), suggestion.id] }));
        void unwrap(attendantDismiss({ client: api.client, path: { id: suggestion.id } })).catch(() => undefined);
      }

      async function chooseSuggestion(suggestion: ComposerSuggestion): Promise<void> {
        if (suggestion.id === 'reply') return bus.focusComposer();
        if (suggestion.send) {
          setDraft(suggestion.text, suggestion.text.length);
          return submit();
        }
        setDraft(suggestion.text, suggestion.text.length);
      }

      // The built-in parts of the composer, registered through the same registries an extension uses.
      const registerBuiltIns = (): void =>
        registerChatBuiltIns(translate, store, { insertAt, clearDraft, addChip, setDraft, runShell, say });

      function applyRegistration(value: unknown): void {
        const parsed = parsePiCustomEvent({ name: 'pi.composer', value });
        if (!parsed || parsed.name !== 'pi.composer') return;
        const v = parsed.value;
        const ext = store._extensions;
        if (v.op === 'remove') {
          ext.removeAction(`pi:${v.id}`);
          ext.removeSuggestion(`pi:${v.id}`);
        } else if (v.op === 'action') {
          ext.addAction({
            id: `pi:${v.id}`,
            label: v.label,
            icon: v.icon ?? v.label.slice(0, 2),
            order: 200,
            source: 'pi',
            run: () => chooseSuggestion({ id: v.id, title: v.label, text: v.text, send: v.send ?? false }),
          });
        } else {
          ext.addSuggestion({ id: `pi:${v.id}`, title: v.title, text: v.text, send: v.send ?? false, source: 'pi' });
        }
      }

      /** How often the list was asked for, per thread; only the open thread's count is kept. Six is the cap of the retries and of the "/" loads. */
      const MAX_COMMAND_ATTEMPTS = 6;
      const commandAttempts = new Map<string, number>();
      async function loadCommands(threadId = store.threadId()): Promise<void> {
        if (!threadId) return;
        for (const key of commandAttempts.keys()) if (key !== threadId) commandAttempts.delete(key);
        commandAttempts.set(threadId, (commandAttempts.get(threadId) ?? 0) + 1);
        patchState(store, { commandsLoading: true });
        await store._request(
          'commands',
          async (signal) => {
            const commands = await unwrap(sessionListCommands({ client: api.client, signal, path: { id: threadId } }));
            const registrations = await unwrap(
              composerComposer({ client: api.client, signal, path: { id: threadId } }),
            ).catch(() => []);
            return { commands, registrations };
          },
          {
            valid: () => store.threadId() === threadId,
            next: ({ commands, registrations }) => {
              patchState(store, {
                commands: commands.map(adaptCommand.bind(undefined, translate)),
                commandsError: undefined,
              });
              for (const registration of registrations) applyRegistration(registration);
              // pi always has commands (/learn, /setup, …): an empty list means the session was not open yet, right after a start. Ask again.
              if (commands.length === 0) retryCommands(threadId);
              else commandAttempts.delete(threadId);
            },
            error: (error) => {
              patchState(store, { commandsError: errorText(error) });
              retryCommands(threadId);
            },
            settled: () => patchState(store, { commandsLoading: false }),
          },
        );
      }

      /** The slash menu stayed empty after a start: a few more tries, spaced out, while the thread is still the open one. */
      const retryCommands = (threadId: string): void => {
        const attempt = commandAttempts.get(threadId) ?? 0;
        if (attempt >= MAX_COMMAND_ATTEMPTS) return;
        setTimeout(() => {
          if (store.threadId() === threadId && store.commands().length === 0 && !store.commandsLoading())
            void loadCommands(threadId);
        }, 1500 * attempt);
      };
      /** A "/" may ask for the list while it is empty, until the tries are spent (a backend that keeps failing is not asked on every keystroke). */
      const commandsWanted = (): boolean => {
        const threadId = store.threadId();
        return (
          !!threadId &&
          store.commands().length === 0 &&
          !store.commandsLoading() &&
          (commandAttempts.get(threadId) ?? 0) < MAX_COMMAND_ATTEMPTS
        );
      };

      return {
        // ---- conversation
        say,
        dismissNotice: (id: number): void =>
          patchState(store, (s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
        refreshStats,
        setRunError: (error: ChatStoreState['runError']): void => patchState(store, { runError: error }),
        send,
        submit,
        /** Stops the run. A thread blocked in a dialog has no run: dismiss the dialog, then end its interrupt. */
        async stop(): Promise<void> {
          const threadId = store.threadId();
          if (!threadId) return;
          const waiting = store.waitingForAnswer();
          await store._backend
            .fetch(`/api/copilotkit/agent/pi/stop/${encodeURIComponent(threadId)}`, { method: 'POST' })
            .catch(() => undefined);
          if (waiting) await store.interrupt.cancel().catch(() => undefined);
        },
        /**
         * The user's answer to a background agent's question, or its dismissal: the AG-UI resume with the question's id, as a
         * dialog's answer goes, which the backend hands to the agents. Nothing of pi's changes; the thread state drops the question.
         */
        async answerAgentQuestion(questionId: string, answer: PiDialogAnswer | 'cancelled'): Promise<void> {
          const threadId = store.threadId();
          if (!threadId) return;
          const entry =
            answer === 'cancelled'
              ? { interruptId: questionId, status: 'cancelled' }
              : { interruptId: questionId, status: 'resolved', payload: answer };
          const res = await store._backend.fetch('/api/copilotkit/agent/pi/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify({
              threadId,
              runId: crypto.randomUUID(),
              state: {},
              tools: [],
              context: [],
              messages: [],
              forwardedProps: {},
              resume: [entry],
            }),
          });
          if (!res.ok) throw new Error(await failureText(res));
          void res.text().catch(() => undefined);
        },
        addLocalActivity,
        /** Empties the transcript and replays the thread again (after `/compact`, `/reload`). */
        reconnect,
        reconnectAndWait,
        /** The last user message text, for ↑ in an empty composer. */
        lastUserText: (): string | undefined => lastUserTextOf(store.messages()),
        /** The last assistant text, for `/copy`. */
        lastAssistantText(): string | undefined {
          const messages = store.messages();
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
          }
          return undefined;
        },
        // ---- commands
        loadCommands,
        findCommand: (name: string): Command | undefined => store.commands().find((c) => c.name === name),
        // ---- model and effort
        setStats: (stats: SessionStats): void => patchState(store, { stats }),
        setHotTurn: (key: string | undefined): void => {
          if (store.hotTurn() !== key) patchState(store, { hotTurn: key });
        },
        // ---- the composer
        /** The draft; a "/" typed while the command list is still empty (a fresh thread, a start) asks for the list right then. */
        setDraft: (text: string, caret?: number): void => {
          setDraft(text, caret);
          if (/^\s*\//.test(text) && commandsWanted()) void loadCommands();
        },
        clearDraft,
        /** The caret moved in the textarea (typing, arrows, click). */
        setCaret: (caret: number): void => patchState(store, { caret }),
        insertAt,
        insertText,
        toggleShell: (): void =>
          patchState(store, (s) => ({
            draft: s.draft.startsWith('!') ? s.draft.replace(/^!+\s?/, '') : `!${s.draft}`,
          })),
        setBehavior: (behavior: 'steer' | 'followUp'): void => patchState(store, { behavior }),
        setPlaceholder: (placeholderOverride: string | undefined): void => patchState(store, { placeholderOverride }),
        selectMenuItem: (id: string | undefined): void => patchState(store, { menuSelected: id }),
        pickMenuItem,
        addImages,
        // ---- skill and prompt-template chips
        addChip,
        addCommandChip,
        /** Takes a chip out of the composer (the close button; Backspace in an empty composer takes the last one). */
        removeChip: (chip: Pick<ComposerChip, 'kind' | 'name'>): void => setChips(withoutChip(store.chips(), chip)),
        /** Pins a chip to the thread, or lets it go: a pinned chip stays on the messages that follow. */
        togglePin: (chip: Pick<ComposerChip, 'kind' | 'name'>): void => setChips(withPinToggled(store.chips(), chip)),
        removeImage: (id: string): void => patchState(store, (s) => ({ images: s.images.filter((i) => i.id !== id) })),
        /** Removes the `@path` a chip stands for from the draft. */
        removeFileChip: (path: string): void => patchState(store, (s) => ({ draft: withoutFileRef(s.draft, path) })),
        handleKey,
        acceptFollowUp,
        dismissFollowUp,
        chooseSuggestion,
        focusComposer: (): void => bus.focusComposer(),
        requestImagePicker: (): void => patchState(store, (s) => ({ pickerRequests: s.pickerRequests + 1 })),
        // ---- the queue bar: pi's queue is the truth; every action answers with it
        loadQueue: (threadId = store.threadId()): Promise<void> =>
          threadId ? loadQueueOf(threadId) : Promise.resolve(),
        /** Steer now: a follow-up is delivered after the current turn instead of after the run. */
        steerQueued: (item: QueueItem) =>
          queueEdit((id) => unwrap(queuePromote({ client: api.client, path: { id }, body: item }))),
        removeQueued: (item: QueueItem) =>
          queueEdit((id) => unwrap(queueRemove({ client: api.client, path: { id }, body: item }))),
        /** Edit: out of the queue and back into the composer (below what is already typed there). */
        async editQueued(item: QueueItem): Promise<void> {
          const done = await queueEdit((id) => unwrap(queueRemove({ client: api.client, path: { id }, body: item })));
          if (!done) return;
          const typed = store.draft();
          const next = typed.trim() ? `${typed.replace(/\s+$/, '')}\n\n${item.text}` : item.text;
          setDraft(next, next.length);
          bus.focusComposer();
        },
        mergeQueued: () => queueEdit((id) => unwrap(queueMerge({ client: api.client, path: { id } }))),
        clearQueued: () => queueEdit((id) => unwrap(queueClear({ client: api.client, path: { id } }))),
        /** Regenerate: navigate to the parent turn (the leaf moves above the user message) and prompt the same text again as its sibling. */
        async regenerate(userMessageId: string): Promise<void> {
          const threadId = store.threadId();
          if (!threadId || store.running()) return;
          const original = store.messages().find((m) => m.id === userMessageId && m.role === 'user');
          if (!original) return;
          const { text, images } = userContent(original);
          const sentChips = store
            .blocks()
            .some((b) => b.kind === 'user' && b.id === userMessageId && !!b.skills?.length);
          if (!text && images.length === 0 && !sentChips) return;
          try {
            await unwrap(
              treeNavigate({ client: api.client, path: { id: threadId }, body: { targetId: userMessageId } }),
            );
            await reconnectAndWait();
            void tree().refresh(threadId);
            // The chips the message went with go with it again.
            const block = store.blocks().find((b) => b.kind === 'user' && b.id === userMessageId);
            const skills = block?.kind === 'user' ? block.skills : undefined;
            await send({ text, images, fileRefs: fileRefsOf(text), ...(skills?.length ? { skills } : {}) });
          } catch (error) {
            say('error', translate('chat.withChatActions.regenerate', { value1: errorText(error) }));
          }
        },
        // ---- for the hooks
        _registerBuiltIns: registerBuiltIns,
        _applyRegistration: applyRegistration,
        _settleConnect: settleConnect,
        _runShell: runShell,
      };
    }),
  );
}
