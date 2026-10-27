import { Overlay, type ConnectedPosition, type OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Directive,
  ElementRef,
  inject,
  InjectionToken,
  input,
  signal,
  type ComponentRef,
} from '@angular/core';

/** The wait before a tooltip appears: long enough that moving across a row of icon buttons shows none. */
export const TIP_DELAY_MS = 400;
/** The fade, in and out; the bubble is removed once it has finished. */
export const TIP_FADE_MS = 120;

/** Room between the button and the bubble: the arrow sits in it. */
const GAP = 8;

/**
 * Where the bubble goes, in the order the overlay tries them: above and centred, below and centred, then aligned to the edge of the button that is
 * nearer the middle of the screen (above, then below), so a button at the far right of the settings window gets a bubble that ends where it ends.
 */
export const TIP_POSITIONS: ConnectedPosition[] = [
  { originX: 'center', originY: 'top', overlayX: 'center', overlayY: 'bottom', offsetY: -GAP },
  { originX: 'center', originY: 'bottom', overlayX: 'center', overlayY: 'top', offsetY: GAP },
  { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -GAP },
  { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: GAP },
  { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -GAP },
  { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: GAP },
];

/** Application defaults with per-directive delay still available as an input. */
export interface TooltipDefaults {
  readonly delayMs: number;
  readonly positions: ConnectedPosition[];
}
export const PK_TOOLTIP_DEFAULTS = new InjectionToken<TooltipDefaults>('PK_TOOLTIP_DEFAULTS', {
  providedIn: 'root',
  factory: () => ({ delayMs: TIP_DELAY_MS, positions: TIP_POSITIONS }),
});

/** Which side of the button the bubble ended up on, from the position the overlay chose. */
export function tipSide(pair: Pick<ConnectedPosition, 'overlayY'>): 'top' | 'bottom' {
  return pair.overlayY === 'bottom' ? 'top' : 'bottom';
}

/** A pointer that is a finger never shows a tooltip: there is no hover, and a long press belongs to the system. */
export function isTouch(event: Event | undefined): boolean {
  return (event as PointerEvent | undefined)?.pointerType === 'touch';
}

let nextId = 0;

/** The bubble: base-content on base-100 text, 12px, an arrow that points at the middle of the button wherever the bubble was pushed to. */
@Component({
  selector: 'pk-tip-bubble',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-tt',
    role: 'tooltip',
    '[id]': 'id()',
    '[attr.data-side]': 'side()',
    '[class.show]': 'shown()',
    '[style.--pk-tt-ax.px]': 'arrowX()',
  },
  template: `{{ text() }}<i class="arrow" aria-hidden="true"></i>`,
})
export class PkTipBubble {
  readonly text = signal('');
  readonly id = signal('');
  readonly side = signal<'top' | 'bottom'>('top');
  readonly shown = signal(false);
  /** The arrow's distance from the bubble's left edge, in px. */
  readonly arrowX = signal<number | null>(null);
}

/**
 * The tooltip (doc/docs/design-system.md "Tooltips"): `<button [pkTip]="'Sign out'">`. It replaces the native `title=` attribute, which shows
 * late, cannot be styled, and is not shown on keyboard focus. The bubble is rendered through the CDK overlay, so a group's `overflow: hidden` cannot cut it.
 *
 * - 400 ms after the pointer enters (or after the button takes keyboard focus; a button focused by a click does not show one), a 120 ms fade.
 * - Above the button by default, below it when there is no room above, aligned to the button's edge when it is too close to the side of the window.
 * - Escape hides it (and only it: the first Escape does not close the dialog behind it); so do a click, a key press on the button and leaving.
 * - Never for a touch pointer.
 * - `aria-describedby` points at the bubble while it is shown. An icon-only button still needs its own `aria-label`: the bubble is a description.
 *
 * A disabled button gets no pointer events in some browsers; put the directive on a wrapper around it to keep its reason as the tip.
 */
@Directive({
  selector: '[pkTip]',
  host: {
    '(pointerenter)': 'onEnter($event)',
    '(pointerleave)': 'hide()',
    '(pointerdown)': 'hide()',
    '(focus)': 'onFocus()',
    '(blur)': 'hide()',
    '(keydown)': 'onKey($event)',
  },
})
export class PkTip {
  private readonly defaults = inject(PK_TOOLTIP_DEFAULTS);
  /** The text; empty or missing means no tooltip. */
  readonly text = input<string | null | undefined>('', { alias: 'pkTip' });
  /** Where to wait before showing (the design system's 400 ms; a spec shortens it). */
  readonly delay = input(this.defaults.delayMs, { alias: 'pkTipDelay' });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly overlay = inject(Overlay);
  private ref: OverlayRef | undefined;
  private bubble: ComponentRef<PkTipBubble> | undefined;
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private removeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly describedBefore: string | null;
  private readonly escape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    this.hide();
  };

  constructor() {
    this.describedBefore = this.host.nativeElement.getAttribute('aria-describedby');
    inject(DestroyRef).onDestroy(() => this.dispose());
  }

  protected onEnter(event: Event): void {
    if (isTouch(event)) return;
    this.schedule();
  }

  protected onFocus(): void {
    if (!this.focusVisible()) return;
    this.schedule();
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' && event.key !== 'Tab') this.hide();
  }

  /** True for a keyboard focus; a focus the pointer caused is not announced twice. Browsers that do not know the selector get the tooltip. */
  private focusVisible(): boolean {
    try {
      return this.host.nativeElement.matches(':focus-visible');
    } catch {
      return true;
    }
  }

  private schedule(): void {
    if (!this.text()) return;
    clearTimeout(this.removeTimer);
    clearTimeout(this.showTimer);
    if (this.bubble) return this.reveal();
    this.showTimer = setTimeout(() => this.show(), this.delay());
  }

  private show(): void {
    const text = this.text();
    if (!text) return;
    this.dispose();
    const origin = this.host.nativeElement;
    const strategy = this.overlay
      .position()
      .flexibleConnectedTo(origin)
      .withPositions(this.defaults.positions)
      .withPush(true)
      .withViewportMargin(8)
      .withFlexibleDimensions(false);
    this.ref = this.overlay.create({
      positionStrategy: strategy,
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      panelClass: 'pk-tt-pane',
    });
    this.bubble = this.ref.attach(new ComponentPortal(PkTipBubble));
    const id = `pk-tt-${++nextId}`;
    this.bubble.instance.text.set(text);
    this.bubble.instance.id.set(id);
    // Position a rendered bubble, not the empty portal that was just attached.
    this.bubble.changeDetectorRef.detectChanges();
    strategy.positionChanges.subscribe((change) => {
      const bubble = this.bubble?.instance;
      if (!bubble) return;
      bubble.side.set(tipSide(change.connectionPair));
      // The arrow points at the middle of the button, which is not the middle of the bubble when it was aligned to an edge.
      queueMicrotask(() => this.positionArrow());
    });
    origin.setAttribute('aria-describedby', [this.describedBefore, id].filter(Boolean).join(' '));
    this.ref.updatePosition();
    // The class is added one frame after the element exists, so the opacity has something to move from.
    this.reveal();
  }

  private reveal(): void {
    const bubble = this.bubble;
    if (!bubble) return;
    // Escape belongs to the tooltip only while it is on its way in or shown; a second one during the fade goes where it was meant to.
    document.removeEventListener('keydown', this.escape, true);
    document.addEventListener('keydown', this.escape, true);
    const on = (): void => {
      if (this.bubble !== bubble) return;
      this.ref?.updatePosition();
      this.positionArrow();
      bubble.instance.shown.set(true);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(on);
    else on();
  }

  private positionArrow(): void {
    const box = (this.bubble?.location.nativeElement as HTMLElement | undefined)?.getBoundingClientRect();
    const button = this.host.nativeElement.getBoundingClientRect();
    // The triangle is 10px wide. Allow its centre within 5px of the edge so a
    // viewport-pushed bubble still points at a trigger near the window border.
    if (box && box.width > 0)
      this.bubble?.instance.arrowX.set(Math.max(5, Math.min(box.width - 5, button.left + button.width / 2 - box.left)));
  }

  /** Fades out and removes the bubble; a pending show is cancelled. */
  hide(): void {
    clearTimeout(this.showTimer);
    if (!this.bubble) return;
    this.bubble.instance.shown.set(false);
    document.removeEventListener('keydown', this.escape, true);
    clearTimeout(this.removeTimer);
    this.removeTimer = setTimeout(() => this.dispose(), TIP_FADE_MS);
  }

  private restoreDescribedBy(): void {
    const el = this.host.nativeElement;
    if (this.describedBefore) el.setAttribute('aria-describedby', this.describedBefore);
    else el.removeAttribute('aria-describedby');
  }

  private dispose(): void {
    clearTimeout(this.showTimer);
    clearTimeout(this.removeTimer);
    document.removeEventListener('keydown', this.escape, true);
    if (this.ref) {
      this.restoreDescribedBy();
      this.ref.dispose();
    }
    this.ref = undefined;
    this.bubble = undefined;
  }
}
