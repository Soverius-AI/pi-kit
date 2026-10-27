import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { groupProviders, providerFamily, type SettingsModel } from '@pi-kit/protocol';
import { THINKING_LEVELS } from '@pi-kit/protocol';
import { compactNumber } from '@pi-kit/ui';
import { UpdateStore } from '@pi-kit/update/api';
import { PkSetting } from '@pi-kit/settings/api';
import { SettingsStore } from '@pi-kit/settings/data';
import { PkIcon, PkScrollArea, PkTabPanel, PkTabs, PkTip } from '@pi-kit/design-system';

interface PinnedRow {
  pattern: string;
  /** The model the pattern names exactly; absent for a glob or a model that is not available. */
  model?: SettingsModel;
}

const keyOf = (m: Pick<SettingsModel, 'provider' | 'id'>): string => `${m.provider}/${m.id}`;

/**
 * Settings › Chat models: the defaults a new thread starts with, the pinned models in the order ⌘⇧M cycles them
 * (drag a card or use its arrows; pi keeps this order in `enabledModels`), the searchable model catalog and the pi update line.
 */
@Component({
  selector: 'pk-models-section',
  imports: [PkSetting, PkTip, PkTabs, PkTabPanel, PkScrollArea, TranslocoPipe, PkIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.overview(); as overview) {
      <div class="flex flex-col gap-5" data-testid="section-models">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="t-sm muted m-0">
            {{ 'settings.modelManagement.theseSettingsChooseChatModelsDownloadsAndLlama' | transloco }}
          </p>
          <div class="flex gap-2">
            <button type="button" class="btn btn-sm" (click)="store.select('providers')">
              {{ 'shared.catalog.providers' | transloco }}
            </button>
            <button type="button" class="btn btn-sm" (click)="store.select('local-models')">
              {{ 'settings.modelManagement.localModels' | transloco }}
            </button>
          </div>
        </div>
        <pk-tabs [label]="'settings.modelManagement.chatModelSettings' | transloco" [(value)]="tab">
          @if (store.shows('default-model', 'default-effort')) {
            <pk-tab-panel value="defaults" [label]="'settings.modelManagement.chatDefaults' | transloco">
              <section class="pk-group" [attr.aria-label]="'settings.modelManagement.newChatDefaults' | transloco">
                <header>
                  <div>
                    <h4>{{ 'settings.modelManagement.newChatDefaults' | transloco }}</h4>
                    <p>{{ 'settings.modelManagement.appliesWhenYouCreateAChatUseThe' | transloco }}</p>
                  </div>
                </header>
                <div pkSetting="default-model">
                  <select
                    class="select select-sm"
                    aria-labelledby="lbl-default-model"
                    data-testid="default-model"
                    (change)="setDefaultModel($any($event.target).value)"
                  >
                    @if (!defaultListed()) {
                      <option [value]="defaultKey()" selected>
                        {{
                          defaultKey()
                            ? defaultKey().replace('|', '/') + ' (not available)'
                            : ('settings.modelsSection.notSet' | transloco)
                        }}
                      </option>
                    }
                    @for (group of availableGroups(); track group.provider) {
                      <optgroup [label]="group.name">
                        @for (model of group.models; track model.provider + model.id) {
                          <option
                            [value]="model.provider + '|' + model.id"
                            [selected]="model.provider + '|' + model.id === defaultKey()"
                          >
                            {{ model.id }}{{ group.provider === 'llama.cpp' ? ' · ' + model.provider : '' }}
                          </option>
                        }
                      </optgroup>
                    }
                  </select>
                </div>
                <div pkSetting="default-effort">
                  <select
                    class="select select-sm"
                    aria-labelledby="lbl-default-effort"
                    data-testid="default-effort"
                    (change)="store.patch({ defaultThinkingLevel: $any($event.target).value })"
                  >
                    @if (!overview.settings.defaultThinkingLevel) {
                      <option value="" selected>{{ 'settings.modelManagement.modelDefault' | transloco }}</option>
                    }
                    @for (level of levels; track level) {
                      <option [value]="level" [selected]="level === overview.settings.defaultThinkingLevel">
                        {{ 'common.effortValue.' + level | transloco }}
                      </option>
                    }
                  </select>
                </div>
              </section>
            </pk-tab-panel>
          }
          @if (store.shows('pinned-models')) {
            <pk-tab-panel
              value="pinned"
              [label]="'shared.catalog.pinnedModels' | transloco"
              [count]="pinnedRows().length"
            >
              <section class="pk-group" [attr.aria-label]="'shared.catalog.pinnedModels' | transloco">
                <header>
                  <div>
                    <h4>{{ 'shared.catalog.pinnedModels' | transloco }}</h4>
                    <p>
                      {{ 'settings.modelsSection.mCyclesThroughTheseFirstToLast' | transloco }}
                    </p>
                  </div>
                  @if (pinnedRows().length > 0) {
                    <div class="actions">
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        data-testid="clear-pinned"
                        (click)="store.setScope(null)"
                      >
                        {{ 'settings.modelManagement.clearPins' | transloco }}
                      </button>
                    </div>
                  }
                </header>
                <p class="t-sm muted px-4 pt-3 m-0">
                  {{
                    pinnedRows().length === 0
                      ? ('settings.modelsSection.noModelIsPinnedSoMCycles' | transloco)
                      : ('settings.modelsSection.modelsNotListedAreStillAvailableFrom' | transloco)
                  }}
                </p>
                <pk-scroll-area
                  class="pk-scroll-area-flush"
                  [label]="'settings.modelManagement.pinnedModelShortcuts' | transloco"
                  maxHeight="20rem"
                  ><div
                    class="pk-cards"
                    role="list"
                    [attr.aria-label]="'settings.modelsSection.pinnedModelsInCyclingOrder' | transloco"
                    data-testid="pinned-list"
                  >
                    @for (row of pinnedRows(); track row.pattern; let i = $index) {
                      <div
                        class="pk-model-card"
                        role="listitem"
                        draggable="true"
                        [class.dragging]="dragFrom() === i"
                        [class.over]="overIndex() === i && dragFrom() !== i"
                        [attr.data-pattern]="row.pattern"
                        (dragstart)="onDragStart($event, i)"
                        (dragover)="onDragOver($event, i)"
                        (drop)="onDrop($event, i)"
                        (dragend)="onDragEnd()"
                      >
                        <pk-icon name="grip" class="grip" />
                        <div class="min-w-0">
                          <div class="nm">{{ row.pattern }}</div>
                          <div class="md">
                            {{
                              row.model
                                ? detail(row.model)
                                : ('settings.modelsSection.aPatternKeptAsItIsIt' | transloco)
                            }}
                          </div>
                        </div>
                        <div class="flex items-center gap-1">
                          <span class="t-xs muted mr-1">{{ i + 1 }}</span>
                          <button
                            type="button"
                            class="btn btn-ghost btn-xs btn-square"
                            [pkTip]="'settings.modelsSection.moveUp' | transloco"
                            [disabled]="i === 0"
                            [attr.aria-label]="'Move ' + row.pattern + ' up'"
                            (click)="move(i, i - 1)"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            class="btn btn-ghost btn-xs btn-square"
                            [pkTip]="'settings.modelsSection.moveDown' | transloco"
                            [disabled]="i === pinnedRows().length - 1"
                            [attr.aria-label]="'Move ' + row.pattern + ' down'"
                            (click)="move(i, i + 1)"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            class="btn btn-ghost btn-xs btn-square"
                            [pkTip]="'settings.mcpSection.remove' | transloco"
                            [attr.aria-label]="'Remove ' + row.pattern + ' from the pinned models'"
                            (click)="remove(i)"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    }
                  </div>
                </pk-scroll-area>
                @if (unpinned().length > 0) {
                  <div class="row">
                    <div class="hint">{{ 'settings.modelsSection.pinAModel' | transloco }}</div>
                    <div class="ctl ctl-w">
                      <select
                        class="select select-sm"
                        [attr.aria-label]="'settings.modelsSection.pinAModel' | transloco"
                        data-testid="add-pinned"
                        (change)="add($any($event.target))"
                      >
                        <option value="" selected>{{ 'settings.modelsSection.chooseAModel' | transloco }}</option>
                        @for (model of unpinned(); track model.provider + model.id) {
                          <option [value]="model.provider + '/' + model.id">{{ model.provider }}/{{ model.id }}</option>
                        }
                      </select>
                    </div>
                  </div>
                }
              </section>
            </pk-tab-panel>
          }
          @if (store.shows('price-table', 'pi-update')) {
            <pk-tab-panel
              value="catalog"
              [label]="'settings.modelManagement.catalog' | transloco"
              [count]="models().length"
            >
              <div class="flex flex-col gap-4">
                @if (store.shows('price-table')) {
                  <section class="pk-group" [attr.aria-label]="'shared.catalog.modelsAndPrices' | transloco">
                    <header>
                      <div>
                        <h4>{{ 'shared.catalog.modelsAndPrices' | transloco }}</h4>
                        <p>{{ 'settings.modelsSection.contextWindowAndPricePerMillionTokens' | transloco }}</p>
                      </div>
                    </header>
                    <div class="flex flex-wrap gap-2 p-3">
                      <input
                        class="input input-sm flex-1 min-w-40"
                        type="search"
                        [attr.aria-label]="'settings.modelManagement.filterModelCatalog' | transloco"
                        [placeholder]="'settings.modelManagement.findAModel' | transloco"
                        [value]="modelQuery()"
                        (input)="modelQuery.set($any($event.target).value)"
                      />
                      <select
                        class="select select-sm"
                        [attr.aria-label]="'settings.modelManagement.filterByProvider' | transloco"
                        [value]="providerFilter()"
                        (change)="providerFilter.set($any($event.target).value)"
                      >
                        <option value="">{{ 'settings.modelManagement.allProviders' | transloco }}</option>
                        @for (group of providerGroups(); track group.provider) {
                          <option [value]="group.provider">{{ group.name }}</option>
                        }
                      </select>
                    </div>
                    <pk-scroll-area
                      class="pk-scroll-area-flush"
                      [label]="'settings.modelManagement.modelCatalog' | transloco"
                      maxHeight="22rem"
                      ><div class="overflow-x-auto" data-testid="price-table">
                        <table class="table table-sm min-w-[38rem]">
                          <thead>
                            <tr>
                              <th>{{ 'shared.catalog.model' | transloco }}</th>
                              <th class="text-right">{{ 'shared.catalog.context' | transloco }}</th>
                              <th class="text-right">{{ 'settings.modelsSection.in1M' | transloco }}</th>
                              <th class="text-right">{{ 'settings.modelsSection.out1M' | transloco }}</th>
                              <th>{{ 'settings.modelManagement.reasoning' | transloco }}</th>
                            </tr>
                          </thead>
                          <tbody>
                            @for (model of filteredModels(); track model.provider + model.id) {
                              <tr>
                                <td class="min-w-56 max-w-80 break-all">
                                  <span class="mono">{{ model.provider }}/{{ model.id }}</span>
                                  @if (model.virtual) {
                                    <span class="badge badge-ghost badge-sm ml-1">{{
                                      'settings.modelsSection.virtual' | transloco
                                    }}</span>
                                  }
                                </td>
                                <td class="text-right">
                                  {{ model.contextWindow ? compact(model.contextWindow) : '–' }}
                                </td>
                                <td class="text-right">{{ usd(model.costInput) }}</td>
                                <td class="text-right">{{ usd(model.costOutput) }}</td>
                                <td>
                                  {{
                                    model.reasoning
                                      ? ('settings.modelsSection.yes' | transloco)
                                      : ('settings.modelsSection.no' | transloco)
                                  }}
                                </td>
                              </tr>
                            } @empty {
                              <tr>
                                <td colspan="5" class="muted">
                                  {{ 'settings.modelManagement.noModelsMatchAdjustTheFiltersOrConnect' | transloco }}
                                </td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div></pk-scroll-area
                    >
                  </section>
                }

                @if (store.shows('pi-update')) {
                  <section
                    class="pk-group"
                    [attr.aria-label]="'settings.modelManagement.catalogMaintenance' | transloco"
                  >
                    <header>
                      <div>
                        <h4>{{ 'settings.modelManagement.catalogUpdates' | transloco }}</h4>
                        <p>
                          {{ 'settings.modelManagement.refreshTheAvailableModelDefinitionsAndPricing' | transloco }}
                        </p>
                      </div>
                    </header>
                    <div class="row" data-testid="pi-update-line">
                      <div class="min-w-0">
                        <div class="lbl">
                          {{ 'settings.nav.pi' | transloco }}
                          <span class="mono">{{ updates.resolution()?.version ?? overview.piVersion }}</span>
                          <span class="chip" [class]="piChip().tone">{{ piChip().text }}</span>
                        </div>
                        <div class="hint">
                          {{ 'settings.modelManagement.modelCatalogs' | transloco: { status: catalogLine() } }}
                        </div>
                      </div>
                      <div class="ctl ctl-w">
                        <button
                          type="button"
                          class="btn btn-sm"
                          [disabled]="updates.running()"
                          (click)="updates.update(['models'])"
                        >
                          {{ 'settings.modelsSection.refreshCatalogs' | transloco }}
                        </button>
                        @if (updates.pi()?.state === 'outdated') {
                          <button
                            type="button"
                            class="btn btn-sm btn-primary"
                            [disabled]="updates.running()"
                            (click)="updates.update(['pi'])"
                          >
                            {{ 'settings.versionsBlock.updatePi' | transloco }}
                          </button>
                        }
                      </div>
                    </div>
                  </section>
                }
              </div>
            </pk-tab-panel>
          }
        </pk-tabs>
      </div>
    } @else if (store.error()) {
      <p class="text-sm text-error" role="alert">
        {{ 'settings.modelsSection.piSSettingsCouldNotBeRead' | transloco: { value1: store.error() } }}
      </p>
    } @else {
      <div class="py-8 grid place-items-center">
        <span
          class="loading loading-dots loading-sm text-primary"
          [attr.aria-label]="'settings.modelsSection.loadingSettings' | transloco"
        ></span>
      </div>
    }
  `,
})
export class ModelsSection {
  protected readonly i18n = inject(Language);
  protected readonly store = inject(SettingsStore);
  protected readonly updates = inject(UpdateStore);

  protected readonly levels = THINKING_LEVELS;
  protected readonly tab = signal('defaults');
  protected readonly modelQuery = signal('');
  protected readonly providerFilter = signal('');
  protected readonly dragFrom = signal<number | undefined>(undefined);
  protected readonly overIndex = signal<number | undefined>(undefined);

  protected readonly models = computed(() =>
    [...(this.store.overview()?.models ?? [])].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
    ),
  );
  protected readonly availableModels = computed(() => this.models().filter((model) => model.available));
  protected readonly filteredModels = computed(() => {
    const query = this.modelQuery().trim().toLowerCase(),
      provider = this.providerFilter();
    return this.models().filter(
      (model) =>
        (!provider || this.family(model.provider).id === provider) &&
        (!query ||
          `${model.name} ${model.id} ${model.provider} ${this.family(model.provider).name}`
            .toLowerCase()
            .includes(query)),
    );
  });
  protected readonly defaultKey = computed(() => {
    const s = this.store.settings();
    return s?.defaultProvider && s.defaultModel ? `${s.defaultProvider}|${s.defaultModel}` : '';
  });
  protected readonly defaultListed = computed(
    () => this.defaultKey() !== '' && this.availableModels().some((m) => `${m.provider}|${m.id}` === this.defaultKey()),
  );

  protected readonly pinnedRows = computed<PinnedRow[]>(() => {
    const byKey = new Map(this.models().map((m) => [keyOf(m), m] as const));
    return (this.store.settings()?.enabledModels ?? []).map((pattern) => ({
      pattern,
      ...(byKey.get(pattern) ? { model: byKey.get(pattern) } : {}),
    }));
  });
  protected readonly unpinned = computed(() => {
    const pinned = new Set(this.pinnedRows().map((r) => r.pattern));
    return this.availableModels().filter((m) => !pinned.has(keyOf(m)));
  });
  protected readonly providerGroups = computed(() => {
    const providers = this.store.overview()?.providers ?? [];
    const ids = [...new Set(this.models().map((m) => m.provider))];
    return groupProviders(ids.map((id) => providers.find((p) => p.id === id) ?? { id, name: id })).map((group) => ({
      provider: group.id,
      name: group.name,
      models: this.models().filter((model) => group.connections.some((connection) => connection.id === model.provider)),
    }));
  });
  protected readonly availableGroups = computed(() =>
    this.providerGroups()
      .map((group) => ({ ...group, models: group.models.filter((model) => model.available) }))
      .filter((group) => group.models.length),
  );

  private family(id: string): { id: string; name: string } {
    return providerFamily(this.store.overview()?.providers.find((provider) => provider.id === id) ?? { id });
  }

  protected readonly piChip = computed(() => {
    const row = this.updates.pi();
    if (row?.state === 'outdated')
      return {
        text: row.latest
          ? this.i18n.t('settings.modelsSection.available', { value1: row.latest })
          : this.i18n.t('settings.modelsSection.updateAvailable'),
        tone: 'warn',
      };
    if (row?.state === 'current' || row?.state === 'done')
      return { text: this.i18n.t('settings.modelsSection.upToDate'), tone: 'ok' };
    return { text: this.i18n.t('settings.modelsSection.notChecked'), tone: 'off' };
  });
  protected readonly catalogLine = computed(() => {
    const at = this.updates.models()?.updatedAt;
    if (!at) return this.i18n.t('settings.modelManagement.notRefreshedYet');
    const days = Math.round((Date.now() - at) / 86_400_000);
    return days < 1
      ? this.i18n.t('settings.modelsSection.refreshedToday')
      : this.i18n.t('settings.modelsSection.refreshedAgo', {
          value1: days,
          value2: days === 1 ? this.i18n.t('settings.modelsSection.day') : this.i18n.t('settings.modelsSection.days'),
        });
  });

  protected detail(model: SettingsModel): string {
    return [
      model.provider,
      model.contextWindow
        ? this.i18n.t('chat.modelPanel.context', { value1: compactNumber(model.contextWindow) })
        : undefined,
      model.reasoning ? this.i18n.t('chat.modelPanel.thinks') : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  protected compact = compactNumber;
  protected usd(value: number | undefined): string {
    return value === undefined
      ? '—'
      : value === 0
        ? this.i18n.t('settings.modelManagement.free')
        : `$${value >= 10 ? Math.round(value) : Math.round(value * 100) / 100}`;
  }

  protected setDefaultModel(key: string): void {
    const [provider, ...rest] = key.split('|');
    if (provider && rest.length > 0) void this.store.patch({ defaultModel: { provider, modelId: rest.join('|') } });
  }

  private patterns(): string[] {
    return [...(this.store.settings()?.enabledModels ?? [])];
  }
  protected move(from: number, to: number): void {
    const list = this.patterns();
    if (from === to || to < 0 || to >= list.length) return;
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item as string);
    void this.store.setScope(list);
  }
  protected remove(index: number): void {
    const list = this.patterns();
    list.splice(index, 1);
    void this.store.setScope(list);
  }
  protected add(select: HTMLSelectElement): void {
    const pattern = select.value;
    select.value = '';
    if (pattern) void this.store.setScope([...this.patterns(), pattern]);
  }

  protected onDragStart(event: DragEvent, index: number): void {
    this.dragFrom.set(index);
    event.dataTransfer?.setData('text/plain', String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }
  protected onDragOver(event: DragEvent, index: number): void {
    if (this.dragFrom() === undefined) return;
    event.preventDefault();
    this.overIndex.set(index);
  }
  protected onDrop(event: DragEvent, index: number): void {
    event.preventDefault();
    const from = this.dragFrom();
    this.onDragEnd();
    if (from !== undefined) this.move(from, index);
  }
  protected onDragEnd(): void {
    this.dragFrom.set(undefined);
    this.overIndex.set(undefined);
  }
}
