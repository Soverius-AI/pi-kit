import { Component, input } from '@angular/core';

@Component({
  selector: 'pk-diff-totals',
  host: { class: 'pk-diff-totals' },
  template: `
    <span class="text-success">+{{ added() }}</span>
    <span class="text-error">−{{ removed() }}</span>
  `,
})
export class PkDiffTotals {
  readonly added = input.required<number>();
  readonly removed = input.required<number>();
}
