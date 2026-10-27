import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChatState, CopilotChatInput } from '@copilotkit/angular';
import { PkComposerWell, PkIcon } from '@pi-kit/design-system';
import { ChatStore } from '@pi-kit/chat/data';
import { DeliverChip } from '@pi-kit/chat/ui';
import { ComposerField } from './composer-field';
import { PkChatState } from './chat-state';

/**
 * The toolbar of a background agent's composer: the Deliver chip while the agent works (a follow-up is its next task, a steer
 * reaches it now) and the round send button, nothing else. The agent has no model or effort to pick, no voice, no context ring of its own; Stop is
 * the panel's.
 */
@Component({
  selector: 'pk-agent-composer-toolbar',
  imports: [DeliverChip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-toolbar compact' },
  template: `
    @if (chat.running()) {
      <!-- Only an agent at work can be steered; a message to an idle or finished one is its next task. -->
      <pk-deliver-chip [mode]="chat.behavior()" (pick)="chat.setBehavior($event)" />
    }
    <div class="grow"></div>
    <div class="end">
      <button
        type="button"
        class="pk-send"
        data-testid="agent-send"
        [title]="'chat.composerToolbar.send' | transloco"
        [attr.aria-label]="'chat.composerToolbar.send9bc25' | transloco"
        [disabled]="!chat.canSend()"
        (click)="chat.submit()"
      >
        <pk-icon name="arrow-up" />
      </button>
    </div>
  `,
})
export class AgentComposerToolbar {
  protected readonly chat = inject(ChatStore);
}

/**
 * The `inputContainer` slot of a background agent's `CopilotChatView`: the thread composer's well and text field on the
 * agent's own `ChatStore` (the one `pk-agent-transcript` provides for `pi-bg`), with the agent's toolbar. A message goes to the agent as
 * a run of `pi-bg`, a follow-up or a steer by the Deliver chip; the agent keeps only the tools its permission allows. The tag is
 * CopilotKit's own, as the thread's container: the view measures it by this name.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector -- CopilotKit's view finds its input container by this tag
  selector: 'copilot-chat-view-input-container',
  imports: [CopilotChatInput, PkComposerWell, TranslocoPipe],
  // CopilotKit's input reads `ChatState` from a parent; the thread's chat page provides it, this container provides its own for the agent's store.
  providers: [PkChatState, { provide: ChatState, useExisting: PkChatState }],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pk-composer" data-testid="agent-composer">
      <div class="pk-measure relative">
        <pk-composer-well>
          <copilot-chat-input
            [textAreaComponent]="field"
            [toolbarComponent]="toolbar"
            [autoFocus]="false"
            mode="input"
          />
        </pk-composer-well>
        <div class="pk-hint">
          @if (chat.running()) {
            <span>{{ 'chat.agentComposer.hint' | transloco }}</span>
          }
          <span class="ml-auto pk-hide-sm">{{ 'chat.inputContainer.sendNewline' | transloco }}</span>
        </div>
      </div>
    </div>
  `,
})
export class AgentInputContainer {
  protected readonly chat = inject(ChatStore);
  protected readonly field = ComposerField;
  protected readonly toolbar = AgentComposerToolbar;
}
