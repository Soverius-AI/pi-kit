import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { copyToClipboard } from '@copilotkit/shared';
import { TranslocoPipe } from '@pi-kit/i18n';
import { highlight } from './markdown';

/** A stable code block with a keyboard-accessible copy control; copying always uses the original source. */
@Component({
  selector: 'pk-code-block',
  imports: [TranslocoPipe],
  host: { class: 'pk-code-block block' },
  template: `
    <div class="pk-code-toolbar">
      <span>{{ language() || ('chat.markdown.code' | transloco) }}</span>
      <button type="button" class="pk-markdown-action" (click)="copy()">
        {{ (copied() ? 'chat.markdown.copied' : 'chat.markdown.copyCode') | transloco }}
      </button>
    </div>
    <pre><code class="hljs" [innerHTML]="html()"></code></pre>
    @if (failed()) {
      <span class="pk-code-error" role="status">{{ 'chat.markdown.copyError' | transloco }}</span>
    }
  `,
})
export class CodeBlock {
  readonly code = input.required<string>();
  readonly language = input('');
  protected readonly html = computed(() => highlight(this.code(), this.language()).html);
  protected readonly copied = signal(false);
  protected readonly failed = signal(false);
  private resetTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.destroyRef.onDestroy(() => clearTimeout(this.resetTimer));
  }

  protected async copy(): Promise<void> {
    const success = await copyToClipboard(this.code());
    if (this.destroyRef.destroyed) return;
    clearTimeout(this.resetTimer);
    this.copied.set(success);
    this.failed.set(!success);
    this.resetTimer = setTimeout(() => this.copied.set(false), 2000);
  }
}
