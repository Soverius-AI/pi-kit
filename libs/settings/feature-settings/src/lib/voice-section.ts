import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { SPEECH_LANGUAGES, SPEECH_LANGUAGE_NAMES } from '@pi-kit/protocol';
import { VoiceStore } from '@pi-kit/chat/api';
import { SettingsStore } from '@pi-kit/settings/data';
import { PkTabs, PkTabPanel } from '@pi-kit/design-system';
import { PkSetting } from '@pi-kit/settings/api';

/**
 * Settings › Voice: the speech engine and the Whistle model (status, the explicit download, removal), the language, how the
 * push-to-talk key behaves, live words, "send when done", and the privacy note. The model is never fetched on its own: the only thing that starts
 * a download is the button here (or its twin in the composer's first-use prompt). The key itself is edited in Keybindings with the other shortcuts.
 */
@Component({
  selector: 'pk-voice-section',
  imports: [PkSetting, PkTabs, PkTabPanel, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-5" data-testid="section-voice">
      <pk-tabs [label]="'shared.catalog.voice' | transloco" [(value)]="tab">
        @if (store.shows('voice-engine')) {
          <pk-tab-panel value="model" [label]="'settings.voiceSection.speechModel' | transloco">
            <section class="pk-group" [attr.aria-label]="'settings.voiceSection.speechModel' | transloco">
              <header>
                <div>
                  <h4>{{ 'settings.voiceSection.speechModel' | transloco }}</h4>
                  <p>{{ 'settings.voiceSection.speechToTextOnThisMachine' | transloco }}</p>
                </div>
              </header>
              <div pkSetting="voice-engine">
                <span
                  chips
                  class="chip"
                  [class.ok]="voice.status()?.model?.state === 'ready'"
                  [class.off]="voice.status()?.model?.state === 'missing'"
                  [class.err]="voice.status()?.model?.state === 'error'"
                  data-testid="voice-model-state"
                  >{{ stateLabel() }}</span
                >
                <div sub class="flex flex-col gap-1 mt-2 t-sm" data-testid="voice-engine-note">
                  @if (voice.status(); as status) {
                    <div>
                      <span class="muted">{{ 'settings.voiceSection.engine' | transloco }}</span> {{ engineLabel() }}.
                      {{ status.note }}
                    </div>
                    <div>
                      <span class="muted">{{ 'settings.voiceSection.model' | transloco }}</span>
                      {{
                        'settings.voiceSection.mBFromCheckedAgainstSHA256'
                          | transloco
                            : {
                                value1: status.model.name,
                                value2: status.model.file,
                                value3: megabytes(),
                                value4: status.model.license,
                                value5: status.model.source,
                              }
                      }}
                      <span class="mono">{{ status.model.sha256.slice(0, 12) }}…</span>
                    </div>
                    <div>
                      <span class="muted">{{ 'settings.voiceSection.storedAt' | transloco }}</span>
                      <span class="mono break-all">{{ status.model.path }}</span>
                    </div>
                    <div>
                      <span class="muted">{{ 'settings.voiceSection.otherFormats' | transloco }}</span>
                      {{
                        status.decoders.ffmpeg
                          ? ('settings.voiceSection.ffmpegIsInstalledSoWebMOggAnd' | transloco)
                          : ('settings.voiceSection.wAVOnlyTheComposerSendsWAVInstall' | transloco)
                      }}
                    </div>
                    @if (status.model.error) {
                      <div class="err" role="alert">{{ status.model.error }}</div>
                    }
                  } @else if (voice.statusError()) {
                    <div class="err" role="alert">
                      {{ 'settings.voiceSection.theBackendDidNotAnswer' | transloco: { value1: voice.statusError() } }}
                    </div>
                  } @else {
                    <div class="muted">{{ 'settings.voiceSection.askingTheBackend' | transloco }}</div>
                  }
                </div>
                <div class="flex items-center gap-2">
                  @switch (voice.status()?.model?.state) {
                    @case ('ready') {
                      <button type="button" class="btn btn-sm" data-testid="voice-remove" (click)="voice.removeModel()">
                        {{ 'settings.voiceSection.remove' | transloco }}
                      </button>
                    }
                    @case ('downloading') {
                      <progress
                        class="progress progress-primary flex-1"
                        [value]="voice.downloadPercent() ?? 0"
                        max="100"
                        [attr.aria-label]="'settings.voiceSection.downloadProgress' | transloco"
                      ></progress>
                      <span class="t-sm" data-testid="voice-progress">{{ voice.downloadPercent() ?? 0 }}%</span>
                    }
                    @default {
                      <button
                        type="button"
                        class="btn btn-sm btn-primary"
                        data-testid="voice-download"
                        [disabled]="voice.requesting() || !voice.status()"
                        (click)="voice.acceptDownload()"
                      >
                        {{ 'settings.voiceSection.downloadWhistleMB' | transloco: { value1: megabytes() } }}
                      </button>
                    }
                  }
                </div>
              </div>
            </section>
          </pk-tab-panel>
        }
        @if (store.shows('voice-language', 'voice-ptt', 'voice-ptt-mode', 'voice-live', 'voice-send')) {
          <pk-tab-panel value="dictation" [label]="'settings.voiceSection.dictation' | transloco">
            <section class="pk-group" [attr.aria-label]="'settings.voiceSection.dictation' | transloco">
              <header>
                <div>
                  <h4>{{ 'settings.voiceSection.dictation' | transloco }}</h4>
                  <p>{{ 'settings.voiceSection.howTheMicrophoneBehaves' | transloco }}</p>
                </div>
              </header>
              <div pkSetting="voice-language">
                <select
                  class="select select-sm"
                  aria-labelledby="lbl-voice-language"
                  data-testid="voice-language"
                  (change)="store.setVoice('language', $any($event.target).value)"
                >
                  <option value="auto" [selected]="voice.language() === 'auto'">
                    {{ 'settings.voiceSection.detect' | transloco }}
                  </option>
                  @for (code of languages; track code) {
                    <option [value]="code" [selected]="voice.language() === code">{{ names[code] }}</option>
                  }
                </select>
              </div>
              <div pkSetting="voice-ptt">
                <span class="pk-keycap" data-testid="voice-key">{{ voice.keyLabel() }}</span>
                <button type="button" class="btn btn-xs" (click)="store.select('keybindings')">
                  {{ 'settings.voiceSection.changeInKeybindings' | transloco }}
                </button>
              </div>
              <div pkSetting="voice-ptt-mode">
                <div class="pk-seg" role="radiogroup" aria-labelledby="lbl-voice-ptt-mode">
                  <input
                    type="radio"
                    name="voice-mode"
                    [attr.aria-label]="'settings.voiceSection.hold' | transloco"
                    [checked]="voice.pttMode() === 'hold'"
                    (change)="store.setVoice('pttMode', 'hold')"
                  />
                  <input
                    type="radio"
                    name="voice-mode"
                    [attr.aria-label]="'settings.voiceSection.toggle' | transloco"
                    [checked]="voice.pttMode() === 'toggle'"
                    (change)="store.setVoice('pttMode', 'toggle')"
                  />
                </div>
              </div>
              <div pkSetting="voice-live">
                <input
                  type="checkbox"
                  class="toggle toggle-primary"
                  aria-labelledby="lbl-voice-live"
                  aria-describedby="hint-voice-live"
                  data-testid="voice-live"
                  [checked]="voice.live()"
                  (change)="store.setVoice('live', $any($event.target).checked)"
                />
              </div>
              <div pkSetting="voice-send">
                <input
                  type="checkbox"
                  class="toggle toggle-primary"
                  aria-labelledby="lbl-voice-send"
                  aria-describedby="hint-voice-send"
                  data-testid="voice-send"
                  [checked]="voice.sendWhenDone()"
                  (change)="store.setVoice('sendWhenDone', $any($event.target).checked)"
                />
              </div>
            </section>
          </pk-tab-panel>
        }
        @if (store.shows('voice-privacy')) {
          <pk-tab-panel value="privacy" [label]="'settings.voiceSection.privacy' | transloco">
            <section class="pk-group" [attr.aria-label]="'settings.voiceSection.privacy' | transloco">
              <header>
                <div>
                  <h4>{{ 'settings.voiceSection.privacy' | transloco }}</h4>
                  <p>{{ 'settings.voiceSection.audioStaysOnThisMachine' | transloco }}</p>
                </div>
              </header>
              <div pkSetting="voice-privacy">
                <span class="chip ok">{{ 'settings.voiceSection.localOnly' | transloco }}</span>
              </div>
            </section>
          </pk-tab-panel>
        }
      </pk-tabs>
    </div>
  `,
})
export class VoiceSection implements OnInit {
  protected readonly tab = signal('model');
  protected readonly i18n = inject(Language);
  protected readonly store = inject(SettingsStore);
  protected readonly voice = inject(VoiceStore);
  protected readonly languages = SPEECH_LANGUAGES;
  protected readonly names = SPEECH_LANGUAGE_NAMES;

  ngOnInit(): void {
    void this.voice.loadStatus();
  }

  protected megabytes(): number {
    return Math.max(1, Math.round((this.voice.status()?.model.bytes ?? 16_919_407) / 1_000_000));
  }

  protected stateLabel(): string {
    const model = this.voice.status()?.model;
    switch (model?.state) {
      case 'ready':
        return 'ready';
      case 'downloading':
        return this.i18n.t('settings.voiceSection.downloading', { value1: this.voice.downloadPercent() ?? 0 });
      case 'error':
        return this.i18n.t('settings.voiceSection.downloadFailed');
      case 'missing':
        return this.i18n.t('settings.voiceSection.notDownloaded');
      default:
        return '…';
    }
  }

  protected engineLabel(): string {
    switch (this.voice.status()?.engine) {
      case 'wasm':
        return this.i18n.t('settings.voiceSection.needleWebAssemblyAWorkerThread');
      case 'python':
        return this.i18n.t('settings.voiceSection.thePythonNeedlePackage');
      case 'fake':
        return this.i18n.t('settings.voiceSection.testEngine');
      default:
        return 'none';
    }
  }
}
