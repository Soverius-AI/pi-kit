import { DestroyRef, inject, computed } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import type { PkMenuItem } from '@pi-kit/design-system';
import type { ComposerChip, ReviewComment } from '@pi-kit/protocol';

/**
 * What the composer lets code outside it add. One registry per kind; the composer's own parts are
 * registered through it too, so there is one mechanism: the toolbar's ⊕ @ ! buttons, the `@file` and `!cmd` steps of the send
 * pipeline, the `/` and `@` menus. pi extensions reach it without touching the renderer: their toolbar actions and suggestions
 * arrive as `pi.composer` events (the extension emits on `pi-kit:composer`), their argument completers through the backend.
 */

/** A button in the composer's toolbar. */
export interface ComposerAction {
  id: string;
  /** The tooltip and the accessible name. */
  label: string;
  /** What the button shows: a glyph or a short word. */
  icon: string;
  placement?: 'left' | 'right';
  /** Lower numbers first within a placement. */
  order?: number;
  /** Shown in mono (the `@` and `!` buttons). */
  mono?: boolean;
  disabled?: () => boolean;
  run: () => void | Promise<void>;
  /** Where it came from, for the DOM (`data-source`). */
  source?: 'app' | 'pi';
}

/** What is about to be sent; every transform may change it. */
export interface SubmitInput {
  text: string;
  images: { mimeType: string; data: string }[];
  fileRefs: string[];
  behavior?: 'steer' | 'followUp';
  review?: ReviewComment[];
  /** The skill and prompt-template chips of the message, in chip order (pinned ones included). */
  skills?: ComposerChip[];
  /** A transform dealt with the message itself (a `!command`, a built-in): nothing is sent. */
  handled?: boolean;
  /** The draft is kept and this is said to the user (a transform could not do its part). */
  refuse?: string;
}

export interface InputTransform {
  id: string;
  /** Lower numbers run first. The built-ins use 10 (shell), 20 (built-in commands), 30 (branch), 40 (file references). */
  order: number;
  transform(input: SubmitInput): SubmitInput | Promise<SubmitInput>;
}

export interface CompletionToken {
  /** Index in the text where the typed token starts (the `/` or the `@`). */
  start: number;
  query: string;
}

/** One entry of a completion menu; `apply` says what choosing it does to the draft. */
export interface CompletionItem extends PkMenuItem {
  /** The group of the menu the item sits in; the provider's title when absent. */
  group?: string;
  apply(): { text: string; caret: number } | { run: () => void };
}

export interface CompletionProvider {
  id: string;
  /** The menu's heading and its group title. */
  title: string;
  /** The first provider (lowest order) whose `match` answers wins. */
  order: number;
  match(text: string, caret: number): CompletionToken | undefined;
  /** Sync results show at once; a promise waits `debounceMs` first and is cancelled when the token changes. */
  complete(
    token: CompletionToken,
    ctx: { text: string; caret: number; signal: AbortSignal },
  ): CompletionItem[] | Promise<CompletionItem[]>;
  debounceMs?: number;
  /** A menu with no entries still shows (the `/` menu says "No command matches"); the others stay closed. */
  showEmpty?: boolean;
}

/** A pill above the composer. */
export interface ComposerSuggestion {
  id: string;
  title: string;
  /** What the pill puts in the composer, or sends when `send` is set. */
  text: string;
  send?: boolean;
  source?: 'app' | 'pi' | 'template';
}

interface ExtensionsState {
  actions: ComposerAction[];
  transforms: InputTransform[];
  providers: CompletionProvider[];
  suggestions: ComposerSuggestion[];
}

const byOrder = <T extends { order?: number }>(a: T, b: T): number => (a.order ?? 100) - (b.order ?? 100);

export const ComposerExtensions = signalStore(
  { providedIn: 'root' },
  withState<ExtensionsState>({ actions: [], transforms: [], providers: [], suggestions: [] }),
  withComputed(({ actions, transforms, providers }) => ({
    leftActions: computed(() => [...actions().filter((a) => (a.placement ?? 'left') === 'left')].sort(byOrder)),
    rightActions: computed(() => [...actions().filter((a) => a.placement === 'right')].sort(byOrder)),
    pipeline: computed(() => [...transforms()].sort((a, b) => a.order - b.order)),
    completionProviders: computed(() => [...providers()].sort((a, b) => a.order - b.order)),
  })),
  withMethods((store) => {
    /** A registration with the same id replaces the earlier one; the returned function removes this one. */
    const put = <K extends keyof ExtensionsState>(
      key: K,
      entry: ExtensionsState[K][number] & { id: string },
    ): (() => void) => {
      patchState(
        store,
        (s) =>
          ({
            [key]: [...(s[key] as { id: string }[]).filter((e) => e.id !== entry.id), entry],
          }) as Partial<ExtensionsState>,
      );
      return () =>
        patchState(
          store,
          (s) => ({ [key]: (s[key] as { id: string }[]).filter((e) => e !== entry) }) as Partial<ExtensionsState>,
        );
    };
    const drop = <K extends keyof ExtensionsState>(key: K, id: string): void =>
      patchState(
        store,
        (s) => ({ [key]: (s[key] as { id: string }[]).filter((e) => e.id !== id) }) as Partial<ExtensionsState>,
      );
    return {
      addAction: (action: ComposerAction) => put('actions', action),
      addTransform: (transform: InputTransform) => put('transforms', transform),
      addProvider: (provider: CompletionProvider) => put('providers', provider),
      addSuggestion: (suggestion: ComposerSuggestion) => put('suggestions', suggestion),
      removeAction: (id: string) => drop('actions', id),
      removeSuggestion: (id: string) => drop('suggestions', id),
      /** Everything a pi extension added goes when the thread changes (its session is gone); the app's own stay. */
      forgetPi(): void {
        patchState(store, (s) => ({
          actions: s.actions.filter((a) => a.source !== 'pi'),
          suggestions: s.suggestions.filter((x) => x.source !== 'pi'),
        }));
      },
    };
  }),
);

// ---- registration from code: call from an injection context; the registration goes away with it

export function registerComposerAction(action: ComposerAction): void {
  inject(DestroyRef).onDestroy(inject(ComposerExtensions).addAction(action));
}

export function registerInputTransform(transform: InputTransform): void {
  inject(DestroyRef).onDestroy(inject(ComposerExtensions).addTransform(transform));
}

export function registerCompletionProvider(provider: CompletionProvider): void {
  inject(DestroyRef).onDestroy(inject(ComposerExtensions).addProvider(provider));
}

export function registerComposerSuggestion(suggestion: ComposerSuggestion): void {
  inject(DestroyRef).onDestroy(inject(ComposerExtensions).addSuggestion(suggestion));
}
