import { TranslocoPipe } from '@pi-kit/i18n';
import { Component, inject } from '@angular/core';
import { UiStore } from '@pi-kit/data-access';

@Component({
  selector: 'pk-preview-prompt',
  imports: [TranslocoPipe],
  template: `
    @if (bus.previewPrompt()) {
      <div role="status" class="alert alert-soft alert-info text-sm max-w-sm" data-testid="preview-prompt">
        <div class="flex flex-col gap-2">
          <span>{{ 'artifacts.preview.autoOpenQuestion' | transloco }}</span>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-primary btn-xs" (click)="bus.setPreviewAutoOpen('always')">
              {{ 'artifacts.preview.autoOpenAlways' | transloco }}
            </button>
            <button type="button" class="btn btn-ghost btn-xs" (click)="bus.dismissPreviewPrompt()">
              {{ 'artifacts.preview.autoOpenNotNow' | transloco }}
            </button>
            <button type="button" class="btn btn-ghost btn-xs" (click)="bus.setPreviewAutoOpen('never')">
              {{ 'artifacts.preview.autoOpenNever' | transloco }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class PreviewPrompt {
  protected readonly bus = inject(UiStore);
}
