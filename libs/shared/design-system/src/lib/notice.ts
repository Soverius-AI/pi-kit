import { Component, input } from '@angular/core';

export type PkNoticeTone = 'info' | 'warning' | 'error';

@Component({
  selector: 'pk-notice',
  host: {
    class: 'alert alert-soft mt-4 flex flex-col items-start gap-1 text-sm',
    '[class.alert-info]': "tone() === 'info'",
    '[class.alert-warning]': "tone() === 'warning'",
    '[class.alert-error]': "tone() === 'error'",
    '[attr.role]': "tone() === 'error' ? 'alert' : null",
    '[attr.data-tone]': 'tone()',
  },
  template: `
    <span>{{ text() }}</span>
    @if (detail()) {
      <code class="mono text-xs wrap-anywhere" data-testid="notice-detail">{{ detail() }}</code>
    }
  `,
})
export class PkNotice {
  readonly tone = input<PkNoticeTone>('info');
  readonly text = input.required<string>();
  readonly detail = input<string>();
}
