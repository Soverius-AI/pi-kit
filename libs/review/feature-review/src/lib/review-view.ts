import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import type { HunkLabelEntry } from '@pi-kit/protocol';
import { PkIcon, PkScoreMeter } from '@pi-kit/design-system';
import { PkDiffViewer } from '@pi-kit/ui';
import { CoordinationStore, ScoreStore } from '@pi-kit/threads/api';
import { ChangesStore } from '@pi-kit/review/data';

/**
 * Review mode's main column: the selected file's diff in the viewer, with the
 * `+` gutter on hover and comment cards, then "N of M files" and a button to the next file. It takes the place of the
 * transcript; the toolbar above selects the file and the comment tray replaces the composer.
 */
@Component({
  selector: 'pk-review-view',
  imports: [PkDiffViewer, PkScoreMeter, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-transcript' },
  template: `
    <div class="pk-measure" style="--pk-measure: 100%">
      @if (review.error(); as error) {
        <p class="text-sm text-error" role="alert">
          {{ 'review.reviewView.theChangesCouldNotBeLoaded' | transloco: { value1: error } }}
        </p>
      } @else if (review.files().length === 0) {
        <div class="grid place-items-center py-16 text-center text-sm text-muted">
          @if (review.loading() && !review.list()) {
            <span
              class="loading loading-dots loading-sm text-primary"
              [attr.aria-label]="'review.reviewView.loadingTheChanges' | transloco"
            ></span>
          } @else {
            <p>
              {{
                review.list()?.note ??
                  (review.source() === 'thread'
                    ? ('review.reviewView.piHasNotChangedAnyFileIn' | transloco)
                    : review.source() === 'outcome'
                      ? ('review.reviewView.theOutcomeChangedNoFile' | transloco)
                      : ('review.reviewView.theWorkingTreeMatchesHEADNothingTo' | transloco))
              }}
            </p>
          }
        </div>
      } @else if (review.model(); as model) {
        @if (outcomeScore(); as score) {
          <pk-score-meter
            [meat]="score.scores.meat"
            [vibe]="score.scores.vibe"
            [line]="score.scores.line"
            [stale]="score.stale"
            [corrected]="score.corrected"
          />
        }
        @if (lease(); as lease) {
          <div class="pk-lease-note" role="note" data-testid="review-lease">
            <pk-icon name="pencil-small" />
            <span
              ><b>{{ lease.title }}</b> {{ 'review.reviewView.isEditingThisFileInTheSame' | transloco }}</span
            >
          </div>
        }
        @if (review.selectedFile()?.conflict) {
          <div class="pk-lease-note conflict" role="alert" data-testid="review-conflict">
            <span
              ><b>{{ 'review.reviewView.mergeConflicts' | transloco }}</b>
              {{ 'review.reviewView.theMarkers' | transloco }}<code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>,
              <code>=======</code>, <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code
              >{{ 'review.reviewView.areInTheFileCommentOnThe' | transloco }}</span
            >
          </div>
        }
        @for (fileModel of [model]; track fileModel.path) {
          <pk-diff
            [model]="model"
            [mode]="mode()"
            [commentable]="true"
            [comments]="review.selectedComments()"
            [subtitle]="review.subtitle()"
            [marks]="marks()"
            (relabel)="relabel($event.hunk, $event.label)"
            (saveComment)="review.save($event)"
            (deleteComment)="review.remove($event)"
          >
            <button diffActions type="button" class="btn btn-ghost btn-xs" (click)="review.openInEditor(model.path)">
              {{ 'review.reviewView.openInEditor' | transloco }}
            </button>
          </pk-diff>
        }
        <div class="flex items-center justify-between mt-4 t-sm muted">
          <span>{{
            'review.reviewView.of'
              | transloco
                : {
                    value1: review.selectedIndex() + 1,
                    value2: review.files().length,
                    value3:
                      review.files().length === 1
                        ? ('review.reviewView.file' | transloco)
                        : ('review.reviewView.files' | transloco),
                  }
          }}</span>
          @if (review.nextName(); as next) {
            <button type="button" class="btn btn-sm" (click)="review.next()">
              {{ 'review.reviewView.nextFile' | transloco: { value1: next } }}
            </button>
          }
        </div>
      } @else if (review.modelError(); as error) {
        <p class="text-sm text-error" role="alert">
          {{ 'review.reviewView.thisFileCouldNotBeCompared' | transloco: { value1: error } }}
        </p>
      } @else {
        <div class="grid place-items-center py-16">
          <span
            class="loading loading-dots loading-sm text-primary"
            [attr.aria-label]="'review.reviewView.loadingTheDiff' | transloco"
          ></span>
        </div>
      }
    </div>
  `,
})
export class ReviewView {
  protected readonly review = inject(ChangesStore);
  private readonly coordination = inject(CoordinationStore);
  private readonly score = inject(ScoreStore);
  /** The Outcome view shows the score and the label of every hunk while the meat-proxy package has scored the thread; every other source, and a removed package, show plain hunks. */
  protected readonly outcomeScore = computed(() =>
    this.review.source() === 'outcome' ? this.score.current() : undefined,
  );
  protected readonly marks = computed<Record<string, HunkLabelEntry>>(() =>
    Object.fromEntries((this.outcomeScore()?.hunks ?? []).map((h) => [h.id, h] as const)),
  );
  /** Another thread's lease on the file in view. */
  protected readonly lease = computed(() => {
    const path = this.review.selectedId();
    return path ? this.coordination.leaseOf(path) : undefined;
  });

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect(() => {
      this.review.selectedId();
      this.review.source();
      host.scrollTop = 0;
    });
    this.coordination.want('review', true);
    const media = matchMedia('(max-width: 767px)');
    const resize = (): void => this.narrow.set(media.matches);
    resize();
    media.addEventListener('change', resize);
    inject(DestroyRef).onDestroy(() => {
      this.coordination.want('review', false);
      media.removeEventListener('change', resize);
    });
  }

  protected relabel(hunk: string, label: Parameters<ScoreStore['relabel']>[2]): void {
    const threadId = this.review.threadId();
    if (threadId) void this.score.relabel(threadId, hunk, label);
  }

  /** Phones have no room for two columns of code. */
  private readonly narrow = signal(false);
  protected readonly mode = computed(() => (this.narrow() ? 'unified' : this.review.layout()));
}
