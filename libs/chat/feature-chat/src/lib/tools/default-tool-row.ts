import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { PkActivityRow, PkLightboxService } from '@pi-kit/design-system';
import { ToolRowBase } from './tool-row-base';

/** Every other tool (MCP tools, extension tools): the name, a one-line summary of the arguments, the details when expanded. */
@Component({
  selector: 'pk-default-tool-row',
  imports: [PkActivityRow, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <pk-activity-row
      [tool]="name()"
      [state]="state()"
      [target]="summary()"
      [sub]="sub()"
      [expandable]="true"
      [(expanded)]="open"
    >
      <span stat>{{ took() }}</span>
      @if (open()) {
        <div class="pk-out term">
          <pre>{{ argsText() }}</pre>
          @if (result(); as r) {
            <pre>{{ r.content }}</pre>
          }
        </div>
      }
    </pk-activity-row>
    <!-- A screenshot the tool returned (the browser's, computer use): a thumbnail that opens full size in the lightbox. -->
    @for (image of info()?.images ?? []; track $index) {
      <button
        type="button"
        class="pk-thumb"
        data-testid="tool-image"
        [attr.aria-label]="'shared.lightbox.open' | transloco"
        (click)="preview('data:' + image.mimeType + ';base64,' + image.data)"
      >
        <img
          [src]="'data:' + image.mimeType + ';base64,' + image.data"
          [alt]="'chat.defaultToolRow.toolScreenshot' | transloco"
          loading="lazy"
          style="display: block; max-width: 100%; max-height: 32rem; object-fit: contain; margin-block: 0.5rem; border-radius: 0.5rem;"
        />
      </button>
    }
  `,
})
export class DefaultToolRow extends ToolRowBase {
  private readonly lightbox = inject(PkLightboxService);

  protected preview(src: string): void {
    this.lightbox.open({ src, caption: this.i18n.t('chat.defaultToolRow.toolScreenshot') });
  }

  protected readonly summary = computed(() => {
    const entries = Object.entries(this.args());
    if (entries.length === 0) return '';
    const [key, value] = entries[0];
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const first = text.split('\n')[0];
    return entries.length === 1 && typeof value === 'string' ? first : `${key}: ${first}`;
  });
  protected readonly argsText = computed(() => JSON.stringify(this.args(), null, 2));
}
