import { TranslocoPipe } from '@pi-kit/i18n';
import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * An extension asking the user (doc/docs/design-system.md, "Approval"): the only element allowed to use the
 * warning fill at rest. By default it is a yes/no question with two buttons; for a choice or a text field
 * project the controls into `[controls]` and set `stacked` so they sit under the question.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-approval',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-approval', '[class.stack]': 'stacked()', role: 'group', '[attr.aria-label]': 'question()' },
  template: `
    <div class="min-w-0 flex-1">
      <div class="q">{{ question() }}</div>
      @if (detail()) {
        <div class="detail">{{ detail() }}</div>
      }
      @if (from()) {
        <div class="from">{{ from() }}</div>
      }
      @if (hint()) {
        <div class="hint">{{ hint() }}</div>
      }
    </div>
    <div class="flex gap-2 shrink-0 flex-wrap items-center">
      <ng-content select="[controls]" />
      @if (!stacked() && confirm()) {
        <button type="button" class="btn btn-sm" (click)="deny.emit()">
          {{ denyLabel() ?? ('shared.approval.deny' | transloco) }}
        </button>
        <button type="button" class="btn btn-sm btn-warning" (click)="allow.emit()">
          {{ allowLabel() ?? ('shared.approval.allow' | transloco) }}
        </button>
      }
    </div>
  `,
})
export class PkApproval {
  protected readonly i18n = inject(Language);
  readonly question = input.required<string>();
  readonly detail = input<string | undefined>(undefined);
  readonly from = input<string | undefined>(undefined);
  /** A second muted line: how long the question waits (the extension's timeout) and the keys that answer it. */
  readonly hint = input<string | undefined>(undefined);
  readonly stacked = input(false);
  /** Show the Allow / Deny pair (a yes/no question). */
  readonly confirm = input(true);
  readonly allowLabel = input<string>();
  readonly denyLabel = input<string>();
  readonly allow = output<void>();
  readonly deny = output<void>();
}
