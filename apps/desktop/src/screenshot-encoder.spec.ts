import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ workers: [] as { emit: (name: string, ...args: unknown[]) => void; webContents: EventEmitter & { send: ReturnType<typeof vi.fn> }; destroy: ReturnType<typeof vi.fn> }[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    BrowserWindow: class extends EventEmitter {
      readonly webContents = Object.assign(new EventEmitter(), { send: vi.fn(), setWindowOpenHandler: vi.fn() });
      private destroyed = false;
      constructor() { super(); native.workers.push(this); }
      isDestroyed = () => this.destroyed;
      loadURL = vi.fn(async () => undefined);
      destroy = vi.fn(() => { this.destroyed = true; this.emit('closed'); });
    },
  };
});
import { encodeScreenshot } from './screenshot-encoder';

const image = {
  isEmpty: () => false,
  getScaleFactors: () => [1],
  getSize: () => ({ width: 2, height: 2 }),
  toBitmap: () => Buffer.alloc(16, 255),
  resize: () => { throw new Error('Must not resize in main'); },
  toPNG: () => { throw new Error('Must not encode in main'); },
  toJPEG: () => { throw new Error('Must not encode in main'); },
};
const png = { data: 'encoded-in-worker', mimeType: 'image/png' };

afterEach(() => { native.workers.length = 0; vi.useRealTimers(); });

describe('screenshot encoder process', () => {
  it('sends raw pixels to the worker, forwards its result, and closes the worker', async () => {
    const pending = encodeScreenshot(image as never, 'png', 80, new AbortController().signal);
    const worker = native.workers[0];
    await vi.waitFor(() => expect(worker.webContents.send).toHaveBeenCalledWith('pi-kit:encode-screenshot', expect.objectContaining({ bitmap: Buffer.alloc(16, 255), width: 2, height: 2, format: 'png', quality: 80 })));
    worker.webContents.emit('ipc-message', {}, 'pi-kit:screenshot-encoded', png);
    expect(await pending).toEqual(png);
    expect(worker.destroy).toHaveBeenCalledTimes(1);
  });

  it('uses the same native scale for bitmap pixels and dimensions on Retina displays', async () => {
    const getSize = vi.fn(() => ({ width: 4, height: 4 }));
    const toBitmap = vi.fn(() => Buffer.alloc(64, 255));
    const pending = encodeScreenshot({ ...image, getScaleFactors: () => [1, 2], getSize, toBitmap } as never, 'png', 80, new AbortController().signal);
    const worker = native.workers[0];
    await vi.waitFor(() => expect(worker.webContents.send).toHaveBeenCalledWith('pi-kit:encode-screenshot', expect.objectContaining({ width: 4, height: 4, bitmap: Buffer.alloc(64, 255) })));
    expect(getSize).toHaveBeenCalledWith(2);
    expect(toBitmap).toHaveBeenCalledWith({ scaleFactor: 2 });
    worker.webContents.emit('ipc-message', {}, 'pi-kit:screenshot-encoded', png);
    await pending;
  });

  it.each(['abort', 'crash', 'close', 'timeout'])('rejects and cleans up on %s; the next job can succeed', async (reason) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = encodeScreenshot(image as never, 'jpeg', 35, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    const worker = native.workers[0];
    if (reason === 'abort') controller.abort();
    else if (reason === 'crash') worker.webContents.emit('render-process-gone', {}, {});
    else if (reason === 'close') worker.emit('closed');
    else await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(worker.destroy).toHaveBeenCalledTimes(1);
    const next = encodeScreenshot(image as never, 'png', 80, new AbortController().signal);
    native.workers[1].webContents.emit('ipc-message', {}, 'pi-kit:screenshot-encoded', png);
    expect(await next).toEqual(png);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a worker for a cancelled job or an empty capture', async () => {
    await expect(encodeScreenshot(image as never, 'png', 80, AbortSignal.abort())).rejects.toThrow('cancelled');
    await expect(encodeScreenshot({ ...image, isEmpty: () => true } as never, 'png', 80, new AbortController().signal)).rejects.toThrow('empty');
    expect(native.workers).toHaveLength(0);
  });
});
