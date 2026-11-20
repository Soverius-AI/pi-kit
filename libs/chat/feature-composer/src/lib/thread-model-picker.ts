import { CdkConnectedOverlay, CdkOverlayOrigin, type ConnectedPosition } from '@angular/cdk/overlay';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { EntryApiClient, sessionModels, sessionSetModel, unwrap } from '@pi-kit/api';
import { ModelPanel } from '@pi-kit/chat/ui';
import { EffortPanel } from '@pi-kit/chat/ui/effort';
import { PkIcon, PkSafeOverlay } from '@pi-kit/design-system';
import { TranslocoPipe } from '@pi-kit/i18n';
import type { ModelInfo, ModelList, ThinkingLevel } from '@pi-kit/protocol';

@Component({
  selector: 'pk-thread-model-picker',
  imports: [CdkConnectedOverlay, CdkOverlayOrigin, EffortPanel, ModelPanel, PkIcon, PkSafeOverlay, TranslocoPipe],
  host: { class: 'contents' },
  template: `
    <div class="pk-chip">
      <button
        type="button"
        class="btn btn-ghost btn-sm gap-2"
        cdkOverlayOrigin
        #modelOrigin="cdkOverlayOrigin"
        aria-haspopup="dialog"
        data-testid="thread-model-chip"
        [attr.aria-expanded]="open() === 'model'"
        [attr.aria-label]="'chat.modelPicker.model' | transloco"
        [disabled]="!list()"
        (click)="toggle('model')"
      >
        <span class="dot" aria-hidden="true"></span>
        <span class="v mono">{{ list()?.current?.id ?? ('chat.modelPicker.noModel' | transloco) }}</span>
        <pk-icon name="chevron-down" class="chev" />
      </button>
    </div>
    @if (levels().length > 1) {
      <div class="pk-chip">
        <button
          type="button"
          class="btn btn-ghost btn-sm gap-2"
          cdkOverlayOrigin
          #effortOrigin="cdkOverlayOrigin"
          aria-haspopup="dialog"
          data-testid="thread-effort-chip"
          [attr.aria-expanded]="open() === 'effort'"
          [attr.aria-label]="
            ('chat.modelPicker.thinkingEffort' | transloco) + ('common.effortValue.' + level() | transloco)
          "
          (click)="toggle('effort')"
        >
          <span class="v">{{ 'common.effortValue.' + level() | transloco }}</span>
          <pk-icon name="chevron-down" class="chev" />
        </button>
      </div>
      <ng-template
        cdkConnectedOverlay
        [cdkConnectedOverlayOrigin]="effortOrigin"
        [cdkConnectedOverlayOpen]="open() === 'effort'"
        [cdkConnectedOverlayPositions]="positions"
        [cdkConnectedOverlayViewportMargin]="16"
        [cdkConnectedOverlayPush]="true"
        [cdkConnectedOverlayHasBackdrop]="true"
        cdkConnectedOverlayBackdropClass="cdk-overlay-transparent-backdrop"
        (backdropClick)="open.set(null)"
        (detach)="open.set(null)"
      >
        <div pkSafeOverlay>
          <pk-effort-panel
            testId="thread-effort-slider"
            [levels]="levels()"
            [level]="pendingLevel() ?? level()"
            (preview)="pendingLevel.set(levels()[$event] ?? null)"
            (commit)="commitEffort()"
            (dismiss)="open.set(null)"
          />
        </div>
      </ng-template>
    }
    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOrigin]="modelOrigin"
      [cdkConnectedOverlayOpen]="open() === 'model'"
      [cdkConnectedOverlayPositions]="positions"
      [cdkConnectedOverlayViewportMargin]="16"
      [cdkConnectedOverlayPush]="true"
      [cdkConnectedOverlayHasBackdrop]="true"
      cdkConnectedOverlayPanelClass="pk-model-overlay"
      cdkConnectedOverlayBackdropClass="cdk-overlay-transparent-backdrop"
      (backdropClick)="open.set(null)"
      (detach)="open.set(null)"
    >
      <div pkSafeOverlay>
        <pk-model-panel
          placement="up"
          [models]="list()?.models ?? []"
          [providers]="list()?.providers ?? []"
          [pinned]="list()?.pinned ?? []"
          [current]="list()?.current ?? null"
          [error]="error()"
          [running]="busy()"
          (pick)="pick($event)"
          (dismiss)="open.set(null)"
        />
      </div>
    </ng-template>
  `,
})
export class ThreadModelPicker {
  private readonly api = inject(EntryApiClient);

  readonly threadId = input.required<string>();
  readonly ownerId = input.required<string>();

  protected readonly list = signal<ModelList | undefined>(undefined);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly busy = signal(false);
  protected readonly open = signal<'model' | 'effort' | null>(null);
  protected readonly pendingLevel = signal<ThinkingLevel | null>(null);
  protected readonly level = computed<ThinkingLevel>(() => this.list()?.thinkingLevel ?? 'off');
  protected readonly levels = computed<readonly ThinkingLevel[]>(() => {
    const levels = this.list()?.thinkingLevels ?? [];
    return levels.length ? levels : ['off'];
  });
  protected readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -8 },
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 8 },
  ];

  constructor() {
    effect(() => {
      const threadId = this.threadId();
      const ownerId = this.ownerId();
      untracked(() => void this.load(threadId, ownerId));
    });
  }

  protected toggle(which: 'model' | 'effort'): void {
    this.pendingLevel.set(null);
    this.open.update((current) => (current === which ? null : which));
  }

  protected async pick(model: ModelInfo): Promise<void> {
    this.open.set(null);
    await this.change({ provider: model.provider, modelId: model.id });
  }

  protected async commitEffort(): Promise<void> {
    const level = this.pendingLevel();
    this.open.set(null);
    this.pendingLevel.set(null);
    if (level && level !== this.level()) await this.change({ thinkingLevel: level });
  }

  private async load(threadId: string, ownerId: string): Promise<void> {
    try {
      const list = await unwrap(sessionModels({ client: this.api.forOwner(ownerId), query: { thread: threadId } }));
      if (threadId === this.threadId()) {
        this.list.set(list);
        this.error.set(undefined);
      }
    } catch (error) {
      if (threadId === this.threadId()) this.error.set(error instanceof Error ? error.message : String(error));
    }
  }

  private async change(body: { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel }): Promise<void> {
    const threadId = this.threadId();
    const ownerId = this.ownerId();
    this.busy.set(true);
    try {
      await unwrap(sessionSetModel({ client: this.api.forOwner(ownerId), path: { id: threadId }, body }));
      await this.load(threadId, ownerId);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
