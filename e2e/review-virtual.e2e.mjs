// Real large-file diffs, no model calls. Check the painted viewport as well as the bounded DOM.
import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeReportingSession } from './support/demo-sessions.mjs';
import { ensureBackend, env, openApp } from './support/app.mjs';

const count = 16_000;
const path = 'src/huge-review.txt';
let app;
let stopBackend;
let compactSession;
const diff = () => app.page.locator('pk-review-view pk-diff');
const scroller = () => app.page.locator('pk-review-view');
const pane = (side) => diff().getByRole('region', { name: side, exact: true });

before(async () => {
  stopBackend = await ensureBackend();
  const lines = Array.from({ length: count }, (_, i) => `line ${i + 1}: ${i === count - 1 ? 'a long offscreen line '.repeat(150) : 'review virtual scrolling'}`);
  lines[299] += ' Needle.Token';
  lines[7999] += ' needle.token needle.token';
  lines[14999] += ' NEEDLE.TOKEN';
  writeFileSync(join(env.project, path), lines.join('\n') + '\n');
  compactSession = writeReportingSession({ agentDir: env.agentDir, cwd: env.project, name: 'Huge compact diff regression' });
  const entries = readFileSync(compactSession.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const patch = `--- a/src/math.ts\n+++ b/src/math.ts\n@@ -0,0 +1,${count} @@\n` + Array.from({ length: count }, (_, i) => `+compact line ${i + 1}`).join('\n') + '\n';
  for (const entry of entries) if (entry.message?.toolName === 'edit') entry.message.details.patch = patch;
  writeFileSync(compactSession.file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  app = await openApp({ scrollbars: true });
  await app.h.newThread();
  await app.h.openPanel('Changes');
  await app.page.getByRole('button', { name: 'Working tree', exact: true }).click();
  await app.page.locator('.pk-file', { hasText: 'huge-review.txt' }).first().click();
  await diff().waitFor();
  await app.h.closePanel();
});
after(async () => {
  await app?.close();
  rmSync(join(env.project, path), { force: true });
  if (compactSession) rmSync(compactSession.file, { force: true });
  await stopBackend?.();
});

async function jump(fraction) {
  await scroller().evaluate((el, part) => { el.scrollTop = part * (el.scrollHeight - el.clientHeight); }, fraction);
  await app.page.waitForFunction(() => {
    const s = document.querySelector('pk-review-view');
    const d = s.querySelector('pk-diff');
    const viewport = s.getBoundingClientRect();
    const body = d.querySelector('[data-diff-content]').getBoundingClientRect();
    const rows = [...d.querySelectorAll('[data-diff-measure]')].map((el) => el.getBoundingClientRect());
    const first = Math.min(...rows.map((r) => r.top));
    const last = Math.max(...rows.map((r) => r.bottom));
    return rows.length && first <= Math.max(viewport.top, body.top) + 30 && last >= Math.min(viewport.bottom, body.bottom) - 30;
  });
}

async function bounded() {
  const rows = await diff().locator('[data-diff-row]').count();
  assert.ok(rows > 0 && rows < 250, `only a bounded row window is mounted, got ${rows}`);
}

it('virtualizes a sixteen-thousand-line unified diff and covers large scroll jumps', async () => {
  assert.equal(await diff().getAttribute('data-diff-virtual'), 'true');
  assert.equal(Number(await diff().getAttribute('data-diff-total')), count + 1);
  await bounded();
  const width = await diff().locator('.body').evaluate((el) => el.scrollWidth);
  assert.ok(width > 10_000, 'the longest offscreen line contributes to the horizontal rail immediately');
  for (const fraction of [0.5, 0.97, 1, 0.03, 0.75, 0]) {
    await jump(fraction);
    await bounded();
    assert.equal(await diff().locator('.body').evaluate((el) => el.scrollWidth), width);
  }
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});

it('keeps split panes aligned and their horizontal rails stable across virtual windows', async () => {
  await app.page.getByRole('button', { name: 'Split', exact: true }).click();
  await pane('After').waitFor();
  const width = await pane('After').evaluate((el) => el.scrollWidth);
  for (const fraction of [0, 0.5, 1, 0.2]) {
    await jump(fraction);
    await bounded();
    const rows = await diff().locator('.split-pane').evaluateAll((panes) => panes.map((el) => [...el.querySelectorAll('.h')].map((row) => { const r = row.getBoundingClientRect(); return [r.top, r.height]; })));
    assert.deepEqual(rows[0], rows[1]);
    assert.equal(await pane('Before').evaluate((el) => el.scrollWidth), width);
    assert.equal(await pane('After').evaluate((el) => el.scrollWidth), width);
  }
  await pane('After').evaluate((el) => { el.scrollLeft = 800; });
  await app.page.waitForFunction(() => [...document.querySelectorAll('pk-review-view .split-pane')].every((el) => el.scrollLeft === 800));
  await jump(0.8);
  assert.deepEqual(await diff().locator('.split-pane').evaluateAll((panes) => panes.map((el) => el.scrollLeft)), [800, 800]);
});

it('preserves a typed draft when its row is unmounted and does not steal focus on remount', async () => {
  const { page } = app;
  const text = 'An unsaved draft that must survive virtualization.\n' + 'A comment line that contributes to the logical row height.\n'.repeat(90);
  await jump(0);
  await pane('After').evaluate((el) => { el.scrollLeft = 0; });
  await page.waitForFunction(() => [...document.querySelectorAll('pk-review-view .split-pane')].every((el) => el.scrollLeft === 0));
  await pane('After').locator('.h').first().getByRole('button').click();
  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill(text);
  await jump(0.9);
  assert.equal(await page.getByRole('textbox', { name: 'Comment', exact: true }).count(), 0);
  await bounded();
  await jump(0);
  const field = page.getByRole('textbox', { name: 'Comment', exact: true });
  assert.equal(await field.inputValue(), text);
  assert.equal(await field.evaluate((el) => document.activeElement === el), false);
  await page.getByRole('button', { name: 'Add to batch', exact: true }).click();
  await jump(0.6);
  await jump(0);
  assert.match(await diff().locator('.pk-cmt').innerText(), /An unsaved draft/);
  await scroller().evaluate((el) => {
    const card = el.querySelector('.pk-cmt');
    el.scrollTop += card.getBoundingClientRect().top - el.getBoundingClientRect().top + el.clientHeight / 2;
  });
  await page.waitForFunction(() => {
    const scroller = document.querySelector('pk-review-view');
    const card = scroller.querySelector('.pk-cmt');
    if (!card) return false;
    const viewport = scroller.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    return bounds.top <= viewport.top && bounds.bottom >= viewport.bottom &&
      !!document.elementFromPoint(viewport.left + viewport.width / 2, viewport.top + viewport.height / 2)?.closest('.pk-cmt');
  });
  await bounded();
  await jump(0);
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});

it('avoids blank painted frames during rapid large jumps and viewport resizing', async () => {
  const { page } = app;
  await page.evaluate(() => {
    window.__diffGaps = [];
    window.__watchDiff = true;
    const check = () => {
      if (!window.__watchDiff) return;
      const s = document.querySelector('pk-review-view').getBoundingClientRect();
      const d = document.querySelector('pk-review-view pk-diff');
      const content = d.querySelector('[data-diff-content]').getBoundingClientRect();
      const rows = [...d.querySelectorAll('[data-diff-measure]')].map((el) => el.getBoundingClientRect());
      const first = Math.min(...rows.map((r) => r.top));
      const last = Math.max(...rows.map((r) => r.bottom));
      const top = Math.max(s.top, content.top);
      const bottom = Math.min(s.bottom, content.bottom);
      if (rows.length && bottom > top && (first > top + 30 || last < bottom - 30)) window.__diffGaps.push({ first, last, top, bottom });
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  for (const part of [0.5, 0.99, 0.1, 0.85, 0.03, 0.6, 1, 0]) await jump(part);
  const gaps = await page.evaluate(() => { window.__watchDiff = false; return window.__diffGaps; });
  assert.deepEqual(gaps, [], 'no painted frame exposes a blank spacer in the viewport');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('#t-threads').evaluate((el) => { el.checked = false; });
  await page.waitForFunction(() => document.querySelector('pk-review-view pk-diff').classList.contains('split') === false);
  for (const part of [0.5, 1, 0]) { await jump(part); await bounded(); }
  mkdirSync('tmp/review-virtual', { recursive: true });
  await page.screenshot({ path: 'tmp/review-virtual/phone.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await pane('After').waitFor();
  await jump(0.5);
  await page.screenshot({ path: 'tmp/review-virtual/desktop.png' });
});

it('finds offscreen matches with the keyboard, wraps navigation, and keeps the find bar visible', async () => {
  const { page } = app;
  await page.locator('pk-review-toolbar select').first().focus();
  await page.keyboard.press('Control+f');
  const find = diff().getByRole('textbox', { name: 'Find in diff', exact: true });
  await find.waitFor();
  assert.equal(await find.evaluate((el) => document.activeElement === el), true);
  await find.fill('needle.token');
  const status = diff().getByRole('status');
  await page.waitForFunction(() => document.querySelector('pk-review-view pk-diff [role="status"]').textContent.includes('1 of 4'));
  assert.equal(await diff().locator('[data-find-current]').innerText(), 'Needle.Token');
  for (const [key, expected, text] of [['Enter', '2 of 4', 'needle.token'], ['Enter', '3 of 4', 'needle.token'], ['Enter', '4 of 4', 'NEEDLE.TOKEN'], ['Enter', '1 of 4', 'Needle.Token'], ['Shift+Enter', '4 of 4', 'NEEDLE.TOKEN']]) {
    await find.press(key);
    assert.match(await status.innerText(), new RegExp(expected));
    const mark = diff().locator('[data-find-current]');
    assert.equal(await mark.innerText(), text);
    const box = await mark.boundingBox();
    const viewport = await scroller().boundingBox();
    assert.ok(box.y > viewport.y && box.y + box.height < viewport.y + viewport.height);
    const bar = await diff().getByRole('search').boundingBox();
    assert.ok(bar.y >= viewport.y - 1 && bar.y < viewport.y + 60, 'find remains docked inside the diff while navigating');
    await bounded();
  }
  await diff().getByRole('button', { name: 'Match case', exact: true }).click();
  assert.match(await status.innerText(), /1 of 2/);
  assert.equal(await diff().locator('[data-find-current]').locator('..').textContent(), 'line 8000: review virtual scrolling needle.token needle.token', 'highlighting preserves the exact source text');
  await diff().getByRole('button', { name: 'Next match', exact: true }).click();
  assert.match(await status.innerText(), /2 of 2/);
  await find.fill('[');
  assert.match(await status.innerText(), /No matches/);
  assert.equal(await diff().getByRole('button', { name: 'Next match', exact: true }).isDisabled(), true);
  await find.press('Escape');
  await diff().getByRole('search').waitFor({ state: 'detached' });
  assert.equal(await diff().getByRole('search').count(), 0);
  assert.equal(await diff().locator('mark').count(), 0);
  await page.keyboard.press('Meta+f');
  await find.fill('a long offscreen line');
  await find.press('Shift+Enter');
  assert.match(await status.innerText(), /150 of 150/);
  await page.waitForFunction(() => {
    const panes = [...document.querySelectorAll('pk-review-view .split-pane')];
    return panes.every((el) => el.scrollLeft > 10_000) && Math.abs(panes[0].scrollLeft - panes[1].scrollLeft) < 1;
  }, undefined);
  const lastMatch = await diff().locator('[data-find-current]').boundingBox();
  const afterPane = await pane('After').boundingBox();
  assert.ok(lastMatch.x >= afterPane.x && lastMatch.x + lastMatch.width <= afterPane.x + afterPane.width);
  await find.fill('line 16000:');
  assert.equal(await diff().locator('[data-find-current]').innerText(), 'line 16000:');
  await page.screenshot({ path: 'tmp/review-virtual/find-desktop.png' });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('#t-threads').evaluate((el) => { el.checked = false; });
  await page.waitForFunction(() => document.querySelector('.pk-threads').getBoundingClientRect().right <= 0);
  await page.waitForFunction(() => !document.querySelector('pk-review-view pk-diff').classList.contains('split'));
  assert.equal(await diff().getByRole('search').evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: 'tmp/review-virtual/find-phone.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await pane('After').waitFor();
  await diff().getByRole('button', { name: 'Close find', exact: true }).click();
  await diff().getByRole('search').waitFor({ state: 'detached' });
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});

it('virtualizes the compact chat diff inside its own vertical scroller', async () => {
  const { page } = app;
  await page.getByRole('button', { name: '‹ Chat', exact: true }).click();
  await app.h.selectThread('Huge compact diff regression');
  const transcript = page.locator('[cdkscrollable]');
  await page.waitForFunction(() => Number(document.querySelector('[data-virtual-total]')?.getAttribute('data-virtual-total')) >= 2);
  await transcript.evaluate((el) => { el.scrollTop = 0; });
  await page.getByRole('button', { name: 'Show what pi did', exact: true }).first().click();
  const compact = page.locator('pk-edit-tool-row pk-diff.compact');
  await compact.waitFor({ state: 'attached' });
  assert.ok(await compact.locator('[data-diff-row]').count() < 100, 'a diff inside closed details does not measure zero-height rows and mount the whole file');
  await page.locator('details.pk-work-row').filter({ has: page.locator('pk-edit-tool-row') }).locator(':scope > summary').click();
  await compact.waitFor();
  assert.equal(await compact.getAttribute('data-diff-virtual'), 'true');
  const outerTop = await transcript.evaluate((el) => el.scrollTop);
  for (const part of [0.5, 1, 0]) {
    await compact.evaluate((el, fraction) => { el.scrollTop = fraction * (el.scrollHeight - el.clientHeight); }, part);
    await page.waitForFunction((fraction) => {
      const el = document.querySelector('pk-edit-tool-row pk-diff.compact');
      const rows = [...el.querySelectorAll('.ln[data-diff-row]')];
      return rows.some((row) => row.textContent.includes(fraction === 1 ? 'compact line 16000' : fraction === 0 ? 'compact line 1' : 'compact line 8000'));
    }, part);
    assert.ok(await compact.locator('[data-diff-row]').count() < 100);
  }
  assert.ok(Math.abs(await transcript.evaluate((el) => el.scrollTop) - outerTop) < 2, 'scrolling the compact diff leaves the transcript position alone');
  await compact.focus();
  await page.keyboard.press('Meta+f');
  const find = compact.getByRole('textbox', { name: 'Find in diff', exact: true });
  await find.fill('compact line 16000');
  assert.equal(await compact.locator('[data-find-current]').innerText(), 'compact line 16000');
  assert.ok(await compact.locator('[data-diff-row]').count() < 100);
  await find.press('Escape');
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});
