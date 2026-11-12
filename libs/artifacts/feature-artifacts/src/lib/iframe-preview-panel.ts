import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import { UiStore } from '@pi-kit/data-access';
import { ChatStore } from '@pi-kit/chat/api';
import { ThreadsStore } from '@pi-kit/threads/api';
import { PreviewPolicy, type PreviewBlock } from './preview-policy';

@Component({
  selector: 'pk-iframe-preview-panel',
  imports: [TranslocoPipe],
  host: { '[attr.inert]': 'visible() ? null : ""' },
  template: `
    <p class="session-note">{{ 'artifacts.preview.separateSession' | transloco }}</p>
    <form class="preview-toolbar" (submit)="navigate($event)">
      <input
        class="input input-sm min-w-0 flex-1 mono"
        type="url"
        inputmode="url"
        autocomplete="off"
        spellcheck="false"
        [attr.aria-label]="'artifacts.preview.address' | transloco"
        [placeholder]="'artifacts.preview.placeholder' | transloco"
        [value]="address()"
        (input)="edit($any($event.target).value)"
      />
      <button class="btn btn-sm" type="submit" [disabled]="!address().trim() || !policy.ready()">
        {{ 'artifacts.artifactsPanel.go' | transloco }}
      </button>
    </form>
    <div class="preview-actions">
      <button class="btn btn-ghost btn-sm" type="button" [disabled]="!loadedUrl()" (click)="reload()">
        {{ 'artifacts.preview.reload' | transloco }}
      </button>
      @if (externalUrl(); as url) {
        <a class="btn btn-ghost btn-sm" [href]="url" target="_blank" rel="noopener noreferrer">{{
          'artifacts.preview.openExternally' | transloco
        }}</a>
      }
      <button class="btn btn-ghost btn-sm" type="button" [disabled]="!loadedUrl()" (click)="unload()">
        {{ 'artifacts.preview.unload' | transloco }}
      </button>
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
      <button class="btn btn-ghost btn-sm" type="button" [disabled]="preparing()" (click)="screenshots.click()">
        {{ 'artifacts.preview.uploadScreenshot' | transloco }}
      </button>
    </div>
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
    <p class="preview-notice">{{ 'artifacts.preview.framingHint' | transloco }}</p>
    @if (loadedUrl()) {
      <p class="preview-status" role="status">
        {{ (loadObserved() ? 'artifacts.preview.frameLoaded' : 'artifacts.preview.loading') | transloco }}
      </p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex: 1;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
    }
    .session-note,
    .preview-notice,
    .preview-status {
      margin: 0;
      padding: 8px 12px;
      font-size: 12px;
      color: var(--pk-muted);
    }
    .session-note {
      border-bottom: 1px solid var(--color-base-300);
    }
    .preview-toolbar,
    .preview-actions,
    .new-url {
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 8px;
      flex-wrap: wrap;
    }
    .preview-toolbar {
      flex-wrap: nowrap;
    }
    .preview-actions {
      padding-top: 0;
      border-bottom: 1px solid var(--color-base-300);
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
