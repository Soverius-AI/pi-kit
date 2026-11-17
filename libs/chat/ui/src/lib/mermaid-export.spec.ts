import { MermaidExport } from './mermaid-export';

const svg = (viewBox = '0 0 640 360') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="100%" style="max-width:640px"><text>Diagram ✓</text></svg>`;
const uri = (source = svg()) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

describe('MermaidExport', () => {
  let exporter: MermaidExport;
  let saved: Blob[];
  let downloads: { filename: string; href: string; connected: boolean }[];
  let images: MockImage[];
  let canvases: HTMLCanvasElement[];
  let failLoad: boolean;
  let stallLoad: boolean;
  const decode = vi.fn<() => Promise<void>>();
  const revoke = vi.fn();
  const fillRect = vi.fn();
  const drawImage = vi.fn();
  const context = { fillStyle: '', fillRect, drawImage };
  const toBlob = vi.fn<(callback: BlobCallback, type?: string, quality?: number) => void>();

  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    source = '';
    decode = decode;
    constructor() {
      images.push(this);
    }
    set src(value: string) {
      this.source = value;
      if (!stallLoad) queueMicrotask(() => (failLoad ? this.onerror?.() : this.onload?.()));
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    exporter = new MermaidExport();
    saved = [];
    downloads = [];
    images = [];
    canvases = [];
    failLoad = false;
    stallLoad = false;
    decode.mockReset().mockResolvedValue();
    revoke.mockReset();
    fillRect.mockReset();
    drawImage.mockReset();
    context.fillStyle = '';
    vi.stubGlobal('Image', MockImage);
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL(blob: Blob | MediaSource): string {
          saved.push(blob as Blob);
          return 'blob:diagram';
        }
        static override revokeObjectURL = revoke;
      },
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ filename: this.download, href: this.href, connected: this.isConnected });
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      canvases.push(this);
      return context as unknown as CanvasRenderingContext2D;
    });
    toBlob.mockReset().mockImplementation((callback) => {
      callback(new Blob(['png bytes'], { type: 'image/png' }));
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(toBlob);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('downloads exact UTF-8 SVG bytes with SVG MIME and removes the temporary anchor', async () => {
    await exporter.download(uri(), 'svg', 'rgb(20, 20, 20)');
    expect(saved[0].type).toBe('image/svg+xml');
    expect(await saved[0].text()).toBe(svg());
    expect(downloads).toEqual([{ filename: 'diagram.svg', href: 'blob:diagram', connected: true }]);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith('blob:diagram');
    expect(images).toHaveLength(0);
  });

  it('renders PNG at 2x viewBox dimensions, not natural image width, and flattens the theme background', async () => {
    await exporter.download(uri(svg('-10 -20 640 360')), 'png', 'rgb(24, 25, 26)');
    expect(canvases[0].width).toBe(1280);
    expect(canvases[0].height).toBe(720);
    expect(context.fillStyle).toBe('rgb(24, 25, 26)');
    expect(fillRect).toHaveBeenCalledWith(0, 0, 1280, 720);
    expect(drawImage).toHaveBeenCalledWith(images[0], 0, 0, 1280, 720);
    expect(fillRect.mock.invocationCallOrder[0]).toBeLessThan(drawImage.mock.invocationCallOrder[0]);
    const raster = new DOMParser().parseFromString(decodeURIComponent(images[0].source.split(',')[1]), 'image/svg+xml');
    expect(raster.documentElement.getAttribute('width')).toBe('1280');
    expect(raster.documentElement.getAttribute('height')).toBe('720');
    expect(raster.documentElement.getAttribute('viewBox')).toBe('-10 -20 640 360');
    expect(raster.documentElement.getAttribute('style')).not.toContain('max-width');
    expect(decode).toHaveBeenCalledOnce();
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    expect(saved[0].type).toBe('image/png');
    expect(downloads[0].filename).toBe('diagram.png');
    expect(images[0].onload).toBeNull();
    expect(images[0].onerror).toBeNull();
  });

  it.each(['0 0 100000 100000', '0 0 1000000000 100', '0 0 100 1000000000'])(
    'bounds large canvas dimensions and area: %s',
    async (bounds) => {
      await exporter.download(uri(svg(bounds)), 'png', 'white');
      const canvas = canvases[0];
      expect(canvas.width).toBeGreaterThan(0);
      expect(canvas.height).toBeGreaterThan(0);
      expect(canvas.width).toBeLessThanOrEqual(8192);
      expect(canvas.height).toBeLessThanOrEqual(8192);
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(16_000_000);
      if (bounds === '0 0 100000 100000') expect([canvas.width, canvas.height]).toEqual([4000, 4000]);
    },
  );

  it.each([
    'https://example.test/diagram.svg',
    'data:text/html,<svg/>',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/svg+xml;charset=utf-8,%ZZ',
    uri('<svg>'),
    uri('<html xmlns="http://www.w3.org/1999/xhtml"/>'),
    uri('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ...['0 0 0 10', '0 0 -1 10', '0 0 Infinity 10', '0 0 NaN 10', '0 0 10', '0 0 1e20 10'].map((box) => uri(svg(box))),
  ])('rejects invalid URL, XML, root, or bounds without starting a download: %s', async (image) => {
    await expect(exporter.download(image, 'svg', 'white')).rejects.toThrow();
    expect(saved).toHaveLength(0);
    expect(images).toHaveLength(0);
  });

  it('rejects image loading and decode failures and clears event handlers', async () => {
    failLoad = true;
    await expect(exporter.download(uri(), 'png', 'white')).rejects.toThrow('load');
    expect(images[0].onerror).toBeNull();
    failLoad = false;
    decode.mockRejectedValueOnce(new Error('decode failed'));
    await expect(exporter.download(uri(), 'png', 'white')).rejects.toThrow('decode failed');
    expect(images[1].onload).toBeNull();
    expect(saved).toHaveLength(0);
  });

  it('rejects unavailable contexts, drawing failures, and failed or throwing PNG encoders', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValueOnce(null);
    await expect(exporter.download(uri(), 'png', 'white')).rejects.toThrow('Canvas');
    drawImage.mockImplementationOnce(() => {
      throw new Error('tainted canvas');
    });
    await expect(exporter.download(uri(), 'png', 'white')).rejects.toThrow('tainted');
    toBlob.mockImplementationOnce((callback) => callback(null));
    await expect(exporter.download(uri(), 'png', 'white')).rejects.toThrow('encode');
    toBlob.mockImplementationOnce(() => {
      throw new Error('encoder failed');
    });
    await expect(exporter.download(uri(), 'png', 'white')).rejects.toThrow('encoder failed');
    expect(saved).toHaveLength(0);
  });

  it.each(['load', 'decode', 'encode'])(
    'times out stalled image %s or PNG encoding without downloading',
    async (stage) => {
      if (stage === 'load') stallLoad = true;
      if (stage === 'decode') decode.mockImplementationOnce(() => new Promise<void>(() => undefined));
      if (stage === 'encode') toBlob.mockImplementationOnce(() => undefined);
      const download = exporter.download(uri(), 'png', 'white');
      const rejection = expect(download).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      expect(images[0].onload).toBeNull();
      expect(images[0].onerror).toBeNull();
      expect(saved).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('caps SVG source size at one megabyte, including UTF-8 byte size', async () => {
    for (const text of ['a'.repeat(1_000_001), '✓'.repeat(340_000)]) {
      await expect(exporter.download(uri(svg().replace('Diagram ✓', text)), 'svg', 'white')).rejects.toThrow(
        'too large',
      );
    }
    expect(saved).toHaveLength(0);
  });

  it('removes the anchor and schedules URL cleanup even when clicking fails', async () => {
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementationOnce(() => {
      throw new Error('download failed');
    });
    await expect(exporter.download(uri(), 'svg', 'white')).rejects.toThrow('download failed');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith('blob:diagram');
  });
});
