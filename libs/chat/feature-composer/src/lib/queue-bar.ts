import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import type { QueueItem } from '@pi-kit/protocol';
import { ChatStore } from '@pi-kit/chat/data';
import { PkIcon } from '@pi-kit/design-system';

/**
 * The queue bar (doc/docs/design-system.md "Queue bar"): the messages pi holds for the running turn, docked
 * onto the composer's well as one unit. pi's queue is the truth (`pi.queue` events, read again from the session after a reload and after
 * every action), so what the bar lists is what pi will deliver: steering messages first, then follow-ups.
 *
 * A row offers Steer now (a follow-up only), Edit (out of the queue, back into the composer) and Remove; the header offers Merge and
 * Clear all. On a phone Steer now and Edit sit behind a tap on the row.
 */
@Component({
  imports: [TranslocoPipe, PkIcon],
  selector: 'pk-queue-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (rows().length > 0) {
      <div class="pk-queue" role="region" [attr.aria-label]="'chat.queueBar.queuedMessages' | transloco">
        <div class="head">
          <b>{{ 'chat.queueBar.queued' | transloco }}</b>
          <span class="count" data-testid="queue-count">{{ rows().length }}</span>
          <span class="rule ml-1" [title]="'chat.queueBar.aSteerIsDeliveredAfterTheCurrent' | transloco">{{
            'chat.queueBar.steerGoesAfterThisTurnFollowUp' | transloco
          }}</span>
          <button
            type="button"
            class="link link-hover ml-auto"
            [title]="'chat.queueBar.joinTheQueuedMessagesIntoOneSteer' | transloco"
            [disabled]="rows().length < 2"
            (click)="chat.mergeQueued()"
          >
            {{ 'chat.queueBar.merge' | transloco }}
          </button>
          <button
            type="button"
            class="link link-hover"
            [title]="'chat.queueBar.removeEveryQueuedMessage' | transloco"
            (click)="chat.clearQueued()"
          >
            {{ 'chat.queueBar.clearAll' | transloco }}
          </button>
        </div>
        @for (row of rows(); track row.kind + ':' + row.index + ':' + row.text) {
          <div
            class="item"
            [class.open]="open() === row.kind + ':' + row.index"
            data-testid="queue-row"
            [attr.data-kind]="row.kind"
          >
            <div class="row">
              <span class="kind" [class.steer]="row.kind === 'steer'">{{
                row.kind === 'steer' ? ('chat.queueBar.steer' | transloco) : ('chat.queueBar.followUp' | transloco)
              }}</span>
              <!-- The text is the row's one control for the phone's tap-to-open strip (a button, so the keyboard reaches it too). -->
              <button
                type="button"
                class="txt"
                [title]="row.text"
                [attr.aria-expanded]="open() === row.kind + ':' + row.index"
                (click)="toggle(row)"
              >
                {{ row.text }}
              </button>
              <div class="acts">
                @if (row.kind === 'followUp') {
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    [title]="'chat.queueBar.deliverAfterTheCurrentTurnInsteadOf' | transloco"
                    (click)="chat.steerQueued(row)"
                  >
                    {{ 'chat.queueBar.steerNow' | transloco }}
                  </button>
                }
                <button
                  type="button"
                  class="btn btn-ghost btn-sm"
                  [title]="'chat.queueBar.putTheTextBackInTheComposer' | transloco"
                  (click)="chat.editQueued(row)"
                >
                  {{ 'chat.queueBar.edit' | transloco }}
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-sm btn-square"
                  [title]="'chat.queueBar.remove' | transloco"
                  [attr.aria-label]="'chat.queueBar.remove' | transloco"
                  (click)="chat.removeQueued(row)"
                >
                  <pk-icon name="close" size="14" />
                </button>
              </div>
            </div>
            <div class="more">
              @if (row.kind === 'followUp') {
                <button type="button" class="btn btn-sm" (click)="chat.steerQueued(row)">
                  {{ 'chat.queueBar.steerNow' | transloco }}
                </button>
              }
              <button type="button" class="btn btn-sm" (click)="chat.editQueued(row)">
                {{ 'chat.queueBar.edit' | transloco }}
              </button>
            </div>
          </div>
        }
      </div>
    }
  `,
})
export class QueueBar {
  protected readonly chat = inject(ChatStore);
  protected readonly rows = computed<QueueItem[]>(() => this.chat.queueRows());
  /** The row whose actions are open on a phone (`kind:index`). */
  protected readonly open = signal<string | undefined>(undefined);

  protected toggle(row: QueueItem): void {
    const key = `${row.kind}:${row.index}`;
    this.open.update((current) => (current === key ? undefined : key));
  }
}
