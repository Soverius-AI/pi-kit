import { ipcRenderer, nativeImage } from 'electron';
import type { EncodedScreenshot, ScreenshotPixels } from './screenshot-encoder';

// This preload runs only in the private encoder renderer, never in the GUI or a project page.
ipcRenderer.once('pi-kit:encode-screenshot', (_event, pixels: ScreenshotPixels) => {
  try {
    const image = nativeImage.createFromBitmap(Buffer.from(pixels.bitmap), { width: pixels.width, height: pixels.height, scaleFactor: 1 });
    if (image.isEmpty()) throw new Error('Empty screenshot');
    const scaled = pixels.width > 1440 ? image.resize({ width: 1440 }) : image;
    const bytes = pixels.format === 'jpeg' ? scaled.toJPEG(pixels.quality) : scaled.toPNG();
    if (!bytes.length) throw new Error('Empty encoded screenshot');
    ipcRenderer.send('pi-kit:screenshot-encoded', { data: bytes.toString('base64'), mimeType: pixels.format === 'jpeg' ? 'image/jpeg' : 'image/png' } satisfies EncodedScreenshot);
  } catch {
    ipcRenderer.send('pi-kit:screenshot-encoded', { error: 'Could not encode the screenshot. Try a smaller capture.' });
  }
});
