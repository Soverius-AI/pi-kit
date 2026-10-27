import { TranslocoPipe } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input, output } from '@angular/core';

export interface PkMenuItem {
  id: string;
  /** Shown in mono, e.g. `/skill:pdf-tools` or `src/app.ts`. */
  name: string;
  description?: string;
  /** Trailing badge text and its daisyUI classes (`badge-info badge-outline`). */
  badge?: string;
  badgeClass?: string;
  disabled?: boolean;
  /** Tooltip, e.g. why an item is disabled. */
  title?: string;
}

export interface PkMenuGroup {
  title: string;
  items: PkMenuItem[];
}

/**
 * The command menu (doc/docs/design-system.md, "Command menu"): a popover above the composer, 480 wide, one line
 * per entry (name in mono, description, source badge), grouped. It is a presentation component: the parent
 * filters, owns the selection and the keyboard, and gets `pick` / `hover` back. `inline` drops the popover
 * chrome so the same list can sit in a dialog (the ⌘K palette).
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-command-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-menu', '[class.inline]': 'inline()', role: 'listbox', '[attr.aria-label]': 'label()' },
  template: `
    @if (head()) {
      <div class="head">
        <span>{{ head() }}</span>
        <span class="ml-auto flex gap-1">
          <kbd class="kbd kbd-xs">↑</kbd><kbd class="kbd kbd-xs">↓</kbd><kbd class="kbd kbd-xs">⏎</kbd>
        </span>
      </div>
    }
    <div class="items">
      @for (group of groups(); track group.title) {
        <div class="group">{{ group.title }}</div>
        @for (item of group.items; track item.id) {
          <div
            class="item"
            role="option"
            tabindex="-1"
            [id]="idPrefix() + item.id"
            [attr.data-id]="item.id"
            [attr.aria-selected]="item.id === selectedId()"
            [attr.aria-disabled]="item.disabled ? 'true' : null"
            [title]="item.title ?? ''"
            (mousedown)="$event.preventDefault()"
            (click)="pick.emit(item)"
            (keydown.enter)="pick.emit(item)"
            (mousemove)="hover.emit(item)"
          >
            <code>{{ item.name }}</code>
            <span class="desc">{{ item.description }}</span>
            @if (item.badge) {
              <span class="badge badge-xs" [class]="item.badgeClass ?? 'badge-ghost'">{{ item.badge }}</span>
            }
          </div>
        }
      } @empty {
        <div class="empty">{{ empty() ?? ('shared.commandMenu.nothingMatches' | transloco) }}</div>
      }
    </div>
  `,
})
export class PkCommandMenu {
  protected readonly i18n = inject(Language);
  readonly groups = input.required<PkMenuGroup[]>();
  readonly selectedId = input<string | undefined>(undefined);
  /** The header line, e.g. "Commands matching sk"; empty hides the header. */
  readonly head = input('');
  readonly empty = input<string>();
  readonly inline = input(false);
  readonly label = input<string>();
  /** Prefix of the option element ids, so a textarea can point `aria-activedescendant` at one. */
  readonly idPrefix = input('pk-opt-');

  readonly pick = output<PkMenuItem>();
  readonly hover = output<PkMenuItem>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // Keep the keyboard selection in view.
    effect(() => {
      const id = this.selectedId();
      if (id === undefined) return;
      queueMicrotask(() => {
        const el = this.host.nativeElement.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
        el?.scrollIntoView({ block: 'nearest' });
      });
    });
  }
}
