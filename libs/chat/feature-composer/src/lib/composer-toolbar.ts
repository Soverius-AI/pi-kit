import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, untracked, viewChild } from '@angular/core';
import { CopilotChatToolsMenu } from '@copilotkit/angular';
import { ChatStore, ComposerExtensions } from '@pi-kit/chat/data';
import { ContextRing } from './context-ring';
import { DeliverChip } from '@pi-kit/chat/ui';
import { ModelPicker } from './model-picker';
import { VoiceButton } from './voice-button';
import { PkIcon } from '@pi-kit/design-system';

/**
 * The `toolbar` slot of `CopilotChatInput`, as the compact toolbar of doc/docs/design-system.md, "Composer":
 * one row of 32px controls. On the left the tools pill (CopilotKit's tools menu ⊕, then `@` and `!` as 28px round buttons inside one pill), the
 * buttons pi extensions registered, the model and effort chips, and while pi runs the "Deliver: Steer" chip; then flexible space; on the right
 * the microphone, the context ring with its usage popover and one round button, amber ↑ to send, red ■ to stop. No text buttons; the
 * shortcuts are in the hint row. In the toolbar slot layout CopilotKit renders neither `additionalToolbarItems` nor the tools menu itself, so this
 * component draws both. The layout rules (the Deliver word dropping first, the chips shrinking, two rows under 768px) are CSS container
 * queries in `components.css`.
 */
@Component({
  selector: 'pk-composer-toolbar',
  imports: [CopilotChatToolsMenu, ContextRing, DeliverChip, ModelPicker, VoiceButton, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-toolbar compact' },
  template: `
    <input
      #fileInput
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp"
      multiple
      class="hidden"
      (change)="onFiles(fileInput)"
    />
    <div class="pk-tools" role="group" [attr.aria-label]="'chat.composerToolbar.insert' | transloco">
      <copilot-chat-tools-menu
        [inputToolsMenu]="chat.toolsMenu()"
        [inputDisabled]="!chat.threadId()"
        inputClass="btn btn-ghost"
      />
      @for (action of builtIn(); track action.id) {
        <button
          type="button"
          class="btn btn-ghost"
          [class.mono]="action.mono"
          [title]="action.label"
          [attr.aria-label]="action.label"
          [attr.data-action]="action.id"
          [attr.data-source]="action.source ?? 'app'"
          [disabled]="!chat.threadId() || (action.disabled?.() ?? false)"
          (click)="action.run()"
        >
          {{ action.icon }}
        </button>
      }
    </div>
    @for (action of extensionActions(); track action.id) {
      <button
        type="button"
        class="pk-ghost"
        [class.mono]="action.mono"
        [title]="action.label"
        [attr.aria-label]="action.label"
        [attr.data-action]="action.id"
        [attr.data-source]="action.source ?? 'app'"
        [disabled]="!chat.threadId() || (action.disabled?.() ?? false)"
        (click)="action.run()"
      >
        {{ action.icon }}
      </button>
    }
    <pk-model-picker />
    @if (chat.running()) {
      <pk-deliver-chip [mode]="chat.behavior()" (pick)="chat.setBehavior($event)" />
    }
    <div class="grow"></div>
    <div class="end">
      @for (action of ext.rightActions(); track action.id) {
        <button
          type="button"
          class="pk-ghost"
          [title]="action.label"
          [attr.aria-label]="action.label"
          [attr.data-action]="action.id"
          (click)="action.run()"
        >
          {{ action.icon }}
        </button>
      }
      <pk-voice-button />
      <pk-context-ring />
      @if (chat.running() || chat.waitingForAnswer()) {
        <button
          type="button"
          class="pk-send stop"
          [title]="'chat.composerToolbar.stopEsc' | transloco"
          [attr.aria-label]="'chat.composerToolbar.stop' | transloco"
          data-testid="stop"
          (click)="chat.stop()"
        >
          <pk-icon name="stop" />
        </button>
      } @else {
        <button
          type="button"
          class="pk-send"
          data-testid="send"
          [title]="
            chat.shellMode()
              ? ('chat.composerToolbar.runTheCommand' | transloco)
              : ('chat.composerToolbar.send' | transloco)
          "
          [attr.aria-label]="
            chat.shellMode() ? ('chat.composerToolbar.run' | transloco) : ('chat.composerToolbar.send9bc25' | transloco)
          "
          [disabled]="!chat.canSend()"
          (click)="chat.submit()"
        >
          <pk-icon name="arrow-up" />
        </button>
      }
    </div>
  `,
})
export class ComposerToolbar {
  protected readonly chat = inject(ChatStore);
  protected readonly ext = inject(ComposerExtensions);
  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  /** `@` and `!`: the composer's own, inside the tools pill. */
  protected readonly builtIn = () => this.ext.leftActions().filter((a) => (a.source ?? 'app') === 'app');
  /** What pi extensions registered (`data-source="pi"`): round ghost buttons beside the pill, so a long label never stretches it. */
  protected readonly extensionActions = () => this.ext.leftActions().filter((a) => (a.source ?? 'app') !== 'app');

  constructor() {
    // The first entry of the ⊕ menu asks for the image picker.
    let seen = this.chat.pickerRequests();
    effect(() => {
      const n = this.chat.pickerRequests();
      if (n === seen) return;
      seen = n;
      untracked(() => this.fileInput().nativeElement.click());
    });
  }

  protected onFiles(input: HTMLInputElement): void {
    void this.chat.addImages(Array.from(input.files ?? []));
    input.value = '';
  }
}
