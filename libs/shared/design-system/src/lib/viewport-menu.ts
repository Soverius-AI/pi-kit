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
    menu.setAttribute('popover', 'manual');
    menu.showPopover();
    this.place();
    document.addEventListener('pointerdown', this.outside, true);
    document.addEventListener('keydown', this.keydown, true);
    document.addEventListener('scroll', this.place, true);
    window.addEventListener('resize', this.place);
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
    const anchor = trigger.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const preferredLeft = this.details.classList.contains('dropdown-end') ? anchor.right - box.width : anchor.left;
    const below = anchor.bottom + 4;
    const top = below + box.height <= window.innerHeight - MARGIN ? below : anchor.top - box.height - 4;
    menu.style.left = `${Math.max(MARGIN, Math.min(preferredLeft, window.innerWidth - box.width - MARGIN))}px`;
    menu.style.top = `${Math.max(MARGIN, Math.min(top, window.innerHeight - box.height - MARGIN))}px`;
  };

  private readonly outside = (event: Event): void => {
    if (!event.composedPath().includes(this.details)) this.close();
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
    if (this.menu) {
      this.menu.removeEventListener('click', this.choose, true);
      this.menu.hidePopover();
      this.menu.removeAttribute('popover');
      this.menu.classList.remove('pk-viewport-menu');
      this.menu.style.removeProperty('left');
      this.menu.style.removeProperty('top');
      this.menu = undefined;
    }
  }
}
