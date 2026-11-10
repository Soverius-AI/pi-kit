import { Component, input } from '@angular/core';
import { PkAnsiText } from './ansi-text';

@Component({
  selector: 'pk-tool-output',
  imports: [PkAnsiText],
  host: { class: 'block pk-out term', 'data-testid': 'tool-output' },
  template: `
    @if (note()) {
      <div class="meta">{{ note() }}</div>
    }
    <pre><pk-ansi-text [text]="text()" />@if (live()) {<span class="animate-pulse">▌</span>}</pre>
  `,
})
export class PkToolOutput {
  readonly text = input.required<string>();
  readonly note = input<string>();
  readonly live = input(false);
}
