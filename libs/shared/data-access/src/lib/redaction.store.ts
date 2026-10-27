import { Language } from '@pi-kit/i18n';
import { computed, inject } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { ApiClient, errorMessage, secretsRedactionConfig, secretsSaveRedaction, unwrap } from '@pi-kit/api';
import {
  DEFAULT_REDACTION,
  type RedactionConfig,
  compileUserPatterns,
  redactText,
  redactValue,
} from '@pi-kit/protocol';

import { ToastStore } from './toast.store';

interface RedactionState {
  config: RedactionConfig;
  /** User patterns that are not valid expressions, named (the backend says it, the same function runs here). */
  errors: string[];
  loaded: boolean;
}

/**
 * The redaction pass on the screen's side: the configuration of Settings › Advanced (user patterns, the folders where the pass is off) and the pure functions of
 * `@pi-kit/protocol`, so a key that was typed, streamed or printed shows as `[redacted openai key …a1b2]` in the transcript. The backend masks what it writes to its database and
 * what leaves in an export; this masks what is drawn. The text the model and pi received is not changed (pi's session file is pi's), so "Edit and branch" and "Copy" work on the originals.
 */
export const RedactionStore = signalStore(
  { providedIn: 'root' },
  withState<RedactionState>({ config: DEFAULT_REDACTION, errors: [], loaded: false }),
  withComputed((store) => ({
    patterns: computed(() => compileUserPatterns(store.config().patterns).compiled),
  })),
  withMethods((store) => {
    const translate = inject(Language).t;
    const api = inject(ApiClient);
    const toasts = inject(ToastStore);
    // Messages are redacted once per object; a new object (a message that streamed on) is looked at again. The cache is dropped when the patterns change.
    let cache = new WeakMap<object, unknown>();
    let patternsAt: unknown;
    // Hydration is prepared in small tasks. Match SDK-cloned messages by their complete JSON value as well as
    // object identity, so the synchronous display projection reuses that work. Bound retained copies to 8 MiB.
    const snapshots = new Map<string, { value?: object; size: number }>();
    let snapshotSize = 0;
    const patternsFor = () => {
      const patterns = store.patterns();
      if (patternsAt !== patterns) {
        cache = new WeakMap();
        snapshots.clear();
        snapshotSize = 0;
        patternsAt = patterns;
      }
      return patterns;
    };
    const maskMessage = <T extends object>(message: T): T => {
      const patterns = patternsFor();
      const known = cache.get(message);
      if (known !== undefined) return known as T;
      const signature = JSON.stringify(message);
      const saved = snapshots.get(signature);
      const out = saved ? ((saved.value as T | undefined) ?? message) : redactValue(message, patterns);
      cache.set(message, out);
      if (!saved) {
        const size = 2 * (signature.length + (out === message ? 0 : JSON.stringify(out).length));
        if (size <= 8 * 1024 * 1024) {
          while (snapshots.size >= 4096 || snapshotSize + size > 8 * 1024 * 1024) {
            const first = snapshots.keys().next().value;
            if (first === undefined) break;
            snapshotSize -= snapshots.get(first)?.size ?? 0;
            snapshots.delete(first);
          }
          snapshots.set(signature, { ...(out === message ? {} : { value: out }), size });
          snapshotSize += size;
        }
      }
      return out;
    };

    const methods = {
      async load(): Promise<void> {
        try {
          const { config, errors } = await unwrap(secretsRedactionConfig({ client: api.client }));
          patchState(store, { config, errors, loaded: true });
        } catch {
          // Not reachable yet: the transcript is drawn as it comes, and the backend masks what it keeps either way.
        }
      },

      /** Settings › Advanced: saves the whole configuration; the backend answers with what it kept and the patterns it could not use. */
      async save(config: RedactionConfig): Promise<boolean> {
        try {
          const saved = await unwrap(secretsSaveRedaction({ client: api.client, body: config }));
          patchState(store, { config: saved.config, errors: saved.errors, loaded: true });
          return true;
        } catch (error) {
          toasts.show(
            'error',
            translate('shared.redactionStore.couldNotSaveTheRedactionSettings', { value1: errorMessage(error) }),
          );
          return false;
        }
      },

      /** Prepare a cold snapshot without combining all historical redaction and first-row layout in one task. */
      async prepare(messages: readonly object[], current: () => boolean = () => true): Promise<void> {
        let started = performance.now();
        for (const message of messages) {
          if (!current()) return;
          maskMessage(message);
          if (performance.now() - started >= 4) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            started = performance.now();
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      },

      /** The pass runs for this folder (always, unless the person switched it off for it). */
      enabledFor(cwd: string | undefined): boolean {
        return !cwd || !store.config().offFor.includes(cwd);
      },

      text(text: string): string {
        return redactText(text, store.patterns()).text;
      },

      /** An AG-UI message as it is drawn: key shapes masked in every string, the same object when there was nothing to mask. */
      message<T extends object>(message: T): T {
        return maskMessage(message);
      },
    };
    return methods;
  }),
);
export type RedactionStore = InstanceType<typeof RedactionStore>;
