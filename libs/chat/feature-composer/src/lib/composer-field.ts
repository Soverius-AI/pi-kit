import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { PkCommandMenu } from '@pi-kit/design-system';
import { ChatStore } from '@pi-kit/chat/data';
import { UiStore } from '@pi-kit/data-access';

/**
 * The `textArea` slot of `CopilotChatInput`: pi-kit's textarea. It renders the draft of `ChatStore`, grows
 * with its text up to 200px, shows the `/`, `@` and argument menu of the store above the well, and forwards what happens in it:
 * keys (menus, Enter to send, ↑ to recall), the caret, pasted images. It decides nothing itself.
 *
 * CopilotKit's input would hand Enter to its own `send()`, which ignores a message that is only an image; the key goes to the store's
 * pipeline instead, so the slot never calls the `onKeyDown` it is given.
 */
@Component({
  selector: 'pk-composer-field',
  imports: [PkCommandMenu, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (chat.menuOpen()) {
      <pk-command-menu
        [groups]="chat.menuGroups()"
        [selectedId]="chat.menuSelected()"
        [head]="chat.menuHead()"
        [empty]="chat.menuEmpty()"
        idPrefix="pk-composer-opt-"
        (pick)="chat.pickMenuItem($event.id)"
        (hover)="chat.selectMenuItem($event.id)"
      />
    }
    <div class="relative">
      @if (chat.followUp(); as suggestion) {
        <div
          #ghost
          class="pk-follow-up-ghost"
          aria-hidden="true"
          data-testid="follow-up-ghost"
          [textContent]="suggestion.text"
        ></div>
      }
      <textarea
        #field
        rows="2"
        [attr.aria-label]="'chat.composerField.messageToPi' | transloco"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        [attr.placeholder]="chat.followUp() ? '' : chat.placeholder()"
        [attr.aria-expanded]="chat.menuOpen()"
        aria-controls="pk-composer-menu"
        [attr.aria-activedescendant]="chat.menuSelected() ? 'pk-composer-opt-' + chat.menuSelected() : null"
        [disabled]="!chat.threadId()"
        [value]="chat.draft()"
        (input)="onInput()"
        (keydown)="onKey($event)"
        (keyup)="chat.setCaret(field.selectionStart)"
        (click)="chat.setCaret(field.selectionStart)"
        (paste)="onPaste($event)"
      ></textarea>
      @if (chat.followUp()) {
        <div class="flex items-center gap-2 px-3 pb-2 t-xs muted" data-testid="follow-up-actions">
          <button type="button" class="btn btn-ghost btn-xs" (click)="chat.acceptFollowUp()">
            {{ 'chat.followUp.accept' | transloco }}
          </button>
          <button type="button" class="btn btn-ghost btn-xs" (click)="chat.dismissFollowUp()">
            {{ 'chat.followUp.dismiss' | transloco }}
          </button>
          <span class="sr-only" role="status">{{ chat.followUp()?.text }}</span>
        </div>
      }
    </div>
  `,
  styles: `
    .pk-follow-up-ghost {
      position: absolute;
      inset: 0 0 auto;
      padding: 12px 16px 4px;
      font: inherit;
      font-size: 15px;
      line-height: 24px;
      opacity: 0.5;
      pointer-events: none;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
})
export class ComposerField {
  protected readonly chat = inject(ChatStore);
  private readonly bus = inject(UiStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly field = viewChild.required<ElementRef<HTMLTextAreaElement>>('field');
  private readonly ghost = viewChild<ElementRef<HTMLElement>>('ghost');

  constructor() {
    // Grow with the text up to 200px, then scroll.
    effect(() => {
      this.chat.draft();
      this.chat.followUp();
      queueMicrotask(() => this.fit());
    });
    afterNextRender(() => {
      const field = this.field().nativeElement;
      let width = field.clientWidth;
      const resize = new ResizeObserver(() => {
        if (field.clientWidth === width) return;
        width = field.clientWidth;
        this.fit();
      });
      resize.observe(field);
      this.destroyRef.onDestroy(() => resize.disconnect());
      this.fit();
    });

    // The store replaced the draft and wants the caret somewhere (a menu entry, an inserted `@path`).
    effect((onCleanup) => {
      const request = this.chat.caretRequest();
      if (!request) return;
      const focused = document.activeElement;
      const timer = untracked(() =>
        setTimeout(() => {
          const el = this.field().nativeElement;
          el.setSelectionRange(request.pos, request.pos);
          // A later click or popup owns focus even if this draft update is still pending.
          if (document.activeElement === focused || document.activeElement === el) el.focus();
        }),
      );
      onCleanup(() => clearTimeout(timer));
    });
    // A new thread, ⌘N and the palette hand the focus to the composer.
    effect(() => {
      this.bus.composerFocus();
      this.chat.threadId();
      queueMicrotask(() => this.field().nativeElement.focus());
    });
  }

  /** A template handler that returns `false` makes Angular cancel the key, so the store's answer (was it dealt with) is not returned. */
  protected onKey(event: KeyboardEvent): void {
    this.chat.handleKey(event);
  }

  protected onInput(): void {
    const el = this.field().nativeElement;
    this.chat.setDraft(el.value);
    this.chat.setCaret(el.selectionStart);
    this.fit();
  }

  protected onPaste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    event.preventDefault();
    void this.chat.addImages(files);
  }

  private fit(): void {
    const el = this.field().nativeElement;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, this.ghost()?.nativeElement.scrollHeight ?? 0), 200)}px`;
  }
}
