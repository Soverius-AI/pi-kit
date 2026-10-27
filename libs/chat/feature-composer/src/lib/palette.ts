import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, untracked } from '@angular/core';
import { PkCommandMenu } from '@pi-kit/design-system';
import { UiStore } from '@pi-kit/data-access';
import { PaletteStore } from '@pi-kit/chat/data';

/**
 * ⌘K: the same command registry as the composer's `/` menu in a dialog, plus the app's own actions.
 * Built-ins run; skills and templates become chips of the composer, extension commands go into it as
 * text to be completed with their arguments.
 */
@Component({
  selector: 'pk-palette',
  imports: [PkCommandMenu, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (bus.palette()) {
      <dialog
        class="modal modal-open items-start"
        [attr.aria-label]="'chat.palette.commandPalette' | transloco"
        tabindex="-1"
        (keydown)="store.onKey($event)"
      >
        <div class="modal-box p-0 mt-16 max-w-xl overflow-hidden">
          <div class="p-3 border-b border-base-300">
            <input
              #search
              type="search"
              class="input input-sm w-full"
              [placeholder]="'chat.palette.searchCommands' | transloco"
              [attr.aria-label]="'chat.palette.searchCommands' | transloco"
              [value]="store.query()"
              (input)="store.setQuery(search.value)"
            />
          </div>
          <pk-command-menu
            [groups]="store.groups()"
            [selectedId]="store.selectedId()"
            [inline]="true"
            [empty]="'chat.palette.noCommandMatches' | transloco"
            idPrefix="pk-palette-opt-"
            (pick)="store.pick($event)"
            (hover)="store.hover($event.id)"
          />
        </div>
        <form method="dialog" class="modal-backdrop">
          <button type="button" (click)="store.close()">{{ 'chat.palette.close' | transloco }}</button>
        </form>
      </dialog>
    }
  `,
})
export class Palette {
  protected readonly bus = inject(UiStore);
  protected readonly store = inject(PaletteStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // The dialog takes the focus when it opens.
    effect(() => {
      if (!this.bus.palette()) return;
      untracked(() =>
        setTimeout(() => this.host.nativeElement.querySelector<HTMLInputElement>('input[type="search"]')?.focus()),
      );
    });
  }
}
