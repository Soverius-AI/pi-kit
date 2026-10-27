import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * One turn of the transcript (doc/docs/design-system.md, "Turn"): a single body column and nothing in a gutter. A user turn's body is a
 * base-100 block (`.pk-user` inside) and is the only marker of who spoke; an assistant turn is plain prose with no mark. Captions
 * (`.pk-when`) and the usage line (`.pk-usage`) inside the body show on hover or focus of the turn. The turns are spaced 32px apart by
 * the sibling rule on `.pk-turn`, so they have to be adjacent siblings.
 */
@Component({
  selector: 'pk-turn',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-turn', '[attr.data-role]': 'role()' },
  template: `<div class="body"><ng-content /></div>`,
})
export class PkTurn {
  readonly role = input<'user' | 'pi'>('pi');
}
