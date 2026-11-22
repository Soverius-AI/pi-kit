import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { BrandLogosStore } from '@pi-kit/settings/api';

/** Composio's logo of an app, or its initial until the logo has loaded or when there is none. */
@Component({
  selector: 'pk-composio-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
  styles: `
    :host {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      flex: none;
      border-radius: 5px;
      background: var(--color-base-200);
      font-size: 11px;
      font-weight: 600;
    }
    img {
      width: 18px;
      height: 18px;
      object-fit: contain;
    }
  `,
  template: `
    @if (src(); as src) {
      <img [src]="src" alt="" />
    } @else {
      {{ name().slice(0, 1).toUpperCase() }}
    }
  `,
})
export class ComposioLogo {
  private readonly logos = inject(BrandLogosStore);
  readonly toolkit = input.required<string>();
  readonly name = input.required<string>();
  protected readonly src = computed(() => this.logos.logos()[this.toolkit()]);
}
