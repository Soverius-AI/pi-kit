import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  type OnInit,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { PkChoice, PkIcon, PkQuota, PkTip } from '@pi-kit/design-system';
import { KeyWorkflow, LoginFlow, ProviderCardsStore, SecretsStore, SettingsStore } from '@pi-kit/settings/api';
import { LocalRuntimeStore } from '@pi-kit/settings/data';
import { addProvider, agoText, letters } from '@pi-kit/settings/util';
import { credentialStoreText, serverLabel } from '@pi-kit/ui';

import { LiteLlmConnectionPanel } from './litellm-connection';

type Method = addProvider.ProviderMethod;

/** Settings provider setup. Reuses the account sign-in flows, local-server discovery,
 * and LiteLLM connection panel; the pure state machine determines the steps. */
@Component({
  selector: 'pk-add-provider-wizard',
  imports: [KeyWorkflow, LoginFlow, PkChoice, PkQuota, PkTip, TranslocoPipe, LiteLlmConnectionPanel, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pk-wf" data-testid="add-provider-wizard">
      <button
        type="button"
        class="pk-backdrop"
        tabindex="-1"
        [attr.aria-label]="'settings.addProviderWizard.close' | transloco"
        (click)="close()"
      ></button>
      <div
        #win
        class="win"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'settings.addProviderWizard.addAProvider' | transloco"
        tabindex="-1"
        (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); close()"
      >
        <div class="head">
          <h2>{{ 'settings.addProviderWizard.addAProvider' | transloco }}</h2>
          @if (subtitle(); as name) {
            <span class="muted t-sm">{{ name }}</span>
          }
          <span
            class="dots"
            role="img"
            [attr.aria-label]="
              ('settings.addProviderWizard.step' | transloco) +
              dots() +
              ('settings.addProviderWizard.of' | transloco) +
              totalDots
            "
          >
            @for (n of dotList; track n) {
              <i [class.on]="n <= dots()"></i>
            }
          </span>
          <button
            type="button"
            class="pk-close ml-auto"
            [pkTip]="'settings.addProviderWizard.closeEsc' | transloco"
            [attr.aria-label]="'settings.addProviderWizard.close' | transloco"
            (click)="close()"
          >
            <pk-icon name="close" />
          </button>
        </div>

        @switch (state().step) {
          @case ('how') {
            <div class="body">
              <div class="wstep" [class.back]="state().direction === 'back'" data-wstep="how">
                <div>
                  <div class="lbl">{{ 'settings.addProviderWizard.howDoYouWantToSignIn' | transloco }}</div>
                  <div class="hint">
                    {{ 'settings.litellm.howHint' | transloco }}
                  </div>
                </div>
                <div
                  class="pk-choices"
                  role="group"
                  [attr.aria-label]="'settings.addProviderWizard.waysToSignIn' | transloco"
                >
                  <button
                    pkChoice
                    letters="R"
                    [recommended]="true"
                    [pressed]="state().method === 'radius'"
                    data-testid="choice-radius"
                    (click)="choose('radius')"
                  >
                    <ng-container t
                      >{{ 'settings.addProviderWizard.radius' | transloco }}
                      <span class="chip rec">{{ 'settings.addProviderWizard.recommendedByPi' | transloco }}</span>
                      @if (radius()?.configured) {
                        <span class="chip ok">{{ 'settings.addProviderWizard.signedIn' | transloco }}</span>
                      }
                    </ng-container>
                    <ng-container d>{{
                      'settings.addProviderWizard.oneSignInManyModelsThroughPi' | transloco
                    }}</ng-container>
                  </button>
                  <button
                    pkChoice
                    [pressed]="state().method === 'subscription'"
                    data-testid="choice-subscription"
                    (click)="choose('subscription')"
                  >
                    <ng-container tile><pk-icon name="switch" /></ng-container>
                    <ng-container t>{{ 'settings.addProviderWizard.aSubscriptionYouHave' | transloco }}</ng-container>
                    <ng-container d>{{
                      'settings.addProviderWizard.claudeChatGPTGitHubCopilotAndOthersThrough' | transloco
                    }}</ng-container>
                  </button>
                  <button
                    pkChoice
                    [pressed]="state().method === 'api_key'"
                    data-testid="choice-api_key"
                    (click)="choose('api_key')"
                  >
                    <ng-container tile><pk-icon name="key-round" /></ng-container>
                    <ng-container t>{{ 'settings.addProviderWizard.anAPIKey' | transloco }}</ng-container>
                    <ng-container d>{{
                      'settings.addProviderWizard.openRouterOpenAIAnthropicGoogleAzureBedrockAnd'
                        | transloco: { value1: moreKeys() }
                    }}</ng-container>
                  </button>
                  <button
                    pkChoice
                    [pressed]="state().method === 'local'"
                    data-testid="choice-local"
                    (click)="choose('local')"
                  >
                    <ng-container tile><pk-icon name="monitor" /></ng-container>
                    <ng-container t>{{ 'settings.addProviderWizard.aLocalModel' | transloco }}</ng-container>
                    <ng-container d>{{
                      'settings.addProviderWizard.ollamaLlamaSwapLMStudioOrAny' | transloco
                    }}</ng-container>
                  </button>
                  <button
                    pkChoice
                    letters="Li"
                    [pressed]="state().method === 'litellm'"
                    data-testid="choice-litellm"
                    (click)="choose('litellm')"
                  >
                    <ng-container t>{{ 'settings.litellm.title' | transloco }}</ng-container>
                    <ng-container d>{{ 'settings.litellm.description' | transloco }}</ng-container>
                  </button>
                </div>
              </div>
            </div>
            <div class="foot">
              <span class="hint">{{ hint() }}</span>
              <button
                type="button"
                class="btn btn-sm btn-primary ml-auto"
                data-testid="wizard-continue"
                [disabled]="!canContinue()"
                (click)="forward()"
              >
                {{ 'settings.addProviderWizard.continue' | transloco }}
              </button>
            </div>
          }

          @case ('which') {
            <div class="body">
              <div class="wstep" [class.back]="state().direction === 'back'" data-wstep="which">
                <div>
                  <div class="lbl">{{ whichTitle() }}</div>
                  <div class="hint">{{ whichHint() }}</div>
                </div>
                @if (state().method === 'litellm') {
                  <pk-litellm-connection (saved)="liteLlmSaved()" />
                } @else if (state().method === 'local') {
                  <div class="flex flex-col gap-3" data-testid="local-panel">
                    @if (cards.servers().length === 0) {
                      @if (runtime.managed(); as swap) {
                        @if (swap.canStart || swap.state === 'starting' || swap.error) {
                          <div class="flex flex-wrap items-center gap-2" data-testid="wizard-llama-swap">
                            <span class="t-sm">{{
                              'settings.addProviderWizard.llamaSwapIsInstalledButNotRunning' | transloco
                            }}</span>
                            <button
                              type="button"
                              class="btn btn-sm btn-primary"
                              [disabled]="runtime.submitting() || !swap.canStart"
                              (click)="startLlamaSwap()"
                              data-testid="wizard-start-llama-swap"
                            >
                              {{
                                swap.state === 'starting'
                                  ? ('settings.addProviderWizard.startingLlamaSwap' | transloco)
                                  : ('settings.addProviderWizard.startLlamaSwap' | transloco)
                              }}
                            </button>
                            @if (swap.error) {
                              <span class="t-sm text-error" role="alert">{{ swap.error }}</span>
                            }
                          </div>
                        }
                      }
                      <p class="t-sm m-0">
                        {{ 'settings.addProviderWizard.nothingAnsweredOn' | transloco }} <code>:8080</code>
                        {{ 'settings.addProviderWizard.llamaSwapLlamaCppSRouterOr' | transloco }} <code>:11434</code>
                        {{ 'settings.addProviderWizard.ollamaStartOneThenPress' | transloco }}
                        <b>{{ 'settings.addProviderWizard.detectAgain' | transloco }}</b
                        >{{ 'settings.addProviderWizard.llamaCppWith' | transloco }}
                        <code>llama-server --models-dir ~/models</code
                        >{{ 'settings.addProviderWizard.orOllamaWith' | transloco }} <code>ollama serve</code
                        >{{ 'settings.addProviderWizard.anyServerThatSpeaksTheOpenAIAPI' | transloco }}
                      </p>
                    } @else {
                      <p class="t-sm m-0">
                        {{
                          'settings.addProviderWizard.foundOnThisMachineUseAddsAll'
                            | transloco
                              : {
                                  value1:
                                    cards.servers().length === 1
                                      ? ('settings.addProviderWizard.oneServer' | transloco)
                                      : cards.servers().length + ('settings.addProviderWizard.servers' | transloco),
                                  value2: serverNames(),
                                }
                        }}
                      </p>
                      <div class="flex flex-wrap gap-2">
                        @for (server of cards.servers(); track server.baseUrl) {
                          <button
                            type="button"
                            class="btn btn-sm"
                            data-testid="use-local"
                            [disabled]="cards.local().phase === 'saving'"
                            (click)="cards.saveLocal(server.baseUrl)"
                          >
                            {{ 'settings.addProviderWizard.use' | transloco: { value1: serverLabel(server) } }}
                          </button>
                        }
                      </div>
                    }
                    <form
                      class="flex flex-wrap items-center gap-2"
                      (submit)="$event.preventDefault(); cards.testLocal()"
                    >
                      <label class="sr-only" for="wizard-local-url">{{
                        'settings.addProviderWizard.serverAddress' | transloco
                      }}</label>
                      <input
                        id="wizard-local-url"
                        class="input input-sm flex-1 min-w-48 mono"
                        [placeholder]="'settings.addProviderWizard.http1270018080V1' | transloco"
                        spellcheck="false"
                        autocomplete="off"
                        data-testid="local-url"
                        [value]="cards.localUrl()"
                        (input)="cards.setLocalUrl($any($event.target).value)"
                      />
                      <button
                        type="submit"
                        class="btn btn-sm"
                        data-testid="local-test"
                        [disabled]="cards.local().phase !== 'idle' || !cards.localUrl().trim()"
                      >
                        {{ 'settings.addProviderWizard.testConnection' | transloco }}
                      </button>
                      <button
                        type="button"
                        class="btn btn-sm btn-ghost"
                        data-testid="detect-again"
                        [disabled]="cards.detecting()"
                        (click)="cards.detect()"
                      >
                        {{ 'settings.addProviderWizard.detectAgain' | transloco }}
                      </button>
                    </form>
                    @if (cards.local().phase === 'testing') {
                      <div class="t-sm flex items-center gap-2" role="status">
                        <span class="loading loading-spinner loading-xs"></span>
                        {{ 'settings.addProviderWizard.askingTheServer' | transloco }}
                      </div>
                    }
                    @if (cards.local().result; as result) {
                      @if (result.ok) {
                        <div class="flex flex-wrap items-center gap-2" role="status" data-testid="local-result">
                          <span class="chip ok">{{ 'settings.addProviderWizard.reachable' | transloco }}</span>
                          <span class="t-sm"
                            >{{ result.models.length }}
                            {{
                              result.models.length === 1
                                ? ('settings.addProviderWizard.model' | transloco)
                                : ('settings.addProviderWizard.models' | transloco)
                            }}
                            @if (result.models.length > 0) {
                              : {{ result.models.slice(0, 4).join(', ') }}
                              @if (result.models.length > 4) {
                                , …
                              }
                            }
                          </span>
                          <button
                            type="button"
                            class="btn btn-sm btn-primary ml-auto"
                            data-testid="local-save"
                            [disabled]="cards.local().phase === 'saving' || result.models.length === 0"
                            (click)="cards.saveLocal(result.baseUrl, result.models)"
                          >
                            {{
                              'settings.addProviderWizard.use'
                                | transloco
                                  : {
                                      value1:
                                        result.models.length === 1
                                          ? ('settings.addProviderWizard.thisModel' | transloco)
                                          : ('settings.addProviderWizard.these' | transloco) +
                                            result.models.length +
                                            ('settings.addProviderWizard.models46183' | transloco),
                                    }
                            }}
                          </button>
                        </div>
                      }
                    }
                    @if (cards.local().error; as error) {
                      <div class="t-sm text-error break-words" role="alert" data-testid="local-error">{{ error }}</div>
                    }
                  </div>
                } @else if (state().method !== undefined) {
                  <input
                    type="search"
                    class="input input-sm w-full"
                    [placeholder]="'settings.addProviderWizard.searchProviders' | transloco"
                    [attr.aria-label]="'settings.addProviderWizard.searchProviders' | transloco"
                    autocomplete="off"
                    spellcheck="false"
                    data-testid="which-search"
                    [value]="state().query"
                    (input)="search($any($event.target).value)"
                  />
                  <div class="pick" role="group" [attr.aria-label]="whichTitle()">
                    @for (p of choices(); track p.id) {
                      <button
                        type="button"
                        [attr.aria-pressed]="state().provider === p.id"
                        [attr.data-provider]="p.id"
                        [attr.data-testid]="'which-' + p.id"
                        (click)="pick(p.id)"
                        (dblclick)="pick(p.id); forward()"
                      >
                        <span class="logo" aria-hidden="true">{{ letters(p.name) }}</span>
                        <span>{{ p.name }}</span>
                        @if (p.configured) {
                          <span class="chip ok ml-auto">{{
                            state().method === 'api_key' && p.stored && p.storedType === 'api_key'
                              ? ('settings.addProviderWizard.hasAKey' | transloco)
                              : ('settings.addProviderWizard.signedIn' | transloco)
                          }}</span>
                        }
                      </button>
                    } @empty {
                      <p class="t-sm muted m-0 px-3 py-2">
                        {{ 'settings.addProviderWizard.noProviderMatches' | transloco: { value1: state().query } }}
                      </p>
                    }
                  </div>
                  @if (state().method === 'subscription' && chosen(); as p) {
                    <div class="box">
                      <div class="t-sm">{{ 'settings.addProviderWizard.whatHappensNext' | transloco }}</div>
                      <dl class="kv">
                        <dt>{{ 'settings.addProviderWizard.opens' | transloco }}</dt>
                        <dd>
                          {{ 'settings.addProviderWizard.theSignInInYourBrowserYou' | transloco: { value1: p.name } }}
                        </dd>
                        <dt>{{ 'settings.addProviderWizard.saves' | transloco }}</dt>
                        <dd>{{ 'settings.addProviderWizard.aRefreshTokenInPiSAuth' | transloco }}</dd>
                        <dt>{{ 'settings.addProviderWizard.withoutABrowser' | transloco }}</dt>
                        <dd>{{ 'settings.addProviderWizard.piAsksYouToPasteTheCode' | transloco }}</dd>
                      </dl>
                    </div>
                  }
                }
              </div>
            </div>
            <div class="foot">
              <button type="button" class="btn btn-sm btn-ghost" data-testid="wizard-back" (click)="back()">
                {{ 'settings.addProviderWizard.back' | transloco }}
              </button>
              <span class="hint">{{ hint() }}</span>
              @if (state().method !== 'local' && state().method !== 'litellm') {
                <button
                  type="button"
                  class="btn btn-sm btn-primary ml-auto"
                  data-testid="wizard-continue"
                  [disabled]="!canContinue()"
                  (click)="forward()"
                >
                  {{
                    state().method === 'subscription'
                      ? ('settings.addProviderWizard.signIn' | transloco)
                      : ('settings.addProviderWizard.continue' | transloco)
                  }}
                </button>
              }
            </div>
          }

          @case ('sign-in') {
            @if (state().method === 'api_key') {
              <pk-key-workflow [embedded]="true" [hint]="hint()" (left)="back()" (finished)="finish()">
                <label done class="flex items-center gap-3 t-sm" data-testid="make-default">
                  <input
                    type="checkbox"
                    class="toggle toggle-sm toggle-primary"
                    [checked]="makeDefault()"
                    (change)="makeDefault.set($any($event.target).checked)"
                  />
                  <span
                    >{{ 'settings.addProviderWizard.make' | transloco }}
                    <span class="mono">{{
                      defaultModel()?.id ?? ('settings.addProviderWizard.itsFirstModel' | transloco)
                    }}</span>
                    {{ 'settings.addProviderWizard.theDefaultForNewThreads' | transloco }}</span
                  >
                </label>
              </pk-key-workflow>
            } @else {
              <div class="body">
                <div class="wstep" [class.back]="state().direction === 'back'" data-wstep="sign-in">
                  <div>
                    <div class="lbl">
                      {{
                        'settings.addProviderWizard.signInTo'
                          | transloco
                            : { value1: chosen()?.name ?? ('settings.addProviderWizard.theProvider' | transloco) }
                      }}
                    </div>
                    <div class="hint">
                      {{ 'settings.addProviderWizard.approvePiInYourBrowserThisWindow' | transloco }}
                    </div>
                  </div>
                  <pk-login-flow />
                </div>
              </div>
              <div class="foot">
                <button type="button" class="btn btn-sm btn-ghost" data-testid="wizard-back" (click)="back()">
                  {{ 'settings.addProviderWizard.back' | transloco }}
                </button>
                <span class="hint">{{ hint() }}</span>
              </div>
            }
          }

          @case ('done') {
            <div class="body">
              <div class="wstep" data-wstep="done">
                @if (state().method === 'litellm') {
                  <div data-testid="provider-result">
                    <div class="lbl">{{ 'settings.litellm.title' | transloco }}</div>
                    <p class="hint">{{ 'settings.litellm.saved' | transloco }}</p>
                    <div class="mono t-sm">{{ modelSample() }}</div>
                  </div>
                } @else if (state().method === 'local') {
                  <div>
                    <div class="lbl">
                      {{
                        'settings.addProviderWizard.isAdded'
                          | transloco
                            : {
                                value1:
                                  cards.local().saved?.provider ?? ('settings.addProviderWizard.theServer' | transloco),
                              }
                      }}
                    </div>
                    <div class="hint">{{ 'settings.addProviderWizard.piWroteItIntoItsModelsJson' | transloco }}</div>
                  </div>
                  <div class="box" data-testid="provider-result">
                    <div class="ok-line">
                      <span class="chip ok">{{ 'settings.addProviderWizard.saved' | transloco }}</span
                      ><span
                        >{{ cards.local().saved?.models ?? 0 }}
                        {{
                          cards.local().saved?.models === 1
                            ? ('settings.addProviderWizard.model' | transloco)
                            : ('settings.addProviderWizard.models' | transloco)
                        }}</span
                      >
                    </div>
                    <dl class="kv">
                      <dt>{{ 'settings.addProviderWizard.address' | transloco }}</dt>
                      <dd class="mono">{{ cards.localUrl() }}</dd>
                      <dt>{{ 'settings.addProviderWizard.savedAs' | transloco }}</dt>
                      <dd>{{ 'settings.addProviderWizard.aServerInPiSModelsJson' | transloco }}</dd>
                    </dl>
                  </div>
                } @else {
                  <div>
                    <div class="lbl">
                      {{ 'settings.addProviderWizard.signedInTo' | transloco: { value1: chosen()?.name } }}
                    </div>
                    <div class="hint">
                      {{ 'settings.addProviderWizard.oneRequestSucceededTheModelsAreIn' | transloco }}
                    </div>
                  </div>
                  <div class="box" data-testid="provider-result">
                    <div class="ok-line">
                      <span class="chip ok">{{ 'settings.addProviderWizard.signedIn' | transloco }}</span
                      ><span
                        >{{ modelCount() }}
                        {{
                          modelCount() === 1
                            ? ('settings.addProviderWizard.model' | transloco)
                            : ('settings.addProviderWizard.models' | transloco)
                        }}</span
                      >
                    </div>
                    <dl class="kv">
                      @if (modelSample()) {
                        <dt>{{ 'settings.addProviderWizard.modelsYouCanUse' | transloco }}</dt>
                        <dd>{{ modelSample() }}</dd>
                      }
                      @if (chosen()?.usage; as usage) {
                        @if (usage.windows.length > 0) {
                          <dt>{{ 'settings.addProviderWizard.usageRightNow' | transloco }}</dt>
                          <dd class="flex flex-wrap gap-3">
                            @for (w of usage.windows; track w.name) {
                              <pk-quota [name]="w.name" [used]="w.used" [resets]="w.resets" />
                            }
                          </dd>
                        }
                      }
                      <dt>{{ 'settings.addProviderWizard.savedAs' | transloco }}</dt>
                      <dd data-testid="saved-as">{{ savedAs() }}</dd>
                    </dl>
                  </div>
                }
                @if (defaultModel(); as model) {
                  <label class="flex items-center gap-3 t-sm" data-testid="make-default">
                    <input
                      type="checkbox"
                      class="toggle toggle-sm toggle-primary"
                      [checked]="makeDefault()"
                      (change)="makeDefault.set($any($event.target).checked)"
                    />
                    <span
                      >{{ 'settings.addProviderWizard.make' | transloco }} <span class="mono">{{ model.id }}</span>
                      {{ 'settings.addProviderWizard.theDefaultForNewThreads' | transloco }}</span
                    >
                  </label>
                }
              </div>
            </div>
            <div class="foot">
              <span class="hint">{{ hint() }}</span>
              <button
                type="button"
                class="btn btn-sm btn-primary ml-auto"
                data-testid="provider-done"
                (click)="finish()"
              >
                {{ 'settings.addProviderWizard.done' | transloco }}
              </button>
            </div>
          }
        }
      </div>
    </div>
  `,
})
export class AddProviderWizard implements OnInit {
  protected readonly i18n = inject(Language);
  /** Where the wizard opens: the first step, or a place the page sends it ("Edit" on a local server, "Add a key instead"). */
  readonly entry = input<{ method?: Method; provider?: string }>({});
  readonly closed = output<void>();

  protected readonly store = inject(SettingsStore);
  protected readonly cards = inject(ProviderCardsStore);
  /** A stopped llama-swap can be started from here: it then shows up among the servers. */
  protected readonly runtime = inject(LocalRuntimeStore);
  private readonly secrets = inject(SecretsStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');

  protected readonly state = signal<addProvider.AddProviderState>(addProvider.startAddProvider());
  protected readonly makeDefault = signal(false);
  protected readonly totalDots = addProvider.ADD_PROVIDER_DOTS;
  protected readonly dotList = [1, 2, 3, 4];
  protected readonly letters = letters;
  protected readonly serverLabel = serverLabel.bind(undefined, this.i18n.t);

  private readonly providers = computed(() => this.store.overview()?.providers ?? []);
  private readonly models = computed(() => this.store.overview()?.models ?? []);
  /** The sign-in of an OAuth way has started; a flow that is gone after that was cancelled in its own box. */
  private started = false;
  private finishing = false;

  protected readonly radius = computed(() => this.providers().find((p) => p.id === addProvider.RADIUS));
  protected readonly chosen = computed(() => this.providers().find((p) => p.id === this.state().provider));
  protected readonly choices = computed(() =>
    addProvider.providersFor(this.providers(), this.state().method, this.state().query),
  );
  protected readonly moreKeys = computed(() =>
    Math.max(0, this.providers().filter((p) => addProvider.offers(p, 'api_key')).length - 5),
  );
  protected readonly canContinue = computed(() => addProvider.canContinue(this.state()));
  protected readonly whichTitle = computed(() =>
    addProvider.whichTitle.bind(undefined, this.i18n.t)(this.state().method),
  );
  protected readonly whichHint = computed(() => {
    switch (this.state().method) {
      case 'litellm':
        return this.i18n.t('settings.litellm.hint');
      case 'subscription':
        return this.i18n.t('settings.addProviderWizard.signInOpensInYourBrowserOn');
      case 'api_key':
        return this.i18n.t('settings.addProviderWizard.subscriptionsClaudeProChatGPTAreNotAPI');
      default:
        return this.i18n.t('settings.addProviderWizard.detectedServersAreListedFirstAnyServer');
    }
  });
  protected readonly subtitle = computed(() =>
    this.state().step === 'how'
      ? ''
      : this.state().method === 'litellm'
        ? 'LiteLLM'
        : this.state().method === 'local'
          ? this.i18n.t('settings.addProviderWizard.localModel')
          : (this.chosen()?.name ?? ''),
  );
  /** The API-key workflow has its own fourth step, the result: the wizard's last dot. */
  protected readonly dots = computed(() =>
    this.state().method === 'api_key' && this.store.keyWorkflow()?.step === 4 ? 4 : addProvider.dotsOn(this.state()),
  );
  protected readonly hint = computed(() => {
    const base = addProvider.footHint.bind(undefined, this.i18n.t)(this.state());
    return this.state().method === 'api_key' && this.store.keyWorkflow()?.step === 4
      ? this.i18n.t('settings.addProviderWizard.step4Of4')
      : base;
  });
  protected readonly modelCount = computed(
    () => this.models().filter((m) => m.provider === this.state().provider).length,
  );
  protected readonly modelSample = computed(() => {
    const names = this.models()
      .filter((m) => m.provider === this.state().provider)
      .map((m) => m.id);
    return names.length === 0
      ? ''
      : `${names.slice(0, 3).join(', ')}${names.length > 3 ? this.i18n.t('settings.addProviderWizard.andMore', { value1: names.length - 3 }) : ''}`;
  });
  /** What the switch would make the default: the first model of the provider that was just added. */
  protected readonly defaultModel = computed(() => {
    const provider = this.state().provider ?? this.cards.local().saved?.provider;
    return provider ? addProvider.defaultModelOf(provider, this.models()) : undefined;
  });
  protected readonly savedAs = computed(() => {
    const p = this.chosen();
    const c = p?.credential;
    if (!p || !c)
      return p
        ? this.i18n.t('settings.addProviderWizard.configured', { value1: p.name })
        : this.i18n.t('settings.addProviderWizard.piReportsNoStoredCredential');
    return `${p.name} ${c.type === 'oauth' ? 'subscription' : 'key'}, ${credentialStoreText(this.i18n.t, c.store, c.type, this.secrets.status()?.label)}, ${c.addedAt ? agoText(this.i18n.t, c.addedAt) : 'today'}`;
  });

  constructor() {
    void this.secrets.loadStatus();
    queueMicrotask(() => this.win()?.nativeElement.focus());
    // A subscription or Radius sign-in that pi finished moves the wizard on to what was saved.
    effect(() => {
      const flow = this.store.flow();
      const s = this.state();
      untracked(() => {
        if (s.step !== 'sign-in' || s.method === 'api_key') return;
        if (flow?.status === 'done') {
          this.store.dismissFlow();
          this.go(addProvider.next(s));
        } else if (!flow && this.started) {
          // cancelled in the box: back to where the person chose
          this.started = false;
          this.go(addProvider.back(s));
        }
      });
    });
    // The key workflow ended without Done (Remove key on a refused key): back to the list of providers.
    effect(() => {
      const wf = this.store.keyWorkflow();
      const s = this.state();
      untracked(() => {
        if (s.step === 'sign-in' && s.method === 'api_key' && !wf && this.started && !this.finishing) {
          this.started = false;
          this.go(addProvider.back(s));
        }
      });
    });
    // A local server that was saved moves the wizard on.
    effect(() => {
      const saved = this.cards.local().saved;
      const s = this.state();
      untracked(() => {
        if (saved && s.step === 'which' && s.method === 'local') this.go(addProvider.next(s));
      });
    });
    // The switch starts on when pi has no default model yet; with one it stays the person's.
    effect(() => {
      const s = this.state();
      if (s.step === 'done' || (s.step === 'sign-in' && s.method === 'api_key'))
        untracked(() => this.makeDefault.set(!this.store.settings()?.defaultModel));
    });
  }

  ngOnInit(): void {
    const entry = this.entry();
    this.cards.resetLocal();
    this.go(addProvider.startAddProvider(entry));
    this.destroyRef.onDestroy(this.runtime.observe());
  }

  protected async startLlamaSwap(): Promise<void> {
    await this.runtime.start();
    await this.cards.detect();
  }

  /** Moves to a state and does what arriving at its step asks for: a sign-in is started when the step is reached, never before. */
  private go(next: addProvider.AddProviderState): void {
    const before = this.state();
    this.state.set(next);
    if (next.step === before.step) return;
    if (next.step === 'which' && next.method === 'local') void this.cards.detect();
    if (next.step === 'sign-in' && next.provider) {
      this.started = true;
      if (next.method === 'api_key') this.store.openKeyWorkflow(next.provider, true);
      else void this.store.login(next.provider, 'oauth');
    }
    if (before.step === 'sign-in' && next.step !== 'done') this.leaveSignIn();
  }

  private leaveSignIn(): void {
    this.started = false;
    this.store.cancelLogin();
    this.store.closeKeyWorkflow();
  }

  protected liteLlmSaved(): void {
    this.go(addProvider.next({ ...this.state(), provider: 'litellm' }));
  }

  protected choose(method: Method): void {
    this.go(addProvider.choose(this.state(), method));
  }
  protected pick(provider: string): void {
    this.state.set(addProvider.pick(this.state(), provider));
  }
  protected search(query: string): void {
    this.state.set(addProvider.search(this.state(), query));
  }
  protected forward(): void {
    if (this.canContinue()) this.go(addProvider.next(this.state()));
  }
  protected back(): void {
    this.go(addProvider.back(this.state()));
  }

  protected serverNames(): string {
    return this.cards
      .servers()
      .map((s) => serverLabel(this.i18n.t, s))
      .join(', ');
  }

  /** Done: the model becomes the default if the switch says so, and the wizard closes. */
  protected async finish(): Promise<void> {
    this.finishing = true;
    const model = this.defaultModel();
    if (this.makeDefault() && model)
      await this.store.patch({ defaultModel: { provider: model.provider, modelId: model.id } });
    this.close();
  }

  protected close(): void {
    this.finishing = true;
    this.started = false;
    this.store.cancelLogin();
    this.store.closeKeyWorkflow();
    this.store.dismissFlow();
    this.closed.emit();
  }
}
