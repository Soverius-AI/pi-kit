import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Directive,
  ElementRef,
  DestroyRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { PkIcon } from '@pi-kit/design-system';
import { diffTextParts, findInDiff, type FindSide, type DiffTextPart } from './diff-find';
import type { DiffModel, HunkLabel, HunkLabelEntry, ReviewComment } from '@pi-kit/protocol';
import { DiffViewport } from './diff-viewport';
import { diffTextWidth } from './diff-width';
import { type Anchor, type Draft, type DiffMode, type ViewRow, buildRows, snippetOf } from './diff-rows';

/** Puts the caret in the comment editor as it appears. */
@Directive({ selector: 'textarea[pkDiffFocus]' })
export class DiffFocus {
  readonly request = input<{ pending: boolean } | undefined>(undefined, { alias: 'pkDiffFocus' });
  constructor() {
    const el = inject<ElementRef<HTMLTextAreaElement>>(ElementRef).nativeElement;
    afterNextRender(() => {
      const request = this.request();
      if (request && !request.pending) return;
      if (request) request.pending = false;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }
}

/** What "Add to batch" hands to the parent: a new comment, or the new text of the one with `id`. */
export interface SavedComment extends Anchor {
  id?: string;
  text: string;
}

/**
 * The diff viewer (doc/docs/design-system.md, "Diff viewer"): a base-100 box with a header (path, origin and ±
 * counts, and actions projected as `[diffActions]`), then rows of comment gutter, old and new line numbers and code.
 * Unified or split. With `commentable` a `+` appears in the gutter on hover; a click opens the comment editor under the
 * row, and the rows a comment covers are tinted with its cards under the last of them. A comment can cover a range:
 * drag from one `+` to another, or click one and shift-click another, on the same side. `compact` is the variant
 * inside a transcript row: no header, no gutter, no border.
 *
 * It owns only what is on screen (which editor is open, the drag); the comments themselves belong to the parent,
 * which gets `saveComment` (new or changed) and `deleteComment`.
 */
@Component({
  selector: 'pk-diff',
  imports: [DiffFocus, NgTemplateOutlet, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-diff',
    tabindex: '-1',
    '[class.compact]': 'compact()',
    '[class.split]': "mode() === 'split'",
    '[class.selecting]': 'dragging()',
    '[attr.data-diff-total]': 'rows().length',
    '[attr.data-diff-virtual]': 'viewport.enabled()',
  },
  templateUrl: './diff-viewer.html',
})
export class PkDiffViewer {
  protected readonly i18n = inject(Language);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly changes = inject(ChangeDetectorRef);
  readonly model = input.required<DiffModel>();
  readonly mode = input<DiffMode>('unified');
  readonly commentable = input(false);
  readonly compact = input(false);
  /** The comments of this file. */
  readonly comments = input<readonly ReviewComment[]>([]);
  /** Muted text in the header ("edited in turn 8"). */
  readonly subtitle = input<string | undefined>(undefined);

  /** Labels of the hunks by hunk id (the Meat Proxy Score): each hunk header shows its label, what it traces to and a control to relabel it. None: plain hunks. */
  readonly marks = input<Readonly<Record<string, HunkLabelEntry>>>({});
  protected readonly labelOptions: readonly HunkLabel[] = ['specified', 'corrected', 'autonomous', 'manual'];

  readonly saveComment = output<SavedComment>();
  /** The person chose another label for a hunk; `label: null` takes their earlier correction back. */
  readonly relabel = output<{ hunk: string; label: HunkLabel | null }>();
  readonly deleteComment = output<string>();

  protected readonly draft = signal<Draft | null>(null);
  protected readonly rows = computed<ViewRow[]>(() =>
    buildRows(this.model(), this.mode(), this.comments(), this.draft()),
  );
  protected readonly viewport = new DiffViewport(
    this.rows,
    computed(() => `${this.model().path}:${this.mode()}`),
    this.compact,
    () => this.ensureSplitWidth(),
  );
  protected readonly findOpen = signal(false);
  protected readonly findQuery = signal('');
  protected readonly matchCase = signal(false);
  private readonly matchPosition = signal(0);
  protected readonly findIndex = computed(() =>
    findInDiff(this.rows(), this.findOpen() ? this.findQuery() : '', this.matchCase()),
  );
  protected readonly activeNumber = computed(() =>
    this.findIndex().matches.length ? Math.min(this.matchPosition(), this.findIndex().matches.length - 1) + 1 : 0,
  );
  protected readonly activeMatch = computed(() => this.findIndex().matches[this.activeNumber() - 1]);
  private readonly findField = viewChild<ElementRef<HTMLInputElement>>('findField');
  private focusFind = false;
  protected focusRequest = { pending: false };
  private typedDraftText: string | undefined;
  protected editorText(draft: Draft): string {
    return this.typedDraftText ?? draft.text ?? '';
  }
  protected rememberText(text: string): void {
    this.typedDraftText = text;
  }
  private readonly splitBody = viewChild<ElementRef<HTMLElement>>('splitBody');
  /** Ignore the scroll event caused by copying an offset to the other pane. */
  private readonly copiedScroll = new WeakMap<HTMLElement, number>();

  constructor() {
    const host = this.host;
    const findShortcut = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== 'f'
      )
        return;
      const target = event.target;
      if (!(target instanceof Node) || !host.getBoundingClientRect().height) return;
      const scope = this.compact() ? host : (host.closest('pk-review-view')?.closest('main') ?? host);
      if (!scope.contains(target) && !(target === host.ownerDocument.body && !this.compact())) return;
      event.preventDefault();
      event.stopPropagation();
      this.openFind();
    };
    window.addEventListener('keydown', findShortcut, { capture: true });
    afterRenderEffect(() => {
      const field = this.findField()?.nativeElement;
      if (field && this.focusFind) {
        this.focusFind = false;
        field.focus({ preventScroll: true });
        field.select();
      }
    });
    // Scrolling and ordinary row hover must not check every binding in a large diff.
    // Native listeners avoid Angular template event checks; signals notify the zoneless view during a drag.
    const hover = (event: PointerEvent): void => {
      if (!this.dragging()) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const line = target.closest<HTMLElement>('[data-diff-row]');
      if (!line || !host.contains(line) || (event.relatedTarget instanceof Node && line.contains(event.relatedTarget)))
        return;
      const item = this.rows()[Number(line.dataset['diffRow'])];
      const anchor =
        item?.kind === 'unified'
          ? item.anchor
          : item?.kind === 'split'
            ? line.dataset['diffSide'] === 'old'
              ? item.left?.anchor
              : item.right?.anchor
            : undefined;
      if (anchor) this.extendTo(anchor);
    };
    const scroll = (event: Event): void => {
      if (event.target instanceof HTMLElement && event.target.classList.contains('split-pane')) this.syncScroll(event);
    };
    const end = (): void => {
      if (this.dragging()) this.endDrag();
    };
    host.addEventListener('pointerover', hover, { passive: true });
    host.addEventListener('scroll', scroll, { capture: true, passive: true });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('keydown', findShortcut, true);
      host.removeEventListener('pointerover', hover);
      host.removeEventListener('scroll', scroll, true);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    });
    afterRenderEffect((onCleanup) => {
      // Comment edits and pane resizing do not change intrinsic code widths.
      const model = this.model();
      const compact = this.compact();
      const virtual = this.viewport.enabled();
      const body = this.splitBody()?.nativeElement;
      if (!body && !virtual) return;
      // Both panes need the same scrollable width, even if one side has shorter lines.
      // Measure intrinsic code widths; the bounded panes themselves never grow with the code.
      const measure = (): void => {
        if (virtual) {
          const context = host.ownerDocument.createElement('canvas').getContext('2d');
          if (!context) return;
          context.font = getComputedStyle(host).font;
          const space = context.measureText(' ').width;
          let width = 0;
          for (const hunk of model.hunks)
            for (const line of hunk.lines)
              width = Math.max(
                width,
                diffTextWidth(line.text, (text) => context.measureText(text).width, space),
              );
          host.style.setProperty('--pk-diff-code-width', `${Math.ceil(width) + 20}px`);
          host.style.setProperty('--pk-diff-gutter', `${compact ? 80 : 116}px`);
          host.style.setProperty('--pk-split-width', `${Math.ceil(width) + 92}px`);
          return;
        }
        if (!body) return;
        const code = body.querySelectorAll<HTMLElement>('.h .c');
        let width = 0;
        for (const cell of code) {
          const line = cell.parentElement;
          if (line) width = Math.max(width, cell.getBoundingClientRect().right - line.getBoundingClientRect().left);
        }
        host.style.setProperty('--pk-split-width', `${Math.ceil(width)}px`);
      };
      measure();
      const fonts = host.ownerDocument.fonts;
      fonts?.addEventListener('loadingdone', measure);
      onCleanup(() => {
        fonts?.removeEventListener('loadingdone', measure);
      });
    });
  }

  protected openFind(): void {
    this.focusFind = true;
    this.findOpen.set(true);
    const field = this.findField()?.nativeElement;
    if (field) {
      this.focusFind = false;
      field.focus({ preventScroll: true });
      field.select();
    }
  }

  protected closeFind(): void {
    this.findOpen.set(false);
    this.host.focus({ preventScroll: true });
  }

  protected search(query: string): void {
    this.findQuery.set(query);
    this.matchPosition.set(0);
    this.revealMatch();
  }

  protected toggleMatchCase(): void {
    this.matchCase.update((value) => !value);
    this.matchPosition.set(0);
    this.revealMatch();
  }

  protected findKey(event: Event): void {
    const key = event as KeyboardEvent;
    if (key.key !== 'Enter') return;
    key.preventDefault();
    key.stopPropagation();
    this.nextMatch(key.shiftKey ? -1 : 1);
  }

  protected nextMatch(direction: number): void {
    const count = this.findIndex().matches.length;
    if (!count) return;
    this.matchPosition.set((this.activeNumber() - 1 + direction + count) % count);
    this.revealMatch();
  }

  protected codeParts(text: string, row: number, side: FindSide): DiffTextPart[] {
    return diffTextParts(text, this.findIndex().byCell.get(`${row}:${side}`), this.activeMatch());
  }

  private revealMatch(): void {
    this.changes.detectChanges();
    const match = this.activeMatch();
    if (!match) return;
    this.viewport.reveal(match.row);
    this.host
      .querySelector<HTMLElement>('[data-find-current]')
      ?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }

  /** Inline highlights can round text runs a few pixels wider than the canvas estimate. */
  private ensureSplitWidth(): void {
    const panes = this.splitBody()?.nativeElement.querySelectorAll<HTMLElement>('.split-pane');
    if (!panes?.length) return;
    let width = Number.parseFloat(this.host.style.getPropertyValue('--pk-split-width')) || 0;
    const previous = width;
    for (const pane of panes) if (pane.scrollWidth > pane.clientWidth) width = Math.max(width, pane.scrollWidth);
    if (width > previous) this.host.style.setProperty('--pk-split-width', `${width}px`);
  }

  protected syncScroll(event: Event): void {
    const source = event.target as HTMLElement;
    const copied = this.copiedScroll.get(source);
    this.copiedScroll.delete(source);
    if (copied === source.scrollLeft) return;
    for (const pane of source.parentElement?.querySelectorAll<HTMLElement>('.split-pane') ?? []) {
      if (pane === source || pane.scrollLeft === source.scrollLeft) continue;
      pane.scrollLeft = source.scrollLeft;
      this.copiedScroll.set(pane, pane.scrollLeft);
    }
  }

  /** A drag from one `+` is on: the pointer entering other rows extends the editor's range. */
  protected readonly dragging = signal(false);
  /** Where the range was started (the drag's or the shift-click's first line), so it can grow upwards as well as downwards. */
  private origin: Anchor | null = null;

  protected labelText(label: HunkLabel): string {
    return this.i18n.t(`shared.diffViewer.label.${label}`);
  }

  protected markTitle(mark: HunkLabelEntry): string {
    return `${mark.by === 'person' ? this.i18n.t('shared.diffViewer.youSaid', { value1: this.labelText(mark.label), value2: mark.was ? this.i18n.t('shared.diffViewer.was', { value1: this.labelText(mark.was) }) : '' }) : this.i18n.t('shared.diffViewer.by', { value1: this.labelText(mark.label), value2: mark.by === 'ledger' ? this.i18n.t('shared.diffViewer.aRuleOfTheLedger') : mark.by === 'default' ? this.i18n.t('shared.diffViewer.default') : this.i18n.t('shared.diffViewer.theModel') })}: ${mark.trace}`;
  }

  protected relabelTo(hunk: string, mark: HunkLabelEntry, event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = select.value;
    select.value = '';
    if (value === 'reset') this.relabel.emit({ hunk, label: null });
    else if (value && value !== mark.label) this.relabel.emit({ hunk, label: value as HunkLabel });
  }

  protected gutterTitle(count: number, editing: boolean): string {
    if (editing) return this.i18n.t('shared.diffViewer.writingAComment');
    return count > 0
      ? `${count} ${count === 1 ? this.i18n.t('common.words.comment') : this.i18n.t('common.words.comments')}`
      : this.i18n.t('shared.diffViewer.commentOnThisLineOrDragTo');
  }

  protected hasOn(item: ViewRow, side: 'old' | 'new'): boolean {
    if (item.kind !== 'split') return false;
    return item.comments.some((c) => c.side === side) || (!!item.draft && item.draft.side === side);
  }

  protected rangeLabel(draft: Draft): string {
    return draft.endLine !== undefined && draft.endLine > draft.line
      ? this.i18n.t('shared.diffViewer.lineRange', { value1: draft.line, value2: draft.endLine })
      : this.i18n.t('shared.diffViewer.line', { value1: draft.line });
  }

  /** A click on `+`: a new editor on that line, or (shift, with a fresh editor open on the same side) the other end of its range. */
  protected open(anchor: Anchor, event?: MouseEvent): void {
    const current = this.draft();
    if (event?.shiftKey && current && !current.id && current.side === anchor.side) {
      this.draft.set(this.spanning(this.origin ?? current, anchor, this.typedDraftText ?? current.text));
      return;
    }
    // A second comment on a line that has one is a new comment; the first keeps its Edit link.
    this.origin = anchor;
    this.typedDraftText = undefined;
    this.focusRequest = { pending: true };
    this.draft.set({ ...anchor });
  }

  protected startDrag(anchor: Anchor, event: PointerEvent): void {
    if (event.button !== 0 || event.shiftKey) return;
    this.origin = anchor;
    this.dragging.set(true);
  }

  /** While dragging, the editor covers everything between the origin and the row under the pointer (same side only). */
  protected extendTo(anchor: Anchor): void {
    if (!this.dragging() || !this.origin || this.origin.side !== anchor.side) return;
    const current = this.draft();
    if (current?.id) return;
    if (!current) this.focusRequest = { pending: true };
    this.draft.set(this.spanning(this.origin, anchor, this.typedDraftText ?? current?.text));
  }

  protected endDrag(): void {
    if (this.dragging()) this.dragging.set(false);
  }

  private spanning(a: Anchor, b: Anchor, text: string | undefined): Draft {
    const line = Math.min(a.line, b.line);
    const endLine = Math.max(a.line, b.line);
    const snippet =
      line === endLine ? (a.line === line ? a.snippet : b.snippet) : snippetOf(this.model(), a.side, line, endLine);
    return {
      side: a.side,
      line,
      ...(endLine > line ? { endLine } : {}),
      snippet,
      ...(text !== undefined ? { text } : {}),
    };
  }

  protected edit(comment: ReviewComment): void {
    this.origin = null;
    this.typedDraftText = comment.text;
    this.focusRequest = { pending: true };
    this.draft.set({
      side: comment.side,
      line: comment.line,
      ...(comment.endLine !== undefined ? { endLine: comment.endLine } : {}),
      snippet: comment.snippet,
      id: comment.id,
      text: comment.text,
    });
  }

  protected cancel(): void {
    this.typedDraftText = undefined;
    this.draft.set(null);
  }

  protected save(text: string): void {
    const draft = this.draft();
    const trimmed = text.trim();
    if (!draft || !trimmed) return;
    this.saveComment.emit({
      side: draft.side,
      line: draft.line,
      ...(draft.endLine !== undefined ? { endLine: draft.endLine } : {}),
      snippet: draft.snippet,
      text: trimmed,
      ...(draft.id ? { id: draft.id } : {}),
    });
    this.draft.set(null);
    this.typedDraftText = undefined;
    this.origin = null;
  }
}
