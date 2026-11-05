import { Component, input } from '@angular/core';
import { PkIcon, type PkIconName } from './icon';
import { PkLogo } from './logo';

/**
 * An empty area that says what is missing and what to do: a mark (the pi-kit mark, or `icon`), a heading, an optional line of text, the
 * caller's actions (`[actions]`) and anything else projected below them, such as a short list to continue from.
 */
@Component({
  selector: 'pk-empty-state',
  imports: [PkIcon, PkLogo],
  host: { class: 'pk-empty-state' },
  template: `
    @if (icon(); as name) {
      <span class="mark" aria-hidden="true"><pk-icon [name]="name" size="24" /></span>
    } @else {
      <pk-logo class="brand" tone="gold" [size]="56" />
    }
    <h2>{{ heading() }}</h2>
    @if (text()) {
      <p>{{ text() }}</p>
    }
    <div class="actions"><ng-content select="[actions]" /></div>
    <ng-content />
  `,
})
export class PkEmptyState {
  readonly heading = input.required<string>();
  readonly text = input<string>();
  readonly icon = input<PkIconName>();
}
