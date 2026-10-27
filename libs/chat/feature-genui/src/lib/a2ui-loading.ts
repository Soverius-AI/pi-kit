import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Shown by CopilotKit's surface until the first one is built (`provideCopilotKit({ a2ui: { loadingComponent } })`). */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-a2ui-loading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-2 p-3" role="status" [attr.aria-label]="'chat.a2uiLoading.generatingUI' | transloco">
      <div class="skeleton h-4 w-3/5"></div>
      <div class="skeleton h-4 w-2/5"></div>
    </div>
  `,
})
export class PkA2uiLoading {}
