import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
import { NgTemplateOutlet } from '@angular/common';
import { CdkConnectedOverlay, CdkOverlayOrigin, type ConnectedPosition } from '@angular/cdk/overlay';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ChatStore } from '@pi-kit/chat/data';
import { FlaskIcon, ModelPanel } from '@pi-kit/chat/ui';
import { EffortPanel } from '@pi-kit/chat/ui/effort';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import { effortTip } from '@pi-kit/chat/util';
import { ProviderUsageStore, UiStore } from '@pi-kit/data-access';
import type { ModelInfo } from '@pi-kit/protocol';

/** Independent model and effort popovers; slider stops come from the active model. */
@Component({
  selector: 'pk-model-picker',
  imports: [
    FlaskIcon,
    EffortPanel,
    ModelPanel,
    NgTemplateOutlet,
    CdkConnectedOverlay,
    CdkOverlayOrigin,
    PkTip,
    TranslocoPipe,
    PkIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'placement() === "composer" ? "contents" : "relative block"',
    '(document:click)': 'onDocumentClick($event)',
    '(keydown.escape)': 'onEscape($event)',
    '(window:focus)': 'refreshUsage()',
  },
  template: `
    @if (placement() === 'composer') {
      <div class="pk-chip">
        <button
          type="button"
          class="btn btn-ghost btn-sm gap-2"
          aria-haspopup="dialog"
          [attr.aria-expanded]="open()"
          [attr.aria-label]="'chat.modelPicker.model' | transloco"
          [title]="'chat.modelPicker.modelMSwitchesToTheNextPinned' | transloco"
          data-testid="model-chip"
          (click)="toggle()"
        >
          <span class="dot" aria-hidden="true"></span>
          <span class="v mono">{{ session.model()?.id ?? ('chat.modelPicker.noModel' | transloco) }}</span>
          <pk-icon name="chevron-down" class="chev" />
        </button>
        @if (open()) {
          <ng-container *ngTemplateOutlet="panel" />
        }
      </div>
      <ng-container *ngTemplateOutlet="effortControl" />
    } @else if (session.stats(); as stats) {
      <button
        type="button"
        class="btn btn-sm gap-2"
        [class.btn-ghost]="!open()"
        [class.btn-active]="open()"
        aria-haspopup="dialog"
        [attr.aria-expanded]="open()"
        [title]="'chat.modelPicker.modelForTheNextMessage' | transloco"
        data-testid="header-model"
        (click)="toggle()"
      >
        <span class="w-2 h-2 rounded-full bg-primary"></span>
        <span class="mono truncate">{{ stats.model?.id ?? ('chat.modelPicker.noModel' | transloco) }}</span>
      </button>
      <ng-container *ngTemplateOutlet="effortControl" />
      @if (open()) {
        <ng-container *ngTemplateOutlet="panel" />
      }
    }
    <ng-template #effortControl>
      <button
        #effortTrigger
        cdkOverlayOrigin
        #origin="cdkOverlayOrigin"
        type="button"
        class="pk-chip effort-control"
        [pkTip]="effortTitle()"
        [attr.aria-label]="
          ('chat.modelPicker.thinkingEffort' | transloco) + ('common.effortValue.' + selectedEffort() | transloco)
        "
        aria-haspopup="dialog"
        [attr.aria-expanded]="effortOpen()"
        [attr.data-testid]="placement() + '-effort-control'"
        (click)="toggleEffort()"
      >
        <pk-flask [level]="selectedEffort()" />
        <span class="effort-value">{{ 'common.effortValue.' + selectedEffort() | transloco }}</span>
        <pk-icon name="chevron-down" size="12" />
      </button>
      <ng-template
        cdkConnectedOverlay
        [cdkConnectedOverlayOrigin]="origin"
        [cdkConnectedOverlayOpen]="effortOpen()"
        [cdkConnectedOverlayPositions]="effortPositions()"
        [cdkConnectedOverlayViewportMargin]="8"
        [cdkConnectedOverlayPush]="true"
        [cdkConnectedOverlayHasBackdrop]="true"
        [cdkConnectedOverlayDisableClose]="true"
        cdkConnectedOverlayBackdropClass="cdk-overlay-transparent-backdrop"
        (backdropClick)="closeEffort(false)"
        (overlayKeydown)="onEffortKey($event)"
        (detach)="closeEffort(false)"
      >
        @defer (on immediate) {
          <pk-effort-panel
            [levels]="session.levels()"
            [level]="selectedEffort()"
            [adjustable]="effortAdjustable()"
            [unavailable]="effortTitle()"
            [testId]="placement() + '-effort-slider'"
            (preview)="previewEffort($event)"
            (commit)="commitEffort()"
            (dismiss)="closeEffort()"
          />
        }
      </ng-template>
    </ng-template>
    <ng-template #panel>
      <pk-model-panel
        [models]="models()"
        [providers]="session.modelProviders()"
        [pinned]="session.pinned()"
        [current]="session.model()"
        [usage]="usageStore.usage()"
        [error]="session.modelError()"
        [running]="session.running()"
        [placement]="placement() === 'composer' ? 'up' : 'down'"
        (pick)="choose($event)"
        (togglePin)="session.togglePinnedModel($event)"
        (manage)="manage()"
        (dismiss)="close()"
      />
    </ng-template>
  `,
  styles: `
    :host {
      align-items: center;
      gap: 8px;
    }
    :host(.relative) {
      display: flex;
      min-width: 0;
    }
    [data-testid='header-model'] {
      min-width: 0;
      flex-shrink: 1;
    }
    .effort-control {
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0 9px;
      min-height: 32px;
      border: 1px solid transparent;
      color: var(--pk-muted);
      font-size: 12px;
      border-radius: var(--radius-selector);
      background: var(--color-base-200);
      cursor: pointer;
    }
    .effort-control:hover,
    .effort-control[aria-expanded='true'] {
      border-color: var(--color-base-300);
      color: var(--color-base-content);
    }
    .effort-value {
      color: var(--color-base-content);
      text-transform: capitalize;
    }
  `,
})
export class ModelPicker {
  protected readonly i18n = inject(Language);
  readonly usageRefreshMs = input(60_000);
  readonly placement = input<'composer' | 'header'>('composer');

  protected readonly session = inject(ChatStore);
  protected readonly usageStore = inject(ProviderUsageStore);
  private readonly bus = inject(UiStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly zone = inject(NgZone);

  protected readonly open = signal(false);
  private readonly effortTrigger = viewChild<ElementRef<HTMLButtonElement>>('effortTrigger');
  private readonly effortOwner = computed(
    () => `${this.session.threadId()}/${this.session.model()?.provider}/${this.session.model()?.id}`,
  );
  protected readonly effortOpen = linkedSignal({ source: this.effortOwner, computation: () => false });
  protected readonly effortPositions = computed<ConnectedPosition[]>(() => {
    const above: ConnectedPosition = {
      originX: 'end',
      originY: 'top',
      overlayX: 'end',
      overlayY: 'bottom',
      offsetY: -8,
    };
    const below: ConnectedPosition = {
      originX: 'end',
      originY: 'bottom',
      overlayX: 'end',
      overlayY: 'top',
      offsetY: 8,
    };
    return this.placement() === 'composer' ? [above, below] : [below, above];
  });
  // Equivalent stats/list refreshes do not reset an in-progress drag. A different thread, model, capability set or confirmed effort does.
  private readonly effortContext = computed(
    () =>
      `${this.session.threadId()}/${this.session.model()?.provider}/${this.session.model()?.id}:${this.session.levels().join(',')}:${this.session.effort()}`,
  );
  protected readonly selectedEffort = linkedSignal({
    source: this.effortContext,
    computation: () => this.session.effort(),
  });
  protected readonly effortAdjustable = computed(
    () => !!this.session.threadId() && !!this.session.modelInfo() && this.session.levels().length > 1,
  );
  protected readonly effortTitle = computed(() =>
    this.effortAdjustable()
      ? effortTip(this.i18n.t, this.selectedEffort())
      : `${this.session.model()?.id ?? this.i18n.t('chat.modelPicker.thisModel')} ${this.session.canThink() ? this.i18n.t('chat.modelPicker.hasNoAdjustableEffortLevels') : this.i18n.t('chat.modelPicker.doesNotThink')}`,
  );
  private effortChange = 0;
  private effortDraft = false;
  protected readonly models = computed(() => this.session.modelList()?.models ?? []);
  /** The providers worth asking for usage: a local server has an address, not a quota. */
  private readonly usageIds = computed(() =>
    this.session
      .modelProviders()
      .filter((p) => p.kind !== 'local')
      .map((p) => p.id),
  );

  constructor() {
    // Commands open the corresponding popover; requests from before this picker mounted are old news.
    let seen = this.bus.chipMenu()?.n ?? 0;
    effect(() => {
      const request = this.bus.chipMenu();
      if (!request || request.n <= seen) return;
      seen = request.n;
      if (untracked(() => this.placement()) !== 'composer') return;
      untracked(() => {
        if (request.menu === 'model') this.show();
        else this.showEffort();
      });
    });
    // While it is open the usage of the providers is asked for (the store does not ask twice inside half a minute) and then once a minute.
    effect((onCleanup) => {
      if (!this.open()) return;
      const ids = this.usageIds();
      untracked(() => void this.usageStore.refresh(ids));
      const interval = this.usageRefreshMs();
      const timer = this.zone.runOutsideAngular(() =>
        setInterval(() => void this.usageStore.refresh(ids, true), interval),
      );
      onCleanup(() => clearInterval(timer));
    });
  }

  protected toggle(): void {
    if (this.open()) this.close();
    else this.show();
  }

  protected async choose(model: ModelInfo): Promise<void> {
    this.close();
    await this.session.chooseModel(model);
  }

  protected previewEffort(index: number): void {
    const level = this.session.levels()[index];
    if (!this.effortAdjustable() || !level) return;
    this.effortChange++;
    this.effortDraft = true;
    this.selectedEffort.set(level);
  }

  protected async commitEffort(): Promise<void> {
    const level = this.selectedEffort();
    if (!this.effortAdjustable() || !this.session.levels().includes(level)) return;
    this.effortDraft = false;
    const version = ++this.effortChange;
    const context = this.effortContext();
    const saved = await this.session.setEffort(level);
    if (!saved && version === this.effortChange && context === this.effortContext())
      this.selectedEffort.set(this.session.effort());
  }

  protected toggleEffort(): void {
    if (this.effortOpen()) this.closeEffort();
    else this.showEffort();
  }

  protected closeEffort(restoreFocus = true): void {
    this.effortOpen.set(false);
    if (this.effortDraft) this.selectedEffort.set(this.session.effort());
    this.effortDraft = false;
    if (restoreFocus) queueMicrotask(() => this.effortTrigger()?.nativeElement.focus());
  }

  protected onEffortKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.closeEffort();
  }

  private showEffort(): void {
    if (!this.session.threadId()) return;
    this.open.set(false);
    this.effortOpen.set(true);
    void this.session.loadModels();
  }

  protected manage(): void {
    this.open.set(false);
    this.bus.openSettings('models');
  }

  protected close(): void {
    if (!this.open()) return;
    this.open.set(false);
    this.bus.focusComposer();
  }

  protected refreshUsage(): void {
    if (this.open()) void this.usageStore.refresh(this.usageIds(), true);
  }

  protected onDocumentClick(event: Event): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.open.set(false);
  }

  protected onEscape(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    this.close();
  }

  private show(): void {
    if (!this.session.threadId()) return;
    this.closeEffort(false);
    this.open.set(true);
    void this.session.loadModels();
  }
}
