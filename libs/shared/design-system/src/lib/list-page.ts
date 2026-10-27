import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The primitives of a list page (doc/docs/design-system.md "List pages"): the row of a configured thing, the choice tile of a wizard, and the usage bar. The
 * look is `.pk-item`, `.pk-choices` and `.pk-quota` in `components.css`; these components give them one shape so Providers, MCP servers and the pages after them cannot
 * drift apart.
 */

/**
 * One row of a list page: a 32px tile (`letters`, or a glyph in the `[tile]` slot), the name with its chips (`[nm]`), one detail line (`[ds]`), the actions on the right
 * (`[act]`: icon buttons, at most one text button) and, under the text, whatever the row opens (`[extra]`: a sign-in panel, a list of tools). The host is the row, so the
 * hairlines between rows are the stylesheet's.
 *
 *   <div pkItem letters="OR"><ng-container nm>OpenRouter <span class="chip ok">API key</span></ng-container><span ds>key ending in a1b2</span><button act …></button></div>
 */
@Component({
  // The host is the row itself, so the hairlines between rows keep working: an attribute selector on purpose.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: '[pkItem]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-item', '[class.off]': 'dimmed()' },
  template: `
    <div class="tile" [class.logo]="!!letters()" aria-hidden="true"><ng-content select="[tile]" />{{ letters() }}</div>
    <div class="min-w-0">
      <div class="nm"><ng-content select="[nm]" /></div>
      <div class="ds"><ng-content select="[ds]" /></div>
    </div>
    <div class="act"><ng-content select="[act]" /></div>
    <ng-content select="[extra]" />
  `,
})
export class PkItem {
  /** The letters of the tile; leave it out and fill `[tile]` with a glyph. */
  readonly letters = input('');
  /** A row that is switched off is drawn quieter, and still readable. */
  readonly dimmed = input(false);
}

/**
 * A choice tile of a wizard (`.pk-choices`, `.pk-gallery`): the tile, a title with its chips (`[t]`), one line under it (`[d]`). `recommended` outlines it in amber (pi's own
 * recommendation, e.g. Radius); `pressed` marks the one that is picked.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'button[pkChoice]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { type: 'button', '[class.rec]': 'recommended()', '[attr.aria-pressed]': 'pressed()' },
  template: `
    <span class="tile" [class.logo]="!!letters()" aria-hidden="true"
      ><ng-content select="[tile]" />{{ letters() }}</span
    >
    <span>
      <span class="t"><ng-content select="[t]" /></span>
      <span class="d"><ng-content select="[d]" /></span>
    </span>
  `,
})
export class PkChoice {
  readonly letters = input('');
  readonly recommended = input(false);
  readonly pressed = input(false);
}

/** `ok` below 80 %, `warn` from 80 %: the bar says "nearly used up" in colour, the words say how much. */
export function quotaTone(used: number): 'ok' | 'warn' {
  return used >= 80 ? 'warn' : 'ok';
}

/** The width of the bar: the share used, kept inside 0 to 100. */
export function quotaWidth(used: number): number {
  return Number.isFinite(used) ? Math.max(0, Math.min(100, Math.round(used))) : 0;
}

/**
 * Usage of a subscription window as a thin bar and words ("5-hour window 38 %, resets 14:30"). Nothing renders without a `name`: a provider that reports no usage shows no
 * bar and no words. The data is the provider's; this is only the shape.
 */
@Component({
  selector: 'pk-quota',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-quota', role: 'img', '[attr.aria-label]': 'words()' },
  template: `
    <span class="bar" aria-hidden="true"><i [class.warn]="tone() === 'warn'" [style.width.%]="width()"></i></span>
    <span aria-hidden="true">{{ words() }}</span>
  `,
})
export class PkQuota {
  protected readonly i18n = inject(Language);
  /** What the window is called: "5-hour window", "week". */
  readonly name = input.required<string>();
  /** The share used, 0 to 100. */
  readonly used = input.required<number>();
  /** When the window resets, as the provider says it ("14:30"). */
  readonly resets = input<string | undefined>(undefined);

  protected readonly width = computed(() => quotaWidth(this.used()));
  protected readonly tone = computed(() => quotaTone(this.used()));
  protected readonly words = computed(
    () =>
      `${this.name()} ${this.width()} %${this.resets() ? this.i18n.t('shared.listPage.resets', { value1: this.resets() }) : ''}`,
  );
}
