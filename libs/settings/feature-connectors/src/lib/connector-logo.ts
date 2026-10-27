import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { pkIconMask } from '@pi-kit/design-system';
import type { Connector } from '@pi-kit/protocol';

/** The connector's mark: monochrome paths on a 24 grid as an icon mask, drawn in the text colour (never markup from the catalog). */
@Component({
  selector: 'pk-connector-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-icon', '[style.--icon]': 'mask()', 'aria-hidden': 'true' },
  template: '',
})
export class ConnectorLogo {
  readonly connector = input.required<Connector>();
  protected readonly mask = computed(() => {
    const logo = this.connector().logo;
    return pkIconMask(logo.paths, logo.style === 'fill' ? 'fill' : 'stroke');
  });
}
