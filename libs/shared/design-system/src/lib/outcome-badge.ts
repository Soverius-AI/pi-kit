import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { PkIcon } from './icon';

/** How a thread ended: a worktree merged back, commits made in its folder, a pull request. */
export type PkOutcomeKind = 'merged' | 'committed' | 'pr';

/**
 * The outcome badge (doc/docs/design-system.md, "Outcome badge"): a muted 16px glyph in the style of the state badges, a git-merge glyph for
 * `merged`, a commit dot for `committed`, a pull-request glyph for `pr`. It is a button: the host opens the badge's menu (`pressed` carries the click,
 * whose `currentTarget` is the anchor of the menu). The tooltip says what happened and when.
 */
@Component({
  selector: 'pk-outcome-badge',
  imports: [PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <button
      type="button"
      class="pk-outcome"
      [attr.data-kind]="kind()"
      data-testid="outcome-badge"
      aria-haspopup="menu"
      [title]="title()"
      [attr.aria-label]="title()"
      (click)="pressed.emit($event)"
    >
      @switch (kind()) {
        @case ('merged') {
          <pk-icon name="git-merge" />
        }
        @case ('pr') {
          <pk-icon name="git-pull-request" />
        }
        @default {
          <pk-icon name="git-commit" />
        }
      }
    </button>
  `,
})
export class PkOutcomeBadge {
  readonly kind = input.required<PkOutcomeKind>();
  /** What happened and when ("Merged into main as a1b2c3d, 2 h ago"); also the accessible name. */
  readonly title = input.required<string>();
  readonly pressed = output<MouseEvent>();
}
