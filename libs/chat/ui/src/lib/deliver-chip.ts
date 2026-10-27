import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, ElementRef, inject, input, output, signal } from '@angular/core';
import { PkIcon } from '@pi-kit/design-system';

export type DeliverMode = 'steer' | 'followUp';

/**
 * "Deliver: Steer" (doc/docs/design-system.md, "Composer"): while pi runs, how a message sent now reaches it. Steer goes in after the current turn,
 * Follow-up after the whole run. A chip like the model and effort chips: a pill with a 14px chevron and a menu above it. When the toolbar is tight
 * the word "Deliver" is the first thing to go (the container query in `components.css`). Stateless: the mode comes in, a choice goes out.
 */
@Component({
  imports: [TranslocoPipe, PkIcon],
  selector: 'pk-deliver-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-chip mode',
    '(document:click)': 'onDocumentClick($event)',
    '(keydown.escape)': 'onEscape($event)',
  },
  template: `
    <button
      type="button"
      class="btn btn-ghost btn-sm gap-1.5"
      aria-haspopup="listbox"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="('chat.deliverChip.deliver' | transloco) + label()"
      data-testid="deliver-chip"
      [title]="'chat.deliverChip.howAMessageSentDuringTheRun' | transloco"
      (click)="open.set(!open())"
    >
      <span>{{ 'chat.deliverChip.deliverdcac5' | transloco }}</span>
      <span class="v">{{ label() }}</span>
      <pk-icon name="chevron-down" class="chev" />
    </button>
    @if (open()) {
      <div
        class="pk-popover up start"
        role="dialog"
        [attr.aria-label]="'chat.deliverChip.howToDeliverMessagesSentDuringA' | transloco"
      >
        <div class="pk-levels" role="listbox" [attr.aria-label]="'chat.deliverChip.delivery' | transloco">
          <div
            class="opt two"
            role="option"
            tabindex="0"
            [attr.aria-selected]="mode() === 'steer'"
            (click)="choose('steer')"
            (keydown.enter)="choose('steer')"
            (keydown.space)="$event.preventDefault(); choose('steer')"
          >
            <div class="main">
              <span>{{ 'chat.deliverChip.steer' | transloco }}</span
              ><span class="sub">{{ 'chat.deliverChip.afterTheCurrentTurnPiTakesIt' | transloco }}</span>
            </div>
          </div>
          <div
            class="opt two"
            role="option"
            tabindex="0"
            [attr.aria-selected]="mode() === 'followUp'"
            (click)="choose('followUp')"
            (keydown.enter)="choose('followUp')"
            (keydown.space)="$event.preventDefault(); choose('followUp')"
          >
            <div class="main">
              <span>{{ 'chat.deliverChip.followUp' | transloco }}</span
              ><span class="sub">{{ 'chat.deliverChip.afterTheRunIsOver' | transloco }}</span>
            </div>
          </div>
        </div>
      </div>
    }
  `,
})
export class DeliverChip {
  protected readonly i18n = inject(Language);
  readonly mode = input<DeliverMode>('steer');
  readonly pick = output<DeliverMode>();

  protected readonly open = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected label(): string {
    return this.mode() === 'steer' ? this.i18n.t('chat.deliverChip.steer') : 'Follow-up';
  }

  protected choose(mode: DeliverMode): void {
    this.pick.emit(mode);
    this.open.set(false);
  }

  protected onDocumentClick(event: Event): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.open.set(false);
  }

  protected onEscape(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    this.open.set(false);
  }
}
