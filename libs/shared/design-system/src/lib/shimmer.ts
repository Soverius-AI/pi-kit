import { Language } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

/**
 * The loading shimmer (doc/docs/design-system.md, "Shimmer"): grey bars that sweep while a page's data is on its way, where a spinner would say
 * nothing about the shape of what comes. `rows` bars of staggered widths (a title-ish first one when `title` is set); the host is a status
 * region with the translated "Loading…" as its name. Use it in place of the content, not next to it.
 */
@Component({
  selector: 'pk-shimmer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-shimmer',
    role: 'status',
    'aria-busy': 'true',
    '[attr.aria-label]': "label() || i18n.t('shared.shimmer.loading')",
    'data-testid': 'shimmer',
  },
  template: `
    @for (width of bars(); track $index) {
      <span class="bar" [class.title]="title() && $index === 0" [style.width.%]="width" aria-hidden="true"></span>
    }
  `,
})
export class PkShimmer {
  protected readonly i18n = inject(Language);
  /** How many bars. */
  readonly rows = input(3);
  /** The first bar is a short, taller title. */
  readonly title = input(false);
  /** The accessible name; "Loading…" when not given. */
  readonly label = input('');
  protected readonly bars = computed(() =>
    Array.from({ length: Math.max(1, this.rows()) }, (_, i) =>
      this.title() && i === 0 ? 38 : [92, 76, 84, 64, 88][i % 5],
    ),
  );
}
