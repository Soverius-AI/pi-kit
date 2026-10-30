import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChatStore } from '@pi-kit/chat/api';
import { ChangesStore } from '@pi-kit/review/data';

/**
 * The comment tray that replaces the composer in review mode: how many
 * comments are pending and on how many files, one chip per comment (`file:line`, a click opens the file), "Discard all"
 * and the primary "Send N comments to pi". Sending is one prompt.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-review-tray',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-composer' },
  template: `
    <div class="pk-measure" style="--pk-measure: 100%">
      <div class="pk-tray">
        <div class="min-w-0 flex-1 flex flex-col gap-2">
          @if (review.commentCount() > 0) {
            <div class="flex items-center gap-2 whitespace-nowrap">
              <span class="font-medium">{{
                'review.reviewTray.pending'
                  | transloco
                    : {
                        value1: review.commentCount(),
                        value2:
                          review.commentCount() === 1
                            ? ('review.reviewTray.comment' | transloco)
                            : ('review.reviewTray.comments' | transloco),
                      }
              }}</span>
              <span class="muted t-sm">{{
                'review.reviewTray.on'
                  | transloco
                    : {
                        value1: review.commentFiles(),
                        value2:
                          review.commentFiles() === 1
                            ? ('review.reviewTray.file' | transloco)
                            : ('review.reviewTray.files' | transloco),
                      }
              }}</span>
            </div>
            <div class="chips">
              @for (comment of review.ordered(); track comment.id) {
                <button type="button" class="chip" [title]="comment.text" (click)="review.select(comment.file)">
                  {{ basename(comment.file) }}:{{ comment.line }}
                </button>
              }
            </div>
            <div class="muted t-xs pk-hide-sm">
              {{
                session.running()
                  ? ('review.reviewTray.piIsRunningSendOnceItHas' | transloco)
                  : ('review.reviewTray.sentAsOneMessagePiSeesEach' | transloco)
              }}
            </div>
          } @else {
            <div class="font-medium">{{ 'review.reviewTray.noCommentsYet' | transloco }}</div>
            <div class="muted t-sm">
              {{ 'review.reviewTray.hoverALineAndClickToStart' | transloco }}
            </div>
          }
        </div>
        <button
          type="button"
          class="btn btn-sm btn-ghost"
          [disabled]="review.commentCount() === 0"
          (click)="review.discardAll()"
        >
          {{ 'review.reviewTray.discardAll' | transloco }}
        </button>
        <button
          type="button"
          class="btn btn-sm btn-primary"
          [disabled]="review.commentCount() === 0 || session.running()"
          (click)="review.send()"
        >
          {{ review.sendLabel() }}
        </button>
      </div>
    </div>
  `,
})
export class ReviewTray {
  protected readonly review = inject(ChangesStore);
  protected readonly session = inject(ChatStore);
  protected readonly basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
}
