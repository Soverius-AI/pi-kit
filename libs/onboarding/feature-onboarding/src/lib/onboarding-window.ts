import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { foundLines } from '@pi-kit/ui';
import { UiStore } from '@pi-kit/data-access';
import { PkIcon, PkLogo } from '@pi-kit/design-system';
import { GetModel, KeyWorkflow } from '@pi-kit/settings/api';
import { OnboardingStore } from '@pi-kit/onboarding/data';

/**
 * The first-run flow: a full-window overlay with a progress rail on the left (a dot strip above the card below 1024 px) and one card at a
 * time: Welcome, Get a model, Pick defaults, Open a folder. The fifth step is not a card here; the flow docks into `pk-onboarding-strip` over the real chat page. Every
 * step can be skipped and none of it differs by operating system. The component renders `OnboardingStore` and forwards clicks; sign-in and the API-key dialog are the
 * same ones Settings › Providers uses (`pk-get-model`, `pk-key-workflow`).
 */
@Component({
  selector: 'pk-onboarding',
  imports: [GetModel, KeyWorkflow, PkLogo, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ob.open() && !ob.docked()) {
      <div
        #root
        class="pk-ob"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'onboarding.onboardingWindow.setUpPiKit' | transloco"
        tabindex="-1"
        data-testid="onboarding"
        [attr.data-step]="ob.step()"
      >
        <aside class="rail" [attr.aria-label]="'onboarding.onboardingWindow.setupSteps' | transloco">
          <div class="brand"><pk-logo tone="gold" [size]="28" [wordmark]="true" /></div>
          <ol class="ob-steps">
            @for (step of ob.steps(); track step.id) {
              <li
                class="ob-step"
                [class.done]="step.state === 'done'"
                [class.now]="step.state === 'now'"
                [attr.aria-current]="step.state === 'now' ? 'step' : null"
                [attr.data-step-id]="step.id"
              >
                <span class="num">
                  @if (step.state === 'done') {
                    <pk-icon name="check" [label]="'onboarding.onboardingWindow.done' | transloco" size="14" />
                  } @else {
                    {{ $index + 1 }}
                  }
                </span>
                <span
                  >{{ step.title }}<small>{{ step.sub }}</small></span
                >
              </li>
            }
          </ol>
          <div class="grow"></div>
          <button type="button" class="link link-hover t-sm muted skip" data-testid="skip-setup" (click)="ob.skip()">
            {{ 'onboarding.onboardingWindow.skipSetupIKnowPi' | transloco }}
          </button>
        </aside>

        <main>
          <div class="ob-card">
            @switch (ob.step()) {
              @case ('welcome') {
                <h1>{{ 'onboarding.onboardingWindow.welcomeToPiKit' | transloco }}</h1>
                <p class="lead">
                  {{ 'onboarding.onboardingWindow.piKitIsADesktopWindowFor' | transloco }}
                </p>
                <div
                  class="found"
                  data-testid="found"
                  [attr.aria-label]="'onboarding.onboardingWindow.whatPiKitFound' | transloco"
                >
                  @if (ob.detecting() && !ob.info()) {
                    <span
                      ><span class="loading loading-spinner loading-xs"></span>
                      {{ 'onboarding.onboardingWindow.lookingAtThisMachine' | transloco }}</span
                    >
                  }
                  @for (line of found(); track line.strong) {
                    <span [class.muted]="line.tone === 'muted'"
                      >{{ line.tone === 'muted' ? '' : ('onboarding.onboardingWindow.found' | transloco)
                      }}<b>{{ line.strong }}</b> {{ line.text }}</span
                    >
                  }
                </div>
                @if (ob.detectError(); as error) {
                  <p class="t-sm text-error" role="alert">
                    {{ 'onboarding.onboardingWindow.couldNotLookAtThisMachine' | transloco: { value1: error } }}
                  </p>
                }
                @if (ob.info()?.existingSetupWorks) {
                  <div class="box" data-testid="existing-setup">
                    <div class="t-sm">
                      <b>{{ 'onboarding.onboardingWindow.yourPiSetupAlreadyWorks' | transloco }}</b>
                      {{
                        'onboarding.onboardingWindow.piKitFoundWithAModelAnd'
                          | transloco
                            : {
                                value1: ob.info()?.providers?.length,
                                value2:
                                  ob.info()?.providers?.length === 1
                                    ? ('onboarding.onboardingWindow.provider' | transloco)
                                    : ('onboarding.onboardingWindow.providers' | transloco),
                                value3: ob.info()?.agentDir?.sessionCount,
                                value4:
                                  ob.info()?.agentDir?.sessionCount === 1
                                    ? ('onboarding.onboardingWindow.session' | transloco)
                                    : ('onboarding.onboardingWindow.sessions' | transloco),
                                value5: ob.info()?.agentDir?.path,
                              }
                      }}
                    </div>
                  </div>
                } @else if (ob.info() && !ob.info()?.needsSetup) {
                  <p class="t-sm muted">{{ 'onboarding.onboardingWindow.aModelIsReadyYouCanAdd' | transloco }}</p>
                } @else if (ob.info()) {
                  <p class="t-sm muted">
                    {{ 'onboarding.onboardingWindow.piHasNoModelToTalkTo' | transloco }}
                  </p>
                }
                <div class="foot">
                  <span class="muted t-sm"
                    >{{ ob.info()?.os?.platform }} {{ ob.info()?.os?.arch }}
                    @if (ob.info()?.proxy; as proxy) {
                      {{ 'onboarding.onboardingWindow.throughTheProxy' | transloco: { value1: proxy } }}
                    }
                  </span>
                  @if (ob.info()?.existingSetupWorks) {
                    <button type="button" class="btn btn-sm ml-auto" data-testid="set-up-another" (click)="ob.next()">
                      {{ 'onboarding.onboardingWindow.setUpAnotherModel' | transloco }}
                    </button>
                    <button
                      type="button"
                      class="btn btn-sm btn-primary"
                      data-testid="use-existing"
                      (click)="ob.useExisting()"
                    >
                      {{ 'onboarding.onboardingWindow.useMyExistingPiSetup' | transloco }}
                    </button>
                  } @else {
                    <button
                      type="button"
                      class="btn btn-sm btn-primary ml-auto"
                      data-testid="get-started"
                      [disabled]="!ob.info()"
                      (click)="ob.next()"
                    >
                      {{ 'onboarding.onboardingWindow.getStarted' | transloco }}
                    </button>
                  }
                </div>
              }

              @case ('model') {
                <h1>{{ 'onboarding.onboardingWindow.howShouldPiReachAModel' | transloco }}</h1>
                <p class="lead">
                  {{ 'onboarding.onboardingWindow.pickOneToStartYouCanAdd' | transloco }}
                </p>
                <pk-get-model />
                <div class="foot">
                  <button type="button" class="btn btn-ghost btn-sm" (click)="ob.back()">
                    <pk-icon name="chevron-left" size="16" />{{ 'onboarding.onboardingWindow.back' | transloco }}
                  </button>
                  <span class="muted t-sm" data-testid="model-summary" role="status">{{
                    ob.hasModel()
                      ? ob.models().length +
                        (ob.models().length === 1
                          ? ('onboarding.onboardingWindow.model' | transloco)
                          : ('onboarding.onboardingWindow.models' | transloco)) +
                        ('onboarding.onboardingWindow.readyToUse' | transloco)
                      : ('onboarding.onboardingWindow.nothingChosenYet' | transloco)
                  }}</span>
                  <button
                    type="button"
                    class="btn btn-sm ml-auto"
                    [class.btn-ghost]="ob.hasModel()"
                    (click)="ob.next()"
                    [hidden]="ob.hasModel()"
                    data-testid="skip-model"
                  >
                    {{ 'onboarding.onboardingWindow.skipForNow' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    [class.ml-auto]="ob.hasModel()"
                    data-testid="continue"
                    [disabled]="!ob.hasModel()"
                    (click)="ob.next()"
                  >
                    {{ 'onboarding.onboardingWindow.continue' | transloco }}
                  </button>
                </div>
              }

              @case ('defaults') {
                <h1>{{ 'onboarding.onboardingWindow.pickYourDefaults' | transloco }}</h1>
                <p class="lead">
                  {{ 'onboarding.onboardingWindow.newThreadsStartWithTheseEverythingHere' | transloco }}
                </p>
                @if (!ob.hasModel()) {
                  <div class="box">
                    <div class="t-sm">
                      {{ 'onboarding.onboardingWindow.thereIsNoModelYetSoThere' | transloco }}
                    </div>
                  </div>
                } @else {
                  <div class="pk-group" data-testid="defaults">
                    <div class="row">
                      <div>
                        <div class="lbl">
                          <label for="ob-model">{{ 'onboarding.onboardingWindow.defaultModel' | transloco }}</label>
                        </div>
                        <div class="hint">
                          {{ 'onboarding.onboardingWindow.pricePerMillionTokensAndContextAre' | transloco }}
                        </div>
                      </div>
                      <div class="ctl">
                        <select
                          id="ob-model"
                          class="select select-sm w-[22rem] max-w-full"
                          data-testid="default-model"
                          [value]="ob.defaults().selected"
                          (change)="ob.chooseModel($any($event.target).value)"
                        >
                          @for (option of ob.defaults().options; track option.value) {
                            <option [value]="option.value" [selected]="option.value === ob.defaults().selected">
                              {{ option.label }}
                            </option>
                          }
                        </select>
                      </div>
                    </div>
                    <div class="row">
                      <div>
                        <div class="lbl">
                          <label for="ob-effort">{{ 'onboarding.onboardingWindow.effort' | transloco }}</label>
                        </div>
                        <div class="hint">
                          {{
                            ob.defaults().reasoning
                              ? ('onboarding.onboardingWindow.howHardTheModelThinksBeforeIt' | transloco)
                              : ('onboarding.onboardingWindow.thisModelDoesNotThinkBeforeAnswering' | transloco)
                          }}
                        </div>
                      </div>
                      <div class="ctl">
                        <select
                          id="ob-effort"
                          class="select select-sm w-40"
                          data-testid="default-effort"
                          [disabled]="!ob.defaults().reasoning"
                          [value]="ob.defaults().effort"
                          (change)="ob.chooseEffort($any($event.target).value)"
                        >
                          @for (level of ob.defaults().levels; track level) {
                            <option [value]="level" [selected]="level === ob.defaults().effort">
                              {{ 'common.effortValue.' + level | transloco }}
                            </option>
                          }
                        </select>
                      </div>
                    </div>
                    <div class="ob-scope">
                      <div>
                        <div class="lbl">
                          {{ 'onboarding.onboardingWindow.modelsFor' | transloco }} <kbd class="kbd kbd-sm">⌘⇧M</kbd>
                        </div>
                        <div class="hint">
                          {{
                            ob.defaults().pinned.length === 0
                              ? ('onboarding.onboardingWindow.nonePinnedMCyclesEveryModelCheck' | transloco)
                              : ob.defaults().pinned.length +
                                ('onboarding.onboardingWindow.pinnedMCyclesThroughThese' | transloco)
                          }}
                        </div>
                      </div>
                      <div>
                        <label class="sr-only" for="ob-scope-filter">{{
                          'onboarding.onboardingWindow.filterTheModels' | transloco
                        }}</label>
                        <input
                          id="ob-scope-filter"
                          type="search"
                          class="input input-sm w-full mb-2"
                          [placeholder]="
                            'onboarding.onboardingWindow.filterTheModels2f27f'
                              | transloco: { value1: ob.defaults().options.length }
                          "
                          autocomplete="off"
                          spellcheck="false"
                          [value]="scopeFilter()"
                          (input)="scopeFilter.set($any($event.target).value)"
                        />
                        <div
                          class="scope"
                          role="group"
                          [attr.aria-label]="'onboarding.onboardingWindow.modelsInTheMCycle' | transloco"
                          data-testid="pinned-models"
                        >
                          @for (option of scopeOptions(); track option.value) {
                            <label class="flex items-center gap-2 t-sm"
                              ><input
                                type="checkbox"
                                class="checkbox checkbox-xs"
                                [checked]="ob.defaults().pinned.includes(option.value)"
                                (change)="ob.togglePinned(option.value, $any($event.target).checked)"
                              />
                              <span class="truncate" [title]="option.label">{{ option.label }}</span></label
                            >
                          } @empty {
                            <span class="t-sm muted">{{
                              'onboarding.onboardingWindow.noModelMatches' | transloco
                            }}</span>
                          }
                        </div>
                      </div>
                    </div>
                    <div class="row">
                      <div>
                        <div class="lbl">
                          <label for="ob-compact">{{
                            'onboarding.onboardingWindow.compactTheContextAutomatically' | transloco
                          }}</label>
                        </div>
                        <div class="hint">
                          {{ 'onboarding.onboardingWindow.piSummarisesTheConversationWhenItNears' | transloco }}
                        </div>
                      </div>
                      <div class="ctl">
                        <input
                          id="ob-compact"
                          type="checkbox"
                          class="toggle toggle-sm"
                          role="switch"
                          data-testid="auto-compaction"
                          [checked]="ob.defaults().autoCompaction"
                          (change)="ob.setCompaction($any($event.target).checked)"
                        />
                      </div>
                    </div>
                  </div>
                }
                <div class="foot">
                  <button type="button" class="btn btn-ghost btn-sm" (click)="ob.back()">
                    <pk-icon name="chevron-left" size="16" />{{ 'onboarding.onboardingWindow.back' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-primary ml-auto"
                    data-testid="continue"
                    (click)="ob.next()"
                  >
                    {{ 'onboarding.onboardingWindow.continue' | transloco }}
                  </button>
                </div>
              }

              @case ('folder') {
                <h1>{{ 'onboarding.onboardingWindow.whereMayPiWork' | transloco }}</h1>
                <p class="lead">
                  {{ 'onboarding.onboardingWindow.piReadsAndChangesFilesInOne' | transloco }}
                </p>
                <div class="box" data-testid="trust-note">
                  <div class="t-sm">
                    <b>{{ 'onboarding.onboardingWindow.whatOpeningAFolderMeans' | transloco }}</b>
                    {{ 'onboarding.onboardingWindow.aFolderCanCarryProjectResourcesUnder' | transloco }}
                    <code>.pi/</code
                    >{{ 'onboarding.onboardingWindow.extensionsSkillsPromptsMCPServersAndSettings' | transloco }}
                  </div>
                </div>
                <form
                  class="flex flex-wrap items-center gap-2 mt-4"
                  (submit)="$event.preventDefault(); ob.openFolder()"
                >
                  <label class="sr-only" for="ob-folder">{{ 'onboarding.onboardingWindow.folder' | transloco }}</label>
                  <input
                    id="ob-folder"
                    class="input w-full sm:flex-1 mono"
                    [placeholder]="'onboarding.onboardingWindow.absolutePathToTheFolder' | transloco"
                    spellcheck="false"
                    autocomplete="off"
                    data-testid="folder-path"
                    [value]="ob.folderPath()"
                    (input)="ob.setFolderPath($any($event.target).value)"
                  />
                  @if (hasPicker) {
                    <button type="button" class="btn btn-sm" data-testid="choose-folder" (click)="ob.chooseFolder()">
                      {{ 'onboarding.onboardingWindow.chooseFolder' | transloco }}
                    </button>
                  }
                  <button
                    type="submit"
                    class="btn btn-sm"
                    data-testid="open-folder"
                    [disabled]="ob.folder().phase === 'opening' || !ob.folderPath().trim()"
                  >
                    {{ 'onboarding.onboardingWindow.openThisFolder' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    data-testid="scratch-folder"
                    [disabled]="ob.folder().phase === 'opening'"
                    (click)="ob.useScratch()"
                  >
                    {{ 'onboarding.onboardingWindow.startWithAScratchFolder' | transloco }}
                  </button>
                </form>
                @if (ob.folder().phase === 'opening') {
                  <p class="t-sm flex items-center gap-2" role="status">
                    <span class="loading loading-spinner loading-xs"></span>
                    {{ 'onboarding.onboardingWindow.opening' | transloco }}
                  </p>
                }
                @if (ob.folder().opened; as opened) {
                  <p class="t-sm flex items-center gap-2 mt-3" role="status" data-testid="folder-opened">
                    <span class="chip ok">{{
                      ob.folder().scratch
                        ? ('onboarding.onboardingWindow.scratchFolder' | transloco)
                        : ('onboarding.onboardingWindow.opened' | transloco)
                    }}</span>
                    <code class="break-all">{{ opened }}</code>
                  </p>
                }
                @if (ob.folder().error; as error) {
                  <p class="t-sm text-error break-words" role="alert">{{ error }}</p>
                }
                <div class="foot">
                  <button type="button" class="btn btn-ghost btn-sm" (click)="ob.back()">
                    <pk-icon name="chevron-left" size="16" />{{ 'onboarding.onboardingWindow.back' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost ml-auto"
                    data-testid="skip-folder"
                    [hidden]="!!ob.folder().opened"
                    (click)="ob.finish()"
                  >
                    {{ 'onboarding.onboardingWindow.skipTakeMeToTheApp' | transloco }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-primary"
                    [class.ml-auto]="!!ob.folder().opened"
                    data-testid="continue"
                    [disabled]="!ob.folder().opened"
                    (click)="ob.next()"
                  >
                    {{ 'onboarding.onboardingWindow.continue' | transloco }}
                  </button>
                </div>
              }
            }
          </div>
        </main>
        @if (!ui.settings()) {
          <pk-key-workflow />
        }
      </div>
    }
  `,
})
export class OnboardingWindow {
  protected readonly i18n = inject(Language);
  protected readonly ob = inject(OnboardingStore);
  protected readonly ui = inject(UiStore);
  private readonly root = viewChild<ElementRef<HTMLElement>>('root');
  protected readonly found = computed(() =>
    this.ob.info() ? foundLines(this.i18n.t, this.ob.info() as NonNullable<ReturnType<typeof this.ob.info>>) : [],
  );
  /** The filter of the ⌘⇧M list (local to this card: a long catalog has hundreds of models). */
  protected readonly scopeFilter = signal('');
  protected readonly scopeOptions = computed(() => {
    const words = this.scopeFilter().toLowerCase().split(/\s+/).filter(Boolean);
    return this.ob.defaults().options.filter((o) => words.every((w) => o.label.toLowerCase().includes(w)));
  });
  protected readonly hasPicker = typeof window !== 'undefined' && !!window.piKit?.showOpenDialog;

  constructor() {
    // The flow takes the focus when it opens, so the keyboard starts in it.
    effect(() => {
      if (this.ob.open()) queueMicrotask(() => this.root()?.nativeElement.focus());
    });
  }
}
