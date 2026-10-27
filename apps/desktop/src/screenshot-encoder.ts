import { join } from 'node:path';
import { BrowserWindow, type NativeImage } from 'electron';
import { BrowserOperationError, type BrowserAction, type BrowserResult } from '@pi-kit/protocol';

export interface ScreenshotPixels {
  bitmap: Uint8Array;
  width: number;
  height: number;
  format: NonNullable<BrowserAction['format']>;
  quality: number;
}
export type EncodedScreenshot = NonNullable<BrowserResult['screenshot']>;

/** NativeImage codecs cannot run in Node workers. A private renderer owns all image processing. */
export function encodeScreenshot(image: NativeImage, format: ScreenshotPixels['format'], quality: number, signal: AbortSignal): Promise<EncodedScreenshot> {
  if (signal.aborted) return Promise.reject(new BrowserOperationError('cancelled', 'Browser capture cancelled.'));
  if (image.isEmpty()) return Promise.reject(new BrowserOperationError('failed', 'The browser returned an empty capture. Reload and try again.'));
  return new Promise((resolve, reject) => {
    const worker = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, 'screenshot-encoder-preload.cjs'),
        partition: 'pi-kit-screenshot-encoder',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    let finished = false;
    const finish = (error?: Error, result?: EncodedScreenshot): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (!worker.isDestroyed()) worker.destroy();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const cancel = (): void => finish(new BrowserOperationError('cancelled', 'Browser capture cancelled.'));
    const timer = setTimeout(() => finish(new BrowserOperationError('timeout', 'Screenshot encoding timed out. Try a smaller capture.')), 20_000);
    signal.addEventListener('abort', cancel, { once: true });
    worker.once('closed', () => finish(new BrowserOperationError('failed', 'The screenshot encoder closed. Try again.')));
    worker.webContents.once('render-process-gone', () => finish(new BrowserOperationError('failed', 'The screenshot encoder stopped. Try again.')));
    worker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    worker.webContents.on('will-navigate', (event) => event.preventDefault());
    worker.webContents.on('ipc-message', (_event, channel, reply: EncodedScreenshot & { error?: string }) => {
      if (channel !== 'pi-kit:screenshot-encoded') return;
      if (reply.error) finish(new BrowserOperationError('failed', reply.error));
      else if (typeof reply.data === 'string' && (reply.mimeType === 'image/png' || reply.mimeType === 'image/jpeg')) finish(undefined, reply);
      else finish(new BrowserOperationError('failed', 'The screenshot encoder returned an invalid image.'));
    });
    // This page contains no scripts, app bridge, credentials or project content. Only its bundled preload runs.
    void worker.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">').then(() => {
      if (finished) return;
      const scaleFactor = Math.max(...image.getScaleFactors());
      const { width, height } = image.getSize(scaleFactor);
      worker.webContents.send('pi-kit:encode-screenshot', { bitmap: image.toBitmap({ scaleFactor }), width, height, format, quality } satisfies ScreenshotPixels);
    }).catch(() => finish(new BrowserOperationError('failed', 'Could not start the screenshot encoder. Try again.')));
  });
}
