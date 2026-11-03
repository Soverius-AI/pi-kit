// Standalone native regression: no backend, model, credentials, or user profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { app, BrowserWindow, nativeImage, webContents } from 'electron';
import { BrowserArtifacts } from '../../apps/desktop/src/browser';

async function main(): Promise<void> {
  await app.whenReady();
  const server = createServer((request, response) => {
    if (request.url === '/hung') return;
    response.setHeader('Content-Type', 'text/html');
    response.end('<html><title>Rendering regression</title><body style="background:#123456;color:white"><h1>Original</h1><button onclick="document.querySelector(\'h1\').textContent=\'Changed\'">Change</button></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = new BrowserArtifacts();
  let host: BrowserWindow | undefined;
  try {
    for (const mode of ['initially-hidden', 'visible', 'hidden-again']) {
      if (mode === 'visible') {
        host = new BrowserWindow({ width: 1100, height: 900, show: true, focusable: false, skipTaskbar: true });
        await host.loadURL('data:text/html,<title>Isolated browser regression</title>');
        for (let width = 1000; width < 1020; width++) {
          browser.layout(host, { owner: 'test', threadId: 'page', bounds: { x: 0, y: 30, width, height: 750 } });
        }
      }
      if (mode === 'hidden-again') {
        assert.ok(host);
        browser.layout(host, { owner: 'test', threadId: 'page', bounds: null });
      }
      await browser.run('page', { action: 'navigate', url: base });
      const before = await browser.run('page', { action: 'snapshot' });
      const ref = before.text?.split('\n').find((line) => line.includes('button "Change"'))?.match(/^\[([^\]]+)\]/)?.[1];
      assert.ok(ref, `${mode}: reference for Change exists`);
      await browser.run('page', { action: 'click', ref });
      const after = await browser.run('page', { action: 'snapshot' });
      assert.match(after.text ?? '', /heading "Changed"/, `${mode}: AX reflects the current DOM`);
      for (const scope of ['viewport', 'fullpage'] as const) {
        const capture = await browser.run('page', { action: 'screenshot', scope, format: 'png' });
        assert.ok(capture.screenshot);
        const image = nativeImage.createFromBuffer(Buffer.from(capture.screenshot.data, 'base64'));
        const size = image.getSize();
        assert.ok(size.width > 500 && size.height > 500, `${mode}: positive capture size`);
        assert.deepEqual([...image.toBitmap().subarray(0, 4)], [0x56, 0x34, 0x12, 0xff], `${mode}/${scope}: actual fixture pixels, not a blank surface`);
      }
      console.log(`PASS ${mode}: current AX, viewport and fullpage pixels`);
    }
    // Full-page and selection capture must preserve scrolled/fixed geometry.
    await browser.run('page', { action: 'evaluate', code: `(() => {
      const target = document.createElement('button'); target.id = 'selection'; target.textContent = 'Crop target';
      target.style.cssText = 'position:fixed;top:100px;left:100px;width:120px;height:80px;background:#00ff00;color:#00ff00;border:0';
      document.body.append(target); const spacer = document.createElement('div'); spacer.style.height = '2000px'; document.body.append(spacer);
      scrollTo(0,300); return true;
    })()` });
    const snapshot = await browser.run('page', { action: 'snapshot' });
    const selected = snapshot.text?.split('\n').find((line) => line.includes('button "Crop target"'))?.match(/^\[([^\]]+)\]/)?.[1];
    assert.ok(selected);
    await browser.run('page', { action: 'inspect', ref: selected });
    const crop = await browser.run('page', { action: 'screenshot', scope: 'selection', format: 'png' });
    assert.ok(crop.screenshot);
    const image = nativeImage.createFromBuffer(Buffer.from(crop.screenshot.data, 'base64'));
    assert.deepEqual([...image.toBitmap().subarray(0, 4)], [0, 255, 0, 255], 'scrolled fixed selection is cropped correctly');
    const full = await browser.run('page', { action: 'screenshot', scope: 'fullpage', format: 'png' });
    assert.ok(full.screenshot);
    assert.ok(nativeImage.createFromBuffer(Buffer.from(full.screenshot.data, 'base64')).getSize().height > 1800, 'fullpage includes below-fold content');
    console.log('PASS scrolled selection and tall fullpage');
    // Long-lived requests must no longer hold the per-chat action queue indefinitely.
    const limited = new BrowserArtifacts(undefined, 8, 1500);
    try {
      await assert.rejects(limited.run('stalled', { action: 'navigate', url: `${base}/hung` }), (error: unknown) => (error as { code?: string }).code === 'timeout');
      assert.equal(limited.state('stalled').open, false);
      await limited.run('stalled', { action: 'navigate', url: base });
      assert.match((await limited.run('stalled', { action: 'snapshot' })).text ?? '', /heading "Original"/);
      console.log('PASS stalled navigation: deadline and fresh-page recovery');
      const stuck = webContents.getAllWebContents().filter((contents) => contents.getURL() === `${base}/`).sort((a, b) => b.id - a.id)[0];
      assert.ok(stuck, 'the replacement page exists');
      stuck.capturePage = () => new Promise(() => { /* reproduce a native capture which never answers */ });
      await assert.rejects(limited.run('stalled', { action: 'screenshot' }), (error: unknown) => (error as { code?: string }).code === 'timeout');
      assert.equal(limited.state('stalled').open, false);
      await limited.run('stalled', { action: 'navigate', url: base });
      assert.match((await limited.run('stalled', { action: 'snapshot' })).text ?? '', /heading "Original"/);
      console.log('PASS stalled native screenshot: retired page and fresh-page recovery');
    } finally { limited.dispose(); }
  } finally {
    browser.dispose();
    host?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
void main().then(() => app.exit(0), (error: unknown) => { console.error(error); app.exit(1); });
