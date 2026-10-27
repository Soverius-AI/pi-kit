import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  providerFamily,
  type ModelInfo,
  type ModelProvider,
  type ModelRef,
  type ProviderUsage,
} from '@pi-kit/protocol';
import {
  type PickerSection,
  modelKey,
  pickerSections,
  providerUsageBar,
  providerUsageParts,
  providerUsageTip,
  stateChip,
  tileLetters,
  visibleModels,
} from '@pi-kit/chat/util';
import { compactNumber, priceLabel } from '@pi-kit/ui';
import { PkIcon } from '@pi-kit/design-system';

let panelCount = 0;

/** Model selection and provider usage, shared by the composer and header. Effort has a separate popup owned by the host. */
@Component({
  imports: [TranslocoPipe, PkIcon],
  selector: 'pk-model-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'onEscape($event)' },
  template: `
    <div
      class="pk-picker"
      [class.down]="placement() === 'down'"
      role="dialog"
      [attr.aria-label]="'chat.modelPanel.chooseAModel' | transloco"
      data-testid="model-picker"
    >
      <div
        class="models"
        role="listbox"
        [attr.aria-label]="'chat.modelPanel.models' | transloco"
        [id]="uid + '-list'"
        data-testid="picker-list"
      >
        @if (error(); as message) {
          <p class="empty text-error">{{ message }}</p>
        }
        @for (section of sections(); track section.key) {
          <div class="grp" role="presentation" data-testid="picker-section" [attr.data-section]="section.key">
            @if (section.kind === 'pinned') {
              <span class="tile pinned" aria-hidden="true">
                <pk-icon name="pushpin" size="11" />
              </span>
              <span class="nm">{{ 'chat.modelPanel.pinned' | transloco }}</span>
              <span class="hint"
                >{{ pinnedHint()
                }}<span class="plan"> {{ 'chat.modelPanel.thePinOnARowAddsOr' | transloco }}</span></span
              >
              <span class="usage" data-testid="picker-pinned-count">{{
                'chat.modelPanel.of' | transloco: { value1: pinnedCount(), value2: models().length }
              }}</span>
            } @else {
              <span class="tile" aria-hidden="true">{{
                section.provider?.kind === 'local' ? '⌂' : letters(section.title)
              }}</span>
              <span class="nm">{{ section.title }}</span>
              @if (section.provider; as provider) {
                @if (chip(provider.kind); as label) {
                  <span class="chip" [class.ok]="provider.kind !== 'other'">{{ label }}</span>
                }
                @if (provider.kind === 'local') {
                  <span class="usage">{{ provider.address }}</span>
                } @else if (usageOf(provider.id); as use) {
                  <!-- TODO: move this title onto the pkTip tooltip directive. -->
                  <span class="usage" data-testid="picker-usage" [title]="usageTip(use)">
                    @if (bar(use); as b) {
                      <span class="bar" aria-hidden="true"><i [class.warn]="b.warn" [style.width.%]="b.used"></i></span>
                    }
                    @for (part of usageParts(use); track $index) {
                      <span class="w">{{ part }}</span>
                    }
                  </span>
                }
              }
            }
          </div>
          @if (section.kind === 'pinned' && section.models.length === 0) {
            <p class="empty" data-testid="picker-pinned-empty">
              {{ 'chat.modelPanel.nothingIsPinnedSoMCyclesAll' | transloco: { value1: models().length } }}
            </p>
          }
          @for (model of section.models; track model.provider + model.id) {
            <div
              class="opt"
              role="option"
              data-testid="picker-row"
              [id]="rowId(model)"
              [attr.data-model]="model.provider + '/' + model.id"
              [attr.aria-selected]="isCurrent(model)"
              [class.active]="activeKey() === key(model)"
              tabindex="-1"
              (click)="pick.emit(model)"
              (keydown.enter)="pick.emit(model)"
              (mouseenter)="cursor.set(key(model))"
            >
              <div class="main">
                <span class="id">{{ model.id }}</span>
                <span class="sub">{{ sub(model, section) }}</span>
              </div>
              <div class="badges">
                @if (model.default) {
                  <span class="chip on">{{ 'chat.modelPanel.default' | transloco }}</span>
                }
                @if (model.virtual) {
                  <span class="chip">{{ 'chat.modelPanel.virtual' | transloco }}</span>
                }
                @if (model.reasoning) {
                  <span class="chip">{{ 'chat.modelPanel.thinks' | transloco }}</span>
                }
              </div>
              <!-- TODO: move this title onto the pkTip tooltip directive. -->
              <button
                type="button"
                class="pin"
                data-testid="picker-pin"
                tabindex="-1"
                [class.on]="isPinned(model)"
                [attr.aria-pressed]="isPinned(model)"
                [attr.aria-label]="
                  (isPinned(model) ? ('chat.modelPanel.unpin' | transloco) : ('chat.modelPanel.pin' | transloco)) +
                  model.id
                "
                [title]="
                  isPinned(model)
                    ? ('chat.modelPanel.unpin' | transloco) + model.id
                    : ('chat.modelPanel.pin' | transloco) +
                      model.id +
                      ('chat.modelPanel.mCyclesPinnedModels' | transloco)
                "
                (click)="$event.stopPropagation(); togglePin.emit(model); focusSearch()"
              >
                <pk-icon name="pushpin" />
              </button>
            </div>
          }
        }
        @if (models().length === 0 && !error()) {
          <p class="empty">{{ 'chat.modelPanel.loadingModels' | transloco }}</p>
        } @else if (models().length > 0 && rows().length === 0 && query() !== '') {
          <p class="empty">{{ 'chat.modelPanel.noModelMatches' | transloco }}</p>
        }
      </div>

      <div class="find">
        <pk-icon name="search" class="muted" size="14" />
        <input
          #search
          type="search"
          class="input input-sm"
          role="combobox"
          [attr.aria-label]="'chat.modelPanel.searchModels' | transloco"
          aria-expanded="true"
          [attr.aria-controls]="uid + '-list'"
          [attr.aria-activedescendant]="activeId()"
          [placeholder]="'chat.modelPanel.searchModelsEGSonnetOrFlash' | transloco"
          autocomplete="off"
          spellcheck="false"
          data-testid="picker-search"
          [value]="query()"
          (input)="onQuery(search.value)"
          (keydown)="onKey($event)"
        />
        <span class="n" data-testid="picker-count"
          >{{ rows().length }}
          {{
            rows().length === 1 ? ('chat.modelPanel.model' | transloco) : ('chat.modelPanel.models5ba26' | transloco)
          }}</span
        >
        <kbd [title]="'chat.modelPanel.moveThroughTheModels' | transloco">↑↓</kbd
        ><kbd [title]="'chat.modelPanel.useTheModelPinsOrUnpinsIt' | transloco">⏎</kbd>
      </div>
      <div class="foot">
        <span
          >{{
            running()
              ? ('chat.modelPanel.aChangeAppliesToTheNextRequest' | transloco)
              : ('chat.modelPanel.appliesToTheNextMessage' | transloco)
          }}
          <b>{{ 'chat.modelPanel.pin9c918' | transloco }}</b>
          {{ 'chat.modelPanel.aModelToKeepItHere' | transloco }}</span
        >
        <button type="button" class="link link-hover" data-testid="picker-manage" (click)="manage.emit()">
          {{ 'chat.modelPanel.modelsAndEffort' | transloco }}
        </button>
      </div>
    </div>
  `,
})
export class ModelPanel {
  protected readonly i18n = inject(Language);
  /** Every model that can be chosen. */
  readonly models = input<readonly ModelInfo[]>([]);
  /** How each provider is signed in, in the order of the sections. */
  readonly providers = input<readonly ModelProvider[]>([]);
  /** The pinned models in ⌘⇧M order. */
  readonly pinned = input<readonly ModelRef[]>([]);
  /** The model the thread uses now. */
  readonly current = input<{ provider: string; id: string } | null>(null);
  /** What the providers say about their usage, by provider id; `null` or absent shows nothing. */
  readonly usage = input<Readonly<Record<string, ProviderUsage | null>>>({});
  readonly error = input<string | undefined>(undefined);
  readonly running = input(false);
  readonly placement = input<'up' | 'down'>('up');
  readonly pick = output<ModelInfo>();
  readonly togglePin = output<ModelInfo>();
  readonly manage = output<void>();
  /** Escape was pressed. */
  readonly dismiss = output<void>();

  protected readonly uid = `pk-picker-${++panelCount}`;
  protected readonly query = signal('');
  protected readonly cursor = signal<string | undefined>(undefined);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly sections = computed<PickerSection[]>(() =>
    pickerSections(this.i18n.t, {
      models: this.models(),
      providers: this.providers(),
      pinned: this.pinned(),
      query: this.query(),
    }),
  );
  protected readonly rows = computed(() => visibleModels(this.sections()));
  protected readonly pinnedKeys = computed(() => new Set(this.pinned().map((p) => modelKey(p))));
  protected readonly pinnedCount = computed(
    () => this.models().filter((m) => this.pinnedKeys().has(modelKey(m))).length,
  );
  /** The row ↑↓ and ⏎ act on: the one the cursor is on, else the first match while searching, else the current model. */
  protected readonly activeKey = computed(() => {
    const rows = this.rows();
    const at = this.cursor();
    if (at && rows.some((m) => modelKey(m) === at)) return at;
    if (this.query().trim() === '') {
      const current = this.current();
      const hit = current ? rows.find((m) => m.provider === current.provider && m.id === current.id) : undefined;
      if (hit) return modelKey(hit);
    }
    return rows[0] ? modelKey(rows[0]) : undefined;
  });
  protected readonly activeId = computed(() => {
    const key = this.activeKey();
    const model = key ? this.rows().find((m) => modelKey(m) === key) : undefined;
    return model ? this.rowId(model) : null;
  });
  protected readonly pinnedHint = computed(() =>
    this.pinnedCount() === 0
      ? this.i18n.t('chat.modelPanel.mCyclesEveryModel')
      : this.i18n.t('chat.modelPanel.mCyclesThese'),
  );

  protected readonly key = modelKey;
  protected readonly letters = tileLetters;
  protected readonly chip = stateChip.bind(undefined, this.i18n.t);
  protected readonly usageParts = providerUsageParts.bind(undefined, this.i18n.t);
  protected readonly bar = providerUsageBar;
  protected readonly usageTip = (use: ProviderUsage): string => providerUsageTip(this.i18n.t, use);

  constructor() {
    afterNextRender(() => {
      const root = this.host.nativeElement;
      const panel = root.querySelector<HTMLElement>('.pk-picker');
      if (panel) {
        // A picker that opens near the edge of a narrow window, or of the chat column beside a side panel (the column clips what leaves it), slides
        // back inside it (the pop animation keeps `transform`, this uses `translate`).
        const box = panel.getBoundingClientRect();
        const clip = root.closest<HTMLElement>('.pk-chat')?.getBoundingClientRect();
        const right = Math.min(window.innerWidth, clip?.right ?? Infinity);
        const left = Math.max(0, clip?.left ?? 0);
        const over = box.right - (right - 8);
        const under = left + 8 - box.left;
        const shift = over > 0 ? -Math.min(over, Math.max(0, box.left - (left + 8))) : under > 0 ? under : 0;
        if (shift !== 0) panel.style.setProperty('--shift', `${shift}px`);
      }
      root.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    });
    // The highlighted row stays in view while ↑↓ walk a long list.
    effect(() => {
      const id = this.activeId();
      if (!id) return;
      untracked(() =>
        queueMicrotask(() =>
          this.host.nativeElement.querySelector<HTMLElement>(`[id="${id}"]`)?.scrollIntoView?.({ block: 'nearest' }),
        ),
      );
    });
  }

  protected rowId(model: ModelInfo): string {
    return `${this.uid}-${modelKey(model)}`;
  }

  protected isCurrent(model: ModelInfo): boolean {
    const current = this.current();
    return current?.provider === model.provider && current.id === model.id;
  }

  protected isPinned(model: ModelInfo): boolean {
    return this.pinnedKeys().has(modelKey(model));
  }

  protected usageOf(provider: string): ProviderUsage | null {
    return this.usage()[provider] ?? null;
  }

  /** "Anthropic · 1M context · subscription" under a pinned row (its section does not say the provider), "1M context · subscription" under a provider. */
  protected sub(model: ModelInfo, section: PickerSection): string {
    const provider = this.providers().find((p) => p.id === model.provider);
    const price = provider?.kind === 'subscription' ? 'subscription' : priceLabel(this.i18n.t, model);
    return [
      ...(section.kind === 'pinned' ? [providerFamily(provider ?? { id: model.provider }).name] : []),
      ...(section.provider?.id === 'llama.cpp' && model.provider !== 'llama.cpp' && model.provider !== 'llama-swap'
        ? [model.provider]
        : []),
      this.i18n.t('chat.modelPanel.context', { value1: compactNumber(model.contextWindow) }),
      price,
    ].join(' · ');
  }

  /** A pin moves a row to another section, which replaces its element and drops the focus; the field gets it back so typing and Escape keep working. */
  protected focusSearch(): void {
    this.host.nativeElement.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  }

  protected onQuery(value: string): void {
    this.query.set(value);
    this.cursor.set(undefined);
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const rows = this.rows();
      if (rows.length === 0) return;
      const at = rows.findIndex((m) => modelKey(m) === this.activeKey());
      const next = (at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      this.cursor.set(modelKey(rows[next]));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const key = this.activeKey();
      const model = key ? this.rows().find((m) => modelKey(m) === key) : undefined;
      // ⇧⏎ is the keyboard's pin: the same toggle the pin on the row does, without leaving the field.
      if (model) (event.shiftKey ? this.togglePin : this.pick).emit(model);
    }
  }

  protected onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.dismiss.emit();
  }
}
