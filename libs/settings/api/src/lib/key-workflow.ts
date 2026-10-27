import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import { type KeyShape, checkKeyShape, credentialStoreText, keyHelp } from '@pi-kit/ui';
import { SecretsStore, SettingsStore } from '@pi-kit/settings/data';

/** “today”, “yesterday” or a date. */
function whenText(at: number | undefined): string {
  if (!at) return 'today';
  const days = Math.floor((Date.now() - at) / 86_400_000);
  return days <= 0
    ? 'today'
    : days === 1
      ? 'yesterday'
      : new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The API-key workflow: a key is never an inline field. Pick the provider, see where
 * to get a key and what it needs, paste it into a password field (no reveal toggle; its shape is checked, the text is not kept), “Validate and
 * save” hands it to pi’s own login, which writes `auth.json`, and one cheap request asks the provider whether it accepts it. Afterwards only the
 * provider, the last four characters, the store and the date are shown.
 *
 * The typed key lives in the input element until the form is submitted; the component keeps only the verdict of the shape check, and empties the
 * input before the request leaves. Esc closes the workflow (and cancels pi’s login) without closing Settings.
 */
@Component({
  selector: 'pk-key-workflow',
  imports: [NgTemplateOutlet, PkTip, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.contents]': 'embedded()' },
  template: `
    @if (store.keyWorkflow(); as wf) {
      @if (embedded()) {
        @if (wf.embedded) {
          <ng-container *ngTemplateOutlet="bodyTpl; context: { $implicit: wf }" />
          <ng-container *ngTemplateOutlet="footTpl; context: { $implicit: wf }" />
        }
      } @else if (!wf.embedded) {
        <div class="pk-wf">
          <button
            type="button"
            class="pk-backdrop"
            tabindex="-1"
            [attr.aria-label]="'settings.keyWorkflow.closeTheAPIKeyWorkflow' | transloco"
            (click)="store.closeKeyWorkflow()"
          ></button>
          <div
            #win
            class="win"
            role="dialog"
            aria-modal="true"
            [attr.aria-label]="'settings.keyWorkflow.addAnAPIKey' | transloco"
            tabindex="-1"
            data-testid="key-workflow"
            (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); store.closeKeyWorkflow()"
          >
            <div class="head">
              <h2>{{ 'settings.keyWorkflow.addAnAPIKey' | transloco }}</h2>
              @if (provider(); as p) {
                <span class="muted t-sm">{{ p.name }}</span>
              }
              <span
                class="dots"
                [attr.aria-label]="
                  ('settings.keyWorkflow.step' | transloco) + wf.step + ('settings.keyWorkflow.of4' | transloco)
                "
                role="img"
              >
                @for (n of steps; track n) {
                  <i [class.on]="n <= wf.step"></i>
                }
              </span>
              <button
                type="button"
                class="pk-close ml-auto"
                [pkTip]="'settings.keyWorkflow.closeEsc' | transloco"
                [attr.aria-label]="'settings.keyWorkflow.closeTheAPIKeyWorkflow' | transloco"
                (click)="store.closeKeyWorkflow()"
              >
                <pk-icon name="close" />
              </button>
            </div>
            <ng-container *ngTemplateOutlet="bodyTpl; context: { $implicit: wf }" />
            <ng-container *ngTemplateOutlet="footTpl; context: { $implicit: wf }" />
          </div>
        </div>
      }
    }

    <ng-template #bodyTpl let-wf>
      <div class="body">
        @switch (wf.step) {
          @case (1) {
            <div>
              <div class="lbl">{{ 'settings.keyWorkflow.whichProviderIsTheKeyFor' | transloco }}</div>
              <div class="hint">
                {{ 'settings.keyWorkflow.subscriptionsClaudeProChatGPTAreNotAPI' | transloco }}
              </div>
            </div>
            <div
              class="pick"
              role="group"
              [attr.aria-label]="'settings.keyWorkflow.providersThatTakeAnAPIKey' | transloco"
            >
              @for (p of keyProviders(); track p.id) {
                <button
                  type="button"
                  [attr.aria-pressed]="wf.provider === p.id"
                  [attr.data-provider]="p.id"
                  (click)="store.keyChooseProvider(p.id)"
                >
                  <span>{{ p.name }}</span>
                  @if (p.stored && p.storedType === 'api_key') {
                    <span class="chip ok">{{ 'settings.keyWorkflow.hasAKey' | transloco }}</span>
                  }
                </button>
              }
            </div>
          }
          @case (2) {
            <div>
              <div class="lbl">{{ 'settings.keyWorkflow.getAKeyFrom' | transloco: { value1: provider()?.name } }}</div>
              <div class="hint">
                @if (help().url; as url) {
                  {{ 'settings.keyWorkflow.createOneAt' | transloco }}
                  <a class="link link-hover" [href]="url" target="_blank" rel="noopener noreferrer">{{ host(url) }}</a
                  >.
                } @else {
                  {{ 'settings.keyWorkflow.createOneInYourProviderSDashboard' | transloco }}
                }
                {{ help().needs }}
              </div>
            </div>
            <div class="box">
              <div class="t-sm">{{ 'settings.keyWorkflow.whatHappensNext' | transloco }}</div>
              <ul class="t-sm muted m-0 pl-5 list-disc">
                <li>{{ 'settings.keyWorkflow.youPasteTheKeyIntoAField' | transloco }}</li>
                <li>
                  {{
                    'settings.keyWorkflow.piKitSDatabaseNeverHoldsIt'
                      | transloco
                        : {
                            value1: secrets.status()?.available
                              ? ('settings.keyWorkflow.theKeyGoesIntoYour' | transloco) +
                                secrets.status()?.label +
                                ('settings.keyWorkflow.piSAuthJsonHoldsOnlyThe' | transloco)
                              : ('settings.keyWorkflow.thereIsNoCredentialStoreHereSo' | transloco),
                          }
                  }}
                </li>
                <li>{{ 'settings.keyWorkflow.oneSmallRequestChecksThatTheProvider' | transloco }}</li>
              </ul>
            </div>
          }
          @case (3) {
            <form (submit)="submit($event)" class="flex flex-col gap-4" autocomplete="off">
              <div>
                <label class="lbl" for="api-key-field">{{ 'settings.keyWorkflow.pasteTheKey' | transloco }}</label>
                <div class="hint">
                  @if (help().url; as url) {
                    {{ 'settings.keyWorkflow.createdAt' | transloco }}
                    <a class="link link-hover" [href]="url" target="_blank" rel="noopener noreferrer">{{ host(url) }}</a
                    >.
                  }
                  {{ help().needs }}
                </div>
              </div>
              <input
                #keyInput
                id="api-key-field"
                name="api-key"
                type="password"
                class="input w-full mono"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                aria-describedby="key-hint"
                [attr.aria-invalid]="shape().state === 'mismatch'"
                [disabled]="wf.phase !== 'editing' && wf.phase !== 'failed'"
                (input)="onInput(keyInput.value)"
              />
              <div
                id="key-hint"
                class="hint flex items-center gap-2"
                data-testid="key-shape"
                [attr.data-state]="shape().state"
              >
                <span class="w-2 h-2 rounded-full shrink-0" [class]="dot()"></span>
                <span>{{ shape().message }}</span>
              </div>
              @if (!ready()) {
                <div class="hint flex items-center gap-2">
                  <span class="loading loading-spinner loading-xs"></span>
                  {{ 'settings.keyWorkflow.askingPiToSignIn' | transloco }}
                </div>
              }
              @if (wf.phase === 'saving' || wf.phase === 'validating') {
                <div class="hint flex items-center gap-2" role="status">
                  <span class="loading loading-spinner loading-xs"></span>
                  {{
                    wf.phase === 'saving'
                      ? ('settings.keyWorkflow.piIsStoringTheKey' | transloco)
                      : ('settings.keyWorkflow.checkingWithTheProvider' | transloco)
                  }}
                </div>
              }
              @if (wf.phase === 'failed') {
                <div class="text-sm text-error break-words" role="alert" data-testid="key-error">{{ wf.error }}</div>
                <div>
                  <button type="button" class="btn btn-sm" (click)="tryAnother()">
                    {{ 'settings.keyWorkflow.tryAgain' | transloco }}
                  </button>
                </div>
              }
              <button type="submit" hidden>{{ 'settings.keyWorkflow.validateAndSave' | transloco }}</button>
            </form>
          }
          @case (4) {
            @if (wf.phase === 'validating' || !wf.validation) {
              <div class="hint flex items-center gap-2" role="status">
                <span class="loading loading-spinner loading-xs"></span>
                {{ 'settings.keyWorkflow.checkingWithTheProvider' | transloco }}
              </div>
            } @else {
              <div class="box" data-testid="key-result">
                <div class="flex items-center gap-2 t-sm">
                  <span class="chip" [class]="resultTone()" data-testid="key-status">{{ resultChip() }}</span>
                  <span>{{ wf.validation.message }}</span>
                </div>
                <dl class="kv">
                  <dt>{{ 'settings.keyWorkflow.modelsYouCanUse' | transloco }}</dt>
                  <dd>
                    {{ wf.validation.models }}
                    @if (wf.validation.sample.length > 0) {
                      {{ 'settings.keyWorkflow.including' | transloco: { value1: wf.validation.sample.join(', ') } }}
                    }
                  </dd>
                  <dt>{{ 'settings.keyWorkflow.savedAs' | transloco }}</dt>
                  <dd data-testid="saved-as">{{ savedAs() }}</dd>
                </dl>
                @if (plainText()) {
                  <div class="hint flex items-center gap-2 text-warning" role="note" data-testid="plain-text-warning">
                    <span class="chip warn">{{ 'settings.keyWorkflow.plainText' | transloco }}</span>
                    {{ 'settings.keyWorkflow.noCredentialStoreTookTheKeySo' | transloco }}
                  </div>
                }
              </div>
              @if (wf.validation.status === 'rejected') {
                <div class="hint text-error">
                  {{ 'settings.keyWorkflow.theProviderRefusedThisKeyYouCan' | transloco }}
                </div>
              }
              <ng-content select="[done]" />
            }
          }
        }
      </div>
    </ng-template>

    <ng-template #footTpl let-wf>
      <div class="foot">
        @if (wf.step === 2 || wf.step === 3) {
          <button type="button" class="btn btn-sm btn-ghost" [disabled]="busy()" (click)="back()">
            {{ 'settings.keyWorkflow.back' | transloco }}
          </button>
        }
        <span class="hint">{{ embedded() && hint() ? hint() : footHint() }}</span>
        <span class="ml-auto flex items-center gap-2">
          @switch (wf.step) {
            @case (1) {
              <button type="button" class="btn btn-sm btn-primary" [disabled]="!wf.provider" (click)="store.keyNext()">
                {{ 'settings.keyWorkflow.next' | transloco }}
              </button>
            }
            @case (2) {
              <button type="button" class="btn btn-sm btn-primary" (click)="store.keyNext()">
                {{ 'settings.keyWorkflow.iHaveAKey' | transloco }}
              </button>
            }
            @case (3) {
              <button
                type="button"
                class="btn btn-sm btn-primary"
                data-testid="validate-save"
                [disabled]="!canSubmit()"
                (click)="submit($event)"
              >
                {{ 'settings.keyWorkflow.validateAndSave' | transloco }}
              </button>
            }
            @case (4) {
              @if (wf.validation?.status === 'rejected') {
                <button type="button" class="btn btn-sm btn-ghost" (click)="store.removeKey()">
                  {{ 'settings.keyWorkflow.removeKey' | transloco }}
                </button>
                <button type="button" class="btn btn-sm" (click)="tryAnother()">
                  {{ 'settings.keyWorkflow.tryAnotherKey' | transloco }}
                </button>
              }
              <button
                type="button"
                class="btn btn-sm btn-primary"
                data-testid="key-done"
                [disabled]="wf.phase !== 'done'"
                (click)="finish()"
              >
                {{ 'settings.keyWorkflow.done' | transloco }}
              </button>
            }
          }
        </span>
      </div>
    </ng-template>
  `,
})
export class KeyWorkflow {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(SettingsStore);
  protected readonly secrets = inject(SecretsStore);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('keyInput');

  /**
   * Inside the "Add a provider" wizard the steps are the wizard's own: only the body and the footer render, as children of the wizard's window, the wizard picks the
   * provider before (so the workflow opens at "where to get a key") and takes over at the end. The window with its dots is the standalone dialog's.
   */
  readonly embedded = input(false);
  /** The footer's line when embedded: the wizard's own count of steps. */
  readonly hint = input('');
  /** Embedded: Back from "where to get a key" goes to the wizard's "which provider". */
  readonly left = output<void>();
  /** Embedded: Done was pressed on the result. */
  readonly finished = output<void>();

  protected readonly steps = [1, 2, 3, 4];
  /** The verdict on the shape of what is typed; never the text. */
  protected readonly shape = signal<KeyShape>({ state: 'empty', message: '' });
  protected readonly typed = signal(false);

  protected readonly keyProviders = computed(() =>
    (this.store.overview()?.providers ?? []).filter((p) => p.methods.includes('api_key')),
  );
  protected readonly provider = computed(() =>
    this.store.overview()?.providers.find((p) => p.id === this.store.keyWorkflow()?.provider),
  );
  protected readonly help = computed(() => keyHelp(this.i18n.t, this.store.keyWorkflow()?.provider ?? ''));
  /** pi’s secret prompt is waiting for the key. */
  protected readonly ready = computed(
    () =>
      this.store.flow()?.prompt?.kind === 'secret' ||
      this.store.keyWorkflow()?.phase === 'saving' ||
      this.store.keyWorkflow()?.phase === 'validating',
  );
  protected readonly busy = computed(() => ['saving', 'validating'].includes(this.store.keyWorkflow()?.phase ?? ''));
  protected readonly canSubmit = computed(
    () =>
      this.typed() && this.shape().state !== 'empty' && this.store.flow()?.prompt?.kind === 'secret' && !this.busy(),
  );
  protected readonly dot = computed(
    () => ({ ok: 'bg-success', unknown: 'bg-info', mismatch: 'bg-warning', empty: 'bg-base-300' })[this.shape().state],
  );

  protected readonly footHint = computed(() => {
    const wf = this.store.keyWorkflow();
    if (!wf) return '';
    return (
      [
        '',
        this.i18n.t('settings.keyWorkflow.step1Of4NextWhereTo'),
        this.i18n.t('settings.keyWorkflow.step2Of4NextPasteIt'),
        this.i18n.t('settings.keyWorkflow.step3Of4NextTheResult'),
        this.i18n.t('settings.keyWorkflow.step4Of4'),
      ][wf.step] ?? ''
    );
  });

  protected readonly resultChip = computed(
    () =>
      ({ ok: 'validated', rejected: 'rejected', unchecked: this.i18n.t('settings.keyWorkflow.notChecked') })[
        this.store.keyWorkflow()?.validation?.status ?? 'unchecked'
      ],
  );
  protected readonly resultTone = computed(
    () =>
      ({ ok: 'ok', rejected: 'err', unchecked: 'warn' })[this.store.keyWorkflow()?.validation?.status ?? 'unchecked'],
  );

  /** `OpenRouter key ending in a1b2, auth.json, today` from what pi stored; nothing of the key itself. */
  protected readonly savedAs = computed(() => {
    const p = this.provider();
    const c = p?.credential;
    if (!p || !c) return this.i18n.t('settings.keyWorkflow.piReportsNoStoredCredential');
    return this.i18n.t('settings.keyWorkflow.key', {
      value1: p.name,
      value2: c.lastFour ? this.i18n.t('settings.keyWorkflow.endingIn', { value1: c.lastFour }) : '',
      value3: credentialStoreText(this.i18n.t, c.store, 'api_key', this.secrets.status()?.label),
      value4: whenText(c.addedAt),
    });
  });
  /** The key had to stay in auth.json in full: a warning, not a footnote. */
  protected readonly plainText = computed(() => {
    const c = this.provider()?.credential;
    return c?.type === 'api_key' && c.store === 'auth.json' && this.secrets.status()?.available === false;
  });

  constructor() {
    void this.secrets.loadStatus();
    // The dialog takes the focus; at step 3 the key field does, once pi’s prompt is waiting.
    effect(() => {
      const wf = this.store.keyWorkflow();
      if (!wf) return;
      queueMicrotask(() => (wf.step === 3 ? this.field()?.nativeElement : this.win()?.nativeElement)?.focus());
    });
    effect(() => {
      if (this.store.keyWorkflow()?.step !== 3) {
        this.shape.set({ state: 'empty', message: '' });
        this.typed.set(false);
      }
    });
    effect(() => {
      const wf = this.store.keyWorkflow();
      if (wf?.step === 3 && !this.typed()) this.shape.set(this.check(''));
    });
  }

  private check(text: string): KeyShape {
    const wf = this.store.keyWorkflow();
    return checkKeyShape(
      this.i18n.t,
      wf?.provider ?? '',
      this.provider()?.name ?? this.i18n.t('settings.keyWorkflow.theProvider'),
      text,
    );
  }

  protected onInput(text: string): void {
    this.typed.set(text.length > 0);
    this.shape.set(this.check(text));
  }

  protected host(url: string): string {
    try {
      const u = new URL(url);
      return u.host + (u.pathname !== '/' ? u.pathname : '');
    } catch {
      return url;
    }
  }

  protected back(): void {
    const input = this.field()?.nativeElement;
    if (input) input.value = '';
    if (this.embedded() && this.store.keyWorkflow()?.step === 2) {
      this.store.closeKeyWorkflow();
      this.left.emit();
      return;
    }
    this.store.keyBack();
  }

  protected finish(): void {
    if (this.embedded()) this.finished.emit();
    else this.store.closeKeyWorkflow();
  }

  /** The key leaves the field here: the field is emptied before the request is made. */
  protected submit(event: Event): void {
    event.preventDefault();
    const input = this.field()?.nativeElement;
    if (!input || !this.canSubmit()) return;
    const key = input.value.trim();
    input.value = '';
    this.typed.set(false);
    this.shape.set(this.check(''));
    if (key) void this.store.submitKey(key);
  }

  protected tryAnother(): void {
    void this.store.keyRetry();
  }
}
