import { ChangeDetectionStrategy, Component, input, numberAttribute } from '@angular/core';
import type { PkIconName } from './icon-names';

export * from './icon-names';

/**
 * An icon of the design system: `src/icons/<name>.svg`, built into `icons.css` by `scripts/build-icons.mjs`. It is no SVG in the DOM: `.pk-icon` paints
 * `currentColor` through the icon as a CSS mask, so `color` tints it like text and a theme needs no extra rules. 16px unless `size` or the stylesheet
 * says otherwise. Decorative by default; with a `label` it is an image with that name.
 */
@Component({
  selector: 'pk-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-icon',
    '[style.--icon]': '"var(--pk-icon-" + name() + ")"',
    '[style.--pk-icon-size]': 'size() ? size() + "px" : null',
    '[attr.role]': 'label() ? "img" : null',
    '[attr.aria-label]': 'label() || null',
    '[attr.aria-hidden]': 'label() ? null : "true"',
  },
  template: '',
})
export class PkIcon {
  readonly name = input.required<PkIconName>();
  readonly size = input(undefined, {
    transform: (v: unknown) => (v == null || v === '' ? undefined : numberAttribute(v)),
  });
  readonly label = input<string>();
}

/**
 * A mask for marks that arrive as data (a connector's logo from the catalog): the paths on a 24 grid, stroked or filled, as the CSS `url()` that
 * `--icon` of a `.pk-icon` takes. Only path data goes in, never markup.
 */
export function pkIconMask(paths: readonly string[], style: 'stroke' | 'fill', strokeWidth = 1.6): string {
  const paint =
    style === 'fill'
      ? "fill='%23000'"
      : `fill='none' stroke='%23000' stroke-width='${strokeWidth}' stroke-linecap='round' stroke-linejoin='round'`;
  const body = paths.map((d) => `%3Cpath d='${encodeURIComponent(d)}'/%3E`).join('');
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' ${paint}%3E${body}%3C/svg%3E")`;
}
