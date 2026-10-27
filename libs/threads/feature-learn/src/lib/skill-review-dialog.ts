import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import { LearnStore, ThreadsStore } from '@pi-kit/threads/data';
import {
  type ChipTone,
  agoText,
  checkStateText,
  fileStatusChip,
  percentText,
  scopeFolder,
  threadLabel,
  verificationChip,
  verificationPhaseText,
} from '@pi-kit/threads/util';

/** A comparison with many files shows this many and counts the rest. */
const FILES_SHOWN = 12;

/**
 * The skill review: an inline page in a learning chat; approved-skill editing also uses this component as a dialog in the workflow-dialog frame (`.pk-wf`, a bottom sheet on phones) with three views. *Working* while the
 * attendant's model drafts; *consent* when the attendant is off and the transcript would go to a model (the person agrees once per thread); and *review*, the point of it all:
 * the `SKILL.md` as pi will load it in an editor (frontmatter and the `x-pi-kit` provenance visible), the name (its `name:` line), the scope (this project's `.pi/skills/` or the
 * user's pi folder), "Verify first" (on by default) with the **verification** section (the prompt to replay, the running state, and the report with its numbers), where the
 * thread comes from, and the two decisions. With "Verify first" on, the primary button replays the skill from the thread's base commit and then waits for the person: **Approve** writes the
 * folder; **Discard** records the decision and writes nothing. Esc closes. This component is a lazy chunk.
 */
@Component({
  selector: 'pk-skill-review-dialog',
  imports: [PkTip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Esc closes it wherever the focus is: the control that had it can go away or be disabled while a replay runs (the primary button), and the focus then falls to the page.
  host: { '(document:keydown.escape)': 'onEscape($event)', '[class.embedded]': 'embedded()' },
  template: `
    @if (store.dialog(); as d) {
      <div class="pk-wf pk-learn" [class.embedded]="embedded()">
        @if (!embedded()) {
          <button
            type="button"
            class="pk-backdrop"
            tabindex="-1"
            [attr.aria-label]="'threads.skillReviewDialog.close' | transloco"
            (click)="store.close()"
          ></button>
        }
        <div
          #win
          class="win"
          [attr.role]="embedded() ? 'region' : 'dialog'"
          [attr.aria-modal]="embedded() ? null : true"
          [attr.aria-label]="title()"
          tabindex="-1"
          data-testid="review-dialog"
          [attr.data-view]="d.view"
          (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); store.close()"
        >
          <div class="head">
            <h2>{{ title() }}</h2>
            @if (store.draft(); as draft) {
              <span
                class="chip"
                [class.ok]="draft.state === 'approved'"
                [class.off]="draft.state === 'discarded'"
                data-testid="draft-state"
                >{{ draft.state }}</span
              >
            }
            <button
              type="button"
              class="pk-close ml-auto"
              [title]="
                embedded()
                  ? ('threads.skillReviewDialog.backToSourceChat' | transloco)
                  : ('threads.skillReviewDialog.close' | transloco)
              "
              [attr.aria-label]="
                embedded()
                  ? ('threads.skillReviewDialog.backToSourceChat' | transloco)
                  : ('threads.skillReviewDialog.close' | transloco)
              "
              (click)="store.close()"
            >
              <pk-icon name="close" />
            </button>
          </div>

          @switch (d.view) {
            @case ('working') {
              <div class="body">
                @if (store.error(); as error) {
                  <p class="text-sm text-error" role="alert" data-testid="learn-error">{{ error }}</p>
                } @else {
                  <div class="flex items-center gap-3">
                    <span class="loading loading-spinner loading-sm text-primary" aria-hidden="true"></span>
                    <p class="text-sm" role="status">
                      {{ 'threads.skillReviewDialog.readingTheSourceChatAndDraftingA' | transloco }}
                    </p>
                  </div>
                }
              </div>
              <div class="foot">
                <span class="ml-auto"
                  ><button type="button" class="btn btn-sm btn-ghost" (click)="store.close()">
                    {{ 'threads.skillReviewDialog.close' | transloco }}
                  </button></span
                >
              </div>
            }
            @case ('consent') {
              <div class="body">
                <p class="text-sm" data-testid="consent-text">{{ store.consent()?.message }}</p>
                <p class="hint">
                  {{ 'threads.skillReviewDialog.theTextIsReadBy' | transloco }}
                  <span class="chip off">{{ store.consent()?.model }}</span
                  >{{ 'threads.skillReviewDialog.youReadTheDraftBeforeAnythingIs' | transloco }}
                </p>
              </div>
              <div class="foot">
                <span class="ml-auto flex items-center gap-2">
                  <button type="button" class="btn btn-sm btn-ghost" (click)="store.close()">
                    {{ 'threads.skillReviewDialog.cancel' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    data-testid="consent-agree"
                    (click)="store.agree()"
                  >
                    {{ 'threads.skillReviewDialog.sendAndDraft' | transloco }}
                  </button>
                </span>
              </div>
            }
            @default {
              <div class="body">
                @if (store.busy() === 'loading') {
                  <div class="grid place-items-center py-6">
                    <span
                      class="loading loading-dots loading-sm text-primary"
                      [attr.aria-label]="'threads.skillReviewDialog.readingTheDraft' | transloco"
                    ></span>
                  </div>
                } @else if (store.draft(); as draft) {
                  <div class="namefield">
                    <label class="lbl" for="skill-name">{{ 'threads.skillReviewDialog.name' | transloco }}</label>
                    <input
                      id="skill-name"
                      class="input input-sm w-full"
                      data-testid="skill-name"
                      spellcheck="false"
                      autocomplete="off"
                      [value]="store.name()"
                      [readOnly]="!store.pending()"
                      (input)="store.setName($any($event.target).value)"
                    />
                    <span class="hint"
                      >{{ 'threads.skillReviewDialog.piListsTheSkillByThisName' | transloco }}
                      <code>/skill:{{ store.name() || 'name' }}</code>
                      {{ 'threads.skillReviewDialog.inTheComposerAddsItToA' | transloco }}</span
                    >
                  </div>

                  <div>
                    <label class="lbl" for="skill-text">{{
                      'threads.skillReviewDialog.sKILLMdAsPiWillLoadIt' | transloco
                    }}</label>
                    <div class="hint mb-1">
                      {{ 'threads.skillReviewDialog.theFrontmatterAtTheTopIsWhat' | transloco }}
                      <code>x-pi-kit</code>
                      {{
                        'threads.skillReviewDialog.blockRecordsWhereItWasLearnedAnd'
                          | transloco
                            : {
                                value1: store.editing()
                                  ? ('threads.skillReviewDialog.stampedAgainWhenYouSave' | transloco)
                                  : ('threads.skillReviewDialog.keptWhenYouApprove' | transloco),
                              }
                      }}
                    </div>
                    <textarea
                      id="skill-text"
                      class="textarea editor"
                      data-testid="skill-text"
                      spellcheck="false"
                      wrap="off"
                      rows="16"
                      [value]="store.text()"
                      [readOnly]="!store.editable()"
                      (input)="store.setText($any($event.target).value)"
                    ></textarea>
                    @if (store.editable() && store.problems().length > 0) {
                      <ul class="problems mt-1" role="alert" data-testid="learn-problems">
                        @for (problem of store.problems(); track problem) {
                          <li>{{ problem }}</li>
                        }
                      </ul>
                    }
                  </div>

                  <fieldset class="flex flex-col gap-2" [disabled]="!store.pending() || store.busy() !== undefined">
                    <legend class="lbl mb-1">{{ 'threads.skillReviewDialog.whereItGoes' | transloco }}</legend>
                    <div class="scopes">
                      <button
                        type="button"
                        class="pk-choice"
                        [attr.aria-pressed]="store.scope() === 'project'"
                        data-testid="scope-project"
                        (click)="store.setScope('project')"
                      >
                        <span class="lbl">{{ 'threads.skillReviewDialog.thisProject' | transloco }}</span>
                        <span class="hint path">{{ folder('project') }}</span>
                      </button>
                      <button
                        type="button"
                        class="pk-choice"
                        [attr.aria-pressed]="store.scope() === 'user'"
                        data-testid="scope-user"
                        (click)="store.setScope('user')"
                      >
                        <span class="lbl">{{ 'threads.skillReviewDialog.everyProject' | transloco }}</span>
                        <span class="hint path">{{ folder('user') }}</span>
                      </button>
                    </div>
                  </fieldset>

                  @if (store.pending()) {
                    <label class="verify text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        class="toggle toggle-sm toggle-primary mt-0.5"
                        role="switch"
                        data-testid="verify-switch"
                        [checked]="store.verify()"
                        [disabled]="store.busy() !== undefined || store.running()"
                        (change)="store.setVerify($any($event.target).checked)"
                      />
                      <span
                        >{{ 'threads.skillReviewDialog.verifyFirst' | transloco
                        }}<span class="hint block">{{
                          'threads.skillReviewDialog.replaysTheSkillFromTheCommitThe' | transloco
                        }}</span></span
                      >
                    </label>
                  }

                  @if (draft.state !== 'discarded') {
                    <div
                      class="box verification"
                      data-testid="verification"
                      [attr.data-state]="store.verification()?.state ?? 'none'"
                      [attr.data-result]="store.verification()?.result ?? null"
                    >
                      <div class="vhead">
                        <span class="lbl">{{ 'threads.skillReviewDialog.verification' | transloco }}</span>
                        @if (chip(); as c) {
                          <span [class]="chipClass(c.tone)" data-testid="verification-result">{{ c.label }}</span>
                        }
                        @if (store.stale()) {
                          <span class="chip warn" data-testid="verification-stale">{{
                            'threads.skillReviewDialog.editedSince' | transloco
                          }}</span>
                        }
                        <span class="ml-auto flex items-center gap-2">
                          @if (store.running()) {
                            <button
                              type="button"
                              class="btn btn-xs btn-ghost"
                              data-testid="verify-stop"
                              (click)="store.stopVerify()"
                            >
                              {{ 'threads.skillReviewDialog.stop' | transloco }}
                            </button>
                          } @else if (store.plan()?.canVerify && store.problems().length === 0) {
                            <button
                              type="button"
                              class="btn btn-xs"
                              data-testid="verify-run"
                              [disabled]="store.busy() !== undefined"
                              [pkTip]="
                                store.dirty()
                                  ? ('threads.skillReviewDialog.saveYourEditFirstAReplayUses' | transloco)
                                  : ''
                              "
                              (click)="store.runVerify()"
                            >
                              {{
                                store.verification()?.state === 'done'
                                  ? ('threads.skillReviewDialog.verifyAgain' | transloco)
                                  : ('threads.skillReviewDialog.verifyNow' | transloco)
                              }}
                            </button>
                          }
                        </span>
                      </div>

                      @if (store.running()) {
                        <div class="vrun" role="status" data-testid="verification-running">
                          <span class="loading loading-spinner loading-sm text-primary" aria-hidden="true"></span>
                          <span class="text-sm" data-testid="verification-phase">{{ phase() }}</span>
                        </div>
                        <p class="hint">
                          {{
                            'threads.skillReviewDialog.itRunsAsAThreadCalledVerify'
                              | transloco: { value1: store.name() }
                          }}
                        </p>
                      } @else {
                        @if (store.verification(); as v) {
                          @switch (v.state) {
                            @case ('done') {
                              <p class="vsummary" data-testid="verification-summary">{{ v.summary }}</p>
                              @if (v.score !== undefined) {
                                <div class="flex items-center gap-2 text-xs" data-testid="verification-score">
                                  <progress
                                    class="progress progress-primary w-40"
                                    [value]="v.score"
                                    max="1"
                                    [attr.aria-label]="
                                      ('threads.skillReviewDialog.similarityOfTheWholeDiff' | transloco) +
                                      percent(v.score)
                                    "
                                  ></progress>
                                  <span class="hint">{{
                                    'threads.skillReviewDialog.ofTheChangedLinesMatch'
                                      | transloco: { value1: percent(v.score) }
                                  }}</span>
                                </div>
                              }
                              @if (v.fileList && v.fileList.length > 0) {
                                <ul class="vfiles" data-testid="verification-files">
                                  @for (file of shownFiles(); track file.path) {
                                    <li [attr.data-status]="file.status">
                                      <span class="path">{{ file.path }}</span>
                                      <span [class]="chipClass(fileChip(file.status).tone)">{{
                                        fileChip(file.status).label
                                      }}</span>
                                      <span class="num">{{
                                        'threads.skillReviewDialog.ofHunks'
                                          | transloco
                                            : {
                                                value1: percent(file.similarity),
                                                value2: file.hunks.matched,
                                                value3: file.hunks.expected,
                                              }
                                      }}</span>
                                    </li>
                                  }
                                </ul>
                                @if (moreFiles() > 0) {
                                  <span class="hint">{{
                                    'threads.skillReviewDialog.andMore' | transloco: { value1: moreFiles() }
                                  }}</span>
                                }
                              }
                              @if (v.checks && v.checks.length > 0) {
                                <ul class="vchecks" data-testid="verification-checks">
                                  @for (check of v.checks; track check.command) {
                                    <li [attr.data-state]="check.state">
                                      <span class="cmd">{{ check.command }}</span>
                                      <span
                                        [class]="
                                          chipClass(
                                            check.state === 'passed' ? 'ok' : check.state === 'failed' ? 'err' : 'off'
                                          )
                                        "
                                        >{{ checkText(check) }}</span
                                      >
                                      <span class="num">{{
                                        'threads.skillReviewDialog.inTheThread'
                                          | transloco
                                            : {
                                                value1: check.originalPassed
                                                  ? ('threads.skillReviewDialog.passed' | transloco)
                                                  : ('threads.skillReviewDialog.failed' | transloco),
                                                value2: check.note ? ', ' + check.note : '',
                                              }
                                      }}</span>
                                    </li>
                                  }
                                </ul>
                              }
                            }
                            @case ('error') {
                              <p class="text-sm text-error" role="alert" data-testid="verification-error">
                                {{ v.error }}
                              </p>
                            }
                            @case ('stopped') {
                              <p class="text-sm" data-testid="verification-stopped">
                                {{ 'threads.skillReviewDialog.theReplayWasStoppedBeforeItFinished' | transloco }}
                              </p>
                            }
                          }
                          @for (warning of v.warnings ?? []; track warning) {
                            <p class="vwarn" data-testid="verification-warning">{{ warning }}</p>
                          }
                        }
                        @if (store.stale()) {
                          <p class="vstale" data-testid="verification-stale-note">
                            {{ 'threads.skillReviewDialog.youEditedTheSkillAfterThisRun' | transloco }}
                          </p>
                        }
                        @if (store.plan(); as plan) {
                          @if (plan.canVerify) {
                            <label class="lbl" for="verify-prompt">{{
                              'threads.skillReviewDialog.firstPromptOfTheReplay' | transloco
                            }}</label>
                            <textarea
                              id="verify-prompt"
                              class="textarea vprompt"
                              data-testid="verify-prompt"
                              spellcheck="false"
                              rows="3"
                              [value]="store.prompt()"
                              [readOnly]="store.busy() !== undefined"
                              (input)="store.setPrompt($any($event.target).value)"
                            ></textarea>
                            <span class="hint" data-testid="verify-plan">
                              {{
                                'threads.skillReviewDialog.theThreadSOwnSentFromCommit'
                                  | transloco
                                    : {
                                        value1: short(plan.base),
                                        value2: plan.model
                                          ? ('threads.skillReviewDialog.and' | transloco) + plan.model
                                          : '',
                                        value3: plan.files,
                                        value4:
                                          plan.files === 1
                                            ? ('threads.skillReviewDialog.file' | transloco)
                                            : ('threads.skillReviewDialog.files' | transloco),
                                        value5:
                                          plan.checks.length > 0
                                            ? ('threads.skillReviewDialog.itRunsTheThreadS' | transloco) +
                                              plan.checks.length +
                                              (plan.checks.length === 1
                                                ? ('threads.skillReviewDialog.check' | transloco)
                                                : ('threads.skillReviewDialog.checks' | transloco)) +
                                              ('threads.skillReviewDialog.again' | transloco)
                                            : '',
                                      }
                              }}
                            </span>
                          } @else {
                            <p class="hint" data-testid="verify-reason">
                              {{ 'threads.skillReviewDialog.cannotBeVerifiedNow' | transloco: { value1: plan.reason } }}
                            </p>
                          }
                        } @else if (!store.verification()) {
                          <p class="hint">{{ 'threads.skillReviewDialog.notVerifiedYet' | transloco }}</p>
                        }
                      }
                    </div>
                  }

                  <div class="box" data-testid="provenance">
                    <div class="lbl">{{ 'threads.skillReviewDialog.whereItComesFrom' | transloco }}</div>
                    <dl class="prov">
                      <dt>{{ 'threads.skillReviewDialog.thread' | transloco }}</dt>
                      <dd>{{ threadName() }}</dd>
                      <dt>{{ 'threads.skillReviewDialog.draftedBy' | transloco }}</dt>
                      <dd>
                        {{
                          draft.madeBy === 'attendant'
                            ? ('threads.skillReviewDialog.theAttendant' | transloco)
                            : ('threads.skillReviewDialog.youOnRequest' | transloco)
                        }}{{ draft.model ? ('threads.skillReviewDialog.with' | transloco) + draft.model : '' }}
                      </dd>
                      <dt>{{ 'threads.skillReviewDialog.when' | transloco }}</dt>
                      <dd>{{ ago(draft.createdAt) }}</dd>
                      @if (draft.path) {
                        <dt>{{ 'threads.skillReviewDialog.writtenTo' | transloco }}</dt>
                        <dd data-testid="draft-path">{{ draft.path }}</dd>
                      }
                    </dl>
                  </div>
                }
              </div>

              <!-- Outside the scrolling body, so a refusal is in view whatever the editor is scrolled to. -->
              @if (store.error(); as error) {
                <p class="px-5 py-2 text-sm text-error border-t border-base-300" role="alert" data-testid="learn-error">
                  {{ error }}
                </p>
              }

              <div class="foot">
                @if (store.busy() === 'approving' || store.busy() === 'discarding' || store.busy() === 'saving') {
                  <span class="loading loading-spinner loading-xs text-primary" aria-hidden="true"></span>
                  <span class="hint">{{
                    store.busy() === 'approving'
                      ? ('threads.skillReviewDialog.writingTheSkill' | transloco)
                      : store.busy() === 'saving'
                        ? ('threads.skillReviewDialog.savingTheSkill' | transloco)
                        : ('threads.skillReviewDialog.discarding' | transloco)
                  }}</span>
                } @else if (store.busy() === 'starting') {
                  <span class="loading loading-spinner loading-xs text-primary" aria-hidden="true"></span>
                  <span class="hint">{{ 'threads.skillReviewDialog.startingTheReplay' | transloco }}</span>
                }
                @if (store.pending() && store.step().note; as note) {
                  <span class="hint" data-testid="step-note">{{ note }}</span>
                }
                <span class="ml-auto flex items-center gap-2">
                  @if (store.editing()) {
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost"
                      data-testid="edit-cancel"
                      (click)="store.close()"
                    >
                      {{ 'threads.skillReviewDialog.cancel' | transloco }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-primary"
                      data-testid="edit-save"
                      [disabled]="!store.canSave()"
                      (click)="store.save()"
                    >
                      {{ 'threads.skillReviewDialog.save' | transloco }}
                    </button>
                  } @else if (store.draft()?.state === 'pending') {
                    <button
                      type="button"
                      class="btn btn-sm btn-ghost"
                      data-testid="discard"
                      [disabled]="store.busy() !== undefined"
                      (click)="store.discard()"
                    >
                      {{ 'threads.skillReviewDialog.discard' | transloco }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-primary"
                      data-testid="approve"
                      [attr.data-step]="store.step().action"
                      [disabled]="!store.canPrimary()"
                      (click)="store.primary()"
                    >
                      {{ store.step().label }}
                    </button>
                  } @else if (store.draft()?.state === 'discarded') {
                    <button type="button" class="btn btn-sm btn-ghost" (click)="store.close()">
                      {{ 'threads.skillReviewDialog.close' | transloco }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-primary"
                      data-testid="reopen"
                      [disabled]="store.busy() !== undefined"
                      (click)="store.reopen()"
                    >
                      {{ 'threads.skillReviewDialog.reopenTheDraft' | transloco }}
                    </button>
                  } @else {
                    <button type="button" class="btn btn-sm" (click)="store.close()">
                      {{ 'threads.skillReviewDialog.done' | transloco }}
                    </button>
                  }
                </span>
              </div>
            }
          }
        </div>
      </div>
    }
  `,
  styles: `
    :host(.embedded) {
      grid-row: 2 / -1;
      display: flex;
      min-height: 0;
      overflow: hidden;
    }
    .pk-wf.embedded {
      position: static;
      inset: auto;
      display: flex;
      flex: 1;
      min-height: 0;
      padding: 0;
      background: transparent;
      z-index: auto;
      animation: none;
    }
    .pk-wf.pk-learn.embedded .win {
      flex: 1;
      width: 100%;
      height: 100%;
      max-height: none;
      border-radius: 0;
      box-shadow: none;
      animation: none;
    }
    .embedded .body {
      flex: 1;
      min-height: 0;
    }
  `,
})
export class SkillReviewDialog {
  protected readonly i18n = inject(Language);
  readonly embedded = input(false);

  protected readonly store = inject(LearnStore);
  private readonly threads = inject(ThreadsStore);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');

  protected readonly title = computed(() => {
    switch (this.store.dialog()?.view) {
      case 'working':
        return this.i18n.t('threads.skillReviewDialog.draftingASkill');
      case 'consent':
        return this.i18n.t('threads.skillReviewDialog.learnASkillFromThisThread');
      default:
        return this.store.editing()
          ? this.i18n.t('threads.skillReviewDialog.editTheSkill')
          : this.i18n.t('threads.skillReviewDialog.reviewTheSkill');
    }
  });

  protected readonly threadName = computed(() => {
    const id = this.store.dialog()?.threadId;
    const thread = id ? this.threads.threads().find((t) => t.id === id) : undefined;
    return thread
      ? threadLabel(this.i18n.t, thread)
      : (this.store.editOf()?.title ??
          (this.store.editing() ? this.i18n.t('threads.skillReviewDialog.aThreadThatWasDeleted') : (id ?? '')));
  });

  constructor() {
    // Focus the review when its view opens; embedded pages never intercept Escape elsewhere in the app.
    effect(() => {
      if (this.store.dialog() && this.win()) queueMicrotask(() => this.win()?.nativeElement.focus());
    });
  }

  protected onEscape(event: Event): void {
    // The dialog's own handler (on the window element) already took an Esc that was pressed inside it.
    if (this.embedded() || !this.store.dialog() || event.defaultPrevented) return;
    event.preventDefault();
    this.store.close();
  }

  protected readonly chip = computed(() => verificationChip(this.i18n.t, this.store.verification()));
  protected readonly phase = computed(() => verificationPhaseText(this.i18n.t, this.store.verification()?.phase));
  private readonly files = computed(() => this.store.verification()?.fileList ?? []);
  protected readonly shownFiles = computed(() => this.files().slice(0, FILES_SHOWN));
  protected readonly moreFiles = computed(() => Math.max(0, this.files().length - FILES_SHOWN));

  protected chipClass(tone: ChipTone): string {
    return `chip ${tone}`;
  }

  protected readonly fileChip = fileStatusChip.bind(undefined, this.i18n.t);
  protected readonly checkText = checkStateText.bind(undefined, this.i18n.t);
  protected readonly percent = percentText;

  protected short(commit: string | null | undefined): string {
    return commit ? commit.slice(0, 7) : this.i18n.t('threads.skillReviewDialog.theBase');
  }

  protected folder(scope: 'project' | 'user'): string {
    return scopeFolder(scope, this.store.name());
  }

  protected ago(at: number): string {
    return agoText(this.i18n.t, at);
  }
}
