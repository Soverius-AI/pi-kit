import { computed } from '@angular/core';
import { patchState, signalStoreFeature, withComputed, withMethods, withState } from '@ngrx/signals';

/**
 * One selected item by id (a thread, a graph row, a file path, a changed file). The store adds the lookup (`selected` is the entity, which only
 * the store knows how to find) and any rule around changing it; this trait is the id, the setter and the moves.
 */
export function withSelection<Id extends string = string>() {
  return signalStoreFeature(
    withState<{ selectedId: Id | undefined }>({ selectedId: undefined }),
    withComputed(({ selectedId }) => ({
      hasSelection: computed(() => selectedId() !== undefined),
    })),
    withMethods((store) => ({
      setSelected(id: Id | undefined): void {
        patchState(store, { selectedId: id });
      },
      clearSelection(): void {
        patchState(store, { selectedId: undefined });
      },
      isSelected(id: Id): boolean {
        return store.selectedId() === id;
      },
      /**
       * Moves the selection `offset` places within `ids` (no selection starts from the first for a move down); it stays put at either end.
       * Returns the id now selected.
       */
      moveSelection(ids: readonly Id[], offset: number): Id | undefined {
        if (ids.length === 0) return store.selectedId();
        const at = ids.indexOf(store.selectedId() as Id);
        const next = at < 0 ? (offset > 0 ? 0 : -1) : Math.min(ids.length - 1, Math.max(0, at + offset));
        if (next >= 0 && next !== at) patchState(store, { selectedId: ids[next] });
        return store.selectedId();
      },
    })),
  );
}
