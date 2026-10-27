import { TranslocoPipe } from '@pi-kit/i18n';
import { inject } from '@angular/core';
import { Language } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';
import { type CodeLanguage, tokenize } from './code-tokens';

/** Above this many characters the colours are skipped: the text is still editable, and the editor stays as quick as a textarea. */

/**
 * The text editor of the file dialogs (doc/docs/design-system.md "File editor"): line numbers, syntax colours, and the line an error is on
 * marked in the gutter. It is a plain `<textarea>` laid over a `<pre>` that draws the same text in colour, so selection, undo, the clipboard and the input method are the browser's. The
 * two share one font, one padding and one line height, and one scroll container; the textarea does not wrap (`wrap="off"`), so a line is a line. ⌘S / Ctrl+S asks the host to save, Enter
 * keeps the indentation of the line it leaves (and goes one level in after `{` or `[`). The editor knows nothing of files or validation: the host passes `errorLine`.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-code-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="pk-editor" #scroller>
      <div class="ln" aria-hidden="true">
        @for (n of numbers(); track n) {
          <span [class.err]="n === errorLine()">{{ n }}</span>
        }
      </div>
      <div class="code">
        <div class="sizer">
          <div class="hl" aria-hidden="true">
            @for (line of lines(); track $index) {
              <div class="row" [class.err-line]="$index + 1 === errorLine()">
                @for (token of line; track $index) {
                  <span [class]="token.kind">{{ token.text }}</span>
                }
              </div>
            }
          </div>
          <textarea
            #field
            class="field"
            wrap="off"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            [attr.aria-label]="label() ?? ('shared.codeEditor.fileText' | transloco)"
            [attr.aria-invalid]="errorLine() ? 'true' : null"
            [readOnly]="readonly()"
            [value]="value()"
            (input)="value.set(field.value)"
            (keydown)="onKey($event)"
          ></textarea>
        </div>
      </div>
    </div>
  `,
})
export class PkCodeEditor {
  protected readonly i18n = inject(Language);
  /** The text. */
  readonly value = model('');
  readonly language = input<CodeLanguage>('json');
  readonly highlightLimit = input(200_000);
  /** The 1-based line to mark as the one with the error. */
  readonly errorLine = input<number | undefined>(undefined);
  readonly readonly = input(false);
  readonly label = input<string>();
  /** ⌘S or Ctrl+S was pressed in the editor. */
  readonly saveRequested = output<void>();

  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');

  protected readonly lines = computed(() => {
    const text = this.value();
    return tokenize(text, text.length > this.highlightLimit() ? 'text' : this.language());
  });
  protected readonly numbers = computed(() => Array.from({ length: this.lines().length }, (_, i) => i + 1));

  /** Puts the caret at the start of a line and scrolls it into view (the host calls this for "go to the error"). */
  goToLine(line: number): void {
    const el = this.field().nativeElement;
    const text = el.value.split('\n');
    const offset = text.slice(0, Math.max(0, line - 1)).reduce((sum, l) => sum + l.length + 1, 0);
    el.focus();
    el.setSelectionRange(offset, offset);
  }

  focus(): void {
    this.field().nativeElement.focus();
  }

  protected onKey(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.saveRequested.emit();
      return;
    }
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      this.readonly() ||
      event.isComposing
    )
      return;
    const el = this.field().nativeElement;
    const { selectionStart, selectionEnd, value } = el;
    if (selectionStart !== selectionEnd) return;
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const before = value.slice(lineStart, selectionStart);
    const indent = /^[ \t]*/.exec(before)?.[0] ?? '';
    const opens = /[{[]\s*$/.test(before);
    const closes = /^\s*[}\]]/.test(value.slice(selectionStart));
    event.preventDefault();
    const extra = opens ? '  ' : '';
    const text = `\n${indent}${extra}${opens && closes ? `\n${indent}` : ''}`;
    // `insertText` keeps the browser's undo stack; the fallback does not.
    if (typeof document.execCommand !== 'function' || !document.execCommand('insertText', false, text)) {
      el.setRangeText(text, selectionStart, selectionEnd, 'end');
      this.value.set(el.value);
    }
    if (opens && closes) {
      const at = selectionStart + 1 + indent.length + extra.length;
      el.setSelectionRange(at, at);
    }
  }
}
