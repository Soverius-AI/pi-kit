import { Language } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChatStore, VoiceStore } from '@pi-kit/chat/data';
import { PkIcon } from '@pi-kit/design-system';

/**
 * The microphone of the composer toolbar: a round 32px ghost button beside the context ring. A click starts dictating and a
 * second click finishes it (the push-to-talk key does the same while held); the recording itself is CopilotKit's `CopilotChatAudioRecorder`, which
 * the well's input mounts in transcribe mode, and the states (listening, transcribing, errors) are drawn in the hint row. The button shows the state by colour:
 * red while it listens, a spinner while Whistle works.
 */
@Component({
  selector: 'pk-voice-button',
  imports: [PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents' },
  template: `
    <button
      type="button"
      class="pk-ghost pk-mic"
      data-testid="voice-button"
      [class.rec]="voice.phase() === 'listening' || voice.phase() === 'starting'"
      [attr.aria-pressed]="voice.phase() === 'listening' || voice.phase() === 'starting'"
      [attr.aria-label]="label()"
      [title]="title()"
      [disabled]="!chat.threadId() || voice.phase() === 'transcribing'"
      (click)="voice.toggle()"
    >
      @if (voice.phase() === 'transcribing') {
        <span class="loading loading-spinner loading-xs" aria-hidden="true"></span>
      } @else {
        <pk-icon name="mic" />
      }
    </button>
  `,
})
export class VoiceButton {
  protected readonly i18n = inject(Language);
  protected readonly chat = inject(ChatStore);
  protected readonly voice = inject(VoiceStore);

  protected label(): string {
    switch (this.voice.phase()) {
      case 'listening':
      case 'starting':
        return this.i18n.t('chat.voiceButton.finishDictating');
      case 'transcribing':
        return this.i18n.t('chat.voiceButton.transcribing');
      default:
        return this.i18n.t('chat.voiceButton.dictate');
    }
  }

  protected title(): string {
    switch (this.voice.phase()) {
      case 'listening':
      case 'starting':
        return this.i18n.t('chat.voiceButton.finishAndInsertTheTextEscThrows');
      case 'transcribing':
        return this.i18n.t('chat.voiceButton.whistleIsTurningTheRecordingIntoText');
      default:
        return this.i18n.t('chat.voiceButton.dictateToTalkTheTextGoesInto', {
          value1:
            this.voice.pttMode() === 'hold'
              ? this.i18n.t('chat.voiceButton.hold')
              : this.i18n.t('chat.voiceButton.press'),
          value2: this.voice.keyLabel(),
        });
    }
  }
}
