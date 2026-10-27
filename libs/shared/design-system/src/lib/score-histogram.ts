import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** A thread of the project that was scored, newest first. */
export interface PkScoreRecent {
  threadId: string;
  title: string | null;
  meat: number;
  line: string;
}

const RANGES = ['0–9', '10–19', '20–29', '30–39', '40–49', '50–59', '60–69', '70–79', '80–89', '90–100'];

/**
 * The score histogram (doc/docs/design-system.md, "Score histogram"): how a project's finished threads are spread over the steered share, ten columns from 0 to 100 %, the
 * average in words, and the newest threads with their number. It describes threads; it ranks nothing. Empty columns stay as a thin rule so the scale is always readable.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-score-histogram',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-histogram', 'data-testid': 'score-histogram' },
  template: `
    <div class="plot" role="img" [attr.aria-label]="label()">
      @for (bin of bins(); track $index) {
        <div
          class="col"
          [attr.data-empty]="bin === 0"
          [attr.title]="title($index, bin)"
          data-testid="score-bin"
          [attr.data-count]="bin"
        >
          <i [style.height.%]="height(bin)"></i>
        </div>
      }
    </div>
    <div class="axis" aria-hidden="true">
      <span>{{ 'shared.scoreHistogram.0Steered' | transloco }}</span
      ><span>100 %</span>
    </div>
    <p class="m-0 text-sm" data-testid="score-mean">{{ summary() }}</p>
    @if (recent().length > 0) {
      <ul class="recent" [attr.aria-label]="'shared.scoreHistogram.newestScoredThreads' | transloco">
        @for (item of recent(); track item.threadId) {
          <li [title]="item.line">
            <span class="pct">{{ item.meat }} %</span
            ><span class="what">{{ item.title || ('shared.scoreHistogram.untitledThread' | transloco) }}</span>
          </li>
        }
      </ul>
    }
  `,
})
export class PkScoreHistogram {
  protected readonly i18n = inject(Language);
  /** Ten counts: threads at 0–9 %, 10–19 %, ... 90–100 % steered. */
  readonly bins = input.required<readonly number[]>();
  readonly mean = input<number | null>(null);
  readonly scored = input(0);
  readonly recent = input<readonly PkScoreRecent[]>([]);

  private readonly peak = computed(() => Math.max(1, ...this.bins()));
  protected readonly label = computed(() =>
    this.i18n.t('shared.scoreHistogram.scoredThreadsByTheShareYouSteered', {
      value1: this.bins()
        .map((n, i) => this.i18n.t('shared.scoreHistogram.at', { value1: n, value2: RANGES[i] }))
        .join(', '),
    }),
  );
  protected readonly summary = computed(() => {
    const mean = this.mean();
    const n = this.scored();
    return mean === null
      ? this.i18n.t('shared.scoreHistogram.noThreadOfThisProjectHasBeen')
      : this.i18n.t('shared.scoreHistogram.onAverageSteeredOverScored', {
          value1: mean,
          value2: n,
          value3: n === 1 ? this.i18n.t('shared.scoreHistogram.thread') : this.i18n.t('shared.scoreHistogram.threads'),
        });
  });

  protected height(count: number): number {
    return count === 0 ? 0 : Math.max(8, Math.round((count / this.peak()) * 100));
  }

  protected title(index: number, count: number): string {
    return this.i18n.t('shared.scoreHistogram.atSteered', {
      value1: count,
      value2: count === 1 ? this.i18n.t('shared.scoreHistogram.thread') : this.i18n.t('shared.scoreHistogram.threads'),
      value3: RANGES[index],
    });
  }
}
