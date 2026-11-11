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
      <pk-icon
        [name]="mode() === 'sandboxed' ? 'lock' : 'lock-open'"
        [class.text-warning]="attention()"
        [class.active]="active() && !attention()"
      />
    }
    @if (attention()) {
      <span class="absolute -right-1 -top-1 size-1.5 rounded-full bg-warning"></span>
    }
  `,
  // Mixed toward the text colour so the green stays bright on dark themes.
  styles: `
    .active {
      color: color-mix(in oklch, var(--color-success), var(--color-base-content) 30%);
      filter: saturate(1.4);
    }
  `,
})
export class PkProtectionBadge {
  readonly mode = input.required<PkProtectionMode>();
  readonly attention = input(false);
  readonly active = input(false);
  readonly busy = input(false);
  readonly label = input<string>();
}
