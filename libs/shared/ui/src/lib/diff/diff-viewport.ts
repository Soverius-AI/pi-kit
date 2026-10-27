import {
  afterRenderEffect,
  ChangeDetectorRef,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { injectVirtualizer, observeElementOffset, type AngularVirtualizer } from '@tanstack/angular-virtual';
import type { ViewRow } from './diff-rows';

const VIRTUAL_THRESHOLD = 400;
const LINE_HEIGHT = 20;

/** TanStack owns the row window; this adapter measures split cells and comment cards as one logical row. */
export class DiffViewport {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly changes = inject(ChangeDetectorRef);
  private readonly scroller = signal<HTMLElement | undefined>(undefined);
  private readonly origin = signal(0);
  private readonly virtualizer: AngularVirtualizer<HTMLElement, HTMLElement>;
  private reportOffset?: (offset: number, scrolling: boolean) => void;
  private previousAnchor = '';
  private activeKey = '';
  private frame = 0;
  private rendering = false;
  private readonly observed = new Set<HTMLElement>();
  private observer?: ResizeObserver;

  readonly enabled: Signal<boolean>;
  readonly items: Signal<{ row: ViewRow; index: number }[]>;
  readonly before: Signal<number>;
  readonly after: Signal<number>;

  constructor(
    private readonly rows: Signal<ViewRow[]>,
    key: Signal<string>,
    private readonly compact: Signal<boolean>,
    private readonly onRender?: () => void,
  ) {
    this.enabled = computed(() => rows().length > VIRTUAL_THRESHOLD);
    this.virtualizer = injectVirtualizer<HTMLElement, HTMLElement>(() => {
      const current = rows();
      const identity = key();
      return {
        count: current.length,
        scrollElement: this.scroller(),
        enabled: this.enabled(),
        scrollMargin: this.origin(),
        // Matches the previous roughly 600 px buffer for ordinary 20 px code rows.
        overscan: 30,
        estimateSize: (index) => {
          const row = current[index];
          return row.kind === 'hunk' ? 24 : LINE_HEIGHT + row.comments.length * 100 + (row.draft ? 180 : 0);
        },
        getItemKey: (index) => `${identity}:${current[index].key}:${this.signature(current[index])}`,
        useApplicationRefTick: false,
        onChange: (_instance, synchronous) => (synchronous ? this.render() : this.schedule()),
        observeElementOffset: (instance, changed) => {
          this.reportOffset = changed;
          const stop = observeElementOffset(instance, changed);
          return () => {
            if (this.reportOffset === changed) this.reportOffset = undefined;
            stop?.();
          };
        },
      };
    });
    this.items = computed(() =>
      this.enabled()
        ? this.virtualizer.getVirtualItems().map(({ index }) => ({ row: rows()[index], index }))
        : rows().map((row, index) => ({ row, index })),
    );
    this.before = computed(() =>
      this.enabled() ? Math.max(0, (this.virtualizer.getVirtualItems()[0]?.start ?? this.origin()) - this.origin()) : 0,
    );
    this.after = computed(() =>
      this.enabled()
        ? Math.max(
            0,
            this.virtualizer.getTotalSize() -
              (this.virtualizer.getVirtualItems().at(-1)?.end ?? this.origin()) +
              this.origin(),
          )
        : 0,
    );
    afterRenderEffect(() => {
      const identity = key();
      rows();
      this.compact();
      untracked(() => {
        if (identity !== this.activeKey) {
          this.activeKey = identity;
          this.virtualizer.measure();
        }
        this.attach();
        this.schedule();
      });
    });
    inject(DestroyRef).onDestroy(() => {
      cancelAnimationFrame(this.frame);
      this.detach();
    });
  }

  private signature(row: ViewRow): string {
    if (row.kind === 'hunk') return row.header;
    if (!row.comments.length && !row.draft) return '';
    return (
      row.comments.map((comment) => `${comment.id}:${comment.text}`).join('\n') +
      (row.draft ? `:draft:${row.draft.id ?? ''}:${row.draft.line}:${row.draft.endLine ?? ''}` : '')
    );
  }

  private findScroller(): HTMLElement {
    let element: HTMLElement | null = this.compact() ? this.host : this.host.parentElement;
    while (element) {
      if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) return element;
      element = element.parentElement;
    }
    return this.host.ownerDocument.scrollingElement as HTMLElement;
  }

  /** Mount an offscreen result before the caller reveals the exact highlighted character. */
  reveal(row: number): void {
    if (!this.enabled()) return;
    this.attach();
    const scroller = this.scroller();
    const content = this.host.querySelector<HTMLElement>('[data-diff-content]');
    if (!scroller || !content) return;
    this.updateOrigin(scroller, content);
    this.virtualizer.scrollToIndex(row, { align: 'center' });
    // Search needs the target mounted in this call, before the browser dispatches its scroll event.
    this.reportOffset?.(scroller.scrollTop, false);
    this.render();
  }

  private attach(): void {
    const scroller = this.enabled() ? this.findScroller() : undefined;
    if (scroller === this.scroller()) return;
    this.detach();
    this.scroller.set(scroller);
    if (scroller) {
      this.observer ??= new ResizeObserver(() => this.schedule());
      for (const element of [scroller, this.host]) {
        this.observer.observe(element);
        this.observed.add(element);
      }
      this.previousAnchor = scroller.style.overflowAnchor;
      scroller.style.overflowAnchor = 'none';
    }
  }

  private detach(): void {
    const scroller = this.scroller();
    if (scroller) scroller.style.overflowAnchor = this.previousAnchor;
    this.scroller.set(undefined);
    this.observer?.disconnect();
    this.observed.clear();
  }

  private updateOrigin(scroller: HTMLElement, content: HTMLElement): void {
    this.origin.set(
      content.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        scroller.clientTop +
        scroller.scrollTop,
    );
  }

  private schedule(): void {
    if (!this.frame && this.enabled())
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.render();
      });
  }

  private render(): void {
    const scroller = this.scroller();
    const observer = this.observer;
    const content = this.host.querySelector<HTMLElement>('[data-diff-content]');
    if (!scroller || !content || !observer || this.rendering) return;
    // Hidden work groups must keep their useful measurements until they reopen.
    if (scroller.clientHeight === 0 || this.host.getBoundingClientRect().height === 0) return;
    this.rendering = true;
    try {
      this.updateOrigin(scroller, content);
      for (let pass = 0; pass < 3; pass++) {
        this.changes.detectChanges();
        const measured = new Map<number, { line: number; extra: number }>();
        for (const element of this.host.querySelectorAll<HTMLElement>('[data-diff-measure]')) {
          const index = Number(element.dataset['diffMeasure']);
          const height = element.getBoundingClientRect().height;
          const entry = measured.get(index) ?? { line: 0, extra: 0 };
          if (element.hasAttribute('data-diff-extra')) entry.extra += height;
          else entry.line = Math.max(entry.line, height);
          measured.set(index, entry);
        }
        const sizes = new Map(this.virtualizer.getVirtualItems().map((item) => [item.index, item.size]));
        let changed = false;
        for (const [index, measuredHeight] of measured) {
          const height = Math.max(1, Math.ceil(measuredHeight.line + measuredHeight.extra));
          if (height !== sizes.get(index)) {
            this.virtualizer.resizeItem(index, height);
            changed = true;
          }
        }
        if (!changed) break;
      }
      this.changes.detectChanges();
      this.onRender?.();
      const next = new Set([
        scroller,
        this.host,
        content,
        ...this.host.querySelectorAll<HTMLElement>('[data-diff-measure]'),
      ]);
      for (const element of this.observed)
        if (!next.has(element)) {
          observer.unobserve(element);
          this.observed.delete(element);
        }
      for (const element of next)
        if (!this.observed.has(element)) {
          observer.observe(element);
          this.observed.add(element);
        }
    } finally {
      this.rendering = false;
    }
  }
}
