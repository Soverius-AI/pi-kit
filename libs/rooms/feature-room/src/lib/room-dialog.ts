import { A11yModule } from '@angular/cdk/a11y';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  effect,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { PkIcon, keepFocusInside } from '@pi-kit/design-system';

let nextDialog = 0;

/** The existing workflow frame, shared by the room's focused editors. */
@Component({
  selector: 'pk-room-dialog',
  imports: [A11yModule, PkIcon],
  template: `
    <div class="pk-wf" data-testid="room-dialog">
      <button
        type="button"
        class="pk-backdrop"
        tabindex="-1"
        [attr.aria-label]="closeLabel()"
        (click)="closed.emit()"
      ></button>
      <div
        #win
        class="win"
        role="dialog"
        aria-modal="true"
        [attr.aria-labelledby]="headingId"
        [attr.aria-busy]="busy()"
        tabindex="-1"
        cdkTrapFocus
        [cdkTrapFocusAutoCapture]="true"
        (keydown.escape)="dismiss($event)"
      >
        <header class="head">
          <h2 [id]="headingId">{{ title() }}</h2>
          @if (busy()) {
            <span class="loading loading-spinner loading-xs" aria-hidden="true"></span>
          }
          <button
            type="button"
            class="pk-close ml-auto"
            data-testid="room-dialog-dismiss"
            [attr.aria-label]="closeLabel()"
            (click)="closed.emit()"
          >
            <pk-icon name="close" />
          </button>
        </header>
        <div class="body">
          @if (error(); as message) {
            <p class="text-sm text-error break-words m-0" role="alert">{{ message }}</p>
          }
          <ng-content />
        </div>
        <footer class="foot">
          <button type="button" class="btn btn-sm btn-ghost" data-testid="room-dialog-close" (click)="closed.emit()">
            {{ closeLabel() }}
          </button>
          <span class="flex-1"></span>
          <ng-content select="[roomDialogActions]" />
        </footer>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: contents;
    }
    .win {
      min-width: 0;
      max-height: min(90dvh, 900px);
    }
    .body {
      min-height: 0;
      overscroll-behavior: contain;
    }
    .head,
    .foot {
      flex-shrink: 0;
    }
    .head h2 {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    @media (max-width: 767px) {
      .win {
        max-height: 100dvh;
      }
      .pk-close,
      .foot button {
        min-height: 44px;
        min-width: 44px;
      }
    }
  `,
})
export class RoomDialog {
  readonly title = input.required<string>();
  readonly closeLabel = input.required<string>();
  readonly busy = input(false);
  readonly error = input<string | null | undefined>();
  readonly closed = output<void>();
  protected readonly headingId = `room-dialog-title-${++nextDialog}`;
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');
  private readonly injector = inject(Injector);
  constructor() {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    inject(DestroyRef).onDestroy(() =>
      queueMicrotask(() => {
        if (opener?.isConnected) opener.focus();
      }),
    );
    effect(() => {
      this.busy();
      this.error();
      this.win();
      untracked(() => keepFocusInside(this.injector, () => this.win()?.nativeElement));
    });
  }
  protected dismiss(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.closed.emit();
  }
}
