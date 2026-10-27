import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Full-width hairline with a short centred label (compaction, branch switch). */
@Component({
  selector: 'pk-marker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-marker', role: 'separator' },
  template: `<ng-content />`,
})
export class PkMarker {}
