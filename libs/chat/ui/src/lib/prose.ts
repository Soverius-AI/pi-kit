import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { MarkdownService } from './markdown';

/** Assistant text as markdown in the transcript's prose style; a blinking caret follows it while it streams. */
@Component({
  selector: 'pk-prose',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `<div class="prose" [class.pk-caret]="streaming()" [innerHTML]="html()"></div>`,
})
export class Prose {
  readonly text = input.required<string>();
  readonly streaming = input(false);
  private readonly markdown = inject(MarkdownService);
  protected readonly html = computed(() =>
    this.streaming() ? this.markdown.render(this.text()) : this.markdown.renderCached(this.text()),
  );
}
