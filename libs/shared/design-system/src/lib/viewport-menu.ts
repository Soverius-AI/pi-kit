import { DestroyRef, Directive, ElementRef, inject } from '@angular/core';

const MARGIN = 8;

/** Keep details menus in the browser's top layer, outside scroll-container clipping. */
@Directive({
  selector: 'details[pkViewportMenu]',
  host: { '(toggle)': 'toggle()' },
})
export class PkViewportMenu {
  private readonly details = inject<ElementRef<HTMLDetailsElement>>(ElementRef).nativeElement;
  private menu: HTMLElement | undefined;
  private observer: ResizeObserver | undefined;
  private placeholder: Comment | undefined;
  private nativePopover = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cleanup());
  }

  protected toggle(): void {
    if (!this.details.open) return this.cleanup();
    if (this.menu) return;
    const menu = this.details.querySelector<HTMLElement>('.dropdown-content');
    if (!menu) return;
    this.menu = menu;
    menu.classList.add('pk-viewport-menu');
    try {
      if (typeof menu.showPopover !== 'function' || typeof menu.hidePopover !== 'function')
        throw new Error('Popover unavailable');
      menu.setAttribute('popover', 'manual');
      menu.showPopover();
      this.nativePopover = true;
    } catch {
      menu.removeAttribute('popover');
      this.placeholder = document.createComment('viewport menu');
      menu.before(this.placeholder);
      document.body.append(menu);
      menu.classList.add('pk-viewport-menu-fallback');
    }
    this.place();
    document.addEventListener('pointerdown', this.outside, true);
    document.addEventListener('keydown', this.keydown, true);
    document.addEventListener('scroll', this.place, true);
    window.addEventListener('resize', this.place);
    window.visualViewport?.addEventListener('resize', this.place);
    window.visualViewport?.addEventListener('scroll', this.place);
    // Capture because action handlers often stop propagation. The microtask
    // closes after the action has read its trigger and opened any dialog.
    menu.addEventListener('click', this.choose, true);
    this.observer = new ResizeObserver(this.place);
    this.observer.observe(menu);
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  private readonly place = (): void => {
    const menu = this.menu;
    const trigger = this.details.querySelector('summary');
    if (!menu || !trigger) return;
    const viewport = window.visualViewport;
    const shell = document.querySelector('.pk-shell');
    const safe = shell ? getComputedStyle(shell) : undefined;
    const left = (viewport?.offsetLeft ?? 0) + Math.max(MARGIN, parseFloat(safe?.paddingLeft ?? '') || 0);
    const topEdge = (viewport?.offsetTop ?? 0) + Math.max(MARGIN, parseFloat(safe?.paddingTop ?? '') || 0);
    const right =
      (viewport?.offsetLeft ?? 0) +
      (viewport?.width ?? window.innerWidth) -
      Math.max(MARGIN, parseFloat(safe?.paddingRight ?? '') || 0);
    const bottom =
      (viewport?.offsetTop ?? 0) +
      (viewport?.height ?? window.innerHeight) -
      Math.max(MARGIN, parseFloat(safe?.paddingBottom ?? '') || 0);
    menu.style.maxWidth = `${Math.max(0, right - left)}px`;
    menu.style.maxHeight = `${Math.max(0, bottom - topEdge)}px`;
    const anchor = trigger.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const preferredLeft = this.details.classList.contains('dropdown-end') ? anchor.right - box.width : anchor.left;
    const below = anchor.bottom + 4;
    const top = below + box.height <= bottom ? below : anchor.top - box.height - 4;
    menu.style.left = `${Math.max(left, Math.min(preferredLeft, right - box.width))}px`;
    menu.style.top = `${Math.max(topEdge, Math.min(top, bottom - box.height))}px`;
  };

  private readonly outside = (event: Event): void => {
    const path = event.composedPath();
    if (!path.includes(this.details) && (!this.menu || !path.includes(this.menu))) this.close();
  };

  private readonly choose = (event: Event): void => {
    if ((event.target as HTMLElement).closest('button:not(:disabled), a[href]')) queueMicrotask(() => this.close());
  };

  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      this.details.querySelector<HTMLElement>('summary')?.focus();
    }
  };

  private close(): void {
    this.details.open = false;
    this.cleanup();
  }

  private cleanup(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    document.removeEventListener('pointerdown', this.outside, true);
    document.removeEventListener('keydown', this.keydown, true);
    document.removeEventListener('scroll', this.place, true);
    window.removeEventListener('resize', this.place);
    window.visualViewport?.removeEventListener('resize', this.place);
    window.visualViewport?.removeEventListener('scroll', this.place);
    if (this.menu) {
      this.menu.removeEventListener('click', this.choose, true);
      if (this.nativePopover) {
        try {
          this.menu.hidePopover();
        } catch {
          /* Safari may already have removed it from the top layer. */
        }
      }
      this.nativePopover = false;
      this.placeholder?.replaceWith(this.menu);
      this.placeholder = undefined;
      this.menu.classList.remove('pk-viewport-menu-fallback');
      this.menu.removeAttribute('popover');
      this.menu.classList.remove('pk-viewport-menu');
      this.menu.style.removeProperty('left');
      this.menu.style.removeProperty('top');
      this.menu.style.removeProperty('max-width');
      this.menu.style.removeProperty('max-height');
      this.menu = undefined;
    }
  }
}
