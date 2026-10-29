import { Component, input, output } from '@angular/core';
import { PkDiffTotals } from './diff-totals';
import { PkIcon } from './icon';

@Component({
  selector: 'pk-changes-pill',
  imports: [PkDiffTotals, PkIcon],
  host: { class: 'contents' },
  template: `
    <button
      type="button"
      class="pk-changes-pill t-xs"
      data-testid="changes-pill"
      [title]="title()"
      [attr.aria-label]="title()"
      (click)="pressed.emit()"
    >
      <pk-icon name="git-branch" size="14" />
      <pk-diff-totals [added]="added()" [removed]="removed()" />
    </button>
  `,
})
export class PkChangesPill {
  readonly added = input.required<number>();
  readonly removed = input.required<number>();
  readonly title = input.required<string>();
  readonly pressed = output<void>();
}
