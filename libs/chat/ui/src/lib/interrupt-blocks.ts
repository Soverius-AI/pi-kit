import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { PkApproval } from '@pi-kit/design-system';
import type { PiDialogAnswer, PiDialogRequest } from '@pi-kit/protocol';

/** Who asked, in the muted line of every block: "Asked by an extension · git-guard · while running bash", or "Question from agent reviewer". */
export function askedBy(translate: Translate, request: PiDialogRequest): string {
  const parts = [
    request.agent
      ? translate('chat.interruptBlocks.questionFromAgent', { value1: request.agent })
      : translate('chat.interruptBlocks.askedByAnExtension', { value1: request.source ? ` · ${request.source}` : '' }),
  ];
  if (request.tool) parts.push(translate('chat.interruptBlocks.whileRunning', { value1: request.tool }));
  return parts.join(' · ');
}

const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Enter must not answer a question the user did not see yet: a key pressed while the block appears is for whatever had the focus before. */
const ARM_MS = 400;

/**
 * What every block of an extension's question has in common: the request, a hint line (the extension's timeout
 * counting down, then the keys), and two outputs, an answer and "dismissed" (which the host sends as pi's `cancelled`). The four
 * `ExtensionUIContext` dialogs are one block each, in the order of the table: confirm, select, input, editor.
 */
@Directive()
abstract class DialogBlock {
  protected readonly i18n = inject(Language);
  readonly request = input.required<PiDialogRequest>();
  /** The timeout, as the host counts it down ("pi continues without an answer in 0:28"); empty when the request has none. */
  readonly timeout = input<string | undefined>(undefined);
  readonly answered = output<PiDialogAnswer>();
  readonly dismissed = output<void>();

  protected readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly from = computed(() => askedBy(this.i18n.t, this.request()));
  protected readonly armedAt = Date.now() + ARM_MS;

  protected abstract get keys(): string;
  protected readonly hint = computed(() => [this.timeout(), this.keys].filter(Boolean).join(' · '));

  /** Moves the focus into the block once it is drawn (the element to focus is found by `selector`; the block itself when none matches). */
  protected focusOnDraw(selector: string): void {
    afterNextRender(() => {
      const el = this.host.nativeElement;
      (el.querySelector<HTMLElement>(selector) ?? el.querySelector<HTMLElement>('pk-approval'))?.focus();
    });
  }
}

/** `ctx.ui.confirm(title, message)`: Allow / Deny. ⏎ allows, Esc denies. */
@Component({
  selector: 'pk-confirm-block',
  imports: [PkApproval],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents', 'data-dialog': 'confirm' },
  template: `
    <pk-approval
      tabindex="-1"
      [question]="request().title"
      [detail]="request().message"
      [from]="from()"
      [hint]="hint()"
      (allow)="answered.emit({ confirmed: true })"
      (deny)="answered.emit({ confirmed: false })"
      (keydown)="onKey($event)"
    />
  `,
})
export class ConfirmBlock extends DialogBlock {
  protected get keys() {
    return this.i18n.t('chat.interruptBlocks.enterAllowsEscDenies');
  }

  constructor() {
    super();
    this.focusOnDraw('pk-approval');
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.answered.emit({ confirmed: false });
    } else if (
      event.key === 'Enter' &&
      !(event.target as HTMLElement).closest('button') &&
      Date.now() >= this.armedAt
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.answered.emit({ confirmed: true });
    }
  }
}

/** `ctx.ui.select(title, options)`: the options as a list, the first one highlighted. ↑ ↓ Home End move, ⏎ or a number picks, Esc cancels. */
@Component({
  selector: 'pk-select-block',
  imports: [PkApproval, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents', 'data-dialog': 'select' },
  template: `
    <pk-approval
      tabindex="-1"
      [question]="request().title"
      [detail]="request().message"
      [from]="from()"
      [hint]="hint()"
      [stacked]="true"
      (keydown)="onKey($event)"
    >
      <div controls class="flex flex-col gap-1 w-full">
        @for (option of options(); track $index) {
          <button
            type="button"
            class="btn btn-sm justify-start gap-3 font-normal"
            [class.btn-warning]="$index === active()"
            [attr.data-option]="option"
            [attr.aria-keyshortcuts]="$index < 9 ? $index + 1 : null"
            (click)="answered.emit({ value: option })"
            (focus)="active.set($index)"
            (mousemove)="hover($event, $index)"
          >
            <kbd class="kbd kbd-xs" aria-hidden="true">{{ $index < 9 ? $index + 1 : '·' }}</kbd>
            <span class="truncate">{{ option }}</span>
          </button>
        } @empty {
          <p class="text-sm muted">{{ 'chat.interruptBlocks.theExtensionOfferedNoOptions' | transloco }}</p>
        }
        <div class="flex justify-end pt-1">
          <button type="button" class="btn btn-sm btn-ghost" (click)="dismissed.emit()">
            {{ 'chat.interruptBlocks.cancel' | transloco }}
          </button>
        </div>
      </div>
    </pk-approval>
  `,
})
export class SelectBlock extends DialogBlock {
  protected get keys() {
    return this.i18n.t('chat.interruptBlocks.moveEnterOrANumberPicksEsc');
  }
  protected readonly options = computed(() => this.request().options ?? []);
  /** The highlighted option: the first one until the user moves (pi's `select` names no default). */
  protected readonly active = signal(0);

  constructor() {
    super();
    this.focusOnDraw('[data-option]');
  }

  /** The highlight and the focus are one thing (Enter picks the focused option), so pointing at an option focuses it. */
  protected hover(event: MouseEvent, index: number): void {
    if (this.active() !== index) (event.currentTarget as HTMLElement).focus();
  }

  protected onKey(event: KeyboardEvent): void {
    const count = this.options().length;
    const move = (to: number): void => {
      event.preventDefault();
      event.stopPropagation();
      if (count === 0) return;
      const next = (to + count) % count;
      this.active.set(next);
      this.host.nativeElement.querySelectorAll<HTMLElement>('[data-option]')[next]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return move(this.active() + 1);
      case 'ArrowUp':
        return move(this.active() - 1);
      case 'Home':
        return move(0);
      case 'End':
        return move(count - 1);
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        return this.dismissed.emit();
      default:
        if (
          /^[1-9]$/.test(event.key) &&
          Number(event.key) <= count &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          event.preventDefault();
          event.stopPropagation();
          this.answered.emit({ value: this.options()[Number(event.key) - 1] });
        }
    }
  }
}

/** `ctx.ui.input(title, placeholder)`: one line with the placeholder; an empty answer gets a message instead of being sent. ⏎ submits, Esc cancels. */
@Component({
  selector: 'pk-input-block',
  imports: [PkApproval, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents', 'data-dialog': 'input' },
  template: `
    <pk-approval
      tabindex="-1"
      [question]="request().title"
      [detail]="request().message"
      [from]="from()"
      [hint]="hint()"
      [stacked]="true"
      (keydown.escape)="cancel($event)"
    >
      <form controls class="flex flex-col gap-2 w-full" novalidate (submit)="submit($event, field.value)">
        <div class="flex gap-2 w-full">
          <input
            #field
            class="input input-sm flex-1"
            [class.input-error]="error()"
            type="text"
            [placeholder]="request().placeholder ?? ''"
            [attr.aria-label]="request().title"
            [attr.aria-invalid]="error() ? 'true' : null"
            [attr.aria-describedby]="error() ? 'dialog-error-' + id : null"
            (input)="error.set(undefined)"
          />
          <button type="button" class="btn btn-sm btn-ghost" (click)="dismissed.emit()">
            {{ 'chat.interruptBlocks.cancel' | transloco }}
          </button>
          <button type="submit" class="btn btn-sm btn-warning">{{ 'chat.interruptBlocks.submit' | transloco }}</button>
        </div>
        @if (error(); as message) {
          <p class="text-xs text-error" role="alert" [id]="'dialog-error-' + id">{{ message }}</p>
        }
      </form>
    </pk-approval>
  `,
})
export class InputBlock extends DialogBlock {
  private static nextId = 0;
  protected readonly id = ++InputBlock.nextId;
  protected get keys() {
    return this.i18n.t('chat.interruptBlocks.enterSubmitsEscCancels');
  }
  protected readonly error = signal<string | undefined>(undefined);

  constructor() {
    super();
    this.focusOnDraw('input');
  }

  protected submit(event: Event, value: string): void {
    event.preventDefault();
    if (!value.trim()) return this.error.set(this.i18n.t('chat.interruptBlocks.typeAnAnswerOrCancel'));
    this.answered.emit({ value });
  }

  protected cancel(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.dismissed.emit();
  }
}

/** `ctx.ui.editor(title, prefill)`: a multiline editor with the text pre-filled. ⌘⏎ submits, Esc cancels. */
@Component({
  selector: 'pk-editor-block',
  imports: [PkApproval, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents', 'data-dialog': 'editor' },
  template: `
    <pk-approval
      tabindex="-1"
      [question]="request().title"
      [detail]="request().message"
      [from]="from()"
      [hint]="hint()"
      [stacked]="true"
      (keydown)="onKey($event, area.value)"
    >
      <div controls class="flex flex-col gap-2 w-full">
        <textarea
          #area
          class="textarea w-full font-mono text-sm"
          rows="8"
          [attr.aria-label]="request().title"
          [value]="request().prefill ?? ''"
        ></textarea>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-sm btn-ghost" (click)="dismissed.emit()">
            {{ 'chat.interruptBlocks.cancel' | transloco }}
          </button>
          <button type="button" class="btn btn-sm btn-warning" (click)="answered.emit({ value: area.value })">
            {{ 'chat.interruptBlocks.submit' | transloco }} <kbd class="kbd kbd-xs" aria-hidden="true">{{ mod }}⏎</kbd>
          </button>
        </div>
      </div>
    </pk-approval>
  `,
})
export class EditorBlock extends DialogBlock {
  protected readonly mod = isMac() ? '⌘' : 'Ctrl+';
  protected get keys() {
    return this.i18n.t('chat.interruptBlocks.enterSubmitsEscCancels58c93', { value1: this.mod });
  }

  constructor() {
    super();
    this.focusOnDraw('textarea');
  }

  protected onKey(event: KeyboardEvent, value: string): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.dismissed.emit();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      this.answered.emit({ value });
    }
  }
}
