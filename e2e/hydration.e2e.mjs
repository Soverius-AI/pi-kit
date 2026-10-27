// A fresh browser/empty cache hydrates a generated long Pi session through the runtime, then scrolls it in both directions.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import { writeTranscriptSession } from './support/transcript-session.mjs';
import { api, ensureBackend, env, openApp } from './support/app.mjs';
import { FAKE_MODEL, FAKE_PROVIDER, registerFakeModel, startFakeModel } from './support/fake-model.mjs';

const title = 'Hydration and virtual scrolling regression';
let app;
let file;
let thread;
let fake;
/** app.e2e.mjs's restart test leaves no backend behind: this file starts one when none answers (after the fake model is registered, so it reads it). */
let stopBackend;
const count = 1200;

before(async () => {
  const text = Array.from({ length: 180 }, (_, index) => `Streamed paragraph ${index}. A sentence that wraps over multiple lines as the reply grows. Another sentence to keep the viewport moving.\n\n`).join('');
  fake = await startFakeModel({ answer: () => ({ text, chunkMs: 18 }) });
  registerFakeModel(env.agentDir, fake.url);
  const modelsFile = join(env.agentDir, 'models.json');
  const models = JSON.parse(readFileSync(modelsFile, 'utf8'));
  models.providers[FAKE_PROVIDER].models[0].contextWindow = 500000;
  writeFileSync(modelsFile, JSON.stringify(models));
  ({ file } = writeTranscriptSession({ agentDir: env.agentDir, cwd: env.project, title, count }));
  stopBackend = await ensureBackend();
  const deadline = Date.now() + 20_000;
  while (!thread && Date.now() < deadline) {
    thread = (await api('/api/threads')).find((t) => t.title === title);
    if (!thread) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(thread, 'the session scanner discovers the fixture');
  const saved = await fetch(`${env.api}/api/settings/thread`, { method: 'PUT', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${env.server.PI_KIT_TOKEN}`,
  }, body: JSON.stringify({ value: thread.id }) });
  assert.ok(saved.ok);
  app = await openApp({ scrollbars: true });
});
after(async () => {
  try {
    await app?.close();
    await fake?.stop();
    if (file) rmSync(file, { force: true });
  } finally {
    await stopBackend?.();
  }
});

it('hydrates cold, keeps a bounded variable-height viewport, and reuses a warm snapshot', async () => {
  const { page, h } = app;
  const connectResponse = page.waitForResponse((response) => response.url().endsWith('/agent/pi/connect'));
  await page.reload(); // The renderer's in-memory cache is empty again.
  const response = await connectResponse;
  assert.equal(response.request().headers()['x-pi-kit-hydrate'], '1');
  assert.equal(response.request().headers()['x-pi-kit-replay-cursor'], undefined);
  const events = (await response.text()).split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)));
  const snapshots = events.filter((event) => event.name === 'pi.thread.hydrate');
  assert.equal(snapshots.length, 1);
  assert.ok(snapshots[0].value.messages.length >= count * 2);
  assert.ok(!events.some((event) => ['TEXT_MESSAGE_CONTENT', 'TOOL_CALL_ARGS'].includes(event.type)));
  const root = page.locator('[pkVirtualTranscript]');
  await page.waitForFunction(() => Number(document.querySelector('[data-virtual-total]')?.getAttribute('data-virtual-total')) >= 2400);
  const rows = page.locator('[data-virtual-row]');
  const scroller = page.locator('[cdkscrollable]');
  await root.getByText(`Viewport question ${count - 1}`, { exact: true }).waitFor();
  assert.ok(await rows.count() < 100, 'offscreen history is unmounted');

  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await root.getByText('Viewport question 0', { exact: true }).waitFor();
  await page.waitForTimeout(250);
  assert.ok(await scroller.evaluate((element) => element.scrollTop) < 10, 'height measurements do not pull the reader to the end');
  assert.ok(await rows.count() < 100);
  assert.equal(await root.getByText(`Viewport question ${count - 1}`, { exact: true }).count(), 0);

  await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
  await root.getByText(`Viewport question ${count - 1}`, { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const element = document.querySelector('[cdkscrollable]');
    return element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
  });
  await page.waitForTimeout(250);
  assert.ok(await scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop) <= 1,
    'Latest remains at the measured bottom after row heights settle');
  const scrollBox = await scroller.boundingBox();
  await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
  await page.evaluate(() => {
    window.__latestGaps = [];
    window.__watchLatest = true;
    const check = () => {
      if (!window.__watchLatest) return;
      const s = document.querySelector('[cdkscrollable]').getBoundingClientRect();
      const root = document.querySelector('[pkVirtualTranscript]').getBoundingClientRect();
      const rows = [...document.querySelectorAll('[data-virtual-row]')].map((row) => row.getBoundingClientRect());
      if (!rows.length || rows[0].top > Math.max(s.top, root.top) + 2 || rows.at(-1).bottom < Math.min(s.bottom, root.bottom) - 2)
        window.__latestGaps.push({ first: rows[0]?.top, last: rows.at(-1)?.bottom });
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  await page.mouse.wheel(0, -80);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => { window.__watchLatest = false; return window.__latestGaps.length; }), 0,
    'Latest followed by a small wheel movement never leaves a blank viewport');
  assert.ok(await scroller.evaluate((element) => element.scrollTop > element.scrollHeight - element.clientHeight - 1000),
    'releasing end-following keeps the reader near the last message');

  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight / 2; });
  await page.waitForTimeout(500);
  const anchor = await rows.evaluateAll((elements) => {
    const viewport = document.querySelector('[cdkscrollable]').getBoundingClientRect();
    const row = elements.find((element) => { const box = element.getBoundingClientRect(); return box.top >= viewport.top && box.top < viewport.bottom; });
    return row ? { id: row.getAttribute('data-virtual-row'), top: row.getBoundingClientRect().top } : undefined;
  });
  assert.ok(anchor);
  await rows.first().evaluate((element) => { element.style.paddingBottom = '180px'; });
  await page.waitForTimeout(350);
  const after = await page.locator(`[data-virtual-row="${anchor.id}"]`).evaluate((element) => element.getBoundingClientRect().top);
  assert.ok(Math.abs(after - anchor.top) < 3, `resizing an overscan row preserves the visible anchor: ${anchor.id}, ${anchor.top} -> ${after}`);

  // The tree can reveal an exact offscreen message without mounting the intervening history.
  await root.evaluate((element) => element.dispatchEvent(new CustomEvent('pk-reveal-message', { detail: { id: 'u900' } })));
  await root.getByText('Viewport question 900', { exact: true }).waitFor();
  assert.ok(await rows.count() < 100);

  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await root.getByText(`Viewport question ${count - 1}`, { exact: true }).waitFor();
  assert.ok(await rows.count() < 100);
  // Observe painted frames, rather than only checking a settled DOM after each jump.
  await page.evaluate(() => {
    window.__virtualGaps = [];
    window.__watchVirtual = true;
    const check = () => {
      if (!window.__watchVirtual) return;
      const viewport = document.querySelector('[cdkscrollable]').getBoundingClientRect();
      const root = document.querySelector('[pkVirtualTranscript]').getBoundingClientRect();
      const rows = [...document.querySelectorAll('[data-virtual-row]')].map((row) => row.getBoundingClientRect());
      const top = Math.max(viewport.top, root.top);
      const bottom = Math.min(viewport.bottom, root.bottom);
      if (rows.length && bottom > top && (rows[0].top > top + 2 || rows.at(-1).bottom < bottom - 2))
        window.__virtualGaps.push({ top, bottom, first: rows[0].top, last: rows.at(-1).bottom });
      requestAnimationFrame(check);
    };
    window.__virtualCheck = check;
    requestAnimationFrame(check);
  });
  for (const fraction of [0, .5, .1, .9, .25, 1, 0]) {
    await scroller.evaluate((element, fraction) => { element.scrollTop = fraction * (element.scrollHeight - element.clientHeight); }, fraction);
    await page.waitForTimeout(80);
  }
  const gaps = await page.evaluate(() => { window.__watchVirtual = false; return window.__virtualGaps; });
  assert.deepEqual(gaps, [], 'large scroll jumps never paint an empty spacer');

  // Each thread retains the exact message and pixel offset where the reader left it.
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight / 2; });
  await page.waitForTimeout(250);
  const saved = await rows.evaluateAll((elements) => {
    const top = document.querySelector('[cdkscrollable]').getBoundingClientRect().top;
    const row = elements.find((element) => element.getBoundingClientRect().bottom > top);
    return { id: row.getAttribute('data-virtual-row'), offset: row.getBoundingClientRect().top - top };
  });
  await h.newThread();
  const warm = page.waitForResponse((r) => r.url().endsWith('/agent/pi/connect') && r.request().postDataJSON()?.threadId === thread.id);
  await h.selectThread(title);
  const cached = await warm;
  assert.ok(cached.request().headers()['x-pi-kit-replay-cursor']);
  const accepted = (await cached.text()).split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)));
  assert.deepEqual(accepted, [{ type: 'CUSTOM', name: 'pi.replay', value: { reset: false, running: false } }]);
  const restored = page.locator(`[data-virtual-row="${saved.id}"]`);
  await restored.waitFor();
  const restoredOffset = await restored.evaluate((element) => element.getBoundingClientRect().top - document.querySelector('[cdkscrollable]').getBoundingClientRect().top);
  assert.ok(Math.abs(restoredOffset - saved.offset) < 2, `switch restores the same reading anchor: ${saved.offset} -> ${restoredOffset}`);

  // A native thumb drag must keep one scroll range while previously unmeasured rows mount.
  // Explicit scrollbar styles also expose the native scrollbar on macOS with auto-hiding enabled.
  await page.addStyleTag({ content: '[cdkscrollable] { scrollbar-width: auto !important; scrollbar-color: auto !important; overflow-y: scroll !important; } [cdkscrollable]::-webkit-scrollbar { display: block !important; width: 14px !important; } [cdkscrollable]::-webkit-scrollbar-thumb { background: #888; min-height: 24px; }' });
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(150);
  assert.ok(await scroller.evaluate((element) => element.offsetWidth - element.clientWidth) > 0, 'the test exposes an actual native scrollbar');
  const box = await scroller.boundingBox();
  const track = { x: box.x + box.width - 7, top: box.y, height: box.height };
  await page.evaluate(() => { window.__virtualGaps = []; window.__watchVirtual = true; requestAnimationFrame(window.__virtualCheck); });
  await page.mouse.move(track.x, track.top + 8);
  await page.mouse.down();
  const dragHeights = [];
  const positions = [];
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(track.x, track.top + 8 + (track.height - 16) * i / 12);
    if (i === 6) await rows.first().evaluate((element) => { element.style.paddingBottom = '180px'; });
    await page.waitForTimeout(25);
    const geometry = await scroller.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight }));
    dragHeights.push(geometry.height);
    positions.push(geometry.top);
  }
  await page.mouse.up();
  assert.ok(Math.max(...dragHeights) - Math.min(...dragHeights) <= 2, `the thumb range stays fixed while dragging: ${dragHeights}`);
  assert.ok(positions.at(-1) > Math.max(...dragHeights) * .9, `dragging to the bottom reaches the bottom: ${positions}`);
  assert.ok(positions.every((position, index) => index === 0 || position >= positions[index - 1] - 2), 'the thumb moves monotonically');
  await page.waitForTimeout(150);
  const endGap = await scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  assert.ok(endGap < 2, `release keeps the end visible: ${endGap}`);
  await page.mouse.move(track.x, track.top + track.height - 8);
  await page.mouse.down();
  const reverseHeights = [];
  const reversePositions = [];
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(track.x, track.top + track.height - 8 - (track.height - 16) * i / 12);
    await page.waitForTimeout(25);
    reverseHeights.push(await scroller.evaluate((element) => element.scrollHeight));
    reversePositions.push(await scroller.evaluate((element) => element.scrollTop));
  }
  await page.mouse.up();
  await page.waitForTimeout(150);
  assert.ok(Math.max(...reverseHeights) - Math.min(...reverseHeights) <= 2, `the reverse drag keeps its range: ${reverseHeights}`);
  const reverseTop = await scroller.evaluate((element) => element.scrollTop);
  assert.ok(reverseTop < 2, `dragging back to the top reaches the top: ${reverseTop}; positions ${reversePositions}; track ${JSON.stringify(track)}`);
  const visibleAnchor = () => rows.evaluateAll((elements) => {
    const top = document.querySelector('[cdkscrollable]').getBoundingClientRect().top;
    const row = elements.find((element) => element.getBoundingClientRect().bottom > top);
    return { id: row.getAttribute('data-virtual-row'), offset: row.getBoundingClientRect().top - top };
  });
  for (const fraction of [.25, .4, .65]) {
    await scroller.evaluate((element) => { element.scrollTop = 0; });
    await page.waitForTimeout(100);
    await page.mouse.move(track.x, track.top + 8);
    await page.mouse.down();
    await page.mouse.move(track.x, track.top + 8 + (track.height - 16) * fraction, { steps: 12 });
    await page.waitForTimeout(70);
    const held = await visibleAnchor();
    await page.mouse.up();
    await page.waitForTimeout(180);
    const released = await visibleAnchor();
    assert.equal(released.id, held.id, `thumb release at ${fraction} retains its visible message`);
    assert.ok(Math.abs(released.offset - held.offset) < 2, `thumb release at ${fraction} retains its pixel offset: ${held.offset} -> ${released.offset}`);
  }
  const dragGaps = await page.evaluate(() => { window.__watchVirtual = false; return window.__virtualGaps; });
  assert.deepEqual(dragGaps, [], 'thumb dragging never paints an uncovered spacer, including after a row resizes');
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});

it('follows streamed generation after Latest, lets the reader scroll up, and resumes following on Latest', async () => {
  const { page } = app;
  const stats = await api(`/api/threads/${thread.id}/model`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: FAKE_PROVIDER, modelId: FAKE_MODEL, thinkingLevel: 'off' }) });
  assert.equal(stats.model?.id, FAKE_MODEL, JSON.stringify(stats));
  await page.reload();
  await page.getByTestId('model-chip').filter({ hasText: FAKE_MODEL }).waitFor();
  const scroller = page.locator('[cdkscrollable]');
  const root = page.locator('[pkVirtualTranscript]');
  await root.getByText(`Viewport question ${count - 1}`, { exact: true }).waitFor();
  // Message DOM can precede the cold-open viewport correction. Observe its public end position before scrolling away.
  await page.waitForFunction(() => {
    const element = document.querySelector('[cdkscrollable]');
    return element.scrollHeight - element.scrollTop - element.clientHeight <= 1;
  });
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await root.getByText('Viewport question 0', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
  const box = await scroller.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 80); // A downward wheel at the end must keep following enabled.
  await page.getByLabel('Message to pi').fill('Stream a long answer for the viewport regression.');
  await page.getByLabel('Message to pi').press('Enter');
  await page.getByTestId('stop').waitFor();
  await page.locator('pk-prose').filter({ hasText: 'Streamed paragraph 0' }).waitFor();
  const endGap = () => scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  const followed = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(120);
    followed.push(await endGap());
  }
  assert.ok(Math.max(...followed) <= 4, `streamed rows stay at the measured bottom: ${followed}`);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(150);
  const reading = await scroller.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(400);
  assert.ok(Math.abs(await scroller.evaluate((element) => element.scrollTop) - reading) < 3,
    'generation does not pull a reader who scrolled up back to the end');
  assert.ok(await endGap() > 100);
  await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
  await page.waitForTimeout(180);
  assert.ok(await endGap() <= 4, 'Latest resumes following during the live response');
  await page.getByTestId('stop').waitFor({ state: 'detached' });
  await page.waitForTimeout(200);
  assert.ok(await endGap() <= 1, 'the completed answer and composer settle at the true end');
});
