import { Directive, inject } from '@angular/core';
import { PkLightboxService } from '@pi-kit/design-system';

/**
 * A click on an image in CopilotKit's attachment queue opens it in the lightbox of the shell. The queue has no output for a click, so
 * this directive on the queue element listens itself; a document chip is not an image and is left alone.
 */
@Directive({
  selector: 'copilot-chat-attachment-queue[pkAttachmentPreview]',
  host: { '(click)': 'preview($event)' },
})
export class AttachmentPreview {
  private readonly lightbox = inject(PkLightboxService);

  protected preview(event: MouseEvent): void {
    const image = event.target instanceof HTMLImageElement ? event.target : null;
    if (!image?.src) return;
    event.preventDefault();
    this.lightbox.open({ src: image.src, caption: image.alt || image.title || '' });
  }
}
