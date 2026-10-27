import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { serverLabel } from '@pi-kit/ui';
import { ProviderCardsStore } from '@pi-kit/settings/data';
import { LoginFlow } from './login-flow';
import { LocalRuntimeWizard } from './local-runtime-wizard';
import { PkIcon } from '@pi-kit/design-system';

/**
 * The four ways to get a model: Radius, a subscription you already have, an API key, a local model, on the onboarding's second card.
 * It uses the same sign-in and API-key flows as Settings › Providers, so a credential is added the same way everywhere. Each card says what it is, shows its own status once something is
 * set up through it ("OpenRouter key …a1b2 saved in keychain, 38 models"), and has one action: the sign-in (inline, `pk-login-flow`), the API-key workflow (a dialog,
 * never a field here), or the local server card (detected servers, "Test connection", instructions when none answers). Several can be added.
 */
@Component({
  selector: 'pk-get-model',
  imports: [LoginFlow, LocalRuntimeWizard, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-0" data-testid="get-model">
      <section class="pk-prov rec" [attr.aria-label]="'settings.getModel.radius' | transloco" data-card="radius">
        <div class="logo logo-primary" aria-hidden="true">{{ 'settings.getModel.r' | transloco }}</div>
        <div class="min-w-0">
          <div class="nm">
            {{ 'settings.getModel.radius' | transloco }}
            <span class="chip rec">{{ 'settings.getModel.recommendedByPi' | transloco }}</span>
            @if (ob.radius()?.configured) {
              <span class="chip ok">{{ 'settings.getModel.signedIn' | transloco }}</span>
            }
          </div>
          <div class="ds">{{ 'settings.getModel.oneSignInManyModelsThroughPi' | transloco }}</div>
          @for (line of ob.statuses().radius; track line) {
            <div class="st" data-testid="card-status">{{ line }}</div>
          }
        </div>
        <div class="act">
          <button
            type="button"
            class="btn btn-sm"
            [class.btn-primary]="!ob.radius()?.configured"
            data-testid="radius-sign-in"
            (click)="ob.signInRadius()"
          >
            {{
              ob.radius()?.configured
                ? ('settings.getModel.signInAgain' | transloco)
                : ('settings.getModel.signIn' | transloco)
            }}
          </button>
        </div>
      </section>

      <section
        class="pk-prov"
        [attr.aria-label]="'settings.getModel.aSubscriptionYouAlreadyHave' | transloco"
        data-card="subscription"
      >
        <div class="logo" aria-hidden="true">
          <pk-icon name="swap" />
        </div>
        <div class="min-w-0">
          <div class="nm">
            {{ 'settings.getModel.aSubscriptionYouAlreadyHave' | transloco }}
            @if (ob.statuses().subscription.length > 0) {
              <span class="chip ok">{{ 'settings.getModel.signedIn' | transloco }}</span>
            }
          </div>
          <div class="ds">
            {{ 'settings.getModel.chatGPTClaudeGitHubCopilotAndOthersThrough' | transloco }}
          </div>
          @for (line of ob.statuses().subscription; track line) {
            <div class="st" data-testid="card-status">{{ line }}</div>
          }
        </div>
        <div class="act">
          <select
            class="select select-sm w-44"
            [attr.aria-label]="'settings.getModel.subscription' | transloco"
            data-testid="subscription-picker"
            [value]="ob.subscription()"
            (change)="ob.setSubscription($any($event.target).value)"
          >
            @for (p of ob.subscriptions(); track p.id) {
              <option [value]="p.id" [selected]="p.id === ob.subscription()">{{ p.name }}</option>
            }
          </select>
          <button
            type="button"
            class="btn btn-sm"
            data-testid="subscription-sign-in"
            [disabled]="!ob.subscription()"
            (click)="ob.signInSubscription()"
          >
            {{ 'settings.getModel.signIn' | transloco }}
          </button>
        </div>
      </section>

      <section class="pk-prov" [attr.aria-label]="'settings.getModel.anAPIKey' | transloco" data-card="key">
        <div class="logo" aria-hidden="true">
          <pk-icon name="key" />
        </div>
        <div class="min-w-0">
          <div class="nm">
            {{ 'settings.getModel.anAPIKey' | transloco }}
            @if (ob.statuses().key.length > 0) {
              <span class="chip ok">{{
                'settings.getModel.saved' | transloco: { value1: ob.statuses().key.length }
              }}</span>
            }
          </div>
          <div class="ds">
            {{ 'settings.getModel.openRouterOpenAIAnthropicGoogleAzureBedrockAnd' | transloco }}
          </div>
          @for (line of ob.statuses().key; track line) {
            <div class="st" data-testid="card-status">{{ line }}</div>
          }
        </div>
        <div class="act">
          <button type="button" class="btn btn-sm" data-testid="add-key-card" (click)="ob.addKey()">
            {{ 'settings.getModel.addAKey' | transloco }}
          </button>
        </div>
      </section>

      <section class="pk-prov" [attr.aria-label]="'settings.getModel.aLocalModel' | transloco" data-card="local">
        <div class="logo" aria-hidden="true">
          <pk-icon name="home" />
        </div>
        <div class="min-w-0">
          <div class="nm">
            {{ 'settings.getModel.aLocalModel' | transloco }}
            @if (ob.servers().length > 0) {
              <span class="chip ok" data-testid="local-found">{{
                'settings.getModel.found'
                  | transloco
                    : {
                        value1:
                          ob.servers()[0].kind === 'ollama'
                            ? ('settings.getModel.ollama' | transloco)
                            : ob.servers()[0].kind === 'llama-swap'
                              ? ('settings.getModel.llamaSwap' | transloco)
                              : ('settings.getModel.aLocalServer' | transloco),
                      }
              }}</span>
            }
          </div>
          <div class="ds">
            {{ 'settings.getModel.runsOnThisMachineNothingLeavesIt' | transloco }}
          </div>
          @for (line of ob.statuses().local; track line) {
            <div class="st" data-testid="card-status">{{ line }}</div>
          }
        </div>
        <div class="act">
          @if (ob.servers()[0]; as server) {
            <button
              type="button"
              class="btn btn-sm"
              data-testid="use-local"
              [disabled]="ob.local().phase === 'saving'"
              (click)="ob.saveLocal(server.baseUrl)"
            >
              {{ 'settings.getModel.use' | transloco: { value1: label(server) } }}
            </button>
          }
          <button
            type="button"
            class="btn btn-sm"
            [class.btn-ghost]="ob.servers().length > 0"
            data-testid="local-more"
            [attr.aria-expanded]="ob.localOpen()"
            (click)="ob.toggleLocal()"
          >
            {{ 'settings.getModel.setUpALocalModel' | transloco }}
          </button>
        </div>
        @if (ob.localOpen()) {
          <div class="more" data-testid="local-panel">
            @if (ob.servers().length === 0) {
              <p class="t-sm m-0">
                {{ 'settings.getModel.nothingAnsweredOn' | transloco }} <code>:8080</code>
                {{ 'settings.getModel.llamaSwapLlamaCppSRouterOr' | transloco }} <code>:11434</code>
                {{ 'settings.getModel.ollamaStartOneThenPress' | transloco }}
                <b>{{ 'settings.getModel.detectAgain' | transloco }}</b
                >{{ 'settings.getModel.llamaCppWith' | transloco }} <code>llama-server --models-dir ~/models</code
                >{{ 'settings.getModel.orOllamaWith' | transloco }} <code>ollama serve</code
                >{{ 'settings.getModel.anyServerThatSpeaksTheOpenAIAPI' | transloco }}
              </p>
            } @else {
              <p class="t-sm m-0">
                {{
                  'settings.getModel.foundOnThisMachineUseAddsAll'
                    | transloco
                      : {
                          value1:
                            ob.servers().length === 1
                              ? ('settings.getModel.oneServer' | transloco)
                              : ob.servers().length + ('settings.getModel.servers' | transloco),
                          value2: serverNames(),
                        }
                }}
              </p>
            }
            <form class="flex flex-wrap items-center gap-2" (submit)="$event.preventDefault(); ob.testLocal()">
              <label class="sr-only" for="local-url">{{ 'settings.getModel.serverAddress' | transloco }}</label>
              <input
                id="local-url"
                class="input input-sm flex-1 min-w-48 mono"
                [placeholder]="'settings.getModel.http1270018080V1' | transloco"
                spellcheck="false"
                autocomplete="off"
                data-testid="local-url"
                [value]="ob.localUrl()"
                (input)="ob.setLocalUrl($any($event.target).value)"
              />
              <button
                type="submit"
                class="btn btn-sm"
                data-testid="local-test"
                [disabled]="ob.local().phase !== 'idle' || !ob.localUrl().trim()"
              >
                {{ 'settings.getModel.testConnection' | transloco }}
              </button>
              <button
                type="button"
                class="btn btn-sm btn-ghost"
                data-testid="detect-again"
                [disabled]="ob.detecting()"
                (click)="ob.detect()"
              >
                {{ 'settings.getModel.detectAgain' | transloco }}
              </button>
            </form>
            @if (ob.local().phase === 'testing') {
              <div class="t-sm flex items-center gap-2" role="status">
                <span class="loading loading-spinner loading-xs"></span>
                {{ 'settings.getModel.askingTheServer' | transloco }}
              </div>
            }
            @if (ob.local().result; as result) {
              @if (result.ok) {
                <div class="flex flex-wrap items-center gap-2" role="status" data-testid="local-result">
                  <span class="chip ok">{{ 'settings.getModel.reachable' | transloco }}</span>
                  <span class="t-sm"
                    >{{ result.models.length }}
                    {{
                      result.models.length === 1
                        ? ('settings.getModel.model' | transloco)
                        : ('settings.getModel.models' | transloco)
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
                    [disabled]="ob.local().phase === 'saving' || result.models.length === 0"
                    (click)="ob.saveLocal(result.baseUrl, result.models)"
                  >
                    {{
                      'settings.getModel.use'
                        | transloco
                          : {
                              value1:
                                result.models.length === 1
                                  ? ('settings.getModel.thisModel' | transloco)
                                  : ('settings.getModel.these' | transloco) +
                                    result.models.length +
                                    ('settings.getModel.models46183' | transloco),
                            }
                    }}
                  </button>
                </div>
              }
            }
            @if (ob.local().error; as error) {
              <div class="t-sm text-error break-words" role="alert" data-testid="local-error">{{ error }}</div>
            }
            <pk-local-runtime-wizard />
          </div>
        }
      </section>

      <div class="mt-3"><pk-login-flow /></div>
    </div>
  `,
})
export class GetModel {
  protected readonly i18n = inject(Language);
  protected readonly ob = inject(ProviderCardsStore);

  protected label(server: Parameters<typeof serverLabel>[1]): string {
    return server.kind === 'ollama'
      ? 'Ollama'
      : server.kind === 'llama-swap'
        ? 'llama-swap'
        : this.i18n.t('settings.getModel.theServer');
  }

  protected serverNames(): string {
    return this.ob
      .servers()
      .map((s) => serverLabel(this.i18n.t, s))
      .join(', ');
  }
}
