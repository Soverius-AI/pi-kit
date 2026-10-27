import { TranslocoPipe } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

export interface PkMenuItem {
  id: string;
  label: string;
  /** Muted text on the right (a shortcut). */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** A hairline above this item. */
  separatorBefore?: boolean;
}

/**
 * A floating menu at a point (doc/docs/design-system.md "Context menu"): the Files panel's right-click menu and the
 * session graph's "More". It is the one allowed floating surface in the panels, so it uses the shadow token; a transparent
 * backdrop catches the click that dismisses it, ↑ ↓ Home End move, Enter chooses, Esc closes (and keeps the app's own Esc
 * from also stopping a run). Focus goes to the first enabled item when it opens and the opener gets it back through `dismissed`.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-context-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'dismissed.emit()' },
  template: `
    <button
      type="button"
      class="pk-ctx-backdrop"
      tabindex="-1"
      aria-hidden="true"
      (click)="dismissed.emit()"
      (contextmenu)="$event.preventDefault(); dismissed.emit()"
    ></button>
    <div
      class="pk-ctx"
      role="menu"
      tabindex="-1"
      [attr.aria-label]="label() ?? ('shared.contextMenu.actions' | transloco)"
      [style.left.px]="placed()?.left ?? x()"
      [style.top.px]="placed()?.top ?? y()"
      (keydown)="onKey($event)"
    >
      @for (item of items(); track item.id) {
        @if (item.separatorBefore) {
          <div class="sep" role="separator"></div>
        }
        <button
          type="button"
          role="menuitem"
          class="item"
          [class.danger]="item.danger"
          [disabled]="item.disabled"
          (click)="choose(item)"
        >
          <span>{{ item.label }}</span>
          @if (item.hint) {
            <span class="hint">{{ item.hint }}</span>
          }
        </button>
      }
    </div>
  `,
})
export class PkContextMenu {
  protected readonly i18n = inject(Language);
  readonly items = input.required<readonly PkMenuItem[]>();
  /** Viewport coordinates of the pointer (or of the button the menu belongs to). */
  readonly x = input.required<number>();
  readonly y = input.required<number>();
  readonly label = input<string>();
  readonly chosen = output<string>();
  readonly dismissed = output<void>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly placed = signal<{ left: number; top: number } | undefined>(undefined);

  constructor() {
    // Placed at the pointer first, then moved inside the window once its size is known.
    afterNextRender(() => {
      const menu = this.host.querySelector<HTMLElement>('.pk-ctx');
      if (!menu) return;
      const { width, height } = menu.getBoundingClientRect();
      this.placed.set({
        left: Math.max(8, Math.min(this.x(), window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(this.y(), window.innerHeight - height - 8)),
      });
      this.buttons()[0]?.focus();
    });
  }

  protected choose(item: PkMenuItem): void {
    if (item.disabled) return;
    this.chosen.emit(item.id);
  }

  protected onKey(event: KeyboardEvent): void {
    const buttons = this.buttons();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | undefined;
    if (event.key === 'ArrowDown') next = (at + 1) % buttons.length;
    else if (event.key === 'ArrowUp') next = (at - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'Escape') {
      event.stopPropagation();
      this.dismissed.emit();
      return;
    } else if (event.key === 'Tab') {
      event.preventDefault();
      return;
    } else return;
    event.preventDefault();
    buttons[next]?.focus();
  }

  private buttons(): HTMLButtonElement[] {
    return Array.from(this.host.querySelectorAll<HTMLButtonElement>('button.item:not(:disabled)'));
  }
}
