// The real review viewer: bounded Before/After panes, shared vertical rows and synchronized horizontal offsets.
// No model calls: compare a hand edit in the scratch project's working tree with HEAD.
import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureBackend, env, openApp } from './support/app.mjs';

let app;
let original;
let originalGreet;
let stopBackend;
const file = () => join(env.project, 'src', 'math.ts');
const diff = () => app.page.locator('pk-review-view pk-diff');
const pane = (side) => diff().getByRole('region', { name: side, exact: true });

before(async () => {
  stopBackend = await ensureBackend();
  original = readFileSync(file(), 'utf8');
  originalGreet = readFileSync(join(env.project, 'src/greet.ts'), 'utf8');
  writeFileSync(join(env.project, 'src/greet.ts'), `${originalGreet}\n// A second file for review navigation.\n`);
  const lines = original.split('\n');
  lines[0] = `// AFTER: ${'a long replacement line '.repeat(30)}`;
  writeFileSync(file(), `${lines.join('\n')}\n${Array.from({ length: 80 }, (_, i) => `// added line ${i + 1}`).join('\n')}\n`);
  app = await openApp();
  await app.h.newThread();
  await app.h.openPanel('Changes');
  await app.page.getByRole('button', { name: 'Working tree', exact: true }).click();
  await app.page.locator('.pk-file', { hasText: 'math.ts' }).first().click();
  await diff().waitFor();
  await app.h.closePanel();
});
after(async () => {
  if (original !== undefined) writeFileSync(file(), original);
  if (originalGreet !== undefined) writeFileSync(join(env.project, 'src/greet.ts'), originalGreet);
  await app?.close();
  await stopBackend?.();
});

async function aligned() {
  await pane('After').waitFor();
  const rows = await diff().locator('.split-pane').evaluateAll((panes) => panes.map((pane) => Array.from(pane.querySelectorAll('.h'), (row) => {
    const r = row.getBoundingClientRect();
    return [r.top, r.height];
  })));
  assert.ok(rows[0].length > 80);
  assert.deepEqual(rows[0], rows[1], 'both sides use identical vertical row positions, including empty cells and comment gaps');
}

it('navigates files and changes source directly from the review toolbar', async () => {
  const { page } = app;
  assert.equal(await page.evaluate(() => typeof globalThis.Zone), 'undefined', 'the Angular 22 renderer runs without Zone.js');
  const toolbar = page.locator('pk-review-toolbar');
  const picker = toolbar.getByRole('combobox', { name: 'Changed files', exact: true });
  await toolbar.getByRole('button', { name: 'Previous file', exact: true }).click();
  await diff().locator('.hd code', { hasText: 'src/greet.ts' }).waitFor();
  assert.equal(await toolbar.getByRole('button', { name: 'Previous file', exact: true }).isDisabled(), true);
  await toolbar.getByRole('button', { name: 'Next file', exact: true }).click();
  await diff().locator('.hd code', { hasText: 'src/math.ts' }).waitFor();
  await picker.selectOption('src/greet.ts');
  await diff().locator('.hd code', { hasText: 'src/greet.ts' }).waitFor();
  await toolbar.getByRole('combobox', { name: 'Source', exact: true }).selectOption('thread');
  await diff().waitFor({ state: 'detached' });
  assert.equal(await picker.isDisabled(), true);
  await toolbar.getByRole('combobox', { name: 'Source', exact: true }).selectOption('worktree');
  await diff().waitFor();
  await picker.selectOption('src/math.ts');
  await diff().locator('.hd code', { hasText: 'src/math.ts' }).waitFor();
});

it('opens find from the diff header and reveals a match in a small nonvirtual diff', async () => {
  const { page } = app;
  assert.equal(await diff().getAttribute('data-diff-virtual'), 'false');
  await diff().getByRole('button', { name: 'Find in diff', exact: true }).click();
  const field = diff().getByRole('textbox', { name: 'Find in diff', exact: true });
  await field.fill('added line 80');
  assert.match(await diff().getByRole('status').innerText(), /1 of 1/);
  const box = await diff().locator('[data-find-current]').boundingBox();
  const viewport = await page.locator('pk-review-view').boundingBox();
  assert.ok(box.y >= viewport.y && box.y + box.height <= viewport.y + viewport.height);
  await field.press('Escape');
  await diff().getByRole('search').waitFor({ state: 'detached' });
  const passed = await diff().evaluate((host) => {
    let reachedApp = false;
    const listener = () => { reachedApp = true; };
    document.addEventListener('keydown', listener, { once: true });
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    document.removeEventListener('keydown', listener);
    return reachedApp;
  });
  assert.equal(passed, true, 'the modified shortcut reaches the app');
  assert.equal(await diff().getByRole('search').count(), 0, 'the modified shortcut reaches the app without opening diff find');
  await page.locator('pk-review-view').evaluate((el) => { el.scrollTop = 0; });
});

it('keeps Before and After side by side for long lines, and scrolls either pane horizontally in sync', async () => {
  const { page } = app;
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await pane('After').waitFor();
  const before = await pane('Before').boundingBox();
  const after = await pane('After').boundingBox();
  const body = await diff().locator('.split-body').boundingBox();
  assert.ok(Math.abs(before.width - after.width) < 1);
  assert.ok(Math.abs(after.x - (before.x + before.width)) < 1);
  assert.ok(Math.abs(after.x + after.width - (body.x + body.width)) < 1, 'After is visible inside the viewer, not beyond the widest old line');
  assert.match(await pane('Before').locator('.h .c').first().innerText(), new RegExp(original.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(await pane('After').locator('.h .c').first().innerText(), /AFTER:/);
  await aligned();
  for (const [side, offset] of [['Before', 120], ['After', 240], ['Before', 100000]]) {
    await pane(side).evaluate((el, left) => { el.scrollLeft = left; }, offset);
    await page.waitForFunction(() => {
      const panes = Array.from(document.querySelectorAll('pk-review-view .split-pane'));
      return panes.length === 2 && panes[0].scrollLeft > 0 && Math.abs(panes[0].scrollLeft - panes[1].scrollLeft) < 1;
    });
  }
  assert.equal(await diff().locator('.split-body').evaluate((el) => el.scrollWidth), Math.round(body.width));
});

it('uses one vertical scroll when wheeling over either side', async () => {
  const { page } = app;
  for (const side of ['Before', 'After']) {
    await page.locator('pk-review-view').evaluate((el) => { el.scrollTop = 0; });
    const box = await pane(side).boundingBox();
    await page.mouse.move(box.x + box.width / 2, Math.max(200, box.y + 80));
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.querySelector('pk-review-view').scrollTop > 100);
    assert.deepEqual(await diff().locator('.split-pane').evaluateAll((els) => els.map((el) => el.scrollTop)), [0, 0]);
    await aligned();
  }
});

it('extends a comment range by dragging across rows with delegated hover handling', async () => {
  const { page } = app;
  await page.locator('pk-review-view').evaluate((el) => { el.scrollTop = 0; });
  await pane('Before').evaluate((el) => { el.scrollLeft = 0; });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('pk-review-view .split-pane')).every((el) => el.scrollLeft === 0));
  const start = await pane('After').locator('.h').nth(0).getByRole('button').boundingBox();
  const end = await pane('After').locator('.h').nth(2).boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + 110, end.y + end.height / 2);
  await page.mouse.up();
  await page.getByRole('textbox', { name: 'Comment', exact: true }).waitFor();
  assert.match(await diff().locator('.pk-cmt .by').innerText(), /1–3/);
  await aligned();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
});

it('keeps both sides aligned around a comment editor and saved card, and preserves the comment across layouts', async () => {
  const { page } = app;
  await page.locator('pk-review-view').evaluate((el) => { el.scrollTop = 0; });
  await pane('Before').evaluate((el) => { el.scrollLeft = 0; });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('pk-review-view .split-pane')).every((el) => el.scrollLeft === 0));
  await pane('After').locator('.h').first().getByRole('button', { name: 'Comment on the new line' }).click();
  await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Keep these lines aligned.');
  await aligned();
  await page.getByRole('button', { name: 'Add to batch', exact: true }).click();
  await aligned();
  assert.equal(await diff().locator('.pk-cmt').count(), 1);
  await page.getByRole('button', { name: 'Unified', exact: true }).click();
  await diff().locator('.split-pane').first().waitFor({ state: 'detached' });
  assert.equal(await diff().locator('.split-pane').count(), 0);
  assert.match(await diff().locator('.pk-cmt').innerText(), /Keep these lines aligned/);
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await aligned();
  assert.equal(await pane('After').locator('.h.commented').count(), 1);
  assert.equal(await pane('Before').locator('.h.commented').count(), 0);
  mkdirSync('tmp/review-layout', { recursive: true });
  await page.screenshot({ path: 'tmp/review-layout/split.png' });
});

it('reacts to phone resizing immediately and restores the chosen split layout on a wider window', async () => {
  const { page } = app;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForFunction(() => !document.querySelector('pk-review-view pk-diff').classList.contains('split'));
  await diff().locator('.split-pane').first().waitFor({ state: 'detached' });
  assert.equal(await diff().locator('.split-pane').count(), 0);
  assert.match(await diff().locator('.pk-cmt').innerText(), /Keep these lines aligned/);
  assert.equal(await page.locator('pk-review-toolbar').evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  await page.locator('#t-threads').evaluate((el) => { el.checked = false; });
  await page.waitForFunction(() => document.querySelector('.pk-threads').getBoundingClientRect().right <= 0);
  await page.screenshot({ path: 'tmp/review-layout/phone.png' });
  await page.setViewportSize({ width: 1024, height: 768 });
  await pane('After').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Split', exact: true }).getAttribute('aria-pressed'), 'true');
  await aligned();
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});
