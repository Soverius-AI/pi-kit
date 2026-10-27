import type { ChangeSource, ThreadSuggestion, ThreadSummary } from '@pi-kit/protocol';

/**
 * What the threads domain needs from code that imports it. A domain library may not import the app, and may not import a domain that imports it back
 * (`review/data` reads `ThreadsStore`, so `threads/data` importing `@pi-kit/review/api` would be a cycle in the project graph). Each need is an abstract class used
 * as an injection token: the library injects it, `app.config.ts` provides the real store (`{ provide: ThreadShell, useExisting: ShellStore }`).
 */

/** The window shell's answers to the sidebar: a waiting badge or an attendant suggestion was clicked. The shell knows the chat's interrupts, the sidebar does not. */
export abstract class ThreadShell {
  /** A waiting badge was clicked: the thread opens scrolled to the approval block that asks the question. */
  abstract openWaiting(threadId: string): void;
  /** The user accepted one of the attendant's suggestions. */
  abstract acceptSuggestion(thread: ThreadSummary, suggestion: ThreadSuggestion): Promise<void>;
  abstract dismissSuggestion(suggestion: ThreadSuggestion): Promise<void>;
  /**
   * A chip of the "Needs you" strip answers a waiting thread's dialog without opening the thread. `suggestion` is the attendant's answer when the chip was it:
   * it is marked accepted once the answer is given. Resolves when the answer was delivered; a failure is a toast.
   */
  abstract answerWaiting(
    thread: ThreadSummary,
    dialogId: string,
    payload: { confirmed: boolean } | { value: string },
    suggestion?: ThreadSuggestion,
  ): Promise<void>;
  /** "Show the outcome" in an outcome badge's menu: the thread opens and review mode shows its outcome. */
  abstract openOutcome(threadId: string): Promise<void>;
  /** A skill was written (an approved draft): the thread's `/` menu and chips read pi's skills again. */
  abstract skillsChanged(threadId: string): void;
}

/** The part of the review mode's changes store a merge-back conflict uses: it opens the "Working tree" source. */
export abstract class WorktreeReview {
  abstract setSource(source: ChangeSource): void;
  abstract open(file?: string): void;
  abstract refresh(source?: ChangeSource): Promise<void>;
}
