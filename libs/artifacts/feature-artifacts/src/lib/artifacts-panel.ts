import { Language } from '@pi-kit/i18n';
import { TranslocoPipe } from '@pi-kit/i18n';
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
import { BrowserStore } from '@pi-kit/artifacts/data';
import { PkIcon } from '@pi-kit/design-system';
import { UiStore } from '@pi-kit/data-access';
import { ThreadsStore } from '@pi-kit/threads/api';
import { BrowserTools } from './browser-tools';

/**
 * The Artifacts panel: the browser the agent shares with the user. It draws the back, forward, reload and address toolbar over a
 * viewport and the `BrowserTools` footer, and in the desktop app places the native browser view over that viewport, moving it as the
 * panel resizes and hiding it while a dialog, the palette or a panel resize is in the way. The page state comes from `BrowserStore`.
 */
@Component({
  selector: 'pk-artifacts-panel',
  providers: [BrowserStore],
  imports: [BrowserTools, PkIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pk-panel',
    '[attr.aria-label]': "i18n.t('artifacts.artifactsPanel.artifacts')",
    '[class.expanded]': 'expanded()',
  },
  template: `
    <div class="pk-bar gap-2">
      <span class="font-medium">{{ 'artifacts.artifactsPanel.artifacts' | transloco }}</span>
      <span class="chip">{{ 'artifacts.artifactsPanel.browser' | transloco }}</span>
      <button
        type="button"
        class="btn btn-ghost btn-sm ml-auto"
        [attr.aria-pressed]="expanded()"
        (click)="expanded.set(!expanded())"
      >
        {{
          expanded() ? ('artifacts.artifactsPanel.shrink' | transloco) : ('artifacts.artifactsPanel.expand' | transloco)
        }}
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm"
        [attr.aria-label]="'artifacts.artifactsPanel.closeArtifacts' | transloco"
        (click)="bus.closePanel()"
      >
        ✕
      </button>
    </div>
    <form class="browser-toolbar" (submit)="navigate($event)">
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-square"
        [attr.aria-label]="'artifacts.artifactsPanel.browserBack' | transloco"
        [disabled]="!store.page()?.canGoBack || store.busy()"
        (click)="store.act({ action: 'back' })"
      >
        <pk-icon name="back" />
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-square"
        [attr.aria-label]="'artifacts.artifactsPanel.browserForward' | transloco"
        [disabled]="!store.page()?.canGoForward || store.busy()"
        (click)="store.act({ action: 'forward' })"
      >
        <pk-icon name="forward" />
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-sm btn-square"
        [attr.aria-label]="'artifacts.artifactsPanel.reloadBrowser' | transloco"
        [disabled]="!store.page()?.open || store.busy()"
        (click)="store.act({ action: 'reload' })"
      >
        <pk-icon name="reload" />
      </button>
      <input
        class="input input-sm min-w-0 flex-1 mono"
        [attr.aria-label]="'artifacts.artifactsPanel.browserAddress' | transloco"
        [placeholder]="'artifacts.artifactsPanel.httpLocalhost3000' | transloco"
        [value]="address()"
        (input)="address.set($any($event.target).value)"
        [disabled]="!store.page()?.available"
      />
      <button
        type="submit"
        class="btn btn-sm"
        [disabled]="!address().trim() || store.busy() || !store.page()?.available"
      >
        {{ 'artifacts.artifactsPanel.go' | transloco }}
      </button>
    </form>
    @if (store.page()?.available) {
      <pk-browser-tools />
    }
    @if (store.error() || store.page()?.error; as error) {
      <p role="alert" class="text-error text-sm px-3 py-2">{{ error }}</p>
    }
    @if (store.page()?.loading || store.busy()) {
      <progress
        class="progress progress-primary h-0.5 w-full"
        [attr.aria-label]="'artifacts.artifactsPanel.browserLoading' | transloco"
      ></progress>
    }
    <div #viewport class="browser-viewport" data-testid="browser-viewport">
      @if (!store.threadId()) {
        <p>{{ 'artifacts.artifactsPanel.selectAChatToOpenItsBrowser' | transloco }}</p>
      } @else if (store.page()?.available === false || !desktop) {
        <p>{{ 'artifacts.artifactsPanel.theBrowserArtifactIsAvailableInThe' | transloco }}</p>
      } @else if (!store.page()?.open) {
        <div class="text-center max-w-sm p-6">
          <h2 class="font-medium mb-2">{{ 'artifacts.artifactsPanel.previewYourWebProject' | transloco }}</h2>
          <p>
            {{ 'artifacts.artifactsPanel.startItsDevelopmentServerThenEnterThe' | transloco }}
          </p>
        </div>
      } @else if (suspended()) {
        <p>{{ 'artifacts.artifactsPanel.browserHiddenWhileADialogIsOpen' | transloco }}</p>
      } @else if (resizing()) {
        <p>{{ 'artifacts.artifactsPanel.releaseToPreviewAtThisWidth' | transloco }}</p>
      }
    </div>
    <div class="browser-footer">
      <span class="truncate">{{
        store.page()?.title || ('artifacts.artifactsPanel.browserSharedWithThisChat' | transloco)
      }}</span>
      @if (store.page()?.open) {
        <button
          type="button"
          class="btn btn-ghost btn-xs shrink-0"
          [disabled]="store.busy()"
          (click)="store.act({ action: 'close' })"
        >
          {{ 'artifacts.artifactsPanel.closePage' | transloco }}
        </button>
      }
    </div>
  `,
  styles: `
    :host {
      min-width: 0;
    }
    :host(.expanded) {
      position: fixed;
      inset: 0 0 var(--pk-status) 0;
      width: auto;
      z-index: 35;
    }
    .browser-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px;
      background: var(--color-base-200);
      border-bottom: 1px solid var(--color-base-300);
    }
    .browser-viewport {
      flex: 1;
      min-height: 0;
      display: grid;
      place-items: center;
      overflow: hidden;
      color: var(--pk-muted);
    }
    .browser-footer {
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: space-between;
      min-height: 32px;
      padding: 4px 12px;
      font-size: 12px;
      color: var(--pk-muted);
      border-top: 1px solid var(--color-base-300);
    }
  `,
})
export class ArtifactsPanel {
  protected readonly i18n = inject(Language);
  readonly refreshMs = input(750);
  readonly suspended = input(false);
  readonly resizing = input(false);
  protected readonly store = inject(BrowserStore);
  protected readonly bus = inject(UiStore);
  protected readonly expanded = signal(false);
  protected readonly desktop = !!window.piKit?.setBrowserViewport;
  private readonly pageUrl = computed(() => this.store.page()?.url ?? '');
  protected readonly address = linkedSignal(() => this.pageUrl());
  private readonly showBrowser = computed(() => !!this.store.page()?.open && !this.suspended() && !this.resizing());
  private readonly threads = inject(ThreadsStore);
  private readonly zone = inject(NgZone);
  private readonly viewport = viewChild<ElementRef<HTMLDivElement>>('viewport');
  private readonly owner = crypto.randomUUID();

  constructor() {
    effect(() => {
      const id = this.threads.selectedId() ?? undefined;
      const interval = this.refreshMs();
      untracked(() => this.zone.runOutsideAngular(() => this.store.watch(id, interval)));
    });
    effect((onCleanup) => {
      const bridge = window.piKit?.setBrowserViewport;
      const threadId = this.store.threadId();
      const element = this.viewport()?.nativeElement;
      const show = this.showBrowser();
      if (!bridge || !threadId || !element || !show) return;
      const position = (): void => {
        const { x, y, width, height } = element.getBoundingClientRect();
        void bridge({ owner: this.owner, threadId, bounds: { x, y, width, height } }).catch(() => undefined);
      };
      const resize = new ResizeObserver(position);
      resize.observe(element);
      const frame = requestAnimationFrame(position);
      window.addEventListener('resize', position);
      window.addEventListener('scroll', position, true);
      onCleanup(() => {
        resize.disconnect();
        cancelAnimationFrame(frame);
        window.removeEventListener('resize', position);
        window.removeEventListener('scroll', position, true);
        void bridge({ owner: this.owner, threadId, bounds: null }).catch(() => undefined);
      });
    });
  }

  protected navigate(event: Event): void {
    event.preventDefault();
    void this.store.act({ action: 'navigate', url: this.address().trim() });
  }
}
