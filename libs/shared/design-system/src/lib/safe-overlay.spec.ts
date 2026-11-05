import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PkSafeOverlay } from './safe-overlay';

@Component({
  imports: [PkSafeOverlay],
  template: '<div class="pk-shell" style="padding:47px 0 34px"></div><div pkSafeOverlay>Popup</div>',
})
class Host {}

describe('safe visual-viewport overlays', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function draw() {
    const viewport = Object.assign(new EventTarget(), {
      width: 390,
      height: 300,
      offsetTop: 200,
      offsetLeft: 0,
      scale: 1,
    });
    Object.defineProperties(viewport, {
      pageTop: { get: () => viewport.offsetTop + scrollY },
      pageLeft: { get: () => viewport.offsetLeft + scrollX },
    });
    let frame: FrameRequestCallback | undefined;
    const raf = vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const fixture = TestBed.createComponent(Host);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    const popup = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[pkSafeOverlay]')!;
    vi.spyOn(popup, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(10, 100, 358, Math.min(560, parseFloat(popup.style.maxHeight) || 560)),
    );
    const place = () => {
      window.dispatchEvent(new Event('resize'));
      frame?.(0);
      frame = undefined;
    };
    place();
    return { viewport, popup, place, fixture, raf };
  }
  it('stays in the keyboard-reduced viewport and outside both hardware safe areas', async () => {
    const f = await draw();
    expect(f.popup.style.maxWidth).toBe('358px');
    expect(f.popup.style.maxHeight).toBe('219px');
    expect(f.popup.style.translate).toBe('6px 147px');
    f.viewport.offsetTop = 280;
    f.place();
    expect(f.popup.style.translate).toBe('6px 227px');
    f.viewport.height = 260;
    f.place();
    expect(f.popup.style.maxHeight).toBe('179px');
  });
  it('measures the visible area in the box coordinates when iOS scrolls the window for the keyboard', async () => {
    vi.stubGlobal('scrollY', 200);
    const f = await draw();
    f.viewport.offsetTop = 0;
    f.place();
    expect(f.popup.style.maxHeight).toBe('219px');
    expect(f.popup.style.translate).toBe('6px -53px');
    expect(f.popup.style.getPropertyValue('--pk-overlay-height')).toBe('219px');
  });
  it('does not fight pinch zoom, and restores constraints when returning to desktop', async () => {
    const f = await draw();
    f.viewport.scale = 2;
    f.place();
    expect(f.popup.style.translate).toBe('6px 147px');
    f.viewport.scale = 1;
    f.viewport.width = 1024;
    f.place();
    expect(f.popup.style.maxHeight).toBe('');
    expect(f.popup.style.translate).toBe('');
    f.fixture.destroy();
    f.raf.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(f.raf).not.toHaveBeenCalled();
  });
});
