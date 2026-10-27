import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { PkIcon } from './icon';

export interface PkCrumb {
  label: string;
  /** `info` marks a fork point (doc/docs/design-system.md, "Breadcrumb strip"). */
  tone?: 'info' | 'default';
  title?: string;
  /** `branch`: the git branch of a thread's worktree, with the branch glyph before it. */
  icon?: 'branch';
}

/**
 * The 28px strip above the transcript (doc/docs/design-system.md, "Breadcrumb strip"): the crumbs of
 * the active path, with fork points in the info colour, and a trailing note (projected) that is hidden on
 * phones.
 */
@Component({
  selector: 'pk-breadcrumb-strip',
  imports: [PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-crumbs', role: 'navigation', '[attr.aria-label]': "i18n.t('shared.breadcrumbStrip.sessionPath')" },
  template: `
    @for (crumb of crumbs(); track $index; let last = $last) {
      @if (crumb.icon === 'branch') {
        <span class="pk-branch-crumb truncate" [title]="crumb.title ?? crumb.label" data-testid="branch-crumb">
          <pk-icon name="git-branch" />
          <span class="truncate">{{ crumb.label }}</span>
        </span>
      } @else {
        <span class="truncate" [class.text-info]="crumb.tone === 'info'" [title]="crumb.title ?? crumb.label">{{
          crumb.label
        }}</span>
      }
      @if (!last) {
        <span aria-hidden="true">›</span>
      }
    }
    <span class="ml-auto pk-hide-sm truncate"><ng-content /></span>
    <span class="pk-crumb-end"><ng-content select="[crumbEnd]" /></span>
  `,
})
export class PkBreadcrumbStrip {
  protected readonly i18n = inject(Language);
  readonly crumbs = input.required<PkCrumb[]>();
}
