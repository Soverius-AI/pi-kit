import {
  afterNextRender,
  ChangeDetectorRef,
  computed,
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  inject,
  Injectable,
  input,
  NgZone,
  signal,
  untracked,
} from '@angular/core';
import type { Message } from '@ag-ui/client';
import { defaultRangeExtractor, injectVirtualizer } from '@tanstack/angular-virtual';

const ESTIMATED_ROW_HEIGHT = 120;
const OVERSCAN_ROWS = 8;
const DRAG_OVERSCAN = 200;
const MAX_LAYOUT_PASSES = 6;
const POSITION_TTL = 15 * 60_000;

interface Anchor {
  id: string;
  offset: number;
}

interface ReadingPosition {
  heights: Map<string, number>;
  width: number;
  top: number;
  pinned: boolean;
  anchor?: Anchor;
  visited: number;
}

interface ThumbDrag {
  height: number;
  scrollHeight: number;
}

/** Survives transcript recreation as well as switching the selected thread. */
@Injectable({ providedIn: 'root' })
export class TranscriptPositions {
  private readonly threads = new Map<string, ReadingPosition>();
  get(id: string | undefined): ReadingPosition | undefined {
    return id ? this.threads.get(id) : undefined;
  }
  save(id: string, position: ReadingPosition): void {
    this.threads.set(id, position);
    for (const [key, value] of this.threads)
      if (key !== id && Date.now() - value.visited > POSITION_TTL) this.threads.delete(key);
  }
}

/** Variable-height window inside CopilotKit's existing scroller. Layout and scroll corrections commit together. */
@Directive({
  selector: '[pkVirtualTranscript]',
  exportAs: 'pkVirtualTranscript',
  host: {
    class: 'pk-virtual-transcript',
    '[attr.data-virtual-total]': 'messages().length',
    '[style.height.px]': 'lockedHeight()',
    '[style.overflow]': "lockedHeight() === null ? null : 'clip'",
  },
})
export class VirtualTranscript {
  readonly messages = input.required<readonly Message[]>();
  readonly threadKey = input<string | undefined>();
  private readonly indexes = computed(() => new Map(this.messages().map((message, index) => [message.id, index])));
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly zone = inject(NgZone);
  private readonly changes = inject(ChangeDetectorRef);
  private readonly positions = inject(TranscriptPositions);
  /** Heights saved at this width by an earlier visit: the package's estimates until it measures a row itself. */
  private restoredSizes: ReadonlyMap<string, number> = new Map();
  private readonly scrollElement = signal<HTMLElement | undefined>(undefined);
  private reportOffset?: (offset: number, scrolling: boolean) => void;
  private reportRect?: (rect: { width: number; height: number }) => void;
  private readonly pendingSizes = new Map<string, number>();
  private readonly viewport = signal({ top: 0, height: 800, pinned: true });
  // Chromium calculates a thumb drag against this range. Do not resize it underneath the pointer.
  private readonly drag = signal<ThumbDrag | undefined>(undefined);
  protected readonly lockedHeight = computed(() => this.drag()?.height ?? null);
  private readonly renderedHeight = signal(0);
  private readonly coverage = signal<{ start?: number; end?: number }>({});
  private readonly virtualizer = injectVirtualizer<HTMLElement, HTMLElement>(() => {
    const messages = this.messages();
    const coverage = this.coverage();
    return {
      count: messages.length,
      scrollElement: this.scrollElement(),
      estimateSize: (index) => this.restoredSizes.get(messages[index].id) ?? ESTIMATED_ROW_HEIGHT,
      getItemKey: (index) => messages[index].id,
      overscan: OVERSCAN_ROWS,
      initialRect: { width: 0, height: 800 },
      useApplicationRefTick: false,
      // Reading anchors, Latest and a held native thumb own the physical scroll transaction below.
      scrollToFn: () => undefined,
      observeElementRect: (_instance, changed) => {
        this.reportRect = changed;
        changed({ width: this.scroller?.clientWidth ?? 0, height: this.viewport().height });
        return () => {
          if (this.reportRect === changed) this.reportRect = undefined;
        };
      },
      observeElementOffset: (instance, changed) => {
        this.reportOffset = changed;
        const view = this.viewport();
        changed(view.pinned ? Math.max(0, instance.getTotalSize() - view.height) : view.top, false);
        return () => {
          if (this.reportOffset === changed) this.reportOffset = undefined;
        };
      },
      rangeExtractor: (range) => {
        const indexes = defaultRangeExtractor(range);
        const start = Math.min(indexes[0] ?? 0, coverage.start ?? Infinity);
        const end = Math.max((indexes.at(-1) ?? -1) + 1, coverage.end ?? 0);
        return Array.from({ length: end - start }, (_, index) => start + index);
      },
      onChange: (_instance, synchronous) => (synchronous ? this.render() : this.schedule()),
    };
  });
  private readonly range = computed(() => {
    const items = this.virtualizer.getVirtualItems();
    return { start: items[0]?.index ?? 0, end: (items.at(-1)?.index ?? -1) + 1 };
  });
  readonly rows = computed(() =>
    this.messages()
      .slice(this.range().start, this.range().end)
      .map((message) => ({ id: message.id, messages: [message] })),
  );
  readonly before = computed(() => {
    const top = this.virtualizer.getVirtualItems()[0]?.start ?? 0;
    const drag = this.drag();
    if (!drag) return top;
    const lastStart = Math.max(0, drag.height - this.renderedHeight());
    return this.range().end === this.messages().length ? lastStart : Math.min(top, lastStart);
  });
  readonly after = computed(() => {
    const drag = this.drag();
    return drag
      ? Math.max(0, drag.height - this.before() - this.renderedHeight())
      : Math.max(0, this.virtualizer.getTotalSize() - (this.virtualizer.getVirtualItems().at(-1)?.end ?? 0));
  });
  private scroller: HTMLElement | null = null;
  private frame = 0;
  private releaseFrame = 0;
  private rendering = false;
  private activeKey: string | undefined;
  private restoring = true;
  private restoreAnchor: Anchor | undefined;
  private expectedScroll: number | undefined;

  constructor() {
    effect(() => {
      const key = this.threadKey();
      untracked(() => this.restoreThread(key));
    });
    effect(() => {
      this.messages();
      untracked(() => {
        this.schedule();
        // Inputs finish updating in this render; restore the reading position before paint.
        queueMicrotask(() => this.render());
      });
    });
    afterNextRender(() => this.attachScroller());
    inject(DestroyRef).onDestroy(() => {
      this.remember();
      cancelAnimationFrame(this.frame);
      cancelAnimationFrame(this.releaseFrame);
      this.cleanup?.();
    });
  }

  private cleanup?: () => void;

  private restoreThread(key: string | undefined): void {
    this.remember();
    this.activeKey = key;
    const saved = this.positions.get(key);
    this.restoredSizes =
      saved && (!this.scroller || saved.width === this.scroller.clientWidth) ? saved.heights : new Map();
    this.pendingSizes.clear();
    cancelAnimationFrame(this.releaseFrame);
    this.drag.set(undefined);
    this.coverage.set({});
    this.virtualizer.measure();
    this.restoring = true;
    this.restoreAnchor = saved?.anchor;
    this.expectedScroll = undefined;
    this.viewport.set({
      top: saved?.top ?? 0,
      height: this.scroller?.clientHeight || 800,
      pinned: saved?.pinned ?? true,
    });
    this.schedule();
  }

  private attachScroller(): void {
    const scroller = this.element.closest<HTMLElement>('[cdkscrollable]');
    if (!scroller) return;
    this.scroller = scroller;
    this.virtualizer().shouldAdjustScrollPositionOnItemSizeChange = () => false;
    this.scrollElement.set(scroller);
    // Browser anchoring must not apply a second correction after ours.
    const previousAnchor = scroller.style.overflowAnchor;
    scroller.style.overflowAnchor = 'none';
    let width = scroller.clientWidth;
    const resize = new ResizeObserver(() => {
      if (width !== scroller.clientWidth) {
        const anchor = this.readAnchor();
        width = scroller.clientWidth;
        this.restoredSizes = new Map();
        this.virtualizer.measure();
        this.setAnchor(anchor);
      }
      // ResizeObserver runs before paint: commit the new window in this delivery, not a later frame.
      this.zone.run(() => this.render());
    });
    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    const passive = { ...options, passive: true };
    this.zone.runOutsideAngular(() => {
      scroller.addEventListener('scroll', () => this.onScroll(scroller), passive);
      scroller.addEventListener(
        'wheel',
        (event) => {
          if (event.deltaY < 0) this.releaseEnd(scroller);
        },
        passive,
      );
      scroller.addEventListener('touchmove', () => this.releaseEnd(scroller), passive);
      scroller.addEventListener(
        'keydown',
        (event) => {
          if ((event.target as HTMLElement).closest('input, textarea, [contenteditable]')) return;
          if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey))
            this.releaseEnd(scroller);
        },
        options,
      );
      scroller.addEventListener('mousedown', (event) => this.beginDrag(event, scroller), options);
      document.addEventListener('mouseup', () => this.endDrag(), options);
      window.addEventListener('blur', () => this.endDrag(), options);
      resize.observe(scroller);
      // CopilotKit reserves composer/footer height here, outside the virtual rows.
      if (scroller.firstElementChild) resize.observe(scroller.firstElementChild);
    });
    this.element.addEventListener(
      'pk-reveal-message',
      (event) => {
        const id = (event as CustomEvent<{ id: string }>).detail?.id;
        const index = this.messages().findIndex((message) => message.id === id);
        if (index >= 0) this.navigate(this.startOf(index), false, scroller);
      },
      options,
    );
    this.element.addEventListener('pk-scroll-latest', () => this.navigate(0, true, scroller), options);
    this.cleanup = () => {
      listeners.abort();
      resize.disconnect();
      scroller.style.overflowAnchor = previousAnchor;
    };
    this.schedule();
  }

  private navigate(top: number, pinned: boolean, scroller: HTMLElement): void {
    this.restoring = false;
    this.restoreAnchor = undefined;
    this.coverage.set({});
    this.viewport.set({ top, height: scroller.clientHeight, pinned });
    this.render();
  }

  private onScroll(scroller: HTMLElement): void {
    if (this.restoring || this.rendering) return;
    const expected = this.expectedScroll;
    this.expectedScroll = undefined;
    if (expected !== undefined && Math.abs(scroller.scrollTop - expected) < 1) return;
    const top = scroller.scrollTop - this.hostOffset();
    const pinned = !this.drag() && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2;
    this.zone.run(() => {
      this.coverage.set({});
      this.viewport.set({ top, height: scroller.clientHeight, pinned });
      // Commit before paint; deferring a scroll event exposed a blank spacer on large jumps.
      this.render();
    });
  }

  private releaseEnd(scroller: HTMLElement): void {
    this.expectedScroll = undefined;
    // A pinned viewport derives its window from the end; capture the actual position before unpinning.
    this.viewport.set({ top: scroller.scrollTop - this.hostOffset(), height: scroller.clientHeight, pinned: false });
  }

  private beginDrag(event: MouseEvent, scroller: HTMLElement): void {
    if (event.button !== 0 || event.clientX < scroller.getBoundingClientRect().right - 16) return;
    cancelAnimationFrame(this.releaseFrame);
    this.releaseEnd(scroller);
    this.coverage.set({});
    this.drag.set({
      height: this.element.getBoundingClientRect().height,
      scrollHeight: scroller.scrollHeight,
    });
    this.render();
  }

  private endDrag(): void {
    if (!this.drag()) return;
    cancelAnimationFrame(this.releaseFrame);
    // Chromium finishes mouseup against the fixed rail before we restore the anchor on the updated range.
    this.releaseFrame = requestAnimationFrame(() => {
      this.releaseFrame = 0;
      if (!this.drag()) return;
      const anchor = this.readAnchor();
      this.drag.set(undefined);
      const indexes = this.indexes();
      for (const [id, height] of this.pendingSizes) {
        const index = indexes.get(id);
        if (index !== undefined) this.virtualizer.resizeItem(index, height);
      }
      this.pendingSizes.clear();
      this.coverage.set({});
      this.setAnchor(anchor);
      this.render();
    });
  }

  /** Row size changes settle together; a held thumb needs the fixed rail updated before paint. */
  measure(id: string, height: number): void {
    if (height <= 0 || (this.pendingSizes.get(id) ?? this.virtualizer.itemSizeCache.get(id)) === Math.ceil(height))
      return;
    // During a thumb drag even an asynchronously rendered tool must keep the rail fixed before paint.
    if (this.drag()) this.render();
    else this.schedule();
  }

  private hostOffset(): number {
    const scroller = this.scroller;
    if (!scroller) return 0;
    return this.element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  }

  private readAnchor(): Anchor | undefined {
    if (!this.scroller) return undefined;
    const top = this.scroller.getBoundingClientRect().top;
    for (const row of this.element.querySelectorAll<HTMLElement>('[data-virtual-row]')) {
      const box = row.getBoundingClientRect();
      if (box.bottom > top) return { id: row.dataset['virtualRow'] ?? '', offset: box.top - top };
    }
    return undefined;
  }

  private setAnchor(anchor: Anchor | undefined): void {
    if (!anchor || this.viewport().pinned) return;
    const index = this.messages().findIndex((message) => message.id === anchor.id);
    if (index >= 0) this.viewport.update((v) => ({ ...v, top: this.startOf(index) - anchor.offset }));
  }

  private remember(): void {
    if (!this.activeKey || !this.scroller || this.restoring) return;
    const heights = new Map(this.restoredSizes);
    for (const [key, height] of this.virtualizer.itemSizeCache) if (typeof key === 'string') heights.set(key, height);
    this.positions.save(this.activeKey, {
      heights,
      width: this.scroller.clientWidth,
      top: this.viewport().top,
      pinned: this.viewport().pinned,
      anchor: this.readAnchor(),
      visited: Date.now(),
    });
  }

  private render(): void {
    const scroller = this.scroller;
    if (!scroller || this.rendering || this.activeKey !== this.threadKey()) return;
    if (this.restoring) {
      if (!this.messages().length) return;
      this.setAnchor(this.restoreAnchor);
      this.restoring = false;
      this.restoreAnchor = undefined;
    }
    this.rendering = true;
    try {
      // A newly encountered short row may expose another row. Settle a bounded number before this frame paints.
      for (let pass = 0; pass < MAX_LAYOUT_PASSES; pass++) {
        this.updateWindow();
        this.changes.detectChanges();
        const measured = this.measureRows();
        const expanded = this.expandDragCoverage();
        if (!measured && !expanded) break;
      }
      this.updateWindow();
      this.changes.detectChanges();
      const drag = this.drag();
      if (drag) {
        const difference = drag.scrollHeight - scroller.scrollHeight;
        if (difference) {
          this.drag.set({ ...drag, height: Math.max(0, drag.height + difference) });
          this.changes.detectChanges();
        }
      }
      const desired = this.viewport().pinned ? scroller.scrollHeight : this.hostOffset() + this.viewport().top;
      if (Math.abs(scroller.scrollTop - desired) > 0.5) scroller.scrollTop = desired;
      this.expectedScroll = scroller.scrollTop;
      this.remember();
    } finally {
      this.rendering = false;
    }
  }

  private startOf(index: number): number {
    this.virtualizer.getTotalSize(); // settle package measurements before reading a row's coordinate
    return this.virtualizer.measurementsCache()[index]?.start ?? 0;
  }

  private updateWindow(): void {
    const viewport = this.viewport();
    const height = this.scroller?.clientHeight || viewport.height;
    this.reportRect?.({ width: this.scroller?.clientWidth ?? 0, height });
    const top = viewport.pinned ? Math.max(0, this.virtualizer.getTotalSize() - height) : viewport.top;
    this.reportOffset?.(top, false);
  }

  private measureRows(): boolean {
    const anchor = this.virtualizer.getVirtualItemForOffset(this.viewport().top);
    const oldAnchor = anchor?.start ?? 0;
    const indexes = this.indexes();
    // The package's size of a row is its measurement or, until then, the estimate it took from `restoredSizes`.
    const sizes = this.virtualizer.measurementsCache();
    let changed = false;
    let renderedHeight = 0;
    for (const row of this.element.querySelectorAll<HTMLElement>('[data-virtual-row]')) {
      const measured = row.getBoundingClientRect().height;
      if (measured <= 0) continue;
      const height = Math.max(1, Math.ceil(measured));
      renderedHeight += height;
      const id = row.dataset['virtualRow'];
      const index = id === undefined ? undefined : indexes.get(id);
      if (id === undefined || index === undefined) continue;
      if ((this.pendingSizes.get(id) ?? sizes[index]?.size) !== height) {
        if (this.drag()) this.pendingSizes.set(id, height);
        else this.virtualizer.resizeItem(index, height);
        changed = true;
      }
    }
    if (changed && anchor && !this.drag() && !this.viewport().pinned) {
      const difference = this.startOf(anchor.index) - oldAnchor;
      if (difference) this.viewport.update((view) => ({ ...view, top: view.top + difference }));
    }
    const dragHeightChanged = !!this.drag() && this.renderedHeight() !== renderedHeight;
    this.renderedHeight.set(renderedHeight);
    return changed || dragHeightChanged;
  }

  private expandDragCoverage(): boolean {
    const drag = this.drag();
    if (!drag) return false;
    const { start, end } = this.range();
    const viewport = this.viewport();
    const renderedHeight = this.renderedHeight();
    const below =
      Math.min(drag.height, viewport.top + viewport.height + DRAG_OVERSCAN) - this.before() - renderedHeight;
    const above = this.before() - viewport.top + DRAG_OVERSCAN;
    const deficit = Math.max(below, above);
    // Frozen estimates can underfill the viewport; size the next batch from the mounted rows' average height.
    const step = Math.max(8, Math.ceil(deficit / Math.max(16, renderedHeight / Math.max(1, end - start))));
    if (below > 0 && end < this.messages().length) {
      this.coverage.set({ start, end: Math.min(this.messages().length, end + step) });
      return true;
    }
    if (above > 0 && start > 0) {
      this.coverage.set({ start: Math.max(0, start - step), end });
      return true;
    }
    return false;
  }

  private schedule(): void {
    if (this.frame) return;
    this.zone.runOutsideAngular(() => {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.zone.run(() => this.render());
      });
    });
  }
}

/**
 * One rendered row of the virtual transcript: it tags its element with the message id and reports every change of its height to
 * `VirtualTranscript` through a `ResizeObserver` (outside the zone), so the offsets stay right as content streams in or folds.
 */
@Directive({
  selector: '[pkVirtualRow]',
  host: { class: 'pk-virtual-row', '[attr.data-virtual-row]': 'messageId()' },
})
export class VirtualRow {
  readonly messageId = input.required<string>();
  private readonly virtual = inject(VirtualTranscript);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  constructor() {
    const zone = inject(NgZone);
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.borderBoxSize[0]?.blockSize ?? this.element.getBoundingClientRect().height;
      this.virtual.measure(this.messageId(), height);
    });
    afterNextRender(() => zone.runOutsideAngular(() => observer.observe(this.element, { box: 'border-box' })));
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }
}
