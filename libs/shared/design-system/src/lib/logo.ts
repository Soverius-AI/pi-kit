import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The pi-kit mark (doc/docs/design-system.md "Brand"): the πk ligature cut into sixteen facets. `tone="mono"` draws it in
 * `currentColor` with the facets kept by opacity (chrome: set `color`, usually `--color-primary`); `tone="gold"` draws the
 * brand colours (about, onboarding). With `wordmark`, the name follows the mark. Same geometry as
 * `libs/shared/design-system/src/brand/*.svg`.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-logo', '[class.wordmark]': 'wordmark()', '[style.--pk-logo-size.px]': 'size()' },
  template: `
    <svg
      viewBox="0 0 100 100"
      [attr.width]="size()"
      [attr.height]="size()"
      aria-hidden="true"
      [attr.fill]="tone() === 'mono' ? 'currentColor' : null"
    >
      @for (f of facets; track $index) {
        <polygon
          [attr.points]="f.p"
          [attr.fill]="tone() === 'gold' ? f.c : null"
          [attr.fill-opacity]="tone() === 'mono' ? f.o : null"
          [attr.stroke]="tone() === 'gold' ? 'rgb(255 255 255 / .22)' : null"
          stroke-width=".45"
          stroke-linejoin="round"
        />
      }
    </svg>
    @if (wordmark()) {
      <span class="name">{{ 'shared.logo.pi' | transloco }}<b>-</b>{{ 'shared.logo.kit' | transloco }}</span>
    }
  `,
})
export class PkLogo {
  /** Mark size in px (the wordmark text scales with it). */
  readonly size = input(20);
  readonly tone = input<'mono' | 'gold'>('mono');
  readonly wordmark = input(false);

  protected readonly facets: readonly { p: string; c: string; o: number }[] = [
    { p: '12,30 40,30 22,41.5', c: '#f6d98c', o: 1 },
    { p: '12,30 22,41.5 12,41.5', c: '#e6a94a', o: 0.8 },
    { p: '22,41.5 40,30 52,41.5', c: '#c58f3a', o: 0.62 },
    { p: '40,30 68,30 52,41.5', c: '#fbe3a0', o: 1 },
    { p: '52,41.5 68,30 68,41.5', c: '#b4772e', o: 0.55 },
    { p: '23,41.5 34.5,41.5 23,60', c: '#edbf63', o: 0.9 },
    { p: '34.5,41.5 34.5,76.5 23,60', c: '#b98332', o: 0.58 },
    { p: '23,60 34.5,76.5 23,76.5', c: '#e2a94c', o: 0.78 },
    { p: '52,20 63.5,20 52,45', c: '#f9dd93', o: 1 },
    { p: '63.5,20 63.5,50 52,45', c: '#d19a3c', o: 0.7 },
    { p: '52,45 63.5,50 52,82', c: '#e9b85a', o: 0.88 },
    { p: '63.5,50 63.5,82 52,82', c: '#a06f28', o: 0.5 },
    { p: '63.5,58 80,40 88,48', c: '#f4c96e', o: 0.95 },
    { p: '63.5,58 88,48 71.5,64', c: '#e2893f', o: 0.66 },
    { p: '63.5,68 71.5,63 88,81', c: '#dfa84a', o: 0.82 },
    { p: '63.5,68 88,81 80,89', c: '#c46b3a', o: 0.52 },
  ];
}
