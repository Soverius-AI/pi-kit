import { Dialog, DialogModule, type DialogRef } from '@angular/cdk/dialog';
import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { ThemeStore } from '@pi-kit/data-access';
import { Language, TranslocoPipe } from '@pi-kit/i18n';
import { CodeBlock } from './code-block';
import { MermaidExport } from './mermaid-export';
import { MermaidViewer, type MermaidView } from './mermaid-viewer';
import { MermaidPolicyError, MermaidRenderer, validateMermaidSource } from './mermaid-renderer';

interface RenderRequest {
  source: string;
  streaming: boolean;
  dark: boolean;
  revision: number;
}

@Component({
  selector: 'pk-mermaid',
  imports: [CodeBlock, DialogModule, TranslocoPipe],
  host: {
    class: 'pk-diagram',
    '[style.--pk-diagram-preview-height]': 'previewHeight() === undefined ? null : previewHeight() + "px"',
  },
  template: `
    <div class="pk-diagram-toolbar" role="group" [attr.aria-label]="'chat.markdown.diagram' | transloco">
      <button type="button" [attr.aria-pressed]="!showSource()" (click)="showSource.set(false)">
        {{ 'chat.markdown.diagram' | transloco }}
      </button>
      <button type="button" [attr.aria-pressed]="showSource()" (click)="showSource.set(true)">
        {{ 'chat.markdown.source' | transloco }}
      </button>
      <span class="pk-diagram-actions">
        <button
          type="button"
          [disabled]="!image() || !!error()"
          aria-haspopup="dialog"
          [attr.aria-expanded]="fullscreen()"
          (click)="openFullscreen()"
        >
          {{ 'chat.markdown.fullscreen' | transloco }}
        </button>
        <button
          type="button"
          [disabled]="!image() || !!error() || !!exporting()"
          [attr.aria-label]="'chat.markdown.downloadSvg' | transloco"
          (click)="download('svg')"
        >
          {{ 'chat.markdown.svg' | transloco }}
        </button>
        <button
          type="button"
          [disabled]="!image() || !!error() || !!exporting()"
          [attr.aria-label]="'chat.markdown.downloadPng' | transloco"
          (click)="download('png')"
        >
          {{ 'chat.markdown.png' | transloco }}
        </button>
      </span>
    </div>
    @if (exportError() && !fullscreen()) {
      <div class="pk-diagram-error" role="alert">{{ 'chat.markdown.downloadError' | transloco }}</div>
    }
    @if (error()) {
      <div class="pk-diagram-error" role="alert">{{ 'chat.markdown.diagramError' | transloco }}: {{ error() }}</div>
    }
    @if (showSource() || error()) {
      <pk-code-block [code]="source()" language="mermaid" />
    } @else {
      <div class="pk-diagram-preview" [attr.aria-busy]="busy()">
        @if (image()) {
          <img [src]="image()" [alt]="'chat.markdown.diagramAlt' | transloco" />
        } @else {
          <span role="status">{{ 'chat.markdown.renderingDiagram' | transloco }}</span>
        }
      </div>
    }
  `,
})
export class MermaidDiagram {
  readonly source = input.required<string>();
  readonly streaming = input(false);
  protected readonly showSource = signal(false);
  protected readonly image = signal<string | undefined>(undefined);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly busy = signal(true);
  protected readonly previewHeight = signal<number | undefined>(undefined);
  protected readonly fullscreen = signal(false);
  protected readonly exporting = signal<'svg' | 'png' | undefined>(undefined);
  protected readonly exportError = signal(false);
  private readonly dialog = inject(Dialog);
  private readonly language = inject(Language);
  private readonly exporter = inject(MermaidExport);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly ownerActive = signal(true);
  private viewer?: DialogRef<void, MermaidViewer>;
  private readonly renderer = inject(MermaidRenderer);
  private readonly theme = inject(ThemeStore);
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: RenderRequest;
  private revision = 0;
  private destroyed = false;
  private inFlight = false;
  private pendingReady = false;
  private previous?: RenderRequest;
  private resizeObserver?: ResizeObserver;

  constructor() {
    afterNextRender(() => this.observePreviewSize());
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      ++this.revision;
      clearTimeout(this.timer);
      this.pending = undefined;
      // A full-window inspection owns its view. Keep the last good snapshot if this row
      // is recycled or its provisional message id is replaced at the end of streaming.
      this.ownerActive.set(false);
      this.resizeObserver?.disconnect();
    });
    effect(() => {
      const request: RenderRequest = {
        source: this.source(),
        streaming: this.streaming(),
        dark: this.theme.isDark(),
        revision: this.revision,
      };
      untracked(() => {
        const previous = this.previous;
        // Appended streaming tokens belong to the same generation. A slow render of that
        // generation remains useful; final validation, replacement, or theme changes do not.
        if (
          !previous ||
          !request.streaming ||
          !previous.streaming ||
          request.dark !== previous.dark ||
          !request.source.startsWith(previous.source)
        ) {
          ++this.revision;
        }
        request.revision = this.revision;
        this.previous = request;
        this.error.set(undefined);
        this.busy.set(true);
        this.pending = request;
        if (!request.streaming) {
          clearTimeout(this.timer);
          this.timer = undefined;
          this.pendingReady = true;
          this.drain();
        } else if (this.timer === undefined && !this.pendingReady) {
          // Fixed window with backpressure: keep only the newest pending snapshot.
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.pendingReady = true;
            this.drain();
          }, 180);
        }
      });
    });
  }

  private observePreviewSize(): void {
    const host = this.host.nativeElement;
    const scroller = host.closest<HTMLElement>('[cdkscrollable]');
    if (!scroller) return;
    const composer = host
      .closest('copilot-chat-view')
      ?.querySelector<HTMLElement>('copilot-chat-view-input-container .pk-composer');
    const measure = (): void => {
      const bounds = scroller.getBoundingClientRect();
      // The floating composer covers the bottom of the scroll area. Use only the visible
      // conversation above it, rather than the image's intrinsic height or the whole window.
      const overlay = composer?.getBoundingClientRect();
      const bottom = Math.min(
        bounds.bottom,
        window.innerHeight,
        overlay && overlay.height > 0 && overlay.bottom > bounds.top ? overlay.top : Infinity,
      );
      const visible = bottom - Math.max(0, bounds.top);
      if (visible > 0) this.previewHeight.set(Math.max(64, Math.floor(visible * 0.6)));
    };
    measure();
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(measure);
      this.resizeObserver.observe(scroller);
      if (composer) this.resizeObserver.observe(composer);
    }
  }

  protected openFullscreen(): void {
    if (!this.image() || this.error() || this.viewer) return;
    this.viewer = this.dialog.open<void, MermaidView, MermaidViewer>(MermaidViewer, {
      data: {
        image: this.image.asReadonly(),
        error: this.error.asReadonly(),
        busy: this.busy.asReadonly(),
        active: this.ownerActive.asReadonly(),
        background: getComputedStyle(this.host.nativeElement).backgroundColor,
      },
      width: '100vw',
      height: '100dvh',
      maxWidth: '100vw',
      maxHeight: '100dvh',
      panelClass: 'pk-diagram-dialog',
      ariaLabel: this.language.t('chat.markdown.fullscreenTitle'),
      autoFocus: '.pk-diagram-close',
      restoreFocus: true,
    });
    this.fullscreen.set(true);
    this.viewer.closed.subscribe(() => {
      this.viewer = undefined;
      this.fullscreen.set(false);
    });
  }

  protected async download(format: 'svg' | 'png'): Promise<void> {
    const image = this.image();
    if (!image || this.error() || this.exporting()) return;
    this.exporting.set(format);
    this.exportError.set(false);
    // Snapshot the displayed image/theme; a new streaming render must not change an in-progress export.
    const background = getComputedStyle(this.host.nativeElement).backgroundColor;
    try {
      await this.exporter.download(image, format, background);
    } catch {
      if (!this.destroyed) this.exportError.set(true);
    } finally {
      if (!this.destroyed) this.exporting.set(undefined);
    }
  }

  private drain(): void {
    if (this.destroyed || this.inFlight || !this.pendingReady || !this.pending) return;
    const request = this.pending;
    this.pending = undefined;
    this.pendingReady = false;
    this.inFlight = true;
    this.busy.set(true);
    void this.render(request).finally(() => {
      this.inFlight = false;
      this.drain();
    });
  }

  private async render(request: RenderRequest): Promise<void> {
    const current = () => !this.destroyed && request.revision === this.revision;
    let lastError: unknown;
    try {
      // Never bypass a rejected directive/limit by trimming it away as a partial line.
      validateMermaidSource(request.source);
      const candidates = [request.source];
      if (request.streaming) {
        let prefix = request.source;
        for (let i = 0; i < 8; i++) {
          const end = prefix.lastIndexOf('\n');
          if (end < 0) break;
          prefix = prefix.slice(0, end);
          if (prefix.trim()) candidates.push(prefix);
        }
      }
      for (const candidate of candidates) {
        if (!current()) return;
        try {
          const image = await this.renderer.render(candidate, request.dark, request.streaming);
          if (current()) {
            this.image.set(image);
            this.busy.set(false);
          }
          return;
        } catch (error) {
          lastError = error;
          if (error instanceof MermaidPolicyError) break;
        }
      }
      throw lastError;
    } catch (error) {
      if (!current()) return;
      this.busy.set(false);
      if (!request.streaming) {
        // Interpolated text, never HTML; keep the last valid image for a later successful update.
        const message = error instanceof Error ? error.message : 'Invalid Mermaid syntax.';
        this.error.set(message.slice(0, 500));
      }
    }
  }
}
