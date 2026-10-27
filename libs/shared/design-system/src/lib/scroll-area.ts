import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A named, keyboard-scrollable region that bounds a long list without growing its page.
 * Override maxHeight when the surrounding panel has a different space budget. */
@Component({
  selector: 'pk-scroll-area',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-scroll-area',
    role: 'region',
    tabindex: '0',
    '[attr.aria-label]': 'label()',
    '[style.max-height]': 'maxHeight()',
  },
  template: '<ng-content />',
})
export class PkScrollArea {
  readonly label = input.required<string>();
  readonly maxHeight = input('min(22rem, 42dvh)');
}
