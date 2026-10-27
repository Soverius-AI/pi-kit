import { Language, TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
  type OnInit,
} from '@angular/core';
import { CdkTrapFocus } from '@angular/cdk/a11y';
import { NgTemplateOutlet } from '@angular/common';
import { errorMessage } from '@pi-kit/api';
import { LocalModelOptionValuesSchema, type LocalModelOptionValues, type LocalModelOptions } from '@pi-kit/protocol';
import { LocalModelCatalogStore, LocalRuntimeStore } from '@pi-kit/settings/data';
import { PkTabs, PkTabPanel, keepFocusInside } from '@pi-kit/design-system';

const modelMessages: Readonly<Record<string, string>> = {
  'MTP support could not be verified for this model and engine.': 'settings.modelManagement.mtp.activationError',
  'Minimum draft tokens must not exceed maximum draft tokens.': 'settings.modelManagement.mtp.rangeError',
  'Immediate reload of an existing process is supported on macOS and Linux.': 'settings.modelManagement.hint.windows',
  'Start the existing llama-swap service for this config to reload a model here.':
    'settings.modelManagement.hint.stopped',
  'Enable llama-swap proxy logging at info or debug to verify immediate reloads.':
    'settings.modelManagement.hint.logging',
  'This model ID cannot be addressed by the reload API.': 'settings.modelManagement.hint.modelId',
  'Uses a config macro. Changing this field overrides it for this model only.': 'settings.modelManagement.hint.macro',
  'Custom YAML value. Leave unchanged to preserve it.': 'settings.modelManagement.hint.customYaml',
  'Custom argument value. Leave unchanged to preserve it.': 'settings.modelManagement.hint.customArgument',
  'The llama-swap config changed since it was loaded. Reload it before saving.':
    'settings.modelManagement.hint.conflict',
  'Fix the config in Advanced YAML before configuring a model.': 'settings.modelManagement.hint.fixYaml',
};

type Key = keyof LocalModelOptionValues;
interface Field {
  key: Key;
  label: string;
  hint: string;
  kind: 'text' | 'number' | 'select';
  min?: number;
  max?: number;
  step?: string;
}
const runtime: Field[] = [
  {
    key: 'name',
    label: 'settings.modelManagement.displayName',
    hint: 'settings.modelManagement.theNameShownToClientsBlankUsesThe',
    kind: 'text',
  },
  {
    key: 'context',
    label: 'settings.modelManagement.contextSize',
    hint: 'settings.modelManagement.totalContextTokensReservedByTheEngineLarger',
    kind: 'number',
    min: 0,
    max: 16777216,
  },
  {
    key: 'gpuLayers',
    label: 'settings.modelManagement.gPULayers',
    hint: 'settings.modelManagement.useAutoAllOrALayerCount0',
    kind: 'text',
  },
  {
    key: 'ttl',
    label: 'settings.modelManagement.unloadAfterIdleSeconds',
    hint: 'settings.modelManagement.0KeepsTheModelLoadedBlankOr1',
    kind: 'number',
    min: -1,
    max: 31536000,
  },
  {
    key: 'parallel',
    label: 'settings.modelManagement.parallelRequests',
    hint: 'settings.modelManagement.serverSlotsForSimultaneousRequests1LetsThe',
    kind: 'number',
    min: -1,
    max: 4096,
  },
  {
    key: 'threads',
    label: 'settings.modelManagement.cPUThreads',
    hint: 'settings.modelManagement.threadsUsedForGeneration1LetsTheEngine',
    kind: 'number',
    min: -1,
    max: 4096,
  },
  {
    key: 'flashAttention',
    label: 'settings.modelManagement.flashAttention',
    hint: 'settings.modelManagement.controlsTheEngineSAttentionImplementationSupportDepends',
    kind: 'select',
  },
];
const sampling: Field[] = [
  {
    key: 'temperature',
    label: 'settings.modelManagement.temperature',
    hint: 'settings.modelManagement.higherValuesIncreaseVariation0ChoosesTheMost',
    kind: 'number',
    min: 0,
    max: 100,
    step: 'any',
  },
  {
    key: 'topP',
    label: 'settings.modelManagement.topP',
    hint: 'settings.modelManagement.keepTokensWithinThisCumulativeProbability1Disables',
    kind: 'number',
    min: 0,
    max: 1,
    step: 'any',
  },
  {
    key: 'topK',
    label: 'settings.modelManagement.topK',
    hint: 'settings.modelManagement.keepThisManyCandidateTokens0DisablesThis',
    kind: 'number',
    min: 0,
    max: 1000000,
  },
  {
    key: 'minP',
    label: 'settings.modelManagement.minP',
    hint: 'settings.modelManagement.minimumProbabilityRelativeToTheMostLikelyToken',
    kind: 'number',
    min: 0,
    max: 1,
    step: 'any',
  },
];

const speculative: Field[] = [
  {
    key: 'specType',
    label: 'settings.modelManagement.mtp.mode',
    hint: 'settings.modelManagement.mtp.modeHint',
    kind: 'select',
  },
  {
    key: 'specDraftMax',
    label: 'settings.modelManagement.mtp.max',
    hint: 'settings.modelManagement.mtp.maxHint',
    kind: 'number',
    min: 1,
    max: 4096,
  },
  {
    key: 'specDraftMin',
    label: 'settings.modelManagement.mtp.min',
    hint: 'settings.modelManagement.mtp.minHint',
    kind: 'number',
    min: 0,
    max: 4096,
  },
  {
    key: 'specDraftPMin',
    label: 'settings.modelManagement.mtp.probability',
    hint: 'settings.modelManagement.mtp.probabilityHint',
    kind: 'number',
    min: 0,
    max: 1,
    step: 'any',
  },
  {
    key: 'draftModel',
    label: 'settings.modelManagement.mtp.draftModel',
    hint: 'settings.modelManagement.mtp.draftModelHint',
    kind: 'text',
  },
];

/** A form over the existing config; sends changed fields only, with the loaded content version. */
@Component({
  selector: 'pk-local-model-settings',
  imports: [PkTabs, PkTabPanel, CdkTrapFocus, NgTemplateOutlet, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pk-wf" data-testid="model-settings">
      <button
        class="pk-backdrop"
        type="button"
        tabindex="-1"
        [attr.aria-label]="'settings.modelManagement.closeModelSettings' | transloco"
        (click)="requestClose()"
      ></button>
      <section
        #win
        class="win wide"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'settings.modelManagement.configureModel' | transloco: { model: model() }"
        tabindex="-1"
        cdkTrapFocus
        [cdkTrapFocusAutoCapture]="true"
        (keydown.escape)="$event.preventDefault(); $event.stopPropagation(); requestClose()"
      >
        <header class="head">
          <div class="min-w-0">
            <h2 class="t-base m-0 break-all">{{ model() }}</h2>
            <p class="t-xs muted m-0">{{ 'settings.modelManagement.modelSettingsLlamaSwap' | transloco }}</p>
          </div>
          <button
            class="pk-close ml-auto"
            type="button"
            [attr.aria-label]="'settings.fileEditor.close' | transloco"
            [disabled]="saving()"
            (click)="requestClose()"
          >
            ✕
          </button>
        </header>
        <div class="body flex flex-col gap-4">
          @if (loading()) {
            <p role="status" class="t-sm muted">{{ 'settings.modelManagement.readingModelSettings' | transloco }}</p>
          }
          @if (error()) {
            <p role="alert" class="t-sm text-error m-0">{{ error() }}</p>
            <button class="btn btn-sm self-start" type="button" [disabled]="saving()" (click)="load()">
              {{ 'settings.modelManagement.reloadModelSettings' | transloco }}
            </button>
          }
          @if (options(); as options) {
            @if (options.engine === 'custom') {
              <p class="t-sm muted m-0">
                {{ 'settings.modelManagement.thisModelUsesACustomLauncherOnlyEngine' | transloco }}
              </p>
            }
            <pk-tabs [label]="'settings.modelManagement.modelSettings' | transloco" [(value)]="tab">
              <pk-tab-panel value="runtime" [label]="'settings.modelManagement.runtime' | transloco">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 py-3">
                  @for (field of runtimeFields(); track field.key) {
                    <ng-container [ngTemplateOutlet]="control" [ngTemplateOutletContext]="{ $implicit: field }" />
                  }
                </div>
              </pk-tab-panel>
              @if (samplingFields().length) {
                <pk-tab-panel value="sampling" [label]="'settings.modelManagement.generationDefaults' | transloco">
                  <p class="t-xs muted mt-3">
                    {{ 'settings.modelManagement.defaultsForRequestsThatDoNotSupplyTheir' | transloco }}
                  </p>
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 py-3">
                    @for (field of samplingFields(); track field.key) {
                      <ng-container [ngTemplateOutlet]="control" [ngTemplateOutletContext]="{ $implicit: field }" />
                    }
                  </div>
                </pk-tab-panel>
              }
              @if (options.mtp || speculativeFields().length) {
                <pk-tab-panel value="mtp" [label]="'settings.modelManagement.mtp.title' | transloco">
                  @if (options.mtp; as mtp) {
                    <p class="t-xs muted mt-3" data-testid="mtp-support">
                      {{ 'settings.modelManagement.mtp.status.' + mtp.status | transloco }}
                    </p>
                  }
                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 py-3">
                    @for (field of speculativeFields(); track field.key) {
                      <ng-container [ngTemplateOutlet]="control" [ngTemplateOutletContext]="{ $implicit: field }" />
                    }
                  </div>
                </pk-tab-panel>
              }
            </pk-tabs>
            <ng-template #control let-field>
              <label class="flex flex-col gap-1 min-w-0" [for]="'model-option-' + field.key">
                <span class="t-sm font-medium">{{ field.label | transloco }}</span>
                @if (field.kind === 'select') {
                  <select
                    [id]="'model-option-' + field.key"
                    class="select select-sm w-full"
                    [attr.aria-label]="field.label | transloco"
                    [disabled]="saving() || applying()"
                    [value]="value(field.key)"
                    (change)="set(field.key, $any($event.target).value)"
                  >
                    <option value="" [selected]="!value(field.key)">
                      {{ 'settings.modelManagement.engineDefault' | transloco }}
                    </option>
                    @if (field.key === 'specType') {
                      <option value="none" [selected]="value(field.key) === 'none'">
                        {{ 'settings.modelManagement.mtp.disabled' | transloco }}
                      </option>
                      <option
                        value="draft-mtp"
                        [selected]="value(field.key) === 'draft-mtp'"
                        [disabled]="!mtpAvailable()"
                      >
                        {{ 'settings.modelManagement.mtp.enabled' | transloco }}
                      </option>
                      @if (value(field.key) && !['none', 'draft-mtp'].includes(value(field.key))) {
                        <option [value]="value(field.key)" [selected]="true">
                          {{ 'settings.modelManagement.mtp.existingMode' | transloco: { mode: value(field.key) } }}
                        </option>
                      }
                    } @else {
                      <option value="auto" [selected]="value(field.key) === 'auto'">
                        {{ 'settings.modelManagement.automatic' | transloco }}
                      </option>
                      <option value="on" [selected]="value(field.key) === 'on'">
                        {{ 'settings.modelManagement.on' | transloco }}
                      </option>
                      <option value="off" [selected]="value(field.key) === 'off'">
                        {{ 'common.effort.off' | transloco }}
                      </option>
                    }
                  </select>
                } @else {
                  <input
                    [id]="'model-option-' + field.key"
                    class="input input-sm w-full"
                    [type]="field.kind"
                    [attr.aria-label]="field.label | transloco"
                    [attr.min]="field.min"
                    [attr.max]="field.max"
                    [attr.step]="field.step ?? '1'"
                    [placeholder]="
                      field.key === 'name'
                        ? ('settings.modelManagement.modelID' | transloco)
                        : ('settings.modelManagement.engineDefault' | transloco)
                    "
                    [disabled]="saving() || applying()"
                    [value]="value(field.key)"
                    (input)="set(field.key, $any($event.target).value, $any($event.target).validity.badInput)"
                  />
                }
                <span class="t-xs muted">{{ field.hint | transloco }}</span>
                @if (options.inherited[field.key]; as hint) {
                  <span class="t-xs muted">{{ modelMessage(hint) }}</span>
                }
              </label>
            </ng-template>
            <p class="t-xs muted m-0">
              {{ 'settings.modelManagement.blankEngineOptionsUseTheEngineOrEnvironment' | transloco }}
            </p>
            @if (options.reload?.available) {
              <p class="t-xs muted m-0">
                {{
                  'settings.modelManagement.reloadUsesYourExistingLlamaSwapInstanceIt'
                    | transloco
                      : {
                          address: options.reload?.baseUrl
                            ? ('settings.modelManagement.at' | transloco: { url: options.reload?.baseUrl })
                            : '',
                        }
                }}
              </p>
            } @else if (options.reload?.reason) {
              <p class="t-xs muted m-0">{{ modelMessage(options.reload.reason) }}</p>
            }
            @if (problem()) {
              <p role="alert" class="t-sm text-error m-0">{{ problem() }}</p>
            }
            @if (applying()) {
              <p class="t-sm m-0" role="status">{{ reloadJob()?.detail }}</p>
              <p class="t-xs muted m-0">
                {{ 'settings.modelManagement.reloadContinuesIfYouCloseThisPanel' | transloco }}
              </p>
            }
            @if (applied()) {
              <p role="status" class="t-sm text-success m-0">
                {{ 'settings.modelManagement.modelReloadedAndReadyTheSavedSettingsAre' | transloco }}
              </p>
            }
            @if (saved() && !applied() && !applying()) {
              <p role="status" class="t-sm text-success m-0">
                {{ 'settings.modelManagement.savedToYourExistingConfigEngineOptionsApply' | transloco }}
              </p>
            }
          }
        </div>
        <footer class="foot flex flex-wrap items-center gap-2">
          @if (confirm()) {
            <p class="t-sm m-0 w-full">
              {{
                confirm() === 'yaml'
                  ? ('settings.modelManagement.discardYourUnsavedChangesAndOpenYAML' | transloco)
                  : ('settings.modelManagement.discardYourUnsavedChanges' | transloco)
              }}
            </p>
            <button class="btn btn-sm" type="button" (click)="confirm.set('')">
              {{ 'settings.fileEditor.keepEditing' | transloco }}
            </button>
            <button class="btn btn-sm btn-error" type="button" (click)="discard()">
              {{ 'settings.modelManagement.discardChanges' | transloco }}
            </button>
          } @else {
            <button
              class="btn btn-sm btn-ghost"
              type="button"
              [disabled]="saving() || applying()"
              (click)="requestAdvanced()"
            >
              {{ 'settings.modelManagement.advancedYAML' | transloco }}
            </button>
            <div class="flex-1"></div>
            <button class="btn btn-sm" type="button" [disabled]="saving()" (click)="requestClose()">
              {{
                dirty()
                  ? ('chat.labels.chatInputToolbarCancelTranscribeButtonLabel' | transloco)
                  : ('settings.fileEditor.close' | transloco)
              }}
            </button>
            <button
              class="btn btn-sm"
              [class.btn-primary]="!options()?.reload?.available"
              type="button"
              [disabled]="
                !options() || loading() || saving() || applying() || runtime.active() || !dirty() || !!problem()
              "
              (click)="save()"
            >
              {{
                saving()
                  ? ('settings.modelManagement.saving' | transloco)
                  : ('settings.modelManagement.saveModelSettings' | transloco)
              }}
            </button>
            <button
              class="btn btn-sm btn-primary"
              type="button"
              [disabled]="
                !options()?.reload?.available ||
                loading() ||
                saving() ||
                applying() ||
                runtime.active() ||
                runtime.submitting() ||
                !!problem()
              "
              (click)="save(true)"
            >
              {{
                applying()
                  ? ('settings.modelManagement.reloadingModel' | transloco)
                  : dirty()
                    ? ('settings.modelManagement.saveAndReloadModel' | transloco)
                    : ('settings.modelManagement.reloadModel' | transloco)
              }}
            </button>
          }
        </footer>
      </section>
    </div>
  `,
})
export class LocalModelSettings implements OnInit {
  protected readonly i18n = inject(Language);
  readonly path = input.required<string>();
  readonly model = input.required<string>();
  readonly closed = output<void>();
  readonly advanced = output<void>();
  readonly changed = output<void>();
  private readonly catalog = inject(LocalModelCatalogStore);
  protected readonly runtime = inject(LocalRuntimeStore);
  private readonly injector = inject(Injector);
  private readonly win = viewChild<ElementRef<HTMLElement>>('win');
  protected readonly options = signal<LocalModelOptions | undefined>(undefined);
  protected readonly draft = signal<Partial<Record<Key, string>>>({});
  private readonly initial = signal<Partial<Record<Key, string>>>({});
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly applied = signal(false);
  private readonly reloadId = signal('');
  protected readonly reloadJob = computed(() => {
    const job = this.runtime.status()?.job;
    return job?.id === this.reloadId() ? job : undefined;
  });
  protected readonly applying = computed(() => ['running', 'cancelling'].includes(this.reloadJob()?.state ?? ''));
  protected readonly error = signal('');
  protected readonly tab = signal('runtime');
  protected readonly confirm = signal<'' | 'close' | 'yaml'>('');
  protected readonly runtimeFields = computed(() =>
    runtime.filter((field) => this.options()?.supported.includes(field.key)),
  );
  protected readonly samplingFields = computed(() =>
    sampling.filter((field) => this.options()?.supported.includes(field.key)),
  );
  protected readonly speculativeFields = computed(() =>
    speculative.filter((field) => this.options()?.supported.includes(field.key)),
  );
  protected readonly mtpAvailable = computed(
    () =>
      ['detected', 'configured'].includes(this.options()?.mtp?.status ?? '') ||
      this.options()?.values.specType?.split(',').includes('draft-mtp'),
  );
  protected readonly dirty = computed(() =>
    Object.keys(this.draft()).some((key) => this.draft()[key as Key] !== this.initial()[key as Key]),
  );
  private readonly values = computed(() => {
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.draft())) {
      if (value === this.initial()[key as Key]) continue;
      const text = value.trim();
      values[key] =
        text === ''
          ? null
          : ['name', 'flashAttention', 'specType', 'draftModel'].includes(key) ||
              (key === 'gpuLayers' && /^(auto|all)$/.test(text))
            ? text
            : Number(text);
    }
    return LocalModelOptionValuesSchema.partial().safeParse(values);
  });
  protected readonly problem = computed(() => {
    const min = this.draft().specDraftMin,
      max = this.draft().specDraftMax;
    if (min && max && Number(min) > Number(max)) return this.i18n.t('settings.modelManagement.mtp.rangeError');
    const values = this.values();
    if (values.success) return '';
    const key = String(values.error.issues[0]?.path[0]);
    const field = [...runtime, ...sampling, ...speculative].find((field) => field.key === key);
    return this.i18n.t('settings.modelManagement.check', {
      field: field ? this.i18n.t(field.label) : this.i18n.t('settings.modelManagement.modelSettings'),
      detail: this.i18n.t('settings.modelManagement.enterAValidValue'),
    });
  });
  constructor() {
    effect(() => {
      const job = this.reloadJob();
      if (!job || ['running', 'cancelling'].includes(job.state)) return;
      untracked(() => {
        if (job.state === 'complete') {
          this.applied.set(true);
          this.changed.emit();
        } else
          this.error.set(
            job.state === 'cancelled'
              ? this.i18n.t('settings.modelManagement.stoppedWaitingForReloadSavedSettingsAreRetained')
              : /saved settings/i.test(job.error ?? job.detail)
                ? (job.error ?? job.detail)
                : this.i18n.t('settings.modelManagement.savedSettingsAreRetained', { detail: job.error ?? job.detail }),
          );
      });
    });
    effect(() => {
      this.loading();
      this.saving();
      this.confirm();
      untracked(() => keepFocusInside(this.injector, () => this.win()?.nativeElement));
    });
  }
  ngOnInit(): void {
    void this.load();
  }
  protected modelMessage(message: string): string {
    const key = modelMessages[message];
    return key ? this.i18n.t(key) : message;
  }
  protected value(key: Key): string {
    return this.draft()[key] ?? '';
  }
  protected set(key: Key, value: string, invalid = false): void {
    this.draft.update((draft) => ({ ...draft, [key]: invalid ? 'invalid' : value }));
    this.saved.set(false);
    this.applied.set(false);
  }
  private accept(options: LocalModelOptions): void {
    const draft = Object.fromEntries(
      options.supported.map((key) => [key, options.values[key] == null ? '' : String(options.values[key])]),
    );
    this.options.set(options);
    this.initial.set(draft);
    this.draft.set({ ...draft });
  }
  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.saved.set(false);
    this.applied.set(false);
    this.reloadId.set('');
    try {
      this.accept(await this.catalog.modelOptions(this.path(), this.model()));
    } catch (error) {
      this.error.set(this.modelMessage(errorMessage(error)));
    } finally {
      this.loading.set(false);
    }
  }
  protected async save(reload = false): Promise<void> {
    const options = this.options(),
      values = this.values();
    if (
      !options ||
      !values.success ||
      (!this.dirty() && !reload) ||
      this.saving() ||
      this.applying() ||
      this.runtime.active()
    )
      return;
    this.saving.set(true);
    this.applied.set(false);
    this.error.set('');
    try {
      if (this.dirty()) {
        this.accept(
          await this.catalog.saveModelOptions({
            path: this.path(),
            model: this.model(),
            version: options.version,
            values: values.data,
          }),
        );
        this.saved.set(true);
        this.changed.emit();
      }
      if (reload) {
        const current = this.options();
        if (!current) return;
        const previous = this.runtime.status()?.job?.id;
        await this.runtime.reloadModel({ path: this.path(), model: this.model(), version: current.version });
        const job = this.runtime.status()?.job;
        if (!job || job.id === previous || job.action?.kind !== 'reload' || job.action.model !== this.model())
          throw new Error(
            this.runtime.error() || this.i18n.t('settings.modelManagement.couldNotStartModelReloadSavedSettingsAre'),
          );
        this.reloadId.set(job.id);
      }
    } catch (error) {
      this.error.set(this.modelMessage(errorMessage(error)));
    } finally {
      this.saving.set(false);
    }
  }
  protected requestClose(): void {
    if (!this.saving()) {
      if (this.dirty()) this.confirm.set('close');
      else this.closed.emit();
    }
  }
  protected requestAdvanced(): void {
    if (this.dirty()) this.confirm.set('yaml');
    else this.advanced.emit();
  }
  protected discard(): void {
    if (this.confirm() === 'yaml') this.advanced.emit();
    else this.closed.emit();
  }
}
