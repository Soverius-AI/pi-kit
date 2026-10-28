import { computed } from '@angular/core';
import { patchState, signalStoreFeature, withComputed, withMethods, withState } from '@ngrx/signals';
import type { ChangedFile, ChangesList } from '@pi-kit/protocol';

/** A folder of changed files, as the Changes panel groups them. */
export interface ChangeGroup {
  dir: string;
  files: ChangedFile[];
}

/** The changed files of the current source, and what is derived from them. */
export function withChangesList() {
  return signalStoreFeature(
    withState<{ list: ChangesList | undefined }>({ list: undefined }),
    withComputed(({ list }) => {
      const files = computed<ChangedFile[]>(() => list()?.files ?? []);
      return {
        files,
        /** The folder is not a git work tree: there are no diffs, and "Initialise git" is offered. */
        notGit: computed(() => list()?.git === false),
        totals: computed(() =>
          files().reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), {
            added: 0,
            removed: 0,
          }),
        ),
        /** The changed files grouped by folder, folders in order. */
        groups: computed<ChangeGroup[]>(() => {
          const groups = new Map<string, ChangedFile[]>();
          for (const file of files()) {
            const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
            groups.set(dir, [...(groups.get(dir) ?? []), file]);
          }
          return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([dir, list]) => ({ dir, files: list }));
        }),
      };
    }),
    withMethods((store) => ({
      /** Keeps a list that is the same as the one shown (a change of an unrelated file): nothing that reads it reloads or flickers. */
      _setList(list: ChangesList | undefined): void {
        if (list && JSON.stringify(list) === JSON.stringify(store.list())) return;
        patchState(store, { list });
      },
    })),
  );
}
