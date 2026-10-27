// Native Electron input and layout are a separate platform risk from Chromium's hydration/streaming contract.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import { _electron } from 'playwright';
import { Harness } from '../scripts/screenshots.mjs';
import { createWorld, root } from './support/env.mjs';
import { writeTranscriptSession } from './support/transcript-session.mjs';

const title = 'Native transcript viewport';
let world, app, page, h;
const errors = [];

before(async () => {
  world = createWorld({ offline: true, setup: ({ agent, project }) => {
    writeTranscriptSession({ agentDir: agent, cwd: project, title });
  } });
  const env = { ...process.env, ...world.env, PI_KIT_SMOKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ args: [join(root, 'dist/apps/desktop/main.cjs')], env });
  const deadline = Date.now() + 60_000;
  while (!page && Date.now() < deadline) {
    page = app.windows().find((window) => window.url().startsWith('app://pi-kit'));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(page, 'the native renderer opens');
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('pk-root .pk-shell');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://pi-kit'))?.setSize(1700, 1000));
  await page.getByRole('button', { name: 'Trust once', exact: true }).click();
  await page.locator('pk-trust-dialog dialog').waitFor({ state: 'detached' });
  h = new Harness(page, { base: 'app://pi-kit', out: join(world.base, 'shots') });
  await h.selectThread(title);
});

after(async () => {
  await app?.close();
  world?.dispose();
});

it('keeps native thumb geometry, painted coverage and reading anchors across resize and thread switches', async () => {
  const root = page.locator('[pkVirtualTranscript]');
  const scroller = page.locator('[cdkscrollable]');
  const rows = page.locator('[data-virtual-row]');
  await root.getByText('Viewport question 1199', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const s = document.querySelector('[cdkscrollable]');
    return s.scrollHeight - s.scrollTop - s.clientHeight <= 1;
  });
  await page.addStyleTag({ content: '[cdkscrollable] { scrollbar-width: auto !important; scrollbar-color: auto !important; overflow-y: scroll !important; } [cdkscrollable]::-webkit-scrollbar { display: block !important; width: 14px !important; } [cdkscrollable]::-webkit-scrollbar-thumb { background: #888; min-height: 24px; }' });
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await root.getByText('Viewport question 0', { exact: true }).waitFor();
  assert.ok(await scroller.evaluate((element) => element.offsetWidth - element.clientWidth) > 0, 'an actual native scrollbar is exposed');
  await page.evaluate(() => {
    window.__nativeCoverage = { watching: true, phase: 'forward drag', gaps: [], maximumRows: 0, longTasks: [] };
    new PerformanceObserver((list) => {
      if (window.__nativeCoverage.watching) window.__nativeCoverage.longTasks.push(...list.getEntries().map((entry) => entry.duration));
    }).observe({ type: 'longtask' });
    const check = () => {
      const state = window.__nativeCoverage;
      if (!state.watching) return;
      const viewport = document.querySelector('[cdkscrollable]').getBoundingClientRect();
      const transcript = document.querySelector('[pkVirtualTranscript]');
      if (Number(transcript?.getAttribute('data-virtual-total')) < 2400 || !transcript) { requestAnimationFrame(check); return; }
      const host = transcript.getBoundingClientRect();
      const boxes = [...document.querySelectorAll('[data-virtual-row]')].map((row) => row.getBoundingClientRect());
      const top = Math.max(viewport.top, host.top), bottom = Math.min(viewport.bottom, host.bottom);
      state.maximumRows = Math.max(state.maximumRows, boxes.length);
      if (bottom > top && (!boxes.length || boxes[0].top > top + 2 || boxes.at(-1).bottom < bottom - 2))
        state.gaps.push({ phase: state.phase, top, bottom, first: boxes[0]?.top, last: boxes.at(-1)?.bottom });
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  const visibleAnchor = () => rows.evaluateAll((elements) => {
    const top = document.querySelector('[cdkscrollable]').getBoundingClientRect().top;
    const row = elements.find((element) => element.getBoundingClientRect().bottom > top);
    return { id: row.getAttribute('data-virtual-row'), offset: row.getBoundingClientRect().top - top };
  });
  const trackBox = await scroller.boundingBox();
  const track = { x: trackBox.x + trackBox.width - 7, top: trackBox.y, height: trackBox.height };
  for (const reverse of [false, true]) {
    await page.evaluate((reverse) => { window.__nativeCoverage.phase = reverse ? 'reverse drag' : 'forward drag'; }, reverse);
    await page.mouse.move(track.x, track.top + (reverse ? track.height - 8 : 8));
    await page.mouse.down();
    const geometry = [];
    for (let i = 1; i <= 12; i++) {
      const fraction = reverse ? 1 - i / 12 : i / 12;
      await page.mouse.move(track.x, track.top + 8 + (track.height - 16) * fraction);
      if (i === 6) await rows.first().evaluate((row) => { row.style.paddingBottom = '180px'; });
      await page.waitForTimeout(25);
      geometry.push(await scroller.evaluate((s) => ({ top: s.scrollTop, height: s.scrollHeight })));
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
    const heights = geometry.map((value) => value.height);
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 2, `native thumb holds one rail: ${heights}`);
    assert.ok(geometry.every((value, index) => !index || (reverse ? value.top <= geometry[index - 1].top + 2 : value.top >= geometry[index - 1].top - 2)), 'native dragging is monotonic');
    const gap = await scroller.evaluate((s, reverse) => reverse ? s.scrollTop : s.scrollHeight - s.scrollTop - s.clientHeight, reverse);
    assert.ok(gap < 2, `native drag reaches its endpoint: ${gap}`);
  }
  await page.evaluate(() => { window.__nativeCoverage.phase = 'release anchor'; });
  await page.mouse.move(track.x, track.top + 8);
  await page.mouse.down();
  await page.mouse.move(track.x, track.top + 8 + (track.height - 16) * .4, { steps: 12 });
  await page.waitForTimeout(70);
  const held = await visibleAnchor();
  await page.mouse.up();
  await page.waitForTimeout(180);
  assert.deepEqual((await visibleAnchor()).id, held.id, 'release retains the same native reading anchor');
  assert.ok(Math.abs((await visibleAnchor()).offset - held.offset) < 2, 'release retains the within-row pixel offset');
  await page.evaluate(() => { window.__nativeCoverage.phase = 'window resize'; });
  // Width invalidation must retain the message even though wrapping changes its within-row geometry.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('app://pi-kit'))?.setSize(1440, 1000));
  await page.waitForTimeout(250);
  assert.equal((await visibleAnchor()).id, held.id, 'window resizing retains the visible message');
  const saved = await visibleAnchor();
  await page.evaluate(() => { window.__nativeCoverage.phase = 'thread switch'; });
  await h.newThread();
  await h.selectThread(title);
  await page.locator(`[data-virtual-row="${saved.id}"]`).waitFor();
  const restored = await visibleAnchor();
  assert.equal(restored.id, saved.id, 'returning to a thread restores its message');
  assert.ok(Math.abs(restored.offset - saved.offset) < 2, 'returning restores its pixel offset');
  await page.evaluate(() => { window.__nativeCoverage.phase = 'Latest'; });
  await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
  await root.getByText('Viewport question 1199', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const s = document.querySelector('[cdkscrollable]');
    return s.scrollHeight - s.scrollTop - s.clientHeight <= 1;
  });
  const coverage = await page.evaluate(() => { window.__nativeCoverage.watching = false; return window.__nativeCoverage; });
  assert.deepEqual(coverage.gaps, [], 'native input never paints an uncovered spacer');
  assert.ok(coverage.maximumRows < 100, `history stays bounded: ${coverage.maximumRows} mounted rows`);
  assert.deepEqual(errors, [], 'native rendering produces no page errors');
  console.log('native transcript metrics', JSON.stringify({ maximumRows: coverage.maximumRows, gaps: coverage.gaps.length, longTasks: coverage.longTasks }));
});
