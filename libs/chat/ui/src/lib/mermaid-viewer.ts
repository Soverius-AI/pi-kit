import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import {
  Component,
  DestroyRef,
  ElementRef,
  type Signal,
  afterRenderEffect,
  computed,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@pi-kit/i18n';
import { MermaidExport } from './mermaid-export';

export interface MermaidView {
  image: Signal<string | undefined>;
  error: Signal<string | undefined>;
  busy: Signal<boolean>;
  active: Signal<boolean>;
  background: string;
}

/** Root-owned viewer: transcript virtualization/id reconciliation must not dismiss an inspection. */
@Component({
  selector: 'pk-mermaid-viewer',
  imports: [TranslocoPipe],
  host: { class: 'pk-diagram-fullscreen' },
  template: `
    <div class="pk-diagram-toolbar pk-diagram-fullscreen-toolbar">
      <span class="pk-diagram-fullscreen-title">{{ 'chat.markdown.diagram' | transloco }}</span>
      @if (!data.active()) {
        <span class="pk-diagram-snapshot" [title]="'chat.markdown.snapshotHint' | transloco">{{
          'chat.markdown.snapshot' | transloco
        }}</span>
      }
      <div role="group" [attr.aria-label]="'chat.markdown.zoomControls' | transloco" class="pk-diagram-zoom">
        <button
          type="button"
          [disabled]="zoom() <= 0.25"
          [attr.aria-label]="'chat.markdown.zoomOut' | transloco"
          (click)="zoom.set(zoom() - 0.25)"
        >
          −
        </button>
        <button type="button" [attr.aria-label]="'chat.markdown.fitDiagram' | transloco" (click)="zoom.set(1)">
          {{ zoom() * 100 }}%
        </button>
        <button
          type="button"
          [disabled]="zoom() >= 4"
          [attr.aria-label]="'chat.markdown.zoomIn' | transloco"
          (click)="zoom.set(zoom() + 0.25)"
        >
          +
        </button>
      </div>
      <span class="pk-diagram-actions">
        <button
          type="button"
          [disabled]="!data.image() || !!data.error() || !!exporting()"
          [attr.aria-label]="'chat.markdown.downloadSvg' | transloco"
          (click)="download('svg')"
        >
          {{ 'chat.markdown.svg' | transloco }}
        </button>
        <button
          type="button"
          [disabled]="!data.image() || !!data.error() || !!exporting()"
          [attr.aria-label]="'chat.markdown.downloadPng' | transloco"
          (click)="download('png')"
        >
          {{ 'chat.markdown.png' | transloco }}
        </button>
        <button type="button" class="pk-diagram-close" (click)="close()">
          {{ 'chat.markdown.closeFullscreen' | transloco }}
        </button>
      </span>
    </div>
    @if (exportError()) {
      <div class="pk-diagram-error" role="alert">{{ 'chat.markdown.downloadError' | transloco }}</div>
    }
    @if (data.error()) {
      <div class="pk-diagram-error" role="alert">
        {{ 'chat.markdown.diagramError' | transloco }}: {{ data.error() }}
      </div>
    }
    <div
      class="pk-diagram-fullscreen-canvas"
      tabindex="0"
      [attr.aria-label]="'chat.markdown.panDiagram' | transloco"
      [attr.aria-busy]="busy()"
      [style.background-color]="background()"
    >
      <div class="pk-diagram-fullscreen-image" [style.width.%]="zoom() * 100" [style.height.%]="zoom() * 100">
        <img [src]="data.image()" [alt]="'chat.markdown.diagramAlt' | transloco" />
      </div>
    </div>
  `,
})
export class MermaidViewer {
  protected readonly data = inject<MermaidView>(DIALOG_DATA);
  protected readonly zoom = signal(1);
  protected readonly busy = computed(() => this.data.active() && this.data.busy());
  protected readonly background = signal(this.data.background);
  protected readonly exporting = signal<'svg' | 'png' | undefined>(undefined);
  protected readonly exportError = signal(false);
  private readonly ref = inject<DialogRef<void>>(DialogRef);
  private readonly exporter = inject(MermaidExport);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterRenderEffect(() => {
      this.data.image();
      if (this.data.active()) this.background.set(getComputedStyle(this.host.nativeElement).backgroundColor);
    });
  }

  protected close(): void {
    this.ref.close();
  }

  protected async download(format: 'svg' | 'png'): Promise<void> {
    const image = this.data.image();
    if (!image || this.data.error() || this.exporting()) return;
    this.exporting.set(format);
    this.exportError.set(false);
    try {
      await this.exporter.download(image, format, this.background());
    } catch {
      if (!this.destroyRef.destroyed) this.exportError.set(true);
    } finally {
      if (!this.destroyRef.destroyed) this.exporting.set(undefined);
    }
  }
}
