import { ChangeDetectionStrategy, Component, computed, effect, inject, input, untracked } from '@angular/core';
import { pkIconMask } from '@pi-kit/design-system';
import type { Connector } from '@pi-kit/protocol';
import { BrandLogosStore } from '@pi-kit/settings/api';

/** The connector's colour brand logo; until it loads, or without one, its monochrome mark from the catalog (paths, never markup). */
@Component({
  selector: 'pk-connector-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', class: 'contents' },
  styles: `
    img {
      width: 22px;
      height: 22px;
      padding: 3px;
      border-radius: 6px;
      background: #fff;
      object-fit: contain;
    }
  `,
  template: `
    @if (brand(); as src) {
      <img [src]="src" alt="" />
    } @else {
      <span class="pk-icon" [style.--icon]="mask()"></span>
    }
  `,
})
export class ConnectorLogo {
  private readonly logos = inject(BrandLogosStore);
  readonly connector = input.required<Connector>();
  protected readonly brand = computed(() => {
    const name = this.connector().brand;
    return name ? this.logos.logos()[name] : undefined;
  });
  protected readonly mask = computed(() => {
    const logo = this.connector().logo;
    return pkIconMask(logo.paths, logo.style === 'fill' ? 'fill' : 'stroke');
  });

  constructor() {
    effect(() => {
      const name = this.connector().brand;
      if (name) untracked(() => void this.logos.load([name]));
    });
  }
}
