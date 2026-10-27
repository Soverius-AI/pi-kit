import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { OutcomeMenuStore, ScoreStore } from '@pi-kit/threads/data';
import { PkContextMenu } from '@pi-kit/ui';

/**
 * The one place the outcome badge's menu is drawn: the badge on a sidebar row and the one at the end of the breadcrumb strip both ask
 * `OutcomeMenuStore` to open it, and this host, which lives in the shell outside the drawer and the panels, shows the context menu at the badge.
 */
@Component({
  selector: 'pk-outcome-menu',
  imports: [PkContextMenu, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (menu.open(); as at) {
      <pk-context-menu
        [items]="menu.items()"
        [x]="at.x"
        [y]="at.y"
        [label]="'threads.outcomeMenuHost.outcome' | transloco"
        (chosen)="menu.choose($event)"
        (dismissed)="menu.close()"
      />
    }
  `,
})
export class OutcomeMenuHost {
  protected readonly menu = inject(OutcomeMenuStore);
  /** Created here so "Score this thread" is in the menu. */
  private readonly score = inject(ScoreStore);
}
