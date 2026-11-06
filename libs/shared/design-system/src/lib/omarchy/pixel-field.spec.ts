import { TestBed } from '@angular/core/testing';
import { PkPixelField } from './pixel-field';
import { createPixelCells, paintPixelField } from './pixel-field-painter';

type PaintedPixel = [number, number, number, number, number, string];
const capturePixels = (context: CanvasRenderingContext2D, pixels: PaintedPixel[]): void => {
  vi.mocked(context.fillRect).mockImplementation((x, y, width, height) => {
    pixels.push([x, y, width, height, context.globalAlpha, context.fillStyle as string]);
  });
};
const idlePixels = (time: number): PaintedPixel[] => {
  const pixels: PaintedPixel[] = [];
  const context = { clearRect: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D;
  capturePixels(context, pixels);
  paintPixelField(context, createPixelCells(1000, 800, 16), 1000, 800, time, '#b59790', '#584e51', 0.3);
  return pixels;
};
const move = (x: number, y: number, pointerType = 'mouse'): void => {
  const event = new Event('pointermove', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    pointerType: { value: pointerType },
  });
  document.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
};

describe('PkPixelField lifecycle', () => {
  let resize: () => void;
  let mutation: () => void;
  let intersect: (entries: { isIntersecting: boolean }[]) => void;
  let media: EventTarget & { matches: boolean };
  let frames: Map<number, FrameRequestCallback>;
  let disconnects: ReturnType<typeof vi.fn>[];
  let context: CanvasRenderingContext2D;
  let rect: DOMRect;
  let hidden: boolean;

  beforeEach(() => {
    hidden = false;
    rect = new DOMRect(0, 0, 1000, 800);
    frames = new Map();
    disconnects = [];
    media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => media),
    );
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect);
    context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      setTransform: vi.fn(),
      fillStyle: '',
      globalAlpha: 1,
      imageSmoothingEnabled: true,
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    let id = 0;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.set(++id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((key: number) => frames.delete(key)),
    );
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = vi.fn();
        observe = vi.fn();
        constructor(callback: () => void) {
          resize = callback;
          disconnects.push(this.disconnect);
        }
      },
    );
    vi.stubGlobal(
      'MutationObserver',
      class {
        disconnect = vi.fn();
        observe = vi.fn();
        constructor(callback: () => void) {
          mutation = callback;
          disconnects.push(this.disconnect);
        }
      },
    );
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        disconnect = vi.fn();
        observe = vi.fn();
        constructor(callback: typeof intersect) {
          intersect = callback;
          disconnects.push(this.disconnect);
        }
      },
    );
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mount(suspended = false) {
    const fixture = TestBed.createComponent(PkPixelField);
    fixture.componentRef.setInput('suspended', suspended);
    fixture.autoDetectChanges();
    await fixture.whenStable();
    return { fixture, host: fixture.nativeElement as HTMLElement };
  }

  it('is decorative, static under reduced motion, and never schedules animation', async () => {
    media.matches = true;
    const { fixture, host } = await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(host.dataset['ready']).toBe('true');
    expect(host.dataset['motion']).toBe('static');
    const canvas = host.querySelector('canvas')!;
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(host.querySelector('[tabindex]')).toBeNull();
    vi.mocked(context.clearRect).mockClear();
    vi.advanceTimersByTime(5000);
    expect(frames.size).toBe(0);
    expect(context.clearRect).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('pauses hidden, suspended and offscreen; resumes without catch-up or per-frame DOM reads', async () => {
    const { fixture, host } = await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Restart after installing fake timers.
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    const computed = vi.spyOn(window, 'getComputedStyle');
    const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    bounds.mockClear();
    vi.advanceTimersByTime(100);
    expect(frames.size).toBe(1);
    const [id, callback] = [...frames.entries()][0];
    frames.delete(id);
    callback(10000000);
    expect(computed).not.toHaveBeenCalled();
    expect(bounds).not.toHaveBeenCalled();
    fixture.componentRef.setInput('suspended', true);
    await vi.advanceTimersByTimeAsync(1);
    await fixture.whenStable();
    expect(host.dataset['motion']).toBe('paused');
    expect(vi.getTimerCount()).toBe(0);
    fixture.componentRef.setInput('suspended', false);
    await vi.advanceTimersByTimeAsync(1);
    await fixture.whenStable();
    expect(host.dataset['motion']).toBe('running');
    vi.advanceTimersByTime(100);
    expect(frames.size).toBe(1);
    intersect([{ isIntersecting: false }]);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    intersect([{ isIntersecting: true }]);
    expect(host.dataset['motion']).toBe('running');
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(host.dataset['motion']).toBe('paused');
    expect(vi.getTimerCount()).toBe(0);
    fixture.destroy();
  });

  it('paints once when initially suspended, repaints resized buffers, and resumes on demand', async () => {
    const { fixture, host } = await mount(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(host.dataset['ready']).toBe('true');
    expect(host.dataset['motion']).toBe('paused');
    expect(context.clearRect).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    resize();
    expect(host.dataset['ready']).toBe('true');
    expect(host.dataset['motion']).toBe('paused');
    expect(context.clearRect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    fixture.componentRef.setInput('suspended', false);
    await vi.advanceTimersByTimeAsync(1);
    await fixture.whenStable();
    expect(host.dataset['motion']).toBe('running');
    vi.advanceTimersByTime(100);
    expect(frames.size).toBe(1);
    fixture.destroy();
  });

  it('samples mouse movement in the existing loop without event-driven paints or layout reads, then settles', async () => {
    rect = new DOMRect(100, 50, 1000, 800);
    const { fixture, host } = await mount(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    host.style.setProperty('--pk-pixel-color', '#b59790');
    host.style.setProperty('--pk-pixel-dim', '#584e51');
    host.style.setProperty('--pk-pixel-opacity', '0.3');
    mutation();
    fixture.componentRef.setInput('suspended', false);
    await vi.advanceTimersByTimeAsync(1);
    await fixture.whenStable();
    const pixels: PaintedPixel[] = [];
    capturePixels(context, pixels);
    const styles = vi.spyOn(window, 'getComputedStyle');
    const bounds = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    bounds.mockClear();
    vi.mocked(context.clearRect).mockClear();
    for (let i = 0; i < 200; i++) move(120, 110);
    expect(context.clearRect).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    expect(bounds).not.toHaveBeenCalled();
    expect(styles).not.toHaveBeenCalled();
    const tick = (now: number) => {
      vi.advanceTimersByTime(100);
      expect(frames.size).toBe(1);
      const [id, callback] = [...frames.entries()][0];
      frames.delete(id);
      pixels.length = 0;
      callback(now);
    };
    tick(1100);
    expect(pixels).not.toEqual(idlePixels(0.1));
    // Leaving the field's bounds clears the target, but the wake decays rather than snapping off.
    move(0, 0);
    for (let i = 1; i <= 12; i++) tick(1100 + i * 100);
    expect(pixels).toEqual(idlePixels(1.3));
    expect(bounds).not.toHaveBeenCalled();
    expect(styles).not.toHaveBeenCalled();
    fixture.destroy();
  });

  it('ignores touch and reduced-motion input and clears any wake before static rendering', async () => {
    rect = new DOMRect(100, 50, 1000, 800);
    const { fixture, host } = await mount(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    host.style.setProperty('--pk-pixel-color', '#b59790');
    host.style.setProperty('--pk-pixel-dim', '#584e51');
    host.style.setProperty('--pk-pixel-opacity', '0.3');
    mutation();
    fixture.componentRef.setInput('suspended', false);
    await vi.advanceTimersByTimeAsync(1);
    await fixture.whenStable();
    const pixels: PaintedPixel[] = [];
    capturePixels(context, pixels);
    const tick = (now: number) => {
      vi.advanceTimersByTime(100);
      const [id, callback] = [...frames.entries()][0];
      frames.delete(id);
      pixels.length = 0;
      callback(now);
    };
    move(120, 110, 'touch');
    tick(1100);
    expect(pixels).toEqual(idlePixels(0.1));
    move(120, 110);
    tick(1200);
    expect(pixels).not.toEqual(idlePixels(0.2));
    pixels.length = 0;
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    expect(host.dataset['motion']).toBe('static');
    expect(pixels).toEqual(idlePixels(0.2));
    vi.mocked(context.clearRect).mockClear();
    for (let i = 0; i < 50; i++) move(130, 100);
    vi.advanceTimersByTime(1000);
    expect(context.clearRect).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    fixture.destroy();
    move(120, 110);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(1000);
    expect(context.clearRect).not.toHaveBeenCalled();
  });

  it('uses inherited text color when no palette tokens are provided', async () => {
    media.matches = true;
    const { host } = await mount();
    const colors: string[] = [];
    vi.mocked(context.fillRect).mockImplementation(() => {
      colors.push(context.fillStyle as string);
    });
    host.style.color = 'rgb(12, 34, 56)';
    mutation();
    expect(colors.length).toBeGreaterThan(0);
    expect(new Set(colors)).toEqual(new Set(['rgb(12, 34, 56)']));
  });

  it('refreshes inherited colors after a root theme/style change and on resize', async () => {
    media.matches = true;
    const { host } = await mount();
    const colors: string[] = [];
    vi.mocked(context.fillRect).mockImplementation(() => {
      colors.push(context.fillStyle as string);
    });
    host.style.setProperty('--pk-pixel-color', '#123456');
    host.style.setProperty('--pk-pixel-dim', '#654321');
    host.style.setProperty('--pk-pixel-mid', '#abcdef');
    mutation();
    expect(colors).toContain('#123456');
    expect(colors).toContain('#654321');
    expect(colors).toContain('#abcdef');
    rect = new DOMRect(0, 0, 12000, 8000);
    resize();
    const canvas = host.querySelector('canvas')!;
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(2000000);
  });

  it('handles zero sizes and unavailable canvas contexts without loops or readiness', async () => {
    rect = new DOMRect();
    const { fixture, host } = await mount();
    expect(host.dataset['ready']).toBeUndefined();
    expect(host.dataset['motion']).toBe('paused');
    rect = new DOMRect(0, 0, 500, 500);
    resize();
    expect(host.dataset['ready']).toBe('true');
    fixture.destroy();
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const next = await mount();
    expect(next.host.dataset['ready']).toBeUndefined();
    expect(next.host.dataset['motion']).toBe('paused');
    expect(frames.size).toBe(0);
  });

  it('cancels pending RAF/timer and disconnects every observer and listener on destroy', async () => {
    const removeDocument = vi.spyOn(document, 'removeEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const { fixture } = await mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    vi.advanceTimersByTime(100);
    expect(frames.size).toBe(1);
    fixture.destroy();
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(disconnects).toHaveLength(3);
    for (const disconnect of disconnects) expect(disconnect).toHaveBeenCalledOnce();
    expect(removeDocument).toHaveBeenCalledWith('pointermove', expect.any(Function), true);
    expect(removeDocument).toHaveBeenCalledWith('pointerout', expect.any(Function));
    expect(removeWindow).toHaveBeenCalledWith('blur', expect.any(Function));
    vi.mocked(context.clearRect).mockClear();
    media.dispatchEvent(new Event('change'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('resize'));
    expect(context.clearRect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
