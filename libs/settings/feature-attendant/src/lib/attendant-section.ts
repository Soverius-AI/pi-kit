import type { Translate } from '@pi-kit/i18n';
import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import type { AttendantAction, PatchAttendantSettings } from '@pi-kit/protocol';
import { AttendantStore, ThreadsStore } from '@pi-kit/threads/api';
import { PkSetting } from '@pi-kit/settings/api';
import { SettingsStore } from '@pi-kit/settings/data';
import { PkTip, PkTabs, PkTabPanel, PkScrollArea } from '@pi-kit/design-system';
import { UiStore } from '@pi-kit/data-access';

const kindLabels = (translate: Translate): Record<AttendantAction['kind'], string> => ({
  title: translate('settings.attendantSection.title'),
  summary: translate('settings.attendantSection.summary'),
  label: translate('settings.attendantSection.label'),
  draft: translate('settings.attendantSection.answerDraft'),
  learn: translate('settings.attendantSection.skillDraft'),
  score: translate('settings.attendantSection.score'),
  prompt: translate('settings.attendantSection.followUpPrompt'),
});

/**
 * Settings › Attendant: switch it on, choose its model, when it looks, the daily cost cap and the projects it keeps away from;
 * grouped into General, Automation, Projects and Activity tabs. Activity lists everything it did or proposed, newest first, with each request’s cost. It is off by default, and while
 * it is off it makes no model call. The page reads the activity every few seconds while it is open (`AttendantStore`).
 */
@Component({
  selector: 'pk-attendant-section',
  imports: [PkSetting, PkTip, PkTabs, PkTabPanel, PkScrollArea, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-5" data-testid="section-attendant">
      <pk-tabs [label]="'settings.attendantSection.attendant' | transloco" [(value)]="tab">
        @if (store.shows('attendant', 'attendant-model')) {
          <pk-tab-panel value="general" [label]="'shared.catalog.general' | transloco">
            <section class="pk-group" [attr.aria-label]="'settings.attendantSection.attendant' | transloco">
              <header>
                <div>
                  <h4>{{ 'settings.attendantSection.attendant' | transloco }}</h4>
                  <p>
                    {{ 'settings.attendantSection.itNeverSendsAnythingForYouTitles' | transloco }}
                  </p>
                </div>
              </header>
              <div pkSetting="attendant">
                <span
                  chips
                  class="chip"
                  [class.ok]="attendant.enabled()"
                  [class.off]="!attendant.enabled()"
                  data-testid="attendant-state"
                  >{{
                    attendant.enabled()
                      ? ('settings.attendantSection.on' | transloco)
                      : ('settings.attendantSection.off' | transloco)
                  }}</span
                >
                <input
                  type="checkbox"
                  class="toggle toggle-primary"
                  data-testid="attendant-toggle"
                  aria-labelledby="lbl-attendant"
                  aria-describedby="hint-attendant"
                  [checked]="attendant.enabled()"
                  [disabled]="!attendant.settings()"
                  (change)="save({ enabled: $any($event.target).checked })"
                />
              </div>
              <div pkSetting="attendant-model">
                <span sub class="hint" data-testid="attendant-active-model">{{ activeModel() }}</span>
                <select
                  class="select select-sm"
                  aria-labelledby="lbl-attendant-model"
                  data-testid="attendant-model"
                  [disabled]="!attendant.settings()"
                  (change)="chooseModel($any($event.target).value)"
                >
                  <option value="" [selected]="!attendant.settings()?.model">
                    {{ 'settings.attendantSection.automaticTheCheapestModel' | transloco }}
                  </option>
                  @for (model of models(); track model.value) {
                    <option [value]="model.value" [selected]="model.value === currentModel()">{{ model.label }}</option>
                  }
                </select>
              </div>
            </section>
          </pk-tab-panel>
        }
        @if (
          store.shows(
            'attendant-on-end',
            'attendant-on-question',
            'attendant-follow-ups',
            'attendant-every',
            'attendant-cap',
            'attendant-no-cap'
          )
        ) {
          <pk-tab-panel value="automation" [label]="'settings.attendantSection.automation' | transloco">
            <div class="flex flex-col gap-5">
              @if (
                store.shows('attendant-on-end', 'attendant-on-question', 'attendant-every', 'attendant-follow-ups')
              ) {
                <section class="pk-group" [attr.aria-label]="'settings.attendantSection.schedule' | transloco">
                  <header>
                    <div>
                      <h4>{{ 'settings.attendantSection.schedule' | transloco }}</h4>
                    </div>
                  </header>
                  <div pkSetting="attendant-on-end">
                    <input
                      type="checkbox"
                      class="toggle toggle-primary"
                      aria-labelledby="lbl-attendant-on-end"
                      aria-describedby="hint-attendant-on-end"
                      data-testid="attendant-on-end"
                      [checked]="attendant.settings()?.when?.onEnd ?? true"
                      [disabled]="!attendant.settings()"
                      (change)="save({ when: { onEnd: $any($event.target).checked } })"
                    />
                  </div>
                  <div pkSetting="attendant-follow-ups">
                    <input
                      type="checkbox"
                      class="toggle toggle-primary"
                      aria-labelledby="lbl-attendant-follow-ups"
                      aria-describedby="hint-attendant-follow-ups"
                      data-testid="attendant-follow-ups"
                      [checked]="attendant.settings()?.followUpSuggestions ?? false"
                      [disabled]="!attendant.settings()"
                      (change)="save({ followUpSuggestions: $any($event.target).checked })"
                    />
                  </div>
                  <div pkSetting="attendant-on-question">
                    <input
                      type="checkbox"
                      class="toggle toggle-primary"
                      aria-labelledby="lbl-attendant-on-question"
                      aria-describedby="hint-attendant-on-question"
                      data-testid="attendant-on-question"
                      [checked]="attendant.settings()?.when?.onInterrupt ?? true"
                      [disabled]="!attendant.settings()"
                      (change)="save({ when: { onInterrupt: $any($event.target).checked } })"
                    />
                  </div>
                  <div pkSetting="attendant-every">
                    <input
                      type="number"
                      min="0"
                      max="1440"
                      step="5"
                      class="input input-sm"
                      aria-labelledby="lbl-attendant-every"
                      aria-describedby="hint-attendant-every"
                      data-testid="attendant-every"
                      [disabled]="!attendant.settings()"
                      [value]="attendant.settings()?.when?.everyMinutes ?? 0"
                      (change)="save({ when: { everyMinutes: clampMinutes($any($event.target).value) } })"
                    />
                  </div>
                </section>
              }
              @if (store.shows('attendant-cap', 'attendant-no-cap')) {
                <section class="pk-group" [attr.aria-label]="'settings.attendantSection.budget' | transloco">
                  <header>
                    <div>
                      <h4>{{ 'settings.attendantSection.budget' | transloco }}</h4>
                    </div>
                  </header>
                  <div pkSetting="attendant-cap">
                    <span sub class="hint" data-testid="attendant-today"
                      >{{
                        'settings.attendantSection.today' | transloco: { value1: money(attendant.today()?.cost ?? 0) }
                      }}
                      @if (
                        attendant.settings()?.dailyCostCap !== null && attendant.settings()?.dailyCostCap !== undefined
                      ) {
                        {{
                          'settings.attendantSection.of'
                            | transloco: { value1: money(attendant.settings()?.dailyCostCap ?? 0) }
                        }}
                      }
                      @if (attendant.status()?.capReached) {
                        {{ 'settings.attendantSection.capReachedItRestsUntilTomorrow' | transloco }}
                      }
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      class="input input-sm"
                      aria-labelledby="lbl-attendant-cap"
                      aria-describedby="hint-attendant-cap"
                      data-testid="attendant-cap"
                      [disabled]="attendant.settings()?.dailyCostCap === null || !attendant.settings()"
                      [value]="attendant.settings()?.dailyCostCap ?? ''"
                      (change)="
                        save({ dailyCostCap: $any($event.target).value === '' ? null : +$any($event.target).value })
                      "
                    />
                  </div>
                  <div pkSetting="attendant-no-cap">
                    <input
                      type="checkbox"
                      class="toggle toggle-primary"
                      aria-labelledby="lbl-attendant-no-cap"
                      aria-describedby="hint-attendant-no-cap"
                      data-testid="attendant-no-cap"
                      [checked]="attendant.settings()?.dailyCostCap === null"
                      [disabled]="!attendant.settings()"
                      (change)="save({ dailyCostCap: $any($event.target).checked ? null : 0.5 })"
                    />
                  </div>
                </section>
              }
            </div>
          </pk-tab-panel>
        }
        @if (store.shows('attendant-projects')) {
          <pk-tab-panel value="projects" [label]="'settings.attendantSection.projects' | transloco">
            <section
              class="pk-group"
              [attr.aria-label]="'settings.attendantSection.projectsTheAttendantWorksIn' | transloco"
            >
              <header>
                <div>
                  <h4>{{ 'settings.attendantSection.projects' | transloco }}</h4>
                  <p>{{ 'settings.attendantSection.turnItOffForAProjectAnd' | transloco }}</p>
                </div>
              </header>
              @for (workspace of threads.workspaces(); track workspace.cwd) {
                <div class="row" [attr.data-testid]="'attendant-project-' + workspace.name">
                  <div class="min-w-0">
                    <div class="lbl">{{ workspace.name }}</div>
                    <div class="hint mono truncate" [pkTip]="workspace.cwd">{{ workspace.cwd }}</div>
                  </div>
                  <div class="ctl ctl-w">
                    <input
                      type="checkbox"
                      class="toggle toggle-sm"
                      [attr.aria-label]="
                        ('settings.attendantSection.letTheAttendantWorkIn' | transloco) + workspace.name
                      "
                      [checked]="workspace.attendant"
                      (change)="setProject(workspace.cwd, $any($event.target).checked)"
                    />
                  </div>
                </div>
              } @empty {
                <div class="row">
                  <div class="hint">{{ 'settings.attendantSection.noProjectIsOpenYet' | transloco }}</div>
                </div>
              }
            </section>
          </pk-tab-panel>
        }

        @if (store.shows('attendant-activity')) {
          <pk-tab-panel value="activity" [label]="'shared.catalog.activity' | transloco">
            <section
              class="pk-group"
              [attr.aria-label]="'settings.attendantSection.attendantActivity' | transloco"
              data-testid="attendant-activity"
            >
              <header>
                <div>
                  <h4>{{ 'settings.attendantSection.attendantActivity' | transloco }}</h4>
                  <p>{{ totals() }}</p>
                </div>
                <button
                  type="button"
                  class="btn btn-sm"
                  data-testid="attendant-run"
                  [disabled]="!attendant.enabled()"
                  [pkTip]="'settings.attendantSection.lookAtTheThreadsThatChangedSince' | transloco"
                  (click)="runNow()"
                >
                  {{ 'settings.attendantSection.lookNow' | transloco }}
                </button>
              </header>
              @if (attendant.actions().length === 0) {
                <div class="row">
                  <div class="hint">
                    {{
                      attendant.enabled()
                        ? ('settings.attendantSection.nothingYetItLooksWhenARun' | transloco)
                        : ('settings.attendantSection.nothingWhileItIsOffItDoes' | transloco)
                    }}
                  </div>
                </div>
              } @else {
                <pk-scroll-area
                  class="pk-scroll-area-flush"
                  [label]="'settings.attendantSection.attendantActivity' | transloco"
                >
                  <table class="table table-sm pk-attendant-activity">
                    <thead>
                      <tr>
                        <th>{{ 'settings.attendantSection.when' | transloco }}</th>
                        <th>{{ 'settings.attendantSection.what' | transloco }}</th>
                        <th>{{ 'settings.attendantSection.thread' | transloco }}</th>
                        <th>{{ 'settings.attendantSection.result' | transloco }}</th>
                        <th class="num">{{ 'settings.attendantSection.tokens' | transloco }}</th>
                        <th class="num">{{ 'settings.attendantSection.cost' | transloco }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (action of attendant.actions(); track action.id) {
                        <tr
                          data-testid="attendant-action"
                          [attr.data-kind]="action.kind"
                          [attr.data-status]="action.status"
                        >
                          <td class="whitespace-nowrap text-muted">{{ time(action.at) }}</td>
                          <td class="whitespace-nowrap">
                            {{ kind(action.kind) }}
                            @if (action.status !== 'done') {
                              <span
                                class="chip"
                                [class.err]="action.status === 'error'"
                                [class.off]="action.status === 'skipped'"
                                >{{ action.status }}</span
                              >
                            }
                          </td>
                          <td class="max-w-40 truncate" [pkTip]="action.threadTitle ?? ''">
                            {{ action.threadTitle ?? '' }}
                          </td>
                          <td class="min-w-48">{{ action.text }}</td>
                          <td class="num">
                            {{
                              action.inputTokens + action.outputTokens > 0
                                ? action.inputTokens + '/' + action.outputTokens
                                : ''
                            }}
                          </td>
                          <td class="num" data-testid="attendant-action-cost">
                            {{ action.model ? money(action.cost) : '' }}
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </pk-scroll-area>
              }
            </section>
          </pk-tab-panel>
        }
      </pk-tabs>
    </div>
  `,
})
export class AttendantSection implements OnInit, OnDestroy {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(SettingsStore);
  protected readonly attendant = inject(AttendantStore);
  protected readonly threads = inject(ThreadsStore);

  protected readonly tab = signal(inject(UiStore).settings()?.tab === 'attendant-activity' ? 'activity' : 'general');

  /** The models pi can use, as `provider/id` options. */
  protected readonly models = computed(() =>
    (this.store.overview()?.models ?? [])
      .filter((m) => !m.virtual)
      .map((m) => ({
        value: `${m.provider}/${m.id}`,
        label: `${m.name} · ${m.provider}${m.costInput ? this.i18n.t('settings.attendantSection.inOutPer1M', { value1: m.costInput, value2: m.costOutput ?? 0 }) : this.i18n.t('settings.attendantSection.free')}`,
      })),
  );
  protected readonly currentModel = computed(() => {
    const model = this.attendant.settings()?.model;
    return model ? `${model.provider}/${model.modelId}` : '';
  });
  protected readonly activeModel = computed(() => {
    const active = this.attendant.status()?.activeModel;
    return active
      ? this.i18n.t('settings.attendantSection.uses', { value1: active })
      : this.i18n.t('settings.attendantSection.noModelIsAvailableYetSignIn');
  });
  protected readonly totals = computed(() => {
    const today = this.attendant.today();
    if (!today) return this.i18n.t('settings.attendantSection.everythingItDidOrProposedNewestFirst');
    const queued = this.attendant.status()?.queued ?? 0;
    return this.i18n.t('settings.attendantSection.todayTokensSincePiKitStarted', {
      value1: today.calls,
      value2:
        today.calls === 1
          ? this.i18n.t('settings.attendantSection.request')
          : this.i18n.t('settings.attendantSection.requests'),
      value3: today.inputTokens + today.outputTokens,
      value4: this.money(today.cost),
      value5: this.attendant.status()?.calls ?? 0,
      value6:
        queued > 0
          ? this.i18n.t('settings.attendantSection.workingOn', {
              value1: queued,
              value2:
                queued === 1
                  ? this.i18n.t('settings.attendantSection.threadNoun')
                  : this.i18n.t('settings.attendantSection.threads'),
            })
          : '',
    });
  });

  ngOnInit(): void {
    this.attendant.watch(true);
  }

  ngOnDestroy(): void {
    this.attendant.watch(false);
  }

  protected save(patch: PatchAttendantSettings): void {
    void this.store.save(
      () => this.attendant.patch(patch),
      this.i18n.t('settings.attendantSection.couldNotSaveTheAttendantSSettings'),
    );
  }

  protected chooseModel(value: string): void {
    const [provider, ...rest] = value.split('/');
    this.save({ model: value ? { provider, modelId: rest.join('/') } : null });
  }

  protected clampMinutes(value: string): number {
    return Math.min(1440, Math.max(0, Math.round(Number(value) || 0)));
  }

  protected setProject(cwd: string, on: boolean): void {
    void this.store.save(
      () => this.threads.setAttendant(cwd, on),
      this.i18n.t('settings.attendantSection.couldNotSaveTheProjectSSetting'),
    );
  }

  protected runNow(): void {
    void this.store.save(
      () => this.attendant.run(),
      this.i18n.t('settings.attendantSection.theAttendantCouldNotStart'),
    );
  }

  protected kind(kind: AttendantAction['kind']): string {
    return kindLabels(this.i18n.t)[kind];
  }

  protected money(usd: number): string {
    return usd === 0 ? '$0.00' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  }

  protected time(at: number): string {
    const date = new Date(at);
    const today = new Date();
    return date.toDateString() === today.toDateString()
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
}
