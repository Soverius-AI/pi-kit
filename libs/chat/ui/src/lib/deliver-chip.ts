import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CdkConnectedOverlay, CdkOverlayOrigin, type ConnectedPosition } from '@angular/cdk/overlay';
import { PkIcon, PkSafeOverlay } from '@pi-kit/design-system';

export type DeliverMode = 'steer' | 'followUp';

/**
 * "Deliver: Steer" (doc/docs/design-system.md, "Composer"): while pi runs, how a message sent now reaches it. Steer goes in after the current turn,
 * Follow-up after the whole run. A chip like the model and effort chips: a pill with a 14px chevron and a menu above it. When the toolbar is tight
 * the word "Deliver" is the first thing to go (the container query in `components.css`). Stateless: the mode comes in, a choice goes out.
 */
@Component({
  imports: [TranslocoPipe, PkIcon, PkSafeOverlay, CdkConnectedOverlay, CdkOverlayOrigin],
  selector: 'pk-deliver-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-chip mode',
    '(document:click)': 'onDocumentClick($event)',
    '(keydown.escape)': 'onEscape($event)',
  },
  template: `
    <button
      #trigger
      cdkOverlayOrigin
      #origin="cdkOverlayOrigin"
      type="button"
      class="btn btn-ghost btn-sm gap-1.5"
      aria-haspopup="dialog"
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
    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOrigin]="origin"
      [cdkConnectedOverlayOpen]="open()"
      [cdkConnectedOverlayPositions]="positions"
      [cdkConnectedOverlayViewportMargin]="16"
      [cdkConnectedOverlayPush]="true"
      [cdkConnectedOverlayHasBackdrop]="true"
      [cdkConnectedOverlayDisableClose]="true"
      cdkConnectedOverlayPanelClass="pk-composer-overlay"
      cdkConnectedOverlayBackdropClass="cdk-overlay-transparent-backdrop"
      (backdropClick)="open.set(false)"
      (overlayKeydown)="$event.key === 'Escape' && onEscape($event)"
      (detach)="open.set(false)"
    >
      <div
        #popup
        pkSafeOverlay
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
    </ng-template>
  `,
})
export class DeliverChip {
  protected readonly i18n = inject(Language);
  readonly mode = input<DeliverMode>('steer');
  readonly pick = output<DeliverMode>();

  protected readonly open = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly popup = viewChild<ElementRef<HTMLElement>>('popup');
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  protected readonly positions: ConnectedPosition[] = [
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -8 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 8 },
  ];

  protected label(): string {
    return this.mode() === 'steer' ? this.i18n.t('chat.deliverChip.steer') : this.i18n.t('chat.deliverChip.followUp');
  }

  protected choose(mode: DeliverMode): void {
    this.pick.emit(mode);
    this.open.set(false);
    queueMicrotask(() => this.trigger()?.nativeElement.focus({ preventScroll: true }));
  }

  protected onDocumentClick(event: Event): void {
    if (
      this.open() &&
      !this.host.nativeElement.contains(event.target as Node) &&
      !this.popup()?.nativeElement.contains(event.target as Node)
    )
      this.open.set(false);
  }

  protected onEscape(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    this.open.set(false);
    queueMicrotask(() => this.trigger()?.nativeElement.focus({ preventScroll: true }));
  }
}
