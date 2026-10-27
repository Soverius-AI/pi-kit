import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { UiStore } from '@pi-kit/data-access';
import type { LearnedSkill } from '@pi-kit/protocol';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import { SettingsStore } from '@pi-kit/settings/data';
import { LearnStore, LearnedStore, learnedRecordLine, retiredText, verificationPhaseText } from '@pi-kit/threads/api';

/**
 * The record of a learned skill (doc/docs/design-system.md "Learned skill record"), drawn under the skill's row in Settings › Skills when the skill was
 * learned from a thread: where it comes from, when it was verified and how, how often prompts used it and how many of those threads merged, when it was last used, a warning when its
 * recent threads keep ending without a result, and the three things the person can do: **Re-verify** (replay it from the base commit again), **Edit** (the review dialog on the saved
 * text) and **Retire** (the folder moves to `.retired/`; nothing is deleted). A skill that is not learned renders nothing.
 */
@Component({
  selector: 'pk-learned-skill',
  imports: [PkTip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pk-learned' },
  template: `
    @if (skill(); as s) {
      <div
        class="rec-block"
        data-testid="learned-skill"
        [attr.data-skill]="s.name"
        [attr.data-flagged]="s.flag ? s.flag.reason : null"
      >
        <p class="rec" data-testid="learned-record">
          {{ 'settings.learnedSkill.learnedFrom' | transloco }}
          <em class="from" data-testid="learned-from">{{ line().from }}</em>
          @for (fact of line().facts; track $index) {
            <span class="sep" aria-hidden="true"> · </span
            ><span class="fact" data-testid="learned-fact">{{ fact }}</span>
          }
        </p>
        @if (s.flag; as flag) {
          <p class="flag" role="status" data-testid="learned-flag">
            <pk-icon name="warning" />
            <span>{{ 'settings.learnedSkill.editItVerifyItAgainOrRetire' | transloco: { value1: flag.text } }}</span>
          </p>
        }
        @if (running()) {
          <p class="run" role="status" data-testid="learned-running">
            <span class="loading loading-spinner loading-xs text-primary" aria-hidden="true"></span>
            <span>{{ phase() }}</span>
            <button type="button" class="btn btn-xs btn-ghost" data-testid="learned-stop" (click)="store.stopVerify(s)">
              {{ 'settings.learnedSkill.stop' | transloco }}
            </button>
          </p>
        }
        @if (store.errors()[s.id]; as error) {
          <p class="err" role="alert" data-testid="learned-error">{{ error }}</p>
        }
        @if (s.missing) {
          <p class="err" role="status" data-testid="learned-missing">
            {{ 'settings.learnedSkill.theSkillFileIsNotThereAny' | transloco: { value1: s.path } }}
          </p>
        }
        @if (confirming()) {
          <div
            class="confirm"
            role="alertdialog"
            [attr.aria-label]="('settings.learnedSkill.retire' | transloco) + s.name"
            data-testid="learned-confirm"
          >
            <p>
              {{ 'settings.learnedSkill.retirec9714' | transloco }} <code>{{ s.name }}</code
              >{{ 'settings.learnedSkill.piStopsLoadingItItsFolderMoves' | transloco }} <code>{{ folder(s) }}</code
              >{{ 'settings.learnedSkill.nothingIsDeletedAndRestoreBringsIt' | transloco }}
            </p>
            <span class="acts">
              <button
                type="button"
                class="btn btn-xs btn-ghost"
                data-testid="learned-retire-cancel"
                (click)="confirming.set(false)"
              >
                {{ 'settings.learnedSkill.cancel' | transloco }}
              </button>
              <button
                type="button"
                class="btn btn-xs btn-primary"
                data-testid="learned-retire-confirm"
                [disabled]="busy()"
                (click)="retire(s)"
              >
                {{ 'settings.learnedSkill.retirec9714' | transloco }}
              </button>
            </span>
          </div>
        } @else {
          <span class="acts">
            <span [pkTip]="reverifyTip()"
              ><button
                type="button"
                class="btn btn-xs"
                data-testid="learned-reverify"
                [disabled]="!canReverify()"
                (click)="store.reverify(s)"
              >
                {{ 'settings.learnedSkill.reVerify' | transloco }}
              </button></span
            >
            <span [pkTip]="editTip()"
              ><button
                type="button"
                class="btn btn-xs"
                data-testid="learned-edit"
                [disabled]="s.missing || running()"
                (click)="edit(s)"
              >
                {{ 'settings.learnedSkill.edit' | transloco }}
              </button></span
            >
            <span [pkTip]="'settings.learnedSkill.movesTheSkillToRetiredPiStops' | transloco"
              ><button
                type="button"
                class="btn btn-xs btn-ghost"
                data-testid="learned-retire"
                [disabled]="busy() || running() || s.missing"
                (click)="confirming.set(true)"
              >
                {{ 'settings.learnedSkill.retirec9714' | transloco }}
              </button></span
            >
          </span>
        }
      </div>
    }
  `,
})
export class PkLearnedSkill {
  protected readonly i18n = inject(Language);
  /** The row's skill name and the file pi loaded it from (`ResourceItem.name` and `path`). */
  readonly name = input.required<string>();
  readonly path = input.required<string>();

  protected readonly store = inject(LearnedStore);
  private readonly learn = inject(LearnStore);
  private readonly settings = inject(SettingsStore);
  private readonly ui = inject(UiStore);
  protected readonly confirming = signal(false);

  protected readonly skill = computed(() =>
    this.store
      .live()
      .find((s) => s.name === this.name() && this.path().replace(/\\/g, '/').endsWith(`/skills/${s.name}/SKILL.md`)),
  );
  protected readonly line = computed(() => learnedRecordLine(this.i18n.t, this.skill() as LearnedSkill));
  protected readonly running = computed(() => this.skill()?.verification?.state === 'running');
  protected readonly busy = computed(() => !!this.store.busy()[this.skill()?.id ?? '']);
  protected readonly phase = computed(() => verificationPhaseText(this.i18n.t, this.skill()?.verification?.phase));
  protected readonly canReverify = computed(
    () => !!this.skill() && !this.skill()?.missing && !this.running() && !this.busy(),
  );
  protected readonly reverifyTip = computed(() =>
    this.running()
      ? this.i18n.t('settings.learnedSkill.itIsBeingVerifiedNow')
      : this.i18n.t('settings.learnedSkill.replaysTheSkillFromTheCommitIts'),
  );
  protected readonly editTip = computed(() =>
    this.running()
      ? this.i18n.t('settings.learnedSkill.waitForTheReplayOrStopIt')
      : this.i18n.t('settings.learnedSkill.opensTheSkillInTheReviewDialog'),
  );

  constructor() {
    void this.store.load();
  }

  protected folder(skill: LearnedSkill): string {
    return skill.scope === 'project'
      ? `.pi/skills/.retired/${skill.name}/`
      : `skills/.retired/${skill.name}/ in pi’s folder`;
  }

  /** Edit is the review dialog, which is a window of its own: Settings gives way to it. */
  protected edit(skill: LearnedSkill): void {
    this.ui.closeSettings();
    void this.learn.edit(skill);
  }

  protected async retire(skill: LearnedSkill): Promise<void> {
    if (await this.store.retire(skill)) {
      this.confirming.set(false);
      await this.settings.loadResources();
    }
  }
}

/**
 * The retired learned skills: a collapsed group under the skills, "Retired · 2", that opens to a row per skill with **Restore**. A retired skill is not loaded by pi, so it
 * is not in the list above; nothing here deletes it.
 */
@Component({
  selector: 'pk-learned-retired',
  imports: [PkTip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.retired().length > 0) {
      <section
        class="pk-group pk-retired"
        [attr.aria-label]="'settings.learnedSkill.retiredSkills' | transloco"
        data-testid="retired-group"
      >
        <header>
          <button
            type="button"
            class="disclose"
            [attr.aria-expanded]="open()"
            aria-controls="retired-rows"
            data-testid="retired-toggle"
            (click)="open.set(!open())"
          >
            <pk-icon name="chevron-right" class="chev" />
            <span
              ><h4>{{ 'settings.learnedSkill.retired' | transloco }}</h4>
              <p>{{ 'settings.learnedSkill.learnedSkillsPiDoesNotLoadAny' | transloco }}</p></span
            >
          </button>
          <span class="chip off" data-testid="retired-count">{{ store.retired().length }}</span>
        </header>
        @if (open()) {
          <div id="retired-rows">
            @for (s of store.retired(); track s.id) {
              <div class="row" [attr.data-testid]="'retired-' + s.name">
                <div class="min-w-0">
                  <div class="lbl">
                    <span>{{ s.name }}</span
                    ><span class="chip off">{{ retiredText(s) }}</span>
                  </div>
                  <div class="hint">
                    {{
                      'settings.learnedSkill.learnedFromc9118'
                        | transloco
                          : {
                              value1:
                                s.learnedFrom.title ?? ('settings.learnedSkill.aThreadThatWasDeleted' | transloco),
                            }
                    }}
                  </div>
                  @if (store.errors()[s.id]; as error) {
                    <div class="hint text-error" role="alert" data-testid="retired-error">{{ error }}</div>
                  }
                </div>
                <div class="ctl ctl-w">
                  @if (store.busy()[s.id]) {
                    <span
                      class="loading loading-spinner loading-xs"
                      [attr.aria-label]="'settings.learnedSkill.restoring' | transloco"
                    ></span>
                  }
                  <span [pkTip]="'settings.learnedSkill.movesTheFolderBackAndMakesPi' | transloco"
                    ><button
                      type="button"
                      class="btn btn-sm"
                      data-testid="learned-restore"
                      [disabled]="!!store.busy()[s.id] || s.missing"
                      (click)="restore(s)"
                    >
                      {{ 'settings.learnedSkill.restore' | transloco }}
                    </button></span
                  >
                </div>
              </div>
            }
          </div>
        }
      </section>
    }
  `,
})
export class PkLearnedRetired {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(LearnedStore);
  private readonly settings = inject(SettingsStore);
  protected readonly open = signal(false);
  protected readonly retiredText = (skill: LearnedSkill): string => retiredText(this.i18n.t, skill);

  constructor() {
    void this.store.load();
  }

  protected async restore(skill: LearnedSkill): Promise<void> {
    if (await this.store.restore(skill)) await this.settings.loadResources();
  }
}
