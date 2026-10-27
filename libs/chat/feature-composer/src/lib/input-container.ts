import { TranslocoPipe } from '@pi-kit/i18n';
import { NgComponentOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { CopilotChatAttachmentQueue, CopilotChatInput, injectChatState } from '@copilotkit/angular';
import { PkAnsiText, PkComposerWell } from '@pi-kit/design-system';
import { GraphStore } from '@pi-kit/session-tree/api';
import { ChatStore, NEW_THREAD_COMPOSER, type NewThreadComposerSlots, VoiceStore } from '@pi-kit/chat/data';
import { SkillChip } from '@pi-kit/chat/ui';
import { AttachmentPreview } from './attachment-preview';
import { ComposerField } from './composer-field';
import { ComposerToolbar } from './composer-toolbar';
import { QueueBar } from './queue-bar';
import { VoiceHint } from './voice-hint';

/**
 * The `inputContainer` slot of `CopilotChatView`: the measure column under the thread, with the widgets the extensions
 * put above and below the editor, the well (branch banner, attachment queue, `copilot-chat-input` with pi-kit's `textArea` and
 * `toolbar` slots) and the hint row (what pi is doing, the extensions' status lines, the context warning, the key hints).
 *
 * While a recording is wanted the input is in CopilotKit's `transcribe` mode: it swaps the editor for its own
 * `CopilotChatAudioRecorder`, whose scrolling waveform then fills the editor row, and the draft waits in `ChatStore` for the field to
 * come back. The store gets the recorder from the input's `audioRecorderRef`.
 *
 * The chip row of the well is one wrapping strip: the skill and prompt-template chips of `ChatStore` first, then CopilotKit's attachment
 * queue with the images and `@path` chips.
 *
 * Its tag is CopilotKit's own, on purpose: the view measures the container to keep the last message above it by looking for
 * `copilot-chat-view-input-container` and measuring its first child (`.pk-composer`); a container under another name is not measured.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector -- CopilotKit's view finds its input container by this tag (see above)
  selector: 'copilot-chat-view-input-container',
  imports: [
    AttachmentPreview,
    CopilotChatAttachmentQueue,
    CopilotChatInput,
    NgComponentOutlet,
    PkAnsiText,
    PkComposerWell,
    QueueBar,
    SkillChip,
    VoiceHint,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pk-composer">
      <div class="pk-measure relative">
        @for (widget of chat.aboveWidgets(); track widget.key) {
          <div class="pk-widget">{{ widget.lines.join('\\n') }}</div>
        }

        <pk-queue-bar />
        @if (newThread(); as slots) {
          <!-- A thread without a message: the Where row of the threads domain sits directly above the well. -->
          <ng-container *ngComponentOutlet="slots.row" />
        }
        <pk-composer-well [mode]="chat.shellMode() ? 'shell' : 'prompt'">
          @if (tree.branch(); as branch) {
            <div class="flex items-center gap-2 px-3 pt-2 t-sm" role="status">
              <span class="badge badge-info badge-outline">{{
                'chat.inputContainer.branchingFromTurn' | transloco: { value1: branch.turn }
              }}</span>
              <span class="muted truncate">{{
                'chat.inputContainer.yourMessageBecomesASiblingOfTurn' | transloco: { value1: branch.turn }
              }}</span>
              <button
                type="button"
                class="btn btn-ghost btn-xs btn-square ml-auto"
                [attr.aria-label]="'chat.inputContainer.cancelBranching' | transloco"
                [title]="'chat.inputContainer.cancelBranchingEsc' | transloco"
                (click)="tree.cancelBranch()"
              >
                ✕
              </button>
            </div>
          }
          <!-- One wrapping row: the skill and prompt-template chips, then CopilotKit's queue of images and @path chips. The queue stays in the DOM when the row is empty. -->
          <div
            class="pk-chip-strip"
            data-testid="chip-strip"
            [class.empty]="chat.chips().length === 0 && state.attachments().length === 0"
          >
            @for (chip of chat.chips(); track chip.kind + ':' + chip.name) {
              <pk-skill-chip
                [kind]="chip.kind"
                [name]="chip.name"
                [scope]="chip.scope"
                [pinned]="chip.pinned"
                (togglePin)="chat.togglePin(chip)"
                (remove)="chat.removeChip(chip)"
              />
            }
            <copilot-chat-attachment-queue
              pkAttachmentPreview
              [attachments]="state.attachments()"
              (removeAttachment)="state.removeAttachment($event)"
            />
          </div>
          <copilot-chat-input
            [textAreaComponent]="field"
            [toolbarComponent]="toolbar"
            [autoFocus]="false"
            [mode]="voice.recorderWanted() ? 'transcribe' : 'input'"
          />
        </pk-composer-well>

        @for (widget of chat.belowWidgets(); track widget.key) {
          <div class="pk-widget pt-2">{{ widget.lines.join('\\n') }}</div>
        }
        <div class="pk-hint">
          @if (newThread(); as slots) {
            <ng-container *ngComponentOutlet="slots.hint" />
          }
          <pk-voice-hint />
          <span>{{ chat.hint() }}</span>
          @for (status of statuses(); track status[0]) {
            <span class="truncate" [attr.data-status]="status[0]"><pk-ansi-text [text]="status[1]" /></span>
          }
          @if (chat.contextWarning(); as warning) {
            <span
              [class.warn]="warning.level === 'warning'"
              [class.bad]="warning.level === 'error'"
              role="status"
              data-testid="context-warning"
              >{{ warning.text }}</span
            >
          }
          <span class="ml-auto pk-hide-sm">{{ 'chat.inputContainer.sendNewlineEscStop' | transloco }}</span>
        </div>
      </div>
    </div>
  `,
})
export class InputContainer {
  protected readonly chat = inject(ChatStore);
  protected readonly tree = inject(GraphStore);
  protected readonly voice = inject(VoiceStore);
  protected readonly state = injectChatState();
  protected readonly field = ComposerField;
  protected readonly toolbar = ComposerToolbar;
  private readonly input = viewChild(CopilotChatInput);

  protected readonly statuses = () => Object.entries(this.chat.statuses());

  /** The Where row and its hint: loaded when a thread without messages is open; the components decide by themselves whether they have anything to show. */
  private readonly newThreadLoader = inject(NEW_THREAD_COMPOSER, { optional: true });
  protected readonly newThread = signal<NewThreadComposerSlots | null>(null);
  private readonly wantsNewThread = computed(() => !!this.chat.threadId() && this.chat.messages().length === 0);

  constructor() {
    effect(() => {
      if (this.wantsNewThread() && !this.newThread() && this.newThreadLoader)
        void this.newThreadLoader().then((slots) => this.newThread.set(slots));
    });
    // The voice store starts and stops the recorder CopilotKit mounts in transcribe mode.
    effect(() => this.voice.attachRecorder(this.input()?.audioRecorderRef()));
  }
}
