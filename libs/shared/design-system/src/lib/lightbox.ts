import { TranslocoPipe } from '@pi-kit/i18n';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injectable,
  Injector,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

/** What the lightbox shows: the image and the line under it (its file name, or what the message called it). */
export interface LightboxImage {
  src: string;
  caption: string;
}

/**
 * The one lightbox of the window (doc/docs/design-system.md, "Lightbox"): `open` from wherever an image is drawn small (a sent message's
 * images, the composer's attachment queue), `close` from the overlay. The element that opened it gets the focus back when it closes.
 */
@Injectable({ providedIn: 'root' })
export class PkLightboxService {
  readonly current = signal<LightboxImage | null>(null);
  private opener: HTMLElement | null = null;

  open(image: LightboxImage): void {
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.current.set(image);
  }

  close(): void {
    if (!this.current()) return;
    this.current.set(null);
    this.opener?.focus();
    this.opener = null;
  }
}

/**
 * The lightbox overlay: the image at the size the window allows over a dimmed backdrop, its caption under it, a close button. Esc, a click
 * beside the image and the button close it; the focus stays on the overlay while it is open. Mounted once, in the shell.
 */
@Component({
  selector: 'pk-lightbox',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'contents', '(document:keydown.escape)': 'onEscape($event)' },
  template: `
    @if (service.current(); as image) {
      <div
        #overlay
        class="pk-lightbox"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        [attr.aria-label]="'shared.lightbox.title' | transloco"
        data-testid="lightbox"
        (click)="onBackdrop($event)"
        (keydown.escape)="onEscape($event)"
      >
        <button
          type="button"
          class="close"
          data-testid="lightbox-close"
          [attr.aria-label]="'shared.lightbox.close' | transloco"
          (click)="service.close()"
        >
          ✕
        </button>
        <figure>
          <img [src]="image.src" [alt]="image.caption" />
          @if (image.caption) {
            <figcaption>{{ image.caption }}</figcaption>
          }
        </figure>
      </div>
    }
  `,
})
export class PkLightbox {
  protected readonly service = inject(PkLightboxService);
  private readonly injector = inject(Injector);
  private readonly overlay = viewChild<ElementRef<HTMLElement>>('overlay');

  constructor() {
    // The overlay takes the focus when it opens, so Esc is heard here and the page's own shortcuts stay quiet.
    effect(() => {
      if (!this.service.current()) return;
      afterNextRender(() => this.overlay()?.nativeElement.focus(), { injector: this.injector });
    });
  }

  protected onEscape(event: Event): void {
    if (!this.service.current()) return;
    event.preventDefault();
    event.stopPropagation();
    this.service.close();
  }

  /** A click on the backdrop closes; one on the image or the caption does not. */
  protected onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.service.close();
  }
}
