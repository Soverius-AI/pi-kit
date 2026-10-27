import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { VoiceStore } from '@pi-kit/chat/data';

/**
 * The voice states of the hint row: the first use asks before downloading the model (with the button that does it), then
 * "Starting the microphone", "Listening" with the words as they are recognised, "Transcribing…", and errors with their reason. The waveform is
 * not here: while a recording is wanted the well's `copilot-chat-input` is in transcribe mode and CopilotKit's recorder takes the editor row.
 */
@Component({
  imports: [TranslocoPipe],
  selector: 'pk-voice-hint',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.hidden]': "voice.phase() === 'idle'",
    class: 'pk-voice',
    '[attr.data-phase]': 'voice.phase()',
    role: 'status',
    'aria-live': 'polite',
  },
  template: `
    @switch (voice.phase()) {
      @case ('setup') {
        <span class="txt" data-testid="voice-hint">{{ voice.hint() }}</span>
        @if (voice.status()?.model?.state === 'downloading') {
          <progress
            class="progress progress-primary w-24"
            [value]="voice.downloadPercent() ?? 0"
            max="100"
            [attr.aria-label]="'chat.voiceHint.downloadProgress' | transloco"
          ></progress>
        } @else {
          <button
            type="button"
            class="btn btn-xs btn-primary"
            data-testid="voice-download"
            [disabled]="voice.requesting()"
            (click)="voice.acceptDownload()"
          >
            {{ 'chat.voiceHint.downloadWhistleMB' | transloco: { value1: megabytes() } }}
          </button>
          <button type="button" class="btn btn-xs btn-ghost" (click)="voice.dismissSetup()">
            {{ 'chat.voiceHint.notNow' | transloco }}
          </button>
        }
      }
      @case ('starting') {
        <span class="loading loading-spinner loading-xs" aria-hidden="true"></span>
        <span class="txt" data-testid="voice-hint">{{ voice.hint() }}</span>
      }
      @case ('listening') {
        <span class="rec-dot" aria-hidden="true"></span>
        <span class="txt" data-testid="voice-hint" [class.partial]="voice.partial()">{{ voice.hint() }}</span>
      }
      @case ('transcribing') {
        <span class="loading loading-spinner loading-xs" aria-hidden="true"></span>
        <span class="txt" data-testid="voice-hint">{{ voice.hint() }}</span>
      }
      @case ('error') {
        <span class="txt err" data-testid="voice-hint">{{ voice.hint() }}</span>
      }
    }
  `,
})
export class VoiceHint {
  protected readonly voice = inject(VoiceStore);

  protected megabytes(): number {
    return Math.max(1, Math.round((this.voice.status()?.model.bytes ?? 16_919_407) / 1_000_000));
  }
}
