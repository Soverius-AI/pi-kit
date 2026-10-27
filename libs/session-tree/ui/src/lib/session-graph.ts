import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  untracked,
} from '@angular/core';
import { type PkGraphActionId, PkGraphRow } from '@pi-kit/design-system';
import type { SessionTree, TreeRow } from '@pi-kit/protocol';
import { defaultRangeExtractor, injectVirtualizer } from '@tanstack/angular-virtual';
import { type GraphItem, edgeSelection, layoutGraph, stepSelection } from '@pi-kit/session-tree/util';

export interface GraphActionEvent {
  row: TreeRow;
  id: PkGraphActionId;
  anchor: HTMLElement;
}

/**
 * The session graph list: `pk-graph-row`s in a listbox, abandoned branches folded into group rows, the
 * "Find a turn" filter applied, windowed once there are more than 200 items. It owns the scroll and the keyboard (↑ ↓ Home End
 * move the selection, Enter and a double click say "go here") and reports hover, picks and row actions; what they mean is the
 * parent's business. The first draw of a tree (and a move of the leaf) scrolls to the current row.
 */
@Component({
  selector: 'pk-session-graph',
  imports: [PkGraphRow, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-h-0 flex-1 overflow-y-auto' },
  template: `
    <div
      class="pk-graph"
      role="listbox"
      [attr.aria-label]="'session-tree.sessionGraph.sessionGraph' | transloco"
      tabindex="0"
      [style.--pk-lanes]="layout().lanes"
      [attr.aria-activedescendant]="activeId()"
      (keydown)="onKey($event)"
    >
      @if (before() > 0) {
        <div aria-hidden="true" [style.height.px]="before()"></div>
      }
      @for (item of slice(); track item.key) {
        <pk-graph-row
          [id]="'pk-graph-' + item.key"
          [row]="item"
          [lanes]="layout().lanes"
          [selected]="item.selectId !== undefined && item.selectId === selectedId()"
          (picked)="onPick(item)"
          (activated)="onActivate(item)"
          (hovered)="onHover(item, $event)"
          (action)="action.emit({ row: item.row, id: $event.id, anchor: $event.anchor })"
        />
      }
      @if (after() > 0) {
        <div aria-hidden="true" [style.height.px]="after()"></div>
      }
      @if (layout().items.length === 0) {
        <p class="px-4 py-3 text-sm text-muted">
          {{
            query().trim()
              ? ('session-tree.sessionGraph.noTurnMatches' | transloco) + query().trim() + '”.'
              : ('session-tree.sessionGraph.thisSessionHasNoTurnsYet' | transloco)
          }}
        </p>
      }
    </div>
  `,
})
export class PkSessionGraph {
  protected readonly i18n = inject(Language);
  readonly tree = input.required<SessionTree>();
  readonly selectedId = input<string | undefined>(undefined);
  readonly fold = input(true);
  readonly virtualizeAbove = input(200);
  readonly overscan = input(12);
  readonly expanded = input<ReadonlySet<string>>(new Set());
  readonly query = input('');
  /** A row was chosen (click, arrow keys). */
  readonly pick = output<string>();
  /** Enter or a double click on a row: "go here". */
  readonly activate = output<string>();
  /** The pointer entered (the row's id) or left (`undefined`) a row of a turn. */
  readonly hover = output<string | undefined>();
  readonly action = output<GraphActionEvent>();
  /** A group row was clicked: fold or unfold that branch (the group's id). */
  readonly toggleGroup = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private lastLeaf: string | undefined;

  protected readonly layout = computed(() =>
    layoutGraph(this.i18n.t, this.tree(), { fold: this.fold(), expanded: this.expanded(), query: this.query() }),
  );
  private readonly virtualizer = injectVirtualizer<HTMLElement, HTMLElement>(() => {
    const items = this.layout().items;
    return {
      count: items.length,
      scrollElement: this.host,
      estimateSize: (index) => items[index].height,
      getItemKey: (index) => items[index].key,
      overscan: this.overscan(),
      paddingStart: 4,
      paddingEnd: 8,
      scrollPaddingStart: 4,
      scrollPaddingEnd: 4,
      initialRect: { width: 0, height: 800 },
      rangeExtractor:
        items.length <= this.virtualizeAbove() ? () => items.map((_, index) => index) : defaultRangeExtractor,
    };
  });
  protected readonly slice = computed(() =>
    this.virtualizer.getVirtualItems().map(({ index }) => this.layout().items[index]),
  );
  // The list's CSS supplies the same outer padding as the virtualizer's coordinate space.
  protected readonly before = computed(() => Math.max(0, (this.virtualizer.getVirtualItems()[0]?.start ?? 4) - 4));
  protected readonly after = computed(() =>
    Math.max(0, this.virtualizer.getTotalSize() - (this.virtualizer.getVirtualItems().at(-1)?.end ?? 0) - 8),
  );
  protected readonly activeId = computed(() => {
    const id = this.selectedId();
    const item = id ? this.layout().items.find((i) => i.selectId === id) : undefined;
    return item ? `pk-graph-${item.key}` : null;
  });

  constructor() {
    // A pending index reveal belongs to the old ordering; filtering/folding must not resume it in the new one.
    effect(() => {
      this.layout();
      untracked(() => this.virtualizer.cancelScroll());
    });
    // The first draw of a tree (and a move of the leaf) scrolls to the current row.
    effect(() => {
      const tree = this.tree();
      if (this.lastLeaf === tree.leafRowId) return;
      this.lastLeaf = tree.leafRowId;
      queueMicrotask(() => this.scrollToLeaf());
    });
    // Keep the selection in view when it moves by keyboard.
    // (Only the selection triggers this: a refetch of the tree must not pull the list back to it.)
    effect(() => {
      const id = this.selectedId();
      if (!id) return;
      const index = untracked(() => this.layout().items.findIndex((i) => i.selectId === id));
      queueMicrotask(() => this.reveal(index));
    });
  }

  /** "Jump to current": centres the row that holds the leaf. */
  scrollToLeaf(): void {
    const index = this.layout().items.findIndex((i) => i.row.id === this.tree().leafRowId && !i.chevron);
    if (index < 0) return;
    this.virtualizer.scrollToIndex(index, { align: 'center' });
  }

  protected onPick(item: GraphItem): void {
    if (item.chevron) this.toggleGroup.emit(item.row.group ?? item.row.id);
    else if (item.selectId) this.pick.emit(item.selectId);
  }

  protected onActivate(item: GraphItem): void {
    if (item.selectId) this.activate.emit(item.selectId);
  }

  protected onHover(item: GraphItem, inside: boolean): void {
    this.hover.emit(inside && item.selectId && item.row.kind === 'turn' ? item.selectId : undefined);
  }

  protected onKey(event: KeyboardEvent): void {
    const items = this.layout().items;
    const current = Math.max(
      0,
      items.findIndex((i) => i.selectId !== undefined && i.selectId === this.selectedId()),
    );
    let next: number | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = stepSelection(items, current, 1);
        break;
      case 'ArrowUp':
        next = stepSelection(items, current, -1);
        break;
      case 'Home':
        next = edgeSelection(items, 1);
        break;
      case 'End':
        next = edgeSelection(items, -1);
        break;
      case 'Enter': {
        const item = items[current];
        if (item?.selectId) {
          event.preventDefault();
          this.activate.emit(item.selectId);
        }
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    const id = items[next]?.selectId;
    if (!id) return;
    this.pick.emit(id);
    // The selection may not have changed (End on the leaf after scrolling away): bring it into view anyway.
    queueMicrotask(() => this.reveal(next));
  }

  private reveal(index: number): void {
    if (index < 0) return;
    this.virtualizer.scrollToIndex(index, { align: 'auto' });
  }
}
