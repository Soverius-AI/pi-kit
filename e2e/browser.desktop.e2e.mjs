// A real Electron window and backend, isolated from the user's pi folder and app data. No model request is needed: REST and pi_browser share this same native page.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, afterEach, before, describe, it } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron } from 'playwright';
import { build } from 'esbuild';
import { createWorld, root } from './support/env.mjs';

let app, page, world, server, base, connection, first, browserTool;
const fixture = `<!doctype html><html><head><title>Artifact fixture</title><style>body { background: #123456; color: white; }</style></head><body><h1>Counter</h1><button onclick="document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1">Increment</button><p id="count">0</p><form onsubmit="event.preventDefault();document.querySelector('#greeting').textContent='Hello '+document.querySelector('input').value"><label>Name <input aria-label="Name" value="before"></label><button>Greet</button></form><p id="greeting" role="status"></p><script>console.log('artifact-ready');window.triggerArtifactError=()=>setTimeout(()=>{throw new Error('artifact-runtime-boom')},0);</script></body></html>`;

async function until(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* page is still loading */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${message}`);
}
async function call(path, body) {
  const response = await fetch(`${connection.url}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${connection.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const answer = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${answer.message}`);
  return answer;
}
const action = (id, body) => call(`/threads/${id}/browser/action`, body);
const evaluate = async (id, code) => JSON.parse((await action(id, { action: 'evaluate', code })).text);
async function assertPagePixels(screenshot) {
  // A valid PNG can still be a blank native view. Decode actual pixels through Electron.
  const pixel = await app.evaluate(({ nativeImage }, data) => {
    const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
    return [...image.toBitmap().subarray(0, 4)];
  }, screenshot.data);
  assert.deepEqual(pixel, [0x56, 0x34, 0x12, 0xff], 'the fixture background is rendered, including while hidden');
}
async function newThread() {
  const created = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/threads');
  const selected = page.waitForRequest(async (request) => request.method() === 'PUT' && new URL(request.url()).pathname === '/api/settings/thread' && request.postDataJSON()?.value === (await (await created).json()).id);
  await Promise.all([created, selected, page.getByTestId('new-thread').click()]);
  const thread = await (await created).json();
  await page.getByLabel('Message to pi').waitFor();
  return thread.id;
}
async function nativeUrls() {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://pi-kit'));
    return window?.contentView.children.map((view) => view.webContents?.getURL()).filter(Boolean) ?? [];
  });
}

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY' });
    res.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  world = createWorld({ offline: true });
  const env = { ...process.env, ...world.env, PI_KIT_SMOKE: '1', PI_KIT_DATA_DIR: world.data };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: [join(root, 'dist/apps/desktop/main.cjs')], env });
  await until(() => {
    page = app.windows().find((window) => window.url().startsWith('app://pi-kit'));
    return !!page;
  }, 'the desktop renderer', 60_000);
  await page.waitForSelector('pk-root .pk-shell');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://pi-kit'))?.setSize(1700, 1000));
  connection = await page.evaluate(async () => ({ url: await window.piKit.getBackendUrl(), token: await window.piKit.getToken() }));
  // Production desktop builds correctly ignore the dev-only trust override; approve this test's scratch project in the real dialog.
  await page.getByRole('button', { name: 'Trust once', exact: true }).click();
  await page.locator('pk-trust-dialog dialog').waitFor({ state: 'detached' });
  first = await newThread();
  // Compile the production extension without adding test-only exports to the backend bundle.
  const compiled = await build({ entryPoints: [join(root, 'apps/backend/src/pi/browser-extension.ts')], bundle: true, platform: 'node', format: 'esm', write: false, define: { __dirname: JSON.stringify(join(root, 'apps/backend/src/pi')) }, logLevel: 'silent',
    // CommonJS dependencies (yaml) call require(): give the in-memory module a real one, resolved from the repository.
    banner: { js: `import { createRequire as __pkCreateRequire } from 'node:module'; const require = __pkCreateRequire(${JSON.stringify(join(root, 'package.json'))});` } });
  const { createBrowserExtension } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  createBrowserExtension({ threadId: first, host: () => ({ available: true, run: (id, input) => action(id, input) }) })({ registerTool: (tool) => { browserTool = tool; }, on: () => undefined });
  const commands = await call(`/threads/${first}/commands`);
  assert.ok(commands.some((command) => command.name === 'skill:pi-browser'), 'the running backend discovers the packaged browser skill');
});

after(async () => {
  await app?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
  world?.dispose();
});

afterEach(async (context) => {
  if (context.passed) return;
  console.error('browser diagnostics', await app.evaluate(({ webContents, BrowserWindow }) => ({ pages: webContents.getAllWebContents().map((w) => ({ id:w.id, url:w.getURL(), loading:w.isLoading() })), views: BrowserWindow.getAllWindows().map(w=>w.contentView.children.length) })));
  console.error('browser state', await call(`/threads/${first}/browser`));
  console.error('panel alert', await page.getByRole('alert').allTextContents());
});

describe('desktop browser artifact', () => {
  it('opens a real project page in Artifacts and exposes the same page to browser actions', async () => {
    await page.getByRole('button', { name: 'Artifacts', exact: true }).click();
    const address = page.getByLabel('Browser address');
    await address.waitFor();
    await address.fill(base);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await until(async () => (await call(`/threads/${first}/browser`)).title === 'Artifact fixture', 'the project loads');
    await until(async () => (await nativeUrls()).includes(`${base}/`), 'the page is mounted in the panel');
    assert.equal(await evaluate(first, 'document.querySelector("h1").textContent'), 'Counter');
    assert.deepEqual(await evaluate(first, '[typeof window.piKit, typeof require, typeof process]'), ['undefined', 'undefined', 'undefined']);
  });

  it('uses accessibility references to click and fill, submits with Enter and returns a screenshot', async () => {
    const snapshot = (await action(first, { action: 'snapshot' })).text;
    const ref = (role, name) => {
      const line = snapshot.split('\n').find((line) => line.includes(`${role} ${JSON.stringify(name)}`));
      const match = line?.match(/^\[([^\]]+)\]/);
      assert.ok(match, `Missing ${role} ${name} in ${snapshot}`);
      return match[1];
    };
    await action(first, { action: 'click', ref: ref('button', 'Increment') });
    assert.equal(await evaluate(first, 'document.querySelector("#count").textContent'), '1');
    await action(first, { action: 'fill', ref: ref('textbox', 'Name'), text: 'Ada' });
    assert.equal(await evaluate(first, 'document.querySelector("input").value'), 'Ada');
    await action(first, { action: 'press', key: 'Enter' });
    assert.equal(await evaluate(first, 'document.querySelector("#greeting").textContent'), 'Hello Ada');
    const toolResult = await browserTool.execute('native-capture', { action: 'screenshot', format: 'png' });
    const state = JSON.parse(toolResult.content.find((item) => item.type === 'text').text).state;
    assert.equal(state.threadId, first);
    assert.equal(state.url, `${base}/`, 'the production pi_browser tool sees the same visible page');
    const result = { screenshot: toolResult.content.find((item) => item.type === 'image') };
    const png = Buffer.from(result.screenshot.data, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.length > 1000, 'the screenshot contains rendered pixels');
    await assertPagePixels(result.screenshot);
    assert.match((await action(first, { action: 'console' })).text, /artifact-ready/);
    if (process.env.BROWSER_E2E_ARTIFACT_DIR) {
      mkdirSync(process.env.BROWSER_E2E_ARTIFACT_DIR, { recursive: true });
      writeFileSync(join(process.env.BROWSER_E2E_ARTIFACT_DIR, 'browser-page.png'), png);
      await page.screenshot({ path: join(process.env.BROWSER_E2E_ARTIFACT_DIR, 'artifacts-panel.png') });
    }
  });

  it('keeps icon tools accessible and preserves the page through panel resize and expand/shrink', async () => {
    const tools = page.getByRole('group', { name: 'Side panel', exact: true });
    for (const name of ['Tree', 'Files', 'Changes', 'Terminal', 'Artifacts']) {
      const button = tools.getByRole('button', { name, exact: true });
      assert.equal(await button.locator('pk-icon').count(), 1);
      assert.equal((await button.textContent()).trim(), '', 'tool buttons save space with accessible icons');
    }
    const artifacts = tools.getByRole('button', { name: 'Artifacts', exact: true });
    await page.keyboard.press('Tab');
    await artifacts.focus();
    await page.getByRole('tooltip').filter({ hasText: 'Artifacts' }).waitFor();
    await artifacts.press('Escape');
    const handle = page.getByRole('separator', { name: 'Resize side panel', exact: true });
    const viewport = page.getByTestId('browser-viewport');
    const before = await viewport.boundingBox();
    const edge = await handle.boundingBox();
    await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
    await page.mouse.down();
    await page.mouse.move(edge.x - 120, edge.y + 200, { steps: 5 });
    await page.mouse.up();
    await until(async () => (await viewport.boundingBox()).width > before.width + 100, 'the panel widened');
    await until(async () => (await call('/settings')).panelWidth > 500, 'the preferred width was saved');
    await until(async () => (await nativeUrls()).includes(`${base}/`), 'the resized native page is restored');
    const counter = await evaluate(first, 'document.querySelector("#count").textContent');
    const docked = await viewport.boundingBox();
    await page.getByRole('button', { name: 'Expand', exact: true }).click();
    await until(async () => (await viewport.boundingBox()).width > docked.width + 200, 'the browser expanded');
    await page.getByRole('button', { name: 'Shrink', exact: true }).click();
    await until(async () => Math.abs((await viewport.boundingBox()).width - docked.width) < 2, 'the preferred docked width returned');
    assert.equal(await evaluate(first, 'document.querySelector("#count").textContent'), counter, 'resizing does not reload the page');
    await handle.press('Home');
    await until(async () => (await call('/settings')).panelWidth === 320, 'keyboard resizing saved the minimum width');
    await handle.dblclick();
    await until(async () => (await call('/settings')).panelWidth === 400, 'double-click restored the default width');
  });

  it('loads each panel from the compact menu and restores keyboard focus', async () => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://pi-kit'))?.setSize(1440, 1000));
    const pocket = page.getByRole('button', { name: 'Side panels', exact: true });
    try {
      await pocket.waitFor();
      await pocket.focus();
      await pocket.press('ArrowDown');
      const menu = page.getByRole('menu', { name: 'Side panels', exact: true });
      await menu.waitFor();
      await until(() => menu.getByRole('menuitemcheckbox', { name: 'Tree', exact: true }).evaluate((item) => item === document.activeElement), 'the menu receives keyboard focus');
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      assert.equal(await pocket.evaluate((item) => item === document.activeElement), true);
      for (const [label, selector] of [['Tree', 'pk-session-panel'], ['Files', 'pk-files-panel'], ['Changes', 'pk-changes-panel'], ['Terminal', 'pk-terminal-panel'], ['Artifacts', 'pk-artifacts-panel']]) {
        await pocket.click();
        await menu.getByRole('menuitemcheckbox', { name: label, exact: true }).click();
        await page.locator(selector).waitFor();
        await menu.waitFor({ state: 'detached' });
      }
      await until(async () => (await nativeUrls()).includes(`${base}/`), 'the retained browser returns after switching panels');
      assert.equal(await evaluate(first, 'document.querySelector("#count").textContent'), '1');
    } finally {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://pi-kit'))?.setSize(1700, 1000));
    }
  });

  it('keeps capture choices above the native view and makes inspection visibly stoppable', async () => {
    const capture = page.getByRole('button', { name: 'Screenshot', exact: true });
    await capture.click();
    const options = page.getByRole('region', { name: 'Screenshot options' });
    await options.waitFor();
    assert.equal(await capture.getAttribute('aria-expanded'), 'true');
    assert.equal(await options.locator('select').count(), 0, 'capture choices never open a popup behind the native view');
    await options.getByRole('button', { name: 'Whole page', exact: true }).click();
    await until(async () => (await options.getByRole('button', { name: 'Whole page', exact: true }).getAttribute('aria-pressed')) === 'true', 'full page capture is selected');
    const optionBounds = await options.boundingBox();
    const viewport = page.getByTestId('browser-viewport');
    await until(async () => (await viewport.boundingBox()).y >= optionBounds.y + optionBounds.height, 'the options have their own space above the native view');
    await until(async () => app.evaluate(({ BrowserWindow }, top) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://pi-kit'));
      const view = window.contentView.children.find((v) => v.webContents?.getURL().startsWith('http://127.0.0.1:'));
      return view?.getBounds().y >= top;
    }, optionBounds.y + optionBounds.height), 'the native view moves below the capture choices');
    if (process.env.BROWSER_E2E_ARTIFACT_DIR) await page.locator('pk-artifacts-panel').screenshot({ path: join(process.env.BROWSER_E2E_ARTIFACT_DIR, 'capture-options.png') });
    await capture.click();
    await options.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Inspect', exact: true }).click();
    const stop = page.getByRole('button', { name: 'Stop inspecting', exact: true });
    await until(async () => (await stop.getAttribute('aria-pressed')) === 'true', 'the inspection button is active');
    assert.match(await stop.getAttribute('class'), /inspect-active/);
    await page.getByRole('status').filter({ hasText: 'Inspection active.' }).waitFor();
    if (process.env.BROWSER_E2E_ARTIFACT_DIR) await page.locator('pk-artifacts-panel').screenshot({ path: join(process.env.BROWSER_E2E_ARTIFACT_DIR, 'inspection-active.png') });
    // Leaving focus in the native page must still allow stopping from the toolbar.
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((wc) => wc.getURL() === url).focus(), `${base}/`);
    await stop.click();
    await until(async () => !(await call(`/threads/${first}/browser`)).inspecting, 'the toolbar stops native inspection');
    await page.getByRole('button', { name: 'Inspect', exact: true }).waitFor();
    await page.getByRole('status').filter({ hasText: 'Inspection active.' }).waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Inspect', exact: true }).click();
    await stop.waitFor();
    await stop.press('Escape');
    await until(async () => !(await call(`/threads/${first}/browser`)).inspecting, 'Escape in the toolbar stops inspection');
  });

  it('picks an element without clicking it, captures its pixels, and attaches screenshots and console context to the draft', async () => {
    await page.getByRole('button', { name: 'Inspect', exact: true }).click();
    await until(async () => (await call(`/threads/${first}/browser`)).inspecting, 'native inspection begins');
    await app.evaluate(async ({ webContents }, url) => {
      const target = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
      const point = await target.executeJavaScript(`(() => { const r = document.querySelector('button').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
      target.focus();
      target.sendInputEvent({ type: 'mouseMove', ...point });
      target.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      target.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    }, `${base}/`);
    await until(async () => (await call(`/threads/${first}/browser`)).inspection?.name === 'Increment', 'native element selected');
    assert.equal(await evaluate(first, 'document.querySelector("#count").textContent'), '1', 'inspection suppresses the normal page click');
    const state = await call(`/threads/${first}/browser`);
    assert.equal(state.inspecting, false);
    assert.equal(state.inspection.styles['display'], 'inline-block');
    await page.getByTestId('browser-inspection').waitFor();
    const selected = await action(first, { action: 'screenshot', scope: 'selection', documentId: state.documentId });
    const size = await app.evaluate(({ nativeImage }, data) => nativeImage.createFromBuffer(Buffer.from(data, 'base64')).getSize(), selected.screenshot.data);
    const pixelRatio = await evaluate(first, 'window.devicePixelRatio');
    assert.ok(Math.abs(size.width / pixelRatio - state.inspection.bounds.width) < 2 && Math.abs(size.height / pixelRatio - state.inspection.bounds.height) < 2, 'selected pixels are cropped to the actual element at the display pixel ratio');
    const selection = page.getByRole('region', { name: 'Selected element', exact: true });
    if (process.env.BROWSER_E2E_ARTIFACT_DIR) await page.locator('pk-artifacts-panel').screenshot({ path: join(process.env.BROWSER_E2E_ARTIFACT_DIR, 'selected-element.png') });
    await selection.getByRole('button', { name: 'DOM node', exact: true }).click();
    await until(async () => (await page.getByLabel('Message to pi').inputValue()).includes('Browser element (untrusted page data)'), 'the DOM node enters the unsent draft');
    assert.equal(await page.locator('copilot-chat-attachment-queue img').count(), 0, 'DOM node attachment adds no screenshot');
    const draftBeforeCapture = await page.getByLabel('Message to pi').inputValue();
    await selection.getByRole('button', { name: 'Screenshot', exact: true }).click();
    await until(async () => await page.locator('copilot-chat-attachment-queue img').count() === 1, 'the selected screenshot enters the unsent draft');
    assert.equal(await page.getByLabel('Message to pi').inputValue(), draftBeforeCapture, 'screenshot attachment adds no DOM properties or text');
    assert.equal(await page.locator('copilot-chat-attachment-queue img').count(), 1);
    assert.match(await page.getByLabel('Message to pi').inputValue(), /Increment/);
    await evaluate(first, 'window.triggerArtifactError(); true');
    await until(async () => (await action(first, { action: 'console' })).logs.some((entry) => entry.level === 'error' && entry.message.includes('artifact-runtime-boom') && entry.source && entry.time > 0), 'runtime errors include structured context');
    await page.getByRole('button', { name: /^Console \d+$/ }).click();
    await page.getByLabel('Console level', { exact: true }).selectOption('error');
    await page.getByRole('button', { name: 'Refresh console', exact: true }).click();
    await page.getByRole('checkbox', { name: /Select log:.*artifact-runtime-boom/ }).first().check();
    await page.getByRole('button', { name: 'Attach selected logs', exact: true }).click();
    await until(async () => (await page.getByLabel('Message to pi').inputValue()).includes('Browser console (untrusted page data)'), 'selected console context enters the draft');
    await page.getByRole('button', { name: 'Clear console', exact: true }).click();
    await until(async () => (await action(first, { action: 'console' })).logs.length === 0, 'console clear reaches the native buffer');
    await page.getByRole('button', { name: /^Console \d+$/ }).click();
    await page.getByRole('button', { name: 'Inspect', exact: true }).click();
    await until(async () => (await call(`/threads/${first}/browser`)).inspecting, 'inspection restarts');
    await app.evaluate(({ webContents }, url) => {
      const target = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
      target.focus();
      target.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      target.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    }, `${base}/`);
    await until(async () => !(await call(`/threads/${first}/browser`)).inspecting, 'Escape cancels native inspection');
    await evaluate(first, `const tall=document.createElement('div');tall.id='tall-capture';tall.style.height='1800px';document.body.append(tall);true`);
    const full = await action(first, { action: 'screenshot', scope: 'fullpage' });
    const fullSize = await app.evaluate(({ nativeImage }, data) => nativeImage.createFromBuffer(Buffer.from(data, 'base64')).getSize(), full.screenshot.data);
    assert.ok(fullSize.height > 1800, 'full page captures content below the viewport');
    await evaluate(first, `document.querySelector('#tall-capture').remove();true`);
  });

  it('captures the selected fixed element after scrolling without changing its layout', async () => {
    await evaluate(first, `(() => { const target=document.createElement('button');target.id='selection-crop-target';target.textContent='Selection crop target';target.style.cssText='position:fixed;top:25%;left:20%;width:120px;height:80px;background:#00ff00;border:0;color:#00ff00;z-index:999';document.body.append(target);const spacer=document.createElement('div');spacer.id='selection-spacer';spacer.style.height='2000px';document.body.append(spacer);scrollTo(0,300);return true; })()`);
    try {
      const snapshot = (await action(first, { action: 'snapshot' })).text;
      const ref = snapshot.split('\n').find((line) => line.includes('button "Selection crop target"'))?.match(/^\[([^\]]+)\]/)?.[1];
      assert.ok(ref);
      await action(first, { action: 'inspect', ref });
      await page.getByTestId('browser-inspection').getByText('Selection crop target', { exact: true }).waitFor();
      await until(async () => Math.abs((await page.getByTestId('browser-viewport').boundingBox()).height - await evaluate(first, 'innerHeight')) < 1, 'the inspector layout is reflected in the native view');
      const before = await evaluate(first, '({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY})');
      const result = await action(first, { action: 'screenshot', scope: 'selection', format: 'png' });
      const pixels = await app.evaluate(({ nativeImage }, data) => {
        const image=nativeImage.createFromBuffer(Buffer.from(data,'base64'));const size=image.getSize();const bitmap=image.toBitmap();
        return { size, samples: [[0.1,0.1],[0.5,0.5],[0.9,0.9]].map(([x,y]) => [...bitmap.subarray((Math.floor(size.height*y)*size.width+Math.floor(size.width*x))*4,(Math.floor(size.height*y)*size.width+Math.floor(size.width*x))*4+4)]) };
      }, result.screenshot.data);
      const density = await evaluate(first, 'devicePixelRatio');
      assert.ok(Math.abs(pixels.size.width / density - 120) < 2 && Math.abs(pixels.size.height / density - 80) < 2, JSON.stringify({ size: pixels.size, density }));
      assert.deepEqual(pixels.samples, [[0,255,0,255],[0,255,0,255],[0,255,0,255]], 'the crop contains the selected element, including after scroll');
      assert.deepEqual(await evaluate(first, '({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY})'), before);
    } finally {
      await evaluate(first, `document.querySelector('#selection-crop-target')?.remove();document.querySelector('#selection-spacer')?.remove();scrollTo(0,0);true`);
      const snapshot = (await action(first, { action: 'snapshot' })).text;
      const ref = snapshot.split('\n').find((line) => line.includes('button "Increment"'))?.match(/^\[([^\]]+)\]/)?.[1];
      if (ref) await action(first, { action: 'inspect', ref });
    }
  });

  it('compresses screenshots as JPEG or PNG, captures visible or whole pages, and saves inspector choices', async () => {
    await evaluate(first, `(() => {
      const canvas=document.createElement('canvas');canvas.id='encoding-fixture';canvas.width=600;canvas.height=1400;
      canvas.style.cssText='display:block;width:100%;height:1400px';
      const context=canvas.getContext('2d'), pixels=context.createImageData(600,1400);
      let seed=17;
      for(let i=0;i<pixels.data.length;i+=4) {
        seed=(Math.imul(seed,1664525)+1013904223)>>>0;
        pixels.data[i]=seed&255;pixels.data[i+1]=(seed>>>8)&255;pixels.data[i+2]=(seed>>>16)&255;pixels.data[i+3]=255;
      }
      context.putImageData(pixels,0,0);document.body.append(canvas);scrollTo(0,0);return true;
    })()`);
    try {
      const capture = async (options) => (await action(first, { action: 'screenshot', ...options })).screenshot;
      const png = await capture({ scope: 'fullpage', format: 'png' });
      const jpeg = await capture({ scope: 'fullpage', format: 'jpeg', quality: 80 });
      const compressed = await capture({ scope: 'fullpage', format: 'jpeg', quality: 20 });
      const visible = await capture({ scope: 'viewport', format: 'jpeg', quality: 80 });
      const bytes = (image) => Buffer.from(image.data, 'base64');
      assert.equal(png.mimeType, 'image/png');
      assert.equal(bytes(png).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(jpeg.mimeType, 'image/jpeg');
      assert.equal(bytes(jpeg).subarray(0, 3).toString('hex'), 'ffd8ff');
      assert.ok(bytes(jpeg).length < bytes(png).length, 'JPEG reduces the detailed screenshot size');
      assert.ok(bytes(compressed).length < bytes(jpeg).length, 'lower JPEG quality reduces size further');
      const dimensions = (image) => app.evaluate(({ nativeImage }, data) => nativeImage.createFromBuffer(Buffer.from(data, 'base64')).getSize(), image.data);
      assert.ok((await dimensions(jpeg)).height > (await dimensions(visible)).height, 'whole page includes content below the visible area');
      console.log('screenshot bytes', { png: bytes(png).length, jpeg80: bytes(jpeg).length, jpeg20: bytes(compressed).length });

      const toggle = page.getByRole('group', { name: 'Browser tools', exact: true }).getByRole('button', { name: 'Screenshot', exact: true });
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      const options = page.getByRole('region', { name: 'Screenshot options', exact: true });
      await options.getByRole('group', { name: 'Screenshot format', exact: true }).getByRole('button', { name: 'JPEG', exact: true }).click();
      await options.getByLabel('Screenshot JPEG quality', { exact: true }).evaluate((input) => {
        input.value = '35';input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await until(async () => (await call('/settings')).screenshotQuality === 35, 'JPEG quality saved');
      await options.getByRole('group', { name: 'Screenshot format', exact: true }).getByRole('button', { name: 'PNG', exact: true }).click();
      await until(async () => (await call('/settings')).screenshotFormat === 'png', 'PNG preference saved');
      assert.equal(await options.getByLabel('Screenshot JPEG quality', { exact: true }).count(), 0, 'PNG is lossless and has no JPEG quality control');
      assert.equal((await capture({ scope: 'viewport' })).mimeType, 'image/png', 'agent captures use saved inspector preferences');
      await toggle.click();await toggle.click();
      assert.equal(await options.getByRole('group', { name: 'Screenshot format', exact: true }).getByRole('button', { name: 'PNG', exact: true }).getAttribute('aria-pressed'), 'true');
      await options.getByRole('group', { name: 'Screenshot format', exact: true }).getByRole('button', { name: 'JPEG', exact: true }).click();
      assert.equal(await options.getByLabel('Screenshot JPEG quality', { exact: true }).inputValue(), '35');
      await options.getByRole('button', { name: 'Whole page', exact: true }).click();
      const response = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith(`/threads/${first}/browser/action`) && res.request().postDataJSON()?.action === 'screenshot');
      await options.getByRole('button', { name: 'Attach screenshot', exact: true }).click();
      const result = await response;
      assert.equal((await result.json()).screenshot.mimeType, 'image/jpeg');
      assert.equal(result.request().postDataJSON().scope, 'fullpage');
      assert.equal(result.request().postDataJSON().quality, 35);
      await until(async () => (await page.locator('copilot-chat-attachment-queue img').count()) >= 2, 'compressed screenshot attaches to the draft');
      await options.getByRole('button', { name: 'Visible area', exact: true }).click();
      await until(async () => (await options.getByRole('button', { name: 'Visible area', exact: true }).getAttribute('aria-pressed')) === 'true', 'visible area capture is selected');
    } finally {
      await evaluate(first, `document.querySelector('#encoding-fixture')?.remove();true`);
    }
  });

  it('encodes every capture scope outside the GUI main process and releases the encoder', async () => {
    await evaluate(first, `(() => { const end=document.createElement('div');end.id='raw-capture-end';end.style.cssText='height:1800px;background:red';document.body.append(end);scrollTo(0,100);return true; })()`);
    await app.evaluate(({ app, nativeImage }) => {
      const prototype = Object.getPrototypeOf(nativeImage.createEmpty());
      const saved = {};
      for (const name of ['resize', 'toPNG', 'toJPEG']) {
        saved[name] = prototype[name];
        prototype[name] = () => { throw new Error('Image processing must not run in main'); };
      }
      const workers = [];
      const created = (_event, wc) => {
        wc.once('did-finish-load', () => { if (wc.getURL().startsWith('data:text/html,')) workers.push(wc.getOSProcessId()); });
      };
      app.on('web-contents-created', created);
      globalThis.encoderCheck = { workers, restore: () => {
        for (const [name, method] of Object.entries(saved)) prototype[name] = method;
        app.off('web-contents-created', created);
      } };
    });
    try {
      const before = await evaluate(first, '({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY})');
      let wholePage;
      for (const scope of ['viewport', 'selection', 'fullpage']) {
        const result = await action(first, { action: 'screenshot', scope, format: scope === 'selection' ? 'jpeg' : 'png' });
        assert.ok(result.screenshot.data.length > 50);
        if (scope === 'fullpage') wholePage = result.screenshot;
      }
      const bottom = await app.evaluate(({ nativeImage }, data) => {
        const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
        const size = image.getSize();
        const offset = ((size.height - 60) * size.width + Math.floor(size.width / 2)) * 4;
        return [...image.toBitmap().subarray(offset, offset + 4)];
      }, wholePage.data);
      assert.deepEqual(bottom, [0, 0, 255, 255], 'raw capture paints content below the original viewport');
      const processes = await app.evaluate(({ BrowserWindow }) => ({
        main: process.pid,
        gui: BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://pi-kit')).webContents.getOSProcessId(),
        encoders: globalThis.encoderCheck.workers,
        activeEncoders: BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith('data:text/html,')).length,
      }));
      assert.equal(processes.encoders.length, 3, 'all capture scopes use the encoder process');
      assert.ok(processes.encoders.every((pid) => pid > 0 && pid !== processes.main && pid !== processes.gui), 'encoding is isolated from both the main process and GUI renderer');
      assert.equal(processes.activeEncoders, 0, 'encoder windows are destroyed after their jobs');
      assert.deepEqual(await evaluate(first, '({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY})'), before, 'capture restores the original viewport and scroll position');
    } finally {
      await app.evaluate(() => { globalThis.encoderCheck.restore(); delete globalThis.encoderCheck; });
      await evaluate(first, `document.querySelector('#raw-capture-end')?.remove();scrollTo(0,0);true`);
    }
  });

  it('hides the native view for app dialogs and restores it afterward', async () => {
    await page.getByTestId('settings-button').click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.waitFor();
    await until(async () => !(await nativeUrls()).includes(`${base}/`), 'the browser is below the dialog');
    await dialog.getByRole('button', { name: /^Close settings/ }).click();
    await until(async () => (await nativeUrls()).includes(`${base}/`), 'the browser is restored');
  });

  it('isolates chats, retains a hidden page, and rejects stale references and privileged URLs', async () => {
    const second = await newThread();
    await until(async () => !(await nativeUrls()).includes(`${base}/`), 'the old chat detaches');
    assert.equal((await call(`/threads/${second}/browser`)).open, false);
    await action(second, { action: 'navigate', url: `${base}/second` });
    assert.equal(await evaluate(second, 'document.querySelector("#count").textContent'), '0');
    await evaluate(first, '"use strict"; document.cookie="artifact=first; path=/"');
    assert.equal(await evaluate(second, 'document.cookie'), '', 'cookies are isolated per chat');
    await assertPagePixels((await action(first, { action: 'screenshot', format: 'png' })).screenshot);
    assert.equal(await evaluate(first, 'document.querySelector("#count").textContent'), '1');
    const old = (await action(first, { action: 'snapshot' })).text.match(/\[([^\]]+)\] button "Increment"/)[1];
    await action(first, { action: 'navigate', url: `${base}/changed` });
    await assert.rejects(action(first, { action: 'screenshot', documentId: 'old-document' }), /browser navigated/);
    assert.equal((await call(`/threads/${first}/browser`)).inspection, undefined, 'navigation invalidates the selected element');
    await assert.rejects(action(first, { action: 'click', ref: old }), /stale element reference/);
    assert.equal((await action(first, { action: 'back' })).state.url, `${base}/`);
    assert.equal((await action(first, { action: 'forward' })).state.url, `${base}/changed`);
    assert.equal((await action(first, { action: 'reload' })).state.loading, false);
    await assert.rejects(action(first, { action: 'navigate', url: 'file:///etc/passwd' }), /HTTP\(S\)/);
    const before = (await call(`/threads/${first}/browser`)).url;
    // A valid HTTP URL must reach the privileged-origin guard, rather than a scheme/schema guard.
    assert.equal(new URL(connection.url).protocol, 'http:');
    const blocked = await fetch(`${connection.url}/api/threads/${first}/browser/action`, {
      method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'navigate', url: connection.url }),
    });
    assert.equal(blocked.status, 400);
    assert.equal((await blocked.json()).message, 'Open an HTTP(S) project page, not a pi-kit application page.');
    assert.equal((await call(`/threads/${first}/browser`)).url, before);
    await action(first, { action: 'close' });
    assert.equal((await call(`/threads/${first}/browser`)).open, false);
    assert.equal((await call(`/threads/${second}/browser`)).open, true);
    await action(first, { action: 'navigate', url: base });
    await action(first, { action: 'snapshot' });
    await assert.rejects(action(first, { action: 'click', ref: old }), /stale element reference/, 'references cannot collide after closing and reopening a page');
    await action(first, { action: 'close' });
  });

  it('keeps the foreground chat and backend alive when background computer use changes the page and its renderer crashes', async () => {
    await newThread();
    const draft = page.getByLabel('Message to pi');
    await draft.fill('Foreground draft must survive background computer use.');
    const health = await call('/health');
    const url = `${base}/background-computer-use`;
    await action(first, { action: 'navigate', url });
    const snapshot = (await action(first, { action: 'snapshot' })).text;
    const ref = snapshot.match(/\[([^\]]+)\] button "Increment"/)[1];
    await action(first, { action: 'click', ref });
    assert.equal(await evaluate(first, 'document.querySelector("#count").textContent'), '1');
    await assertPagePixels((await action(first, { action: 'screenshot', format: 'png' })).screenshot);
    const pending = action(first, { action: 'evaluate', code: 'globalThis.backgroundPending = true; new Promise(() => {})' });
    const rejected = assert.rejects(pending, /page stopped|page.*closed|target.*closed/i);
    await until(() => app.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find((wc) => wc.getURL() === url);
      return (await wc?.debugger.sendCommand('Runtime.evaluate', { expression: 'globalThis.backgroundPending', returnByValue: true }))?.result?.value;
    }, url), 'the hidden page is executing the browser action');
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((wc) => wc.getURL() === url)?.forcefullyCrashRenderer(), url);
    await rejected;
    assert.equal((await call('/health')).bootId, health.bootId, 'a background page failure must not restart the backend');
    assert.equal(await draft.inputValue(), 'Foreground draft must survive background computer use.');
    await action(first, { action: 'close' });
    await action(first, { action: 'navigate', url: base });
    assert.equal(await evaluate(first, 'document.querySelector("h1").textContent'), 'Counter', 'subsequent computer use still works');
    await action(first, { action: 'close' });
  });
});

it('loads German catalogs through the desktop app protocol and updates an open settings window', async () => {
  await page.getByTestId('settings-button').click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'General', exact: true }).click();
  await app.evaluate(({ Tray }) => {
    globalThis.i18nTray = { original: Tray.prototype.setContextMenu, labels: [] };
    Tray.prototype.setContextMenu = function (menu) {
      globalThis.i18nTray.labels = menu.items.map((item) => item.label);
      return globalThis.i18nTray.original.call(this, menu);
    };
  });
  try {
    await settings.getByTestId('language-select').selectOption('de');
    const german = page.getByRole('dialog', { name: 'Einstellungen', exact: true });
    await german.getByText('Sprache der Oberfläche', { exact: true }).waitFor();
    for (const placement of ['composer']) {
      const effort = page.getByTestId(`${placement}-effort-control`);
      assert.equal((await effort.locator('.effort-value').textContent()).trim(), 'Aus');
      assert.match(await effort.getAttribute('aria-label'), /Aus/);
    }
    assert.equal(await page.locator('html').getAttribute('lang'), 'de');
    const catalog = await page.evaluate(() => fetch('./i18n/de.json').then((response) => response.json()));
    // The catalog is nested by scope; read the key either way.
    assert.equal(catalog['settings.language.heading'] ?? catalog.settings?.language?.heading, 'Sprache');
    await until(() => app.evaluate(() => globalThis.i18nTray.labels.includes('Beenden')), 'the native tray follows the selected language');
    assert.ok(await app.evaluate(() => globalThis.i18nTray.labels.includes('pi-kit anzeigen')));
    const out = join(root, 'output/playwright/i18n');
    mkdirSync(out, { recursive: true });
    await page.screenshot({ path: join(out, 'settings-desktop-de.png') });
  } finally {
    try {
      await page.getByTestId('language-select').selectOption('en');
      await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Close settings', exact: true }).click();
    } finally {
      await app.evaluate(({ Tray }) => { Tray.prototype.setContextMenu = globalThis.i18nTray.original; delete globalThis.i18nTray; });
    }
  }
});
