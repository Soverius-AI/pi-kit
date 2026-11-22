import { Component, computed, input, output } from '@angular/core';
import type { PkNoticeTone } from './notice';

export interface PkDiagnostic {
  level: PkNoticeTone;
  message: string;
}

@Component({
  selector: 'pk-diagnostics',
  host: {
    class: 'alert alert-soft mt-4 flex items-start gap-3 text-sm',
    '[class.alert-info]': "tone() === 'info'",
    '[class.alert-warning]': "tone() === 'warning'",
    '[class.alert-error]': "tone() === 'error'",
    '[attr.role]': "tone() === 'error' ? 'alert' : 'status'",
    '[attr.data-tone]': 'tone()',
    'data-testid': 'session-diagnostics',
  },
  template: `
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <span class="font-medium">{{ title() }}</span>
      <ul class="flex flex-col gap-1">
        @for (item of items(); track $index) {
          <li class="flex items-baseline gap-2" [attr.data-level]="item.level">
            <span
              class="badge badge-xs shrink-0"
              [class.badge-error]="item.level === 'error'"
              [class.badge-warning]="item.level === 'warning'"
              [class.badge-info]="item.level === 'info'"
              >{{ levelLabels()[item.level] }}</span
            >
            <code class="mono text-xs wrap-anywhere">{{ item.message }}</code>
          </li>
        }
      </ul>
    </div>
    <button
      type="button"
      class="btn btn-ghost btn-xs"
      data-testid="session-diagnostics-dismiss"
      (click)="dismissed.emit()"
    >
      {{ dismissLabel() }}
    </button>
  `,
})
export class PkDiagnostics {
  readonly title = input.required<string>();
  readonly items = input.required<PkDiagnostic[]>();
  readonly levelLabels = input.required<Record<PkNoticeTone, string>>();
  readonly dismissLabel = input.required<string>();
  readonly dismissed = output<void>();

  protected readonly tone = computed<PkNoticeTone>(() => {
    const levels = this.items().map((item) => item.level);
    if (levels.includes('error')) return 'error';
    if (levels.includes('warning')) return 'warning';
    return 'info';
  });
}
