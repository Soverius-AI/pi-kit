import { computed, inject, linkedSignal } from '@angular/core';
import { signalStoreFeature, withComputed, withProps } from '@ngrx/signals';
import type { ChangeSource } from '@pi-kit/protocol';
import { ThreadsStore } from '@pi-kit/threads/api';

/**
 * Which changes the panel shows: "This thread", the working tree or the thread's outcome. The source the person chose is kept; the Outcome source
 * falls back to "This thread" when the open thread has no outcome (any more), and stays there.
 */
export function withChangeSource() {
  return signalStoreFeature(
    withProps(() => {
      const threads = inject(ThreadsStore);
      const chosen = linkedSignal<boolean, ChangeSource>({
        source: () => !!threads.selected()?.state.outcome,
        computation: (hasOutcome, previous) =>
          !hasOutcome && previous?.value === 'outcome' ? 'thread' : (previous?.value ?? 'thread'),
      });
      return { _source: chosen, source: chosen.asReadonly() };
    }),
    withComputed(({ source }) => ({
      /** Revert and Stage act on the files on disk; the Outcome is committed history. */
      editable: computed(() => source() !== 'outcome'),
    })),
  );
}
