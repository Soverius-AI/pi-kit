import { InjectionToken, type Signal, type Type } from '@angular/core';

/**
 * What the chat store needs from two domains that themselves read the chat. `session-tree/data` and `settings/data` import
 * `@pi-kit/chat/api`, so `chat/data` cannot import theirs back (the project graph would have a cycle): each need is an abstract class used as an injection
 * token. The chat injects it; `app.config.ts` provides the real store (`{ provide: ChatTree, useExisting: GraphStore }`).
 */

/** The part of the session tree's store the composer uses: "Edit and branch" and "↑ recalls the last message". */
export abstract class ChatTree {
  /** The turn the composer is about to branch from, while there is one. */
  abstract readonly branch: Signal<unknown | undefined>;
  /** ↑ in an empty composer: the last message comes back to edit; resolves to whether a branch is now pending. */
  abstract recallLast(): Promise<boolean>;
  /** Moves the leaf to the edited turn's parent so the prompt that follows becomes its sibling. */
  abstract commitBranch(): Promise<void>;
  /** Reads the tree of the thread again. */
  abstract refresh(threadId?: string): Promise<void>;
  /** Opens the Session panel on its context inspector: what the model sees, piece by piece. */
  abstract showContext(): void;
}

/** One connected connector whose tools are declared to the model: a group of its own in the `/` menu. */
export interface ConnectorMenuGroup {
  server: string;
  title: string;
  /** "Linear: create issue, search issues…" */
  line: string;
  /** What choosing it puts in the composer. */
  insert: string;
}

/** The part of Settings › MCP servers the `/` menu lists. */
export abstract class ChatConnectors {
  abstract readonly menuGroups: Signal<readonly ConnectorMenuGroup[]>;
}

/**
 * Two places of the chat page that the threads domain fills for a thread that has no message yet: the page itself (heading, lead, the recent
 * things to continue) in the transcript's place, and, in the composer, the Where row directly above the well plus the line under the well that says what Send will
 * do. Each is a function that loads the components, so the chunk is fetched when a new thread is first shown; `app.config.ts` provides them from
 * `@pi-kit/threads/feature-new-thread`. Without a provider the slots stay empty.
 */
export const EMPTY_THREAD_PAGE = new InjectionToken<() => Promise<Type<unknown>>>('EMPTY_THREAD_PAGE');
export interface NewThreadComposerSlots {
  row: Type<unknown>;
  hint: Type<unknown>;
}
export const NEW_THREAD_COMPOSER = new InjectionToken<() => Promise<NewThreadComposerSlots>>('NEW_THREAD_COMPOSER');
