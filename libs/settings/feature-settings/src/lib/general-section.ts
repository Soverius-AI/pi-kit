import { Language, TranslocoPipe, isLanguage } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { PkShimmer, PkTabs, PkTabPanel, PkTip } from '@pi-kit/design-system';
import { PkVersions } from './versions-block';
import { PkSetting } from '@pi-kit/settings/api';
import { ViewPrefs } from '@pi-kit/data-access';
import { BackgroundServiceStore, SecretsStore, SettingsStore } from '@pi-kit/settings/data';

/** Settings › General: what pi does when a conversation gets long and when a provider fails, how queued messages are delivered, whether pi-kit keeps running in the background, and the versions. */
@Component({
  selector: 'pk-general-section',
  imports: [PkSetting, PkVersions, PkShimmer, PkTabs, PkTabPanel, PkTip, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.settings(); as settings) {
      <div class="flex flex-col gap-5" data-testid="section-general">
        <pk-tabs [label]="'shared.catalog.general' | transloco" [(value)]="tab">
          @if (store.shows('language', 'auto-compaction', 'background-service', 'unattended-keys')) {
            <pk-tab-panel value="preferences" [label]="'settings.sectionTabs.preferences' | transloco">
              <div class="flex flex-col gap-5">
                @if (store.shows('language')) {
                  <section class="pk-group" [attr.aria-label]="'settings.language.heading' | transloco">
                    <header>
                      <div>
                        <h4>{{ 'settings.language.heading' | transloco }}</h4>
                      </div>
                    </header>
                    <div pkSetting="language">
                      <select
                        class="select select-sm"
                        data-testid="language-select"
                        aria-labelledby="lbl-language"
                        aria-describedby="hint-language"
                        [value]="prefs.language()"
                        (change)="changeLanguage($any($event.target).value)"
                      >
                        <option value="en">{{ 'settings.language.english' | transloco }}</option>
                        <option value="de">{{ 'settings.language.german' | transloco }}</option>
                      </select>
                      @if (language.error()) {
                        <div sub class="text-error" role="alert">
                          {{ 'settings.language.loadFailed' | transloco }}
                          <button type="button" class="btn btn-xs" (click)="language.activate(prefs.language())">
                            {{ 'settings.language.retry' | transloco }}
                          </button>
                        </div>
                      }
                    </div>
                  </section>
                }
                @if (store.shows('auto-compaction')) {
                  <section class="pk-group" [attr.aria-label]="'settings.generalSection.context' | transloco">
                    <header>
                      <div>
                        <h4>{{ 'settings.generalSection.context' | transloco }}</h4>
                        <p>{{ 'settings.generalSection.whatPiDoesWhenAConversationGets' | transloco }}</p>
                      </div>
                    </header>
                    <div pkSetting="auto-compaction">
                      <input
                        type="checkbox"
                        class="toggle toggle-primary"
                        aria-labelledby="lbl-auto-compaction"
                        aria-describedby="hint-auto-compaction"
                        [checked]="settings.autoCompaction"
                        (change)="store.patch({ autoCompaction: $any($event.target).checked })"
                      />
                    </div>
                  </section>
                }
                @if (store.shows('background-service', 'unattended-keys') && background.status(); as service) {
                  <section class="pk-group" [attr.aria-label]="'settings.background.heading' | transloco">
                    <header>
                      <div>
                        <h4>{{ 'settings.background.heading' | transloco }}</h4>
                      </div>
                    </header>
                    <div pkSetting="background-service">
                      <input
                        type="checkbox"
                        class="toggle toggle-primary"
                        data-testid="background-service"
                        aria-labelledby="lbl-background-service"
                        aria-describedby="hint-background-service"
                        [checked]="service.enabled"
                        [disabled]="!service.supported || background.busy()"
                        (change)="switchBackground($any($event.target))"
                      />
                      @if (background.busy()) {
                        <div sub class="t-xs muted" role="status">
                          {{ 'settings.background.restarting' | transloco }}
                        </div>
                      } @else if (!service.supported) {
                        <div sub class="t-xs muted">{{ service.reason }}</div>
                      }
                      @if (service.cli?.available && service.cli; as cli) {
                        <div sub class="flex flex-wrap items-center gap-2 t-xs muted" data-testid="pi-kit-command">
                          <span>{{ 'settings.background.command' | transloco }}</span>
                          @if (cli.other) {
                            <span>{{
                              'settings.background.commandOther' | transloco: { path: cli.path, other: cli.other }
                            }}</span>
                          } @else if (cli.installed && cli.onPath) {
                            <span class="chip ok">{{ 'settings.background.commandOnPath' | transloco }}</span>
                          } @else if (cli.installed) {
                            <span>{{ 'settings.background.commandNotOnPath' | transloco: { dir: cli.dir } }}</span>
                          } @else {
                            <button
                              type="button"
                              class="btn btn-xs"
                              data-testid="install-pi-kit-command"
                              [pkTip]="'settings.background.writesTo' | transloco: { dir: cli.dir }"
                              (click)="background.installCommand()"
                            >
                              {{ 'settings.background.installCommand' | transloco }}
                            </button>
                          }
                        </div>
                      }
                      @if (background.error(); as error) {
                        <div sub class="text-error" role="alert">{{ error }}</div>
                      }
                    </div>
                    @if (store.shows('unattended-keys') && secrets.status()?.unattended !== undefined) {
                      <div pkSetting="unattended-keys">
                        <input
                          type="checkbox"
                          class="toggle toggle-primary"
                          data-testid="unattended-keys"
                          aria-labelledby="lbl-unattended-keys"
                          aria-describedby="hint-unattended-keys"
                          [checked]="secrets.status()?.unattended"
                          [disabled]="secrets.unattendedBusy()"
                          (change)="switchUnattended($any($event.target))"
                        />
                        @if (secrets.unattendedBusy()) {
                          <div sub class="t-xs muted" role="status">
                            {{ 'settings.background.unattendedBusy' | transloco }}
                          </div>
                        }
                      </div>
                    }
                  </section>
                }
              </div>
            </pk-tab-panel>
          }
          @if (store.shows('retry', 'steering-mode', 'follow-up-mode')) {
            <pk-tab-panel value="runs" [label]="'settings.generalSection.runs' | transloco">
              <section class="pk-group" [attr.aria-label]="'settings.generalSection.runs' | transloco">
                <header>
                  <div>
                    <h4>{{ 'settings.generalSection.runs' | transloco }}</h4>
                    <p>{{ 'settings.generalSection.retriesAndQueuedMessages' | transloco }}</p>
                  </div>
                </header>
                <div pkSetting="retry">
                  <input
                    type="checkbox"
                    class="toggle toggle-primary"
                    aria-labelledby="lbl-retry"
                    aria-describedby="hint-retry"
                    [checked]="settings.retryEnabled"
                    (change)="store.patch({ retryEnabled: $any($event.target).checked })"
                  />
                </div>
                <div pkSetting="steering-mode">
                  <select
                    class="select select-sm"
                    aria-labelledby="lbl-steering-mode"
                    (change)="store.patch({ steeringMode: $any($event.target).value })"
                  >
                    <option value="one-at-a-time" [selected]="settings.steeringMode === 'one-at-a-time'">
                      {{ 'settings.generalSection.oneAtATime' | transloco }}
                    </option>
                    <option value="all" [selected]="settings.steeringMode === 'all'">
                      {{ 'settings.generalSection.allAtOnce' | transloco }}
                    </option>
                  </select>
                </div>
                <div pkSetting="follow-up-mode">
                  <select
                    class="select select-sm"
                    aria-labelledby="lbl-follow-up-mode"
                    (change)="store.patch({ followUpMode: $any($event.target).value })"
                  >
                    <option value="one-at-a-time" [selected]="settings.followUpMode === 'one-at-a-time'">
                      {{ 'settings.generalSection.oneAtATime' | transloco }}
                    </option>
                    <option value="all" [selected]="settings.followUpMode === 'all'">
                      {{ 'settings.generalSection.allAtOnce' | transloco }}
                    </option>
                  </select>
                </div>
              </section>
            </pk-tab-panel>
          }
          @if (store.shows('versions')) {
            <pk-tab-panel value="versions" [label]="'settings.versionsBlock.versions' | transloco">
              <pk-versions />
            </pk-tab-panel>
          }
        </pk-tabs>
        @if (!store.searching()) {
          <p class="t-xs muted break-all">
            {{ 'settings.generalSection.piSSettingsAreIn' | transloco }} <code>{{ settings.agentDir }}</code>
          </p>
        }
      </div>
    } @else if (store.error()) {
      <p class="text-sm text-error" role="alert">
        {{ 'settings.generalSection.piSSettingsCouldNotBeRead' | transloco: { value1: store.error() } }}
      </p>
    } @else {
      <pk-shimmer [rows]="6" [title]="true" [label]="'settings.generalSection.loadingSettings' | transloco" />
    }
  `,
})
export class GeneralSection {
  protected readonly tab = signal('preferences');
  protected readonly store = inject(SettingsStore);
  protected readonly prefs = inject(ViewPrefs);
  protected readonly language = inject(Language);
  protected readonly background = inject(BackgroundServiceStore);
  protected readonly secrets = inject(SecretsStore);

  constructor() {
    void this.background.load();
    void this.secrets.loadStatus();
  }

  /** A failed switch springs back; on success the app restarts and the store stays busy until then. */
  protected async switchBackground(input: HTMLInputElement): Promise<void> {
    await this.background.setEnabled(input.checked);
    if (!this.background.busy()) input.checked = !!this.background.status()?.enabled;
  }

  protected async switchUnattended(input: HTMLInputElement): Promise<void> {
    await this.secrets.setUnattended(input.checked);
    input.checked = !!this.secrets.status()?.unattended;
  }

  protected async changeLanguage(value: string): Promise<void> {
    if (isLanguage(value)) await this.store.setPref('language', value);
  }
}
