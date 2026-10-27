import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import { signalStore, withComputed, withMethods } from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { BackendService, failureText } from '@pi-kit/api';
import { ChatStore, CommandRegistry } from '@pi-kit/chat/api';
import { totalsLine } from '@pi-kit/chat/util';
import {
  DialogStore,
  DRAWER_BELOW_PX,
  HealthStore,
  PHONE_BELOW_PX,
  ToastStore,
  UiStore,
  ViewPrefs,
} from '@pi-kit/data-access';
import type { PiDialogRequest, ThreadSuggestion, ThreadSummary } from '@pi-kit/protocol';
import { ChangesStore } from '@pi-kit/review/api';
import { GraphStore } from '@pi-kit/session-tree/api';
import { AttendantStore, threadLabel, ThreadsStore } from '@pi-kit/threads/api';
import { eventMatches } from '@pi-kit/ui';
import { fromEvent, tap } from 'rxjs';

/**
 * The window shell's logic, kept out of `App`. The keyboard is bound once, here, to the combinations in
 * `ViewPrefs.combos()` (so a changed shortcut applies at once); the panel toggles, the dialog routing of Esc, and the texts of the header and
 * the status bar are derived here. `App` and its template only render these and forward intent.
 */
export const ShellStore = signalStore(
  { providedIn: 'root' },
  withComputed(() => {
    const translate = inject(Language).t;
    const health = inject(HealthStore);
    const threads = inject(ThreadsStore);
    const chat = inject(ChatStore);
    return {
      backendLabel: computed(() => {
        switch (health.state()) {
          case 'ok':
            return translate('shell.shellStore.backendConnected');
          case 'error':
            return translate('shell.shellStore.backendUnreachable');
          default:
            return translate('shell.shellStore.connectingToBackend');
        }
      }),
      /** The header's title: the thread's, else the app's name. */
      title: computed(() => {
        const thread = threads.selected();
        return thread ? threadLabel(translate, thread) : 'pi-kit';
      }),
      runState: computed(() => {
        if (chat.waitingForAnswer()) return translate('shell.shellStore.waitingForYourAnswer');
        if (chat.compacting()) return translate('shell.shellStore.compacting');
        return chat.running() ? translate('shell.shellStore.running') : translate('shell.shellStore.idle');
      }),
      /** `$0.84 · 112k tokens · 9 turns`; it opens the usage dialog. */
      totals: computed(() => totalsLine(translate, chat.totalCost(), chat.totalTokens(), chat.totalTurns())),
      sessionLabel: computed(() => {
        const id = chat.stats()?.sessionId ?? threads.selectedId();
        return id ? translate('shell.shellStore.session', { value1: id.slice(0, 4), value2: id.slice(-4) }) : '';
      }),
      statusEntries: computed(() => Object.entries(chat.statuses())),
      // The header's panel switcher: a panel needs a thread (Tree, Changes) or a folder (Files, Terminal).
      treeDisabled: computed(() => !threads.selectedId()),
      changesDisabled: computed(() => !threads.selectedId()),
      filesDisabled: computed(() => !threads.workspace()),
      terminalDisabled: computed(() => !threads.workspace()),
    };
  }),
  withMethods(() => {
    const translate = inject(Language).t;
    const threads = inject(ThreadsStore);
    const chat = inject(ChatStore);
    const ui = inject(UiStore);
    const dialogs = inject(DialogStore);
    const prefs = inject(ViewPrefs);
    const graph = inject(GraphStore);
    const registry = inject(CommandRegistry);
    const attendant = inject(AttendantStore);
    const toasts = inject(ToastStore);
    const review = inject(ChangesStore);
    const backend = inject(BackendService);

    /** Waits (polling) until `check` holds, at most `ms`; whether it did. */
    const until = async (check: () => boolean, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (!check()) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return true;
    };

    /** Scrolls the open thread's approval block into view and marks it for a moment; the transcript may still be replaying, so it looks for a few seconds. */
    const revealApproval = async (threadId: string): Promise<void> => {
      const found = await until(
        () => threads.selectedId() === threadId && document.querySelector('.pk-main .pk-approval') !== null,
        6000,
      );
      const block = found ? document.querySelector<HTMLElement>('.pk-main .pk-approval') : null;
      if (!block) return;
      block.scrollIntoView({ block: 'center' });
      block.setAttribute('data-reveal', '');
      setTimeout(() => block.removeAttribute('data-reveal'), 1600);
    };

    /**
     * The shortcuts of Settings › Keybindings (the defaults include ⌘N new thread, ⌘K command palette, ⌘B the sidebar, ⌘⇧M / ⌘⇧E model and effort, ⌘⇧F the Files filter)
     * and Esc stop (menus and dialogs take Esc first). The combinations are `ViewPrefs.combos()`, so a changed shortcut applies at once.
     */
    const handleKey = (event: KeyboardEvent): void => {
      // The terminal panel owns every key typed in it (Esc, ⌘K and Ctrl+N mean something to a shell).
      if ((event.target as HTMLElement | null)?.closest?.('.xterm')) return;
      const combos = prefs.combos();
      const is = (id: string): boolean => eventMatches(combos[id] ?? '', event);
      if (is('cycle-model') || is('cycle-effort')) {
        // The next pinned model, the next effort level (pi's Ctrl+P and Shift+Tab); a toast says which.
        event.preventDefault();
        if (threads.selectedId()) void (is('cycle-model') ? chat.cycleModel() : chat.cycleEffort());
      } else if (is('new-worktree-thread')) {
        event.preventDefault();
        void registry.newThread('worktree');
      } else if (is('new-thread')) {
        event.preventDefault();
        void registry.newThread();
      } else if (is('command-palette')) {
        event.preventDefault();
        ui.togglePalette();
      } else if (is('search-threads')) {
        event.preventDefault();
        ui.focusThreadSearch();
      } else if (is('files-filter')) {
        // The Files panel's filter (on a phone the Files panel does not exist).
        if (!threads.workspace() || window.innerWidth < PHONE_BELOW_PX) return;
        event.preventDefault();
        ui.focusFilesFilter();
      } else if (is('prev-thread') || is('next-thread')) {
        // The thread before or after the open one in this project, in the order the sidebar lists them.
        event.preventDefault();
        threads.stepThread(is('prev-thread') ? -1 : 1);
      } else if (is('toggle-sidebar')) {
        event.preventDefault();
        toggleSidebar();
      } else if (projectKey(event) !== undefined) {
        // ⌘1 to ⌘9: the 1st to 9th project of the sidebar.
        event.preventDefault();
        threads.jumpToProject((projectKey(event) as number) - 1);
      } else if (event.key === 'Escape' && !event.defaultPrevented) {
        if (dialogs.current()) return dialogs.close();
        if (ui.settings()) return ui.closeSettings();
        if (ui.palette()) return ui.closePalette();
        if (graph.branch()) return graph.cancelBranch();
        // Where the panel overlays the page (drawer, sheet) it closes like a menu; beside the transcript it stays.
        if (!chat.running() && ui.closePanelIfOverlay()) return;
        if (chat.running() || chat.waitingForAnswer()) {
          event.preventDefault();
          void chat.stop();
        }
      }
    };

    const projectKey = (event: KeyboardEvent): number | undefined => {
      for (let n = 1; n <= 9; n++) if (eventMatches(`mod+${n}`, event)) return n;
      return undefined;
    };

    /** On a wide window the sidebar collapses (remembered); below 1024px, where it is a drawer, the drawer opens or closes. */
    const toggleSidebar = (): void => {
      const drawer = document.getElementById('t-threads') as HTMLInputElement | null;
      if (drawer && window.innerWidth < DRAWER_BELOW_PX) drawer.checked = !drawer.checked;
      else void prefs.toggleSidebar();
    };

    const bindKeyboard = rxMethod<KeyboardEvent>(tap((event) => handleKey(event)));
    let started = false;

    return {
      handleKey,
      toggleSidebar,
      /** Binds the keyboard (once) and loads the workspaces and the remembered thread. */
      start(): void {
        if (started) return;
        started = true;
        bindKeyboard(fromEvent<KeyboardEvent>(document, 'keydown'));
        void threads.init();
      },
      /** The sidebar opened a thread (on a phone from the drawer). */
      openThread(threadId: string): void {
        threads.select(threadId);
        void threads.refresh();
      },
      /** A waiting badge was clicked: the thread opens scrolled to the approval block that asks the question. */
      openWaiting(threadId: string): void {
        threads.select(threadId);
        void revealApproval(threadId);
      },
      /**
       * "Show the outcome" of a thread's badge: the thread opens, and review mode shows the Outcome source. Review mode starts over when the open
       * thread changes, so it is asked only once it follows this thread.
       */
      async openOutcome(threadId: string): Promise<void> {
        if (threads.selectedId() !== threadId) threads.select(threadId);
        // On a phone the list is a drawer over the page; the diff is what the person looks at next.
        const drawer = document.getElementById('t-threads') as HTMLInputElement | null;
        if (drawer) drawer.checked = false;
        const ready = await until(() => threads.selectedId() === threadId && review.threadId() === threadId, 5000);
        if (!ready) return;
        // The review store resets in an effect when its thread changes; let that run before asking for the source.
        await new Promise((resolve) => setTimeout(resolve, 60));
        review.setSource('outcome');
        review.open();
      },
      /** A skill was approved: the backend reloaded the sessions that were idle, and the thread's `/` menu and chips read the commands again. */
      skillsChanged(threadId: string): void {
        if (threads.selectedId() === threadId) void chat.loadCommands(threadId);
      },
      async dismissSuggestion(suggestion: ThreadSuggestion): Promise<void> {
        await attendant.dismiss(suggestion).catch(() => undefined);
      },
      /**
       * A chip of the sidebar's "Needs you" strip answers the dialog. The open thread's own approval block resolves through the chat, so it goes away as when
       * the button in it is pressed; any other thread gets the AG-UI resume from the API, without being opened. The attendant's suggestion, when the chip was it, is accepted after.
       */
      async answerWaiting(
        thread: ThreadSummary,
        dialogId: string,
        payload: { confirmed: boolean } | { value: string },
        suggestion?: ThreadSuggestion,
      ): Promise<void> {
        try {
          if (threads.selectedId() === thread.id && chat.interrupt.interrupts().some((i) => i.id === dialogId))
            await chat.interrupt.resolve(payload, dialogId);
          else {
            const res = await backend.fetch('/api/copilotkit/agent/pi/run', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
              body: JSON.stringify({
                threadId: thread.id,
                runId: crypto.randomUUID(),
                state: {},
                tools: [],
                context: [],
                messages: [],
                forwardedProps: {},
                resume: [{ interruptId: dialogId, status: 'resolved', payload }],
              }),
            });
            if (!res.ok) throw new Error(await failureText(res));
            void res.text().catch(() => undefined);
          }
          if (suggestion) await attendant.accept(suggestion).catch(() => undefined);
        } catch (error) {
          toasts.show(
            'error',
            translate('shell.shellStore.couldNotAnswer', {
              value1: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      },
      /**
       * The user accepted one of the attendant's suggestions. A label is applied. An answer is given by this click, as if the user had pressed the
       * button in the approval: the thread opens, and once its question is there it is answered with the suggested choice. The attendant never answers by itself.
       */
      async acceptSuggestion(thread: ThreadSummary, suggestion: ThreadSuggestion): Promise<void> {
        try {
          // A drafted skill is read in the review dialog (the sidebar opens it); nothing here applies it.
          if (suggestion.kind === 'learn') return;
          if (suggestion.kind === 'label') {
            await attendant.accept(suggestion);
            toasts.show('success', translate('shell.shellStore.labelled', { value1: suggestion.text }));
            return;
          }
          threads.select(thread.id);
          const ready = await until(
            () =>
              threads.selectedId() === thread.id && chat.interrupt.interrupts().some((i) => i.id === suggestion.target),
            10_000,
          );
          if (!ready) {
            toasts.show('info', translate('shell.shellStore.thatQuestionIsNotOpenAnyMore'));
            await attendant.dismiss(suggestion);
            return;
          }
          const request = chat.interrupt.interrupts().find((i) => i.id === suggestion.target)?.metadata as
            PiDialogRequest | undefined;
          await chat.interrupt.resolve(
            request?.method === 'confirm' ? { confirmed: suggestion.text === 'Allow' } : { value: suggestion.text },
            suggestion.target,
          );
          await attendant.accept(suggestion);
        } catch (error) {
          toasts.show(
            'error',
            translate('shell.shellStore.couldNotUseTheSuggestion', {
              value1: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      },
    };
  }),
);
export type ShellStore = InstanceType<typeof ShellStore>;
