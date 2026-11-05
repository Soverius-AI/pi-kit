import { CdkConnectedOverlay } from '@angular/cdk/overlay';
import { afterNextRender, DestroyRef, Directive, ElementRef, inject } from '@angular/core';

/** CDK uses the layout viewport; iOS's keyboard and notch narrow the visual one. */
@Directive({ selector: '[pkSafeOverlay]' })
export class PkSafeOverlay {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly connected = inject(CdkConnectedOverlay, { optional: true });
  private frame: number | undefined;
  private observer: ResizeObserver | undefined;
  private original: { maxWidth: string; maxHeight: string; overflow: string; translate: string } | undefined;

  constructor() {
    afterNextRender(() => {
      const style = this.element.style;
      this.original = {
        maxWidth: style.maxWidth,
        maxHeight: style.maxHeight,
        overflow: style.overflow,
        translate: style.translate,
      };
      this.place();
      window.visualViewport?.addEventListener('resize', this.schedule);
      window.visualViewport?.addEventListener('scroll', this.schedule);
      window.addEventListener('resize', this.schedule);
      if (typeof ResizeObserver === 'function') {
        this.observer = new ResizeObserver(this.schedule);
        this.observer.observe(this.element);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      this.observer?.disconnect();
      window.visualViewport?.removeEventListener('resize', this.schedule);
      window.visualViewport?.removeEventListener('scroll', this.schedule);
      window.removeEventListener('resize', this.schedule);
      if (this.original) Object.assign(this.element.style, this.original);
    });
  }

  private readonly schedule = (): void => {
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.place();
    });
  };

  private place(): void {
    const viewport = window.visualViewport;
    if (viewport && viewport.scale !== 1) return; // Never fight the user's pinch zoom.
    if ((viewport?.width ?? innerWidth) > 767 && !navigator.maxTouchPoints) {
      if (this.original) Object.assign(this.element.style, this.original);
      this.element.style.removeProperty('--pk-overlay-height');
      return;
    }
    // Box coordinates are relative to the layout viewport, which iOS may scroll for the keyboard while also reporting that scroll as offsetTop.
    const offsetLeft = viewport ? viewport.pageLeft - scrollX : 0;
    const offsetTop = viewport ? viewport.pageTop - scrollY : 0;
    const shell = document.querySelector('.pk-shell');
    const safe = shell ? getComputedStyle(shell) : undefined;
    const left = offsetLeft + Math.max(16, parseFloat(safe?.paddingLeft ?? '') || 0);
    const right =
      offsetLeft + (viewport?.width ?? innerWidth) - Math.max(16, parseFloat(safe?.paddingRight ?? '') || 0);
    const top = offsetTop + Math.max(16, parseFloat(safe?.paddingTop ?? '') || 0);
    const bottom =
      offsetTop + (viewport?.height ?? innerHeight) - Math.max(16, parseFloat(safe?.paddingBottom ?? '') || 0);
    const style = this.element.style;
    style.translate = this.original?.translate ?? '';
    style.maxWidth = `${Math.max(0, right - left)}px`;
    style.maxHeight = `${Math.max(0, Math.min(560, bottom - top))}px`;
    style.setProperty('--pk-overlay-height', style.maxHeight);
    style.overflow = 'auto';
    this.connected?.overlayRef?.updatePosition();
    const box = this.element.getBoundingClientRect();
    const x = box.left < left ? left - box.left : box.right > right ? right - box.right : 0;
    const y = box.top < top ? top - box.top : box.bottom > bottom ? bottom - box.bottom : 0;
    if (x || y) style.translate = `${x}px ${y}px`;
  }
}
