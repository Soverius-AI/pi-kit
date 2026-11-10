import { CdkConnectedOverlay, CdkOverlayOrigin, type ConnectedPosition } from '@angular/cdk/overlay';
import {
  afterRenderEffect,
  Component,
  computed,
  ElementRef,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { ThreadProtectionStore } from '@pi-kit/chat/data';
import { DialogStore } from '@pi-kit/data-access';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import {
  PkCommandMenu,
  PkIcon,
  PkProtectionBadge,
  PkSafeOverlay,
  PkTip,
  type PkMenuGroup,
} from '@pi-kit/design-system';
import type { ThreadProtectionMode } from '@pi-kit/protocol';
import { ThreadProtectionDialog, type ThreadProtectionDialogInputs } from './thread-protection-dialog';

@Component({
  selector: 'pk-thread-protection-picker',
  imports: [
    TranslocoPipe,
    CdkConnectedOverlay,
    CdkOverlayOrigin,
    PkCommandMenu,
    PkSafeOverlay,
    PkIcon,
    PkProtectionBadge,
    PkTip,
  ],
  host: { class: 'inline-flex shrink-0 items-center' },
  template: `
    @if (!store.remote) {
      <div class="pk-chip" [pkTip]="label()">
        <button
          #trigger
          cdkOverlayOrigin
          #origin="cdkOverlayOrigin"
          type="button"
          class="btn btn-ghost btn-sm"
          data-testid="protection-chip"
          [disabled]="!store.canOpen()"
          aria-haspopup="dialog"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="open() ? menuId : null"
          [attr.aria-label]="label()"
          (click)="toggle()"
          (keydown)="onTriggerKey($event)"
        >
          <pk-protection-badge
            [mode]="store.mode()"
            [attention]="attention()"
            [busy]="store.loading() || store.pending()"
          />
        </button>
      </div>
      <ng-template
        cdkConnectedOverlay
        [cdkConnectedOverlayOrigin]="origin"
        [cdkConnectedOverlayOpen]="open()"
        [cdkConnectedOverlayPositions]="positions"
        [cdkConnectedOverlayViewportMargin]="12"
        [cdkConnectedOverlayPush]="true"
        [cdkConnectedOverlayHasBackdrop]="true"
        [cdkConnectedOverlayDisableClose]="true"
        cdkConnectedOverlayBackdropClass="cdk-overlay-transparent-backdrop"
        (backdropClick)="close()"
        (detach)="close(false)"
      >
        <div
          pkSafeOverlay
          class="pk-menu static! w-80! max-w-[calc(100vw-1.5rem)]"
          role="dialog"
          [id]="menuId"
          [attr.aria-label]="'chat.threadProtection.label' | transloco"
          (keydown.escape)="dismiss($event)"
          (focusout)="onFocusOut($event)"
        >
          <div class="head">
            <span>{{ 'chat.threadProtection.label' | transloco }}</span>
          </div>
          <pk-command-menu
            #menu
            class="pt-1"
            tabindex="0"
            [inline]="true"
            [groups]="groups()"
            [selectedId]="selected()"
            [idPrefix]="optionPrefix"
            [label]="'chat.threadProtection.label' | transloco"
            [attr.aria-activedescendant]="optionPrefix + selected()"
            (pick)="choose($event.id)"
            (hover)="hover($event.id)"
            (keydown)="onMenuKey($event)"
          />
          <div class="space-y-2 border-t border-base-300 px-3 py-3">
            <div class="flex items-center gap-2 text-xs font-medium" [class.text-warning]="attention()">
              @if (attention()) {
                <pk-icon name="alert-circle" size="14" />
              }
              <span>{{ status() }}</span>
            </div>
            @if (detail(); as detail) {
              <p
                class="m-0 max-h-32 overflow-y-auto text-xs leading-relaxed muted mono wrap-anywhere"
                data-testid="protection-detail"
                [attr.role]="store.error() ? 'alert' : null"
              >
                {{ detail }}
              </p>
            }
            @if (coverage(); as coverage) {
              <p class="m-0 text-xs leading-relaxed muted" data-testid="protection-coverage">{{ coverage }}</p>
            }
            @if (refreshable()) {
              <div class="flex flex-wrap gap-2">
                @if (store.protection()?.state === 'setup-required') {
                  <button
                    type="button"
                    class="btn btn-primary btn-xs gap-1.5"
                    data-testid="protection-setup"
                    [disabled]="!store.canChange()"
                    (click)="setup()"
                  >
                    <pk-icon name="lock" size="12" />
                    {{ 'chat.threadProtection.setup' | transloco }}
                  </button>
                }
                <button
                  type="button"
                  class="btn btn-ghost btn-xs gap-1.5"
                  data-testid="protection-refresh"
                  [disabled]="store.loading() || store.pending()"
                  (click)="refresh()"
                  (keydown)="onRefreshKey($event)"
                >
                  <pk-icon name="refresh" size="12" />
                  {{ 'chat.threadProtection.refresh' | transloco }}
                </button>
              </div>
            }
          </div>
        </div>
      </ng-template>
    } @else {
      <pk-protection-badge
        class="p-2"
        [mode]="store.mode()"
        [attention]="attention()"
        [label]="label()"
        [pkTip]="label()"
      />
    }
    <span class="sr-only" role="status">{{ status() }}</span>
  `,
})
export class ThreadProtectionPicker {
  protected readonly store = inject(ThreadProtectionStore);
  private readonly dialogs = inject(DialogStore);
  private readonly language = inject(Language);
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly menu = viewChild('menu', { read: ElementRef<HTMLElement> });
  private readonly menuContext = computed(() => (this.store.canOpen() ? this.store.threadId() : undefined));
  private readonly modes = ['bypass', 'sandboxed'] as const;
  protected readonly open = linkedSignal({ source: this.menuContext, computation: () => false });
  protected readonly selected = signal<ThreadProtectionMode>('bypass');
  protected readonly menuId = 'pk-thread-protection-menu';
  protected readonly optionPrefix = 'pk-thread-protection-option-';
  protected readonly positions: ConnectedPosition[] = [
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -8 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 8 },
  ];
  protected readonly attention = computed(
    () =>
      !!this.store.error() ||
      ['unavailable', 'setup-required', 'recovery-required', 'experimental'].includes(
        this.store.protection()?.state ?? '',
      ),
  );
  protected readonly refreshable = computed(() => this.attention() || this.store.protection()?.state === 'starting');
  protected readonly status = computed(() => {
    const protection = this.store.protection();
    const key = this.store.loading()
      ? 'loading'
      : (this.store.pendingStatus() ?? (this.store.error() || !protection ? 'unknown' : 'status.' + protection.state));
    return this.language.t('chat.threadProtection.' + key);
  });
  protected readonly label = computed(
    () =>
      `${this.language.t('chat.threadProtection.label')}: ${this.language.t('chat.threadProtection.' + this.store.mode())} · ${this.status()}`,
  );
  protected readonly detail = computed(() => this.store.error() ?? this.store.protection()?.reason);
  protected readonly coverage = computed(() => {
    const protection = this.store.protection();
    if (!protection) return undefined;
    const scope =
      protection.mode === 'bypass' ? 'bypass' : protection.platform === 'win32' ? 'sandboxedWindows' : 'sandboxed';
    return this.language.t('chat.threadProtection.coverage.' + scope);
  });
  protected readonly groups = computed<PkMenuGroup[]>(() => [
    {
      title: '',
      items: this.modes.map((mode) => ({
        id: mode,
        name: this.language.t('chat.threadProtection.' + mode),
        description: this.language.t('chat.threadProtection.' + mode + 'Description'),
        badge: mode === this.store.mode() ? this.language.t('chat.threadProtection.current') : undefined,
        disabled: !this.store.canChange(),
      })),
    },
  ]);

  constructor() {
    afterRenderEffect(() => this.menu()?.nativeElement.focus());
  }

  protected toggle(): void {
    if (this.open()) return this.close();
    this.selected.set(this.store.mode());
    this.open.set(true);
  }

  protected close(restoreFocus = true): void {
    this.open.set(false);
    if (restoreFocus) this.trigger()?.nativeElement.focus();
  }

  protected dismiss(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.close();
  }

  protected onFocusOut(event: FocusEvent): void {
    if (event.relatedTarget instanceof Node && !(event.currentTarget as HTMLElement).contains(event.relatedTarget))
      this.close(false);
  }

  protected refresh(): void {
    this.menu()?.nativeElement.focus();
    this.store.retry();
  }

  protected onRefreshKey(event: KeyboardEvent): void {
    if (event.key === 'Tab' && !event.shiftKey) this.close();
  }

  protected hover(id: string): void {
    const mode = this.modes.find((m) => m === id);
    if (mode) this.selected.set(mode);
  }

  protected onTriggerKey(event: KeyboardEvent): void {
    if (!this.store.canOpen() || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    this.selected.set(event.key === 'ArrowUp' || event.key === 'End' ? 'sandboxed' : 'bypass');
    this.open.set(true);
  }

  protected onMenuKey(event: KeyboardEvent): void {
    if (!this.open()) return;
    if (event.key === 'Tab') {
      if (!event.shiftKey && this.refreshable()) return;
      this.close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    switch (event.key) {
      case 'Escape':
        this.close();
        break;
      case 'Home':
        this.selected.set('bypass');
        break;
      case 'End':
        this.selected.set('sandboxed');
        break;
      case 'ArrowDown':
      case 'ArrowUp':
        this.selected.update((mode) => (mode === 'bypass' ? 'sandboxed' : 'bypass'));
        break;
      default:
        this.choose(this.selected());
    }
  }

  protected choose(id: string): void {
    const mode = this.modes.find((m) => m === id);
    const protection = this.store.protection();
    if (!this.open() || !this.store.canChange() || !mode || !protection) return;
    this.close();
    const recovery = protection.state === 'recovery-required';
    if (mode === protection.mode && !recovery) return;
    const windows = mode === 'sandboxed' && protection.platform === 'win32' && !protection.experimentalWindowsAccepted;
    const threadId = this.store.threadId();
    this.ask({
      title: 'confirmTitle',
      confirmLabel: 'confirm',
      warnings: [
        ...(recovery ? (['recoveryWarning'] as const) : []),
        mode === 'sandboxed' ? 'enableWarning' : 'bypassWarning',
      ],
      consents: [
        ...(recovery ? (['recoveryConsent'] as const) : []),
        ...(windows ? (['windowsConsent'] as const) : []),
      ],
      apply: () =>
        void this.store.change(
          {
            mode,
            ...(mode === 'bypass' ? { confirmBypass: true } : {}),
            ...(windows ? { experimentalWindowsAccepted: true } : {}),
            ...(recovery ? { confirmRecovery: true } : {}),
          },
          threadId,
        ),
    });
  }

  protected setup(): void {
    const threadId = this.store.threadId();
    this.close();
    this.ask({
      title: 'setupTitle',
      confirmLabel: 'setupConfirm',
      warnings: ['setupWarning'],
      consents: ['setupConsent'],
      apply: () => void this.store.setupWindows(threadId),
    });
  }

  private ask(inputs: ThreadProtectionDialogInputs): void {
    this.dialogs.show({ kind: 'component', component: ThreadProtectionDialog, inputs });
  }
}
