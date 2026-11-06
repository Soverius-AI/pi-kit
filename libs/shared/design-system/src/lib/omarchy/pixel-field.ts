import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  NgZone,
  viewChild,
} from '@angular/core';
import {
  createPixelCells,
  paintPixelField,
  pixelBackingSize,
  type PixelCell,
  type PixelPointer,
} from './pixel-field-painter';

/** Decorative only. The consuming shell owns theme-based mounting and stacking. */
@Component({
  selector: 'pk-pixel-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true' },
  template: '<canvas #canvas aria-hidden="true"></canvas>',
  styles: `
    :host {
      position: absolute;
      inset: 0;
      z-index: -1;
      overflow: hidden;
      pointer-events: none;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
      image-rendering: pixelated;
      pointer-events: none;
    }
  `,
})
export class PkPixelField {
  readonly suspended = input(false);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly document = inject(DOCUMENT);
  private readonly zone = inject(NgZone);
  private context: CanvasRenderingContext2D | null = null;
  private resize?: ResizeObserver;
  private mutations?: MutationObserver;
  private intersection?: IntersectionObserver;
  private media?: MediaQueryList;
  private timer?: ReturnType<typeof setTimeout>;
  private frame?: number;
  private destroyed = false;
  private initialized = false;
  private visible = true;
  private width = 0;
  private height = 0;
  private time = 0;
  private previous = 0;
  private cells: PixelCell[] = [];
  private cellSize?: number;
  private color = 'transparent';
  private dim = 'transparent';
  private mid = 'transparent';
  private opacity = 0.2;
  private speed = 1;
  private left = 0;
  private top = 0;
  private pointerRadius = 160;
  private pointerGain = 0.85;
  private interactive = false;
  private pointerTarget?: { x: number; y: number; at: number };
  private pointer?: PixelPointer;

  constructor() {
    afterNextRender(() => this.zone.runOutsideAngular(() => this.initialize()));
    effect(() => {
      this.suspended();
      if (this.initialized) this.zone.runOutsideAngular(() => this.reconcile());
    });
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.interactive = false;
      this.resetPointer();
      this.stop();
      this.resize?.disconnect();
      this.mutations?.disconnect();
      this.intersection?.disconnect();
      this.media?.removeEventListener('change', this.reconcile);
      this.document.removeEventListener('visibilitychange', this.reconcile);
      this.document.removeEventListener('pointermove', this.movePointer, true);
      this.document.removeEventListener('pointerout', this.pointerOut);
      window.removeEventListener('resize', this.refresh);
      window.removeEventListener('blur', this.leavePointer);
    });
  }

  private initialize(): void {
    if (this.destroyed) return;
    this.context = this.canvas().nativeElement.getContext('2d');
    this.initialized = true;
    this.media = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.media.addEventListener('change', this.reconcile);
    this.document.addEventListener('visibilitychange', this.reconcile);
    // Listen outside Angular on the document: the decorative canvas remains click-through.
    this.document.addEventListener('pointermove', this.movePointer, { passive: true, capture: true });
    this.document.addEventListener('pointerout', this.pointerOut, { passive: true });
    window.addEventListener('resize', this.refresh);
    window.addEventListener('blur', this.leavePointer);
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(this.refresh);
      this.resize.observe(this.host);
    }
    if (typeof MutationObserver === 'function') {
      this.mutations = new MutationObserver(this.refresh);
      // Observe the inherited style chain as well as the root's late theme callback.
      for (let ancestor: HTMLElement | null = this.host; ancestor; ancestor = ancestor.parentElement) {
        this.mutations.observe(ancestor, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
      }
    }
    if (typeof IntersectionObserver === 'function') {
      this.intersection = new IntersectionObserver((entries) => {
        this.visible = entries[entries.length - 1]?.isIntersecting ?? true;
        this.reconcile();
      });
      this.intersection.observe(this.host);
    }
    this.refresh();
  }

  private readonly refresh = (): void => {
    if (this.destroyed) return;
    const box = this.host.getBoundingClientRect();
    const width = Math.max(0, box.width);
    const height = Math.max(0, box.height);
    const resized = width !== this.width || height !== this.height;
    this.width = width;
    this.height = height;
    this.left = box.left;
    this.top = box.top;
    this.resetPointer();
    const styles = getComputedStyle(this.host);
    const property = (name: string) => styles.getPropertyValue(name).trim();
    this.color = property('--pk-pixel-color') || property('--color-primary') || styles.color;
    this.dim = property('--pk-pixel-dim') || property('--color-base-300') || styles.color;
    this.mid = property('--pk-pixel-mid') || this.color;
    const opacity = Number.parseFloat(property('--pk-pixel-opacity'));
    this.opacity = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 0.2;
    const speed = Number.parseFloat(property('--pk-pixel-speed'));
    this.speed = Number.isFinite(speed) ? Math.max(0.2, Math.min(3, speed)) : 1;
    const radius = Number.parseFloat(property('--pk-pixel-pointer-radius'));
    const gain = Number.parseFloat(property('--pk-pixel-pointer-gain'));
    this.pointerRadius = Number.isFinite(radius) ? Math.max(0, Math.min(320, radius)) : 160;
    this.pointerGain = Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : 0.85;
    const cell = Number.parseFloat(property('--pk-pixel-cell'));
    const cellSize = Number.isFinite(cell) ? cell : 16;
    if (resized || cellSize !== this.cellSize) this.cells = createPixelCells(this.width, this.height, cellSize);
    this.cellSize = cellSize;
    const canvas = this.canvas().nativeElement;
    delete this.host.dataset['ready'];
    const backing = pixelBackingSize(this.width, this.height, window.devicePixelRatio);
    if (canvas.width !== backing.width) canvas.width = backing.width;
    if (canvas.height !== backing.height) canvas.height = backing.height;
    if (this.context && this.width && this.height) {
      this.context.setTransform(backing.width / this.width, 0, 0, backing.height / this.height, 0, 0);
      this.context.imageSmoothingEnabled = false;
    }
    this.reconcile();
  };

  private readonly reconcile = (): void => {
    this.stop();
    this.interactive = !!(
      !this.destroyed &&
      this.context &&
      this.width &&
      this.height &&
      !this.document.hidden &&
      this.visible &&
      !this.suspended() &&
      !this.media?.matches &&
      this.pointerRadius > 0 &&
      this.pointerGain > 0
    );
    if (!this.interactive) this.resetPointer();
    if (this.destroyed) return;
    if (!this.context || !this.width || !this.height || this.document.hidden || !this.visible) {
      this.host.dataset['motion'] = 'paused';
      return;
    }
    this.draw();
    if (this.suspended()) {
      this.host.dataset['motion'] = 'paused';
      return;
    }
    this.host.dataset['motion'] = this.media?.matches ? 'static' : 'running';
    if (!this.media?.matches) {
      this.previous = performance.now();
      this.schedule();
    }
  };

  private draw(): void {
    if (!this.context) return;
    paintPixelField(
      this.context,
      this.cells,
      this.width,
      this.height,
      this.time,
      this.color,
      this.dim,
      this.opacity,
      this.pointer,
      this.mid,
    );
    if (this.host.dataset['ready'] !== 'true') this.host.dataset['ready'] = 'true';
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.frame = requestAnimationFrame((now) => {
        this.frame = undefined;
        const elapsed = Math.max(0, Math.min(200, now - this.previous)) / 1000;
        this.time += elapsed * this.speed;
        this.previous = now;
        this.updatePointer(now, elapsed);
        this.draw();
        this.schedule();
      });
    }, 50);
  }

  /** Pointer events only update cached coordinates; the existing capped loop does all painting. */
  private readonly movePointer = (event: PointerEvent): void => {
    if (!this.interactive) return;
    if (event.pointerType !== 'mouse' || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      this.leavePointer();
      return;
    }
    const x = event.clientX - this.left;
    const y = event.clientY - this.top;
    if (x < 0 || y < 0 || x > this.width || y > this.height) {
      this.leavePointer();
      return;
    }
    const at = performance.now();
    if (this.pointerTarget) {
      this.pointerTarget.x = x;
      this.pointerTarget.y = y;
      this.pointerTarget.at = at;
    } else {
      this.pointerTarget = { x, y, at };
    }
  };

  private readonly leavePointer = (): void => {
    this.pointerTarget = undefined;
  };

  private readonly pointerOut = (event: PointerEvent): void => {
    if (!event.relatedTarget) this.leavePointer();
  };

  private resetPointer(): void {
    this.pointerTarget = undefined;
    this.pointer = undefined;
  }

  private updatePointer(now: number, elapsed: number): void {
    // A stationary/absent pointer settles back into the ambient field rather than leaving a hot spot.
    const target = this.pointerTarget && now - this.pointerTarget.at <= 600 ? this.pointerTarget : undefined;
    if (target) {
      this.pointer ??= {
        x: target.x,
        y: target.y,
        strength: 0,
        radius: this.pointerRadius,
      };
      const follow = 1 - Math.exp(-elapsed * 16);
      this.pointer.x += (target.x - this.pointer.x) * follow;
      this.pointer.y += (target.y - this.pointer.y) * follow;
    }
    if (!this.pointer) return;
    this.pointer.strength += ((target ? this.pointerGain : 0) - this.pointer.strength) * (1 - Math.exp(-elapsed * 6));
    if (!target && this.pointer.strength < 0.01) this.pointer = undefined;
  }

  private stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.timer = undefined;
    this.frame = undefined;
  }
}
