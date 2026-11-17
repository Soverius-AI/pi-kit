import { Injectable } from '@angular/core';

const SVG_PREFIX = 'data:image/svg+xml;charset=utf-8,';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MAX_PIXELS = 16_000_000;
const MAX_DIMENSION = 8192;
const URL_CLEANUP_DELAY = 1000;
const MAX_SVG_BYTES = 1_000_000;
const EXPORT_TIMEOUT = 15_000;

async function withTimeout<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Diagram export timed out.')), EXPORT_TIMEOUT);
      }),
      work(),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Exports snapshots produced by MermaidRenderer; this is not an arbitrary SVG sanitizer. */
@Injectable({ providedIn: 'root' })
export class MermaidExport {
  async download(image: string, format: 'svg' | 'png', background: string): Promise<void> {
    if (!image.startsWith(SVG_PREFIX)) throw new Error('Expected a vetted SVG image URL.');
    const source = decodeURIComponent(image.slice(SVG_PREFIX.length));
    if (source.length > MAX_SVG_BYTES) throw new Error('SVG diagram is too large.');
    const sourceBlob = new Blob([source], { type: 'image/svg+xml' });
    if (sourceBlob.size > MAX_SVG_BYTES) throw new Error('SVG diagram is too large.');
    const document = new DOMParser().parseFromString(source, 'image/svg+xml');
    const root = document.documentElement;
    if (
      document.doctype ||
      document.querySelector('parsererror') ||
      root.localName !== 'svg' ||
      root.namespaceURI !== SVG_NAMESPACE
    ) {
      throw new Error('Invalid SVG diagram.');
    }
    const coordinates = root
      .getAttribute('viewBox')
      ?.trim()
      .split(/[\s,]+/);
    const bounds = coordinates?.map(Number);
    if (
      !bounds ||
      !coordinates?.every((value) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) ||
      bounds.length !== 4 ||
      !bounds.every((value) => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) ||
      bounds[2] <= 0 ||
      bounds[3] <= 0 ||
      !Number.isSafeInteger(Math.ceil(Math.abs(bounds[0]) + bounds[2])) ||
      !Number.isSafeInteger(Math.ceil(Math.abs(bounds[1]) + bounds[3]))
    ) {
      throw new Error('Invalid SVG viewBox bounds.');
    }

    if (format === 'svg') {
      this.save(sourceBlob, 'diagram.svg');
      return;
    }
    if (format !== 'png') throw new Error('Unsupported diagram export format.');

    const width = bounds[2];
    const height = bounds[3];
    const scale = Math.min(2, MAX_DIMENSION / width, MAX_DIMENSION / height, Math.sqrt(MAX_PIXELS / width / height));
    const pixelWidth = Math.max(1, Math.floor(width * scale));
    const pixelHeight = Math.max(1, Math.floor(height * scale));
    // Mermaid uses width="100%". Give the isolated image explicit raster dimensions,
    // rather than relying on the browser's default 300px replaced-element width.
    root.setAttribute('width', String(pixelWidth));
    root.setAttribute('height', String(pixelHeight));
    root.style.removeProperty('max-width');
    root.style.removeProperty('width');
    root.style.removeProperty('height');
    const rasterSource = new XMLSerializer().serializeToString(root);
    const rasterImage = new Image();
    try {
      await withTimeout(async () => {
        await new Promise<void>((resolve, reject) => {
          rasterImage.onload = () => resolve();
          rasterImage.onerror = () => reject(new Error('Could not load the SVG diagram.'));
          rasterImage.src = `${SVG_PREFIX}${encodeURIComponent(rasterSource)}`;
        });
        if (typeof rasterImage.decode === 'function') await rasterImage.decode();
      });
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is unavailable.');
      context.fillStyle = background;
      context.fillRect(0, 0, pixelWidth, pixelHeight);
      context.drawImage(rasterImage, 0, 0, pixelWidth, pixelHeight);
      const blob = await withTimeout(
        () =>
          new Promise<Blob>((resolve, reject) => {
            canvas.toBlob(
              (result) => (result ? resolve(result) : reject(new Error('Could not encode the PNG diagram.'))),
              'image/png',
            );
          }),
      );
      this.save(blob, 'diagram.png');
    } finally {
      rasterImage.onload = null;
      rasterImage.onerror = null;
    }
  }

  private save(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    try {
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
    } finally {
      anchor.remove();
      // Revoking synchronously can race the browser's download navigation.
      setTimeout(() => URL.revokeObjectURL(url), URL_CLEANUP_DELAY);
    }
  }
}
