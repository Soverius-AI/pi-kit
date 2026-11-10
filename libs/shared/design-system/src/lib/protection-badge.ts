import { Component, input } from '@angular/core';
import { PkIcon } from './icon';

export type PkProtectionMode = 'bypass' | 'sandboxed';

@Component({
  selector: 'pk-protection-badge',
  imports: [PkIcon],
  host: {
    class: 'relative inline-flex items-center',
    'data-testid': 'protection-badge',
    '[attr.data-mode]': 'mode()',
    '[attr.role]': 'label() ? "img" : null',
    '[attr.aria-label]': 'label() ?? null',
    '[attr.aria-hidden]': 'label() ? null : "true"',
  },
  template: `
    @if (busy()) {
      <span class="loading loading-spinner loading-xs"></span>
    } @else {
      <pk-icon [name]="mode() === 'sandboxed' ? 'lock' : 'lock-open'" [class.text-warning]="attention()" />
    }
    @if (attention()) {
      <span class="absolute -right-1 -top-1 size-1.5 rounded-full bg-warning"></span>
    }
  `,
})
export class PkProtectionBadge {
  readonly mode = input.required<PkProtectionMode>();
  readonly attention = input(false);
  readonly busy = input(false);
  readonly label = input<string>();
}
