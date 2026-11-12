import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { UiStore, readStorage, writeStorage } from '@pi-kit/data-access';
import { PkIcon, PkTip } from '@pi-kit/design-system';
import { ChatStore } from '@pi-kit/chat/api';
import { ThreadsStore } from '@pi-kit/threads/api';
import { PreviewPolicy, type PreviewBlock } from './preview-policy';

@Component({
  selector: 'pk-iframe-preview-panel',
  imports: [PkIcon, PkTip, TranslocoPipe],
  host: { '[attr.inert]': 'visible() ? null : ""' },
  template: `
    <form class="preview-toolbar" (submit)="navigate($event); addressInput.blur()">
      <button
        class="btn btn-ghost btn-sm btn-square"
        type="button"
        [attr.aria-label]="'artifacts.preview.reload' | transloco"
        [pkTip]="'artifacts.preview.reload' | transloco"
        [disabled]="!loadedUrl()"
        (click)="reload()"
      >
        <pk-icon name="reload" />
      </button>
      <input
        #addressInput
        class="input input-sm min-w-0 flex-1 mono"
        type="url"
        inputmode="url"
        enterkeyhint="go"
        autocomplete="off"
        spellcheck="false"
        [attr.aria-label]="'artifacts.preview.address' | transloco"
        [placeholder]="'artifacts.preview.placeholder' | transloco"
        [value]="address()"
        (input)="edit($any($event.target).value)"
      />
      <button
        class="go btn btn-sm btn-square"
        type="submit"
        [attr.aria-label]="'artifacts.artifactsPanel.go' | transloco"
        [pkTip]="'artifacts.artifactsPanel.go' | transloco"
        [disabled]="!address().trim() || !policy.ready()"
      >
        <pk-icon name="arrow-right" />
      </button>
      @if (externalUrl(); as url) {
        <a
          class="btn btn-ghost btn-sm btn-square"
          [href]="url"
          target="_blank"
          rel="noopener noreferrer"
          [attr.aria-label]="'artifacts.preview.openExternally' | transloco"
          [pkTip]="'artifacts.preview.openExternally' | transloco"
        >
          <pk-icon name="globe" />
        </a>
      } @else {
        <button
          class="btn btn-ghost btn-sm btn-square"
          type="button"
          disabled
          [attr.aria-label]="'artifacts.preview.openExternally' | transloco"
        >
          <pk-icon name="globe" />
        </button>
      }
      <input
        #screenshots
        type="file"
        class="sr-only"
        accept="image/*"
        multiple
        tabindex="-1"
        [attr.aria-label]="'artifacts.preview.uploadScreenshot' | transloco"
        (change)="upload($event)"
      />
      <button
        class="btn btn-ghost btn-sm btn-square"
        type="button"
        [attr.aria-label]="'artifacts.preview.uploadScreenshot' | transloco"
        [pkTip]="'artifacts.preview.uploadScreenshot' | transloco"
        [disabled]="preparing()"
        (click)="screenshots.click()"
      >
        <pk-icon name="camera" />
      </button>
      <button
        class="btn btn-ghost btn-sm btn-square"
        type="button"
        [attr.aria-label]="'artifacts.preview.unload' | transloco"
        [pkTip]="'artifacts.preview.unload' | transloco"
        [disabled]="!loadedUrl()"
        (click)="unload()"
      >
        <pk-icon name="stop" />
      </button>
    </form>
    @if (notice(); as text) {
      <p class="preview-notice" role="status">{{ text }}</p>
    }
    @if (newUrl(); as url) {
      <div class="new-url" role="status">
        <span>{{ 'artifacts.preview.newUrl' | transloco }}</span>
        <button class="btn btn-sm" type="button" (click)="loadPublished(url)">
          {{ 'artifacts.preview.loadNewUrl' | transloco }}
        </button>
      </div>
    }
    @if (blocked(); as reason) {
      <p class="preview-notice" role="status">{{ 'artifacts.preview.blocked.' + reason | transloco }}</p>
    }
    <div class="preview-content">
      @for (frame of frames(); track frame.generation) {
        <iframe
          data-testid="iframe-preview"
          [src]="frame.src"
          [title]="previewTitle()"
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerpolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'"
          (load)="frameLoaded(frame.generation)"
        ></iframe>
      } @empty {
        <div class="preview-empty">
          <h2>{{ 'artifacts.preview.heading' | transloco }}</h2>
          <p>{{ 'artifacts.preview.setup' | transloco }}</p>
        </div>
      }
    </div>
    @if (!hintDismissed()) {
      <div class="preview-hint">
        <p>{{ 'artifacts.preview.hint' | transloco }}</p>
        <button
          class="btn btn-ghost btn-xs btn-square"
          type="button"
          [attr.aria-label]="'artifacts.preview.dismissHint' | transloco"
          [pkTip]="'artifacts.preview.dismissHint' | transloco"
          (click)="dismissHint()"
        >
          <pk-icon name="close" size="14" />
        </button>
      </div>
    }
    @if (loadedUrl()) {
      <p class="sr-only" role="status">
        {{ (loadObserved() ? 'artifacts.preview.frameLoaded' : 'artifacts.preview.loading') | transloco }}
      </p>
    }
  `,
  styles: `
    :host {
      container: preview / inline-size;
      display: flex;
      flex: 1;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
    }
    .preview-notice {
      margin: 0;
      padding: 8px 12px;
      font-size: 12px;
      color: var(--pk-muted);
    }
    .preview-toolbar,
    .new-url {
      display: flex;
      gap: 4px;
      align-items: center;
      padding: 6px 8px;
    }
    .preview-toolbar {
      border-bottom: 1px solid var(--color-base-300);
    }
    .new-url {
      flex-wrap: wrap;
    }
    .preview-hint {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 4px 4px 4px 12px;
      border-top: 1px solid var(--color-base-300);
      font-size: 12px;
      line-height: 1.35;
      color: var(--pk-muted);
    }
    .preview-hint p {
      flex: 1;
      margin: 0;
    }
    @container preview (max-width: 480px) {
      .go {
        display: none;
      }
      .preview-toolbar .btn-square {
        width: 36px;
        height: 36px;
        min-height: 36px;
      }
      .preview-toolbar:has(input[type='url']:focus) .btn-square {
        display: none;
      }
      .preview-toolbar:has(input[type='url']:focus) .go {
        display: inline-flex;
      }
    }
    .new-url {
      justify-content: space-between;
      font-size: 12px;
      background: var(--color-base-200);
    }
    .preview-content {
      flex: 1;
      min-height: 160px;
      display: flex;
      overflow: hidden;
    }
    iframe {
      flex: 1;
      width: 100%;
      height: 100%;
      min-height: 160px;
      border: 0;
      background: white;
    }
    .preview-empty {
      margin: auto;
      max-width: 360px;
      padding: 24px;
      text-align: center;
      color: var(--pk-muted);
    }
    h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 8px;
    }
  `,
})
export class IframePreviewPanel {
  private static readonly HINT_KEY = 'pi-kit.preview-hint-dismissed.v1';
  readonly visible = input(true);
  protected readonly bus = inject(UiStore);
  protected readonly policy = inject(PreviewPolicy);
  private readonly threads = inject(ThreadsStore);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly language = inject(Language);
  private readonly chat = inject(ChatStore);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly preparing = signal(false);
  protected readonly notice = signal<string | undefined>(undefined);
  protected readonly hintDismissed = signal(readStorage(IframePreviewPanel.HINT_KEY, 'controller') === '1');
  protected readonly address = signal('');
  protected readonly loadedUrl = signal<string | undefined>(undefined);
  protected readonly blocked = signal<PreviewBlock | undefined>(undefined);
  protected readonly loadObserved = signal(false);
  protected readonly frames = signal<{ generation: number; src: SafeResourceUrl }[]>([]);
  private generation = 0;
  private documentGeneration = 0;
  private readonly initialAttempted = signal(false);
  private edited = false;
  private thread: string | undefined;
  private readonly publishedUrl = computed(() => {
    const id = this.threads.selectedId();
    const preview = id ? this.bus.previewFor(id) : undefined;
    return preview?.previewUrl ?? preview?.sourceUrl;
  });
  protected readonly previewTitle = computed(() => {
    const id = this.threads.selectedId();
    return (id && this.bus.previewFor(id)?.title) || this.language.t('artifacts.preview.heading');
  });
  protected readonly externalUrl = computed(() => this.policy.external(this.address()));
  protected readonly newUrl = computed(() => {
    const url = this.publishedUrl();
    return url && this.initialAttempted() && url !== this.loadedUrl() && url !== this.address() ? url : undefined;
  });

  constructor() {
    effect(() => {
      const id = this.threads.selectedId() ?? undefined;
      const published = this.publishedUrl();
      const ready = this.policy.ready();
      const visible = this.visible();
      untracked(() => {
        if (id !== this.thread) {
          this.thread = id;
          this.edited = false;
          this.address.set('');
          this.unload();
          this.initialAttempted.set(false);
        }
        if (!id || !visible || !ready || !published || this.initialAttempted() || this.edited) return;
        this.initialAttempted.set(true);
        this.address.set(published);
        this.load(published);
      });
    });
  }

  protected async upload(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    const threadId = this.threads.selectedId();
    const generation = this.generation;
    const documentGeneration = this.documentGeneration;
    if (!files.length || !threadId || threadId !== this.thread || this.destroyRef.destroyed || this.preparing()) return;
    this.preparing.set(true);
    try {
      const added = await this.chat.addImages(files, {
        threadId,
        current: () =>
          !this.destroyRef.destroyed &&
          this.threads.selectedId() === threadId &&
          this.generation === generation &&
          this.documentGeneration === documentGeneration,
      });
      if (!this.destroyRef.destroyed && this.threads.selectedId() === threadId)
        this.notice.set(
          this.language.t(
            added
              ? 'artifacts.browserTools.attachedToTheDraftAddYourFeedback'
              : 'artifacts.browserTools.contextExpiredOrCouldNotBeVerified',
          ),
        );
    } catch {
      if (!this.destroyRef.destroyed)
        this.notice.set(this.language.t('artifacts.browserTools.couldNotAttachBrowserContextRefreshAnd'));
    } finally {
      if (!this.destroyRef.destroyed) this.preparing.set(false);
    }
  }

  protected dismissHint(): void {
    this.hintDismissed.set(true);
    writeStorage(IframePreviewPanel.HINT_KEY, '1', 'controller');
  }

  protected edit(value: string): void {
    this.edited = true;
    this.address.set(value);
    this.blocked.set(undefined);
  }

  protected navigate(event: Event): void {
    event.preventDefault();
    this.initialAttempted.set(true);
    this.load(this.address());
  }

  protected loadPublished(url: string): void {
    this.address.set(url);
    this.initialAttempted.set(true);
    this.load(url);
  }

  protected reload(): void {
    const url = this.loadedUrl();
    if (url) this.load(url);
  }

  protected unload(): void {
    this.initialAttempted.set(true);
    this.generation++;
    this.frames.set([]);
    this.loadedUrl.set(undefined);
    this.blocked.set(undefined);
    this.loadObserved.set(false);
  }

  protected frameLoaded(generation: number): void {
    if (generation === this.generation) {
      this.documentGeneration++;
      this.loadObserved.set(true);
    }
  }

  private load(value: string): void {
    const target = this.policy.resolve(value);
    if ('blocked' in target) {
      this.blocked.set(target.blocked);
      return;
    }
    this.blocked.set(undefined);
    this.loadObserved.set(false);
    this.loadedUrl.set(target.url);
    const threadId = this.threads.selectedId();
    if (threadId) this.bus.browserActivity(threadId);
    this.frames.set([
      { generation: ++this.generation, src: this.sanitizer.bypassSecurityTrustResourceUrl(target.url) },
    ]);
  }
}
