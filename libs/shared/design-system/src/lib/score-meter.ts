import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The score meter (doc/docs/design-system.md, "Score meter"): the Meat Proxy Score and the Vibe Score of an outcome, never as a bare number. A base-200 box with the share steered
 * ("62 % steered", "38 % vibe"), a thin bar that fills with the steered part in the primary tint, and the sentence that says what it is made of ("14 of 23 hunks, 9 by the first prompt,
 * 3 by review comments, 2 by hand"). When the outcome moved on since the hunks were labelled it says so; the score is of the labels as they were.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-score-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-score', 'data-testid': 'score-meter', '[attr.data-stale]': 'stale()' },
  template: `
    <div class="nums">
      <b data-testid="score-meat">{{ 'shared.scoreMeter.steered' | transloco: { value1: meat() } }}</b>
      <span class="muted" data-testid="score-vibe">{{ 'shared.scoreMeter.vibe' | transloco: { value1: vibe() } }}</span>
      @if (corrected() > 0) {
        <span class="muted" data-testid="score-corrected">{{
          'shared.scoreMeter.correctedByYou'
            | transloco
              : {
                  value1: corrected(),
                  value2:
                    corrected() === 1
                      ? ('shared.scoreMeter.label' | transloco)
                      : ('shared.scoreMeter.labels' | transloco),
                }
        }}</span>
      }
    </div>
    <div
      class="bar"
      role="img"
      [attr.aria-label]="meat() + ('shared.scoreMeter.percentOfTheChangedLinesWereSteered' | transloco)"
    >
      <i [style.width.%]="meat()"></i>
    </div>
    <p class="line" data-testid="score-line">{{ detail() }}</p>
  `,
})
export class PkScoreMeter {
  /** Whole percent of the changed lines in hunks the person specified, corrected or changed by hand. */
  readonly meat = input.required<number>();
  readonly vibe = input.required<number>();
  /** "62 % steered: 14 of 23 hunks, 9 by the first prompt, ...": the part after the colon is shown under the bar. */
  readonly line = input.required<string>();
  /** The outcome has changed since the hunks were labelled. */
  readonly stale = input(false);
  /** How many labels the person changed by hand. */
  readonly corrected = input(0);

  protected readonly detail = computed(() => {
    const line = this.line();
    const at = line.indexOf(': ');
    return at < 0 ? line : line.slice(at + 2);
  });
}
