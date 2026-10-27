import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PkLightbox, PkLightboxService } from './lightbox';

@Component({
  selector: 'pk-lightbox-host',
  imports: [PkLightbox],
  template: `
    <button
      type="button"
      data-testid="thumb"
      (click)="service.open({ src: 'data:image/png;base64,AA==', caption: 'shot.png' })"
    >
      open
    </button>
    <pk-lightbox />
  `,
})
class Host {
  readonly service = inject(PkLightboxService);
}

describe('the lightbox', () => {
  const render = () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    return { fixture, root, service: fixture.componentInstance.service };
  };

  it('opens from an image with its caption, closes on Esc and gives the opener its focus back', async () => {
    const { fixture, root } = render();
    const thumb = root.querySelector<HTMLButtonElement>('[data-testid=thumb]')!;
    thumb.focus();
    thumb.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const box = root.querySelector<HTMLElement>('[data-testid=lightbox]')!;
    expect(box.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    expect(box.querySelector('figcaption')?.textContent).toBe('shot.png');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(root.querySelector('[data-testid=lightbox]')).toBeNull();
    expect(document.activeElement).toBe(thumb);
  });

  it('closes on the backdrop and on the button, not on the image', () => {
    const { fixture, root, service } = render();
    service.open({ src: 'data:image/png;base64,AA==', caption: '' });
    fixture.detectChanges();
    root.querySelector<HTMLElement>('[data-testid=lightbox] img')!.click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid=lightbox]')).not.toBeNull();
    expect(root.querySelector('[data-testid=lightbox] figcaption')).toBeNull();
    root.querySelector<HTMLElement>('[data-testid=lightbox]')!.click();
    fixture.detectChanges();
    expect(root.querySelector('[data-testid=lightbox]')).toBeNull();
    service.open({ src: 'data:image/png;base64,AA==', caption: 'x' });
    fixture.detectChanges();
    root.querySelector<HTMLElement>('[data-testid=lightbox-close]')!.click();
    fixture.detectChanges();
    expect(service.current()).toBeNull();
  });
});
