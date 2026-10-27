// End to end: the one model picker. The backend this file starts is its own, on a scratch machine that is signed in to an Anthropic subscription, an OpenRouter key and
// a Google key from the environment besides the local llama-swap (e2e/support/picker-world.mjs), with a fake server answering the two usage endpoints; the page is the shared renderer pointed
// at it. No real account, token or keychain is involved, and the tokens in the scratch files must never reach the backend's log.
//
// Walk: the picker from the composer chip (Pinned, a section per provider with its state and usage), the search (glob, a section with no match hides),
// pin and unpin from a row with ⌘⇧M honouring the set, the keyboard (↑ ⏎, ⇧⏎), the effort popover and brain, and the usage cache.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { env, openApp } from './support/app.mjs';
import { ALT_MODEL, MODEL, THINKING_MODEL, createWorld, isUp, root } from './support/env.mjs';
import { FAKE_KEY, FAKE_RADIUS_TOKEN, FAKE_TOKEN, pickerWorld, startUsageServer } from './support/picker-world.mjs';

const PORT = Number(new URL(env.api).port) + 23;
const API = `http://127.0.0.1:${PORT}`;

let usage;
let world;
let backend;
let app;
let logFd;
let logPath;

/** A request against this file's own backend, with its dev token. */
async function call(path, init = {}) {
  const { token } = await (await fetch(`${API}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  return res.json();
}

const settings = () => JSON.parse(readFileSync(join(world.agent, 'settings.json'), 'utf8'));
const pinnedNow = () => settings().enabledModels ?? [];

async function pollUntil(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const chip = () => app.page.getByTestId('model-chip');
const picker = () => app.page.getByTestId('model-picker');
const row = (model) => picker().locator(`[data-testid="picker-row"][data-model="${model}"]`);
const section = (key) => picker().locator(`[data-testid="picker-section"][data-section="${key}"]`);

async function openFromChip() {
  await chip().click();
  await picker().waitFor();
  await picker().getByTestId('picker-row').first().waitFor();
}

async function close() {
  await app.page.keyboard.press('Escape');
  await picker().waitFor({ state: 'detached' });
}

before(async () => {
  usage = await startUsageServer();
  const fixture = pickerWorld(usage.urls);
  world = createWorld({ ...fixture, setup: (context) => {
    fixture.setup(context);
    const file = join(context.agent, 'models.json'), config = JSON.parse(readFileSync(file, 'utf8'));
    const local = config.providers['llama-swap'];
    config.providers.ds4 = { ...local, name: 'DeepSeek (llama-swap)', models: [local.models[0]] };
    config.providers.glm = { ...local, name: 'GLM (llama-swap)', models: [local.models[2]] };
    writeFileSync(file, JSON.stringify(config, null, 2));
  } });
  logPath = join(world.base, 'picker-backend.log');
  logFd = openSync(logPath, 'w');
  backend = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: root,
    env: { ...process.env, ...world.env, NODE_ENV: 'development', PI_KIT_PORT: String(PORT), PI_KIT_ORIGIN: env.base, PI_KIT_VERSION: '0.0.0-e2e' },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  const deadline = Date.now() + 60_000;
  while (!(await isUp(`${API}/api/dev/token`, { Origin: env.base }))) {
    if (Date.now() > deadline) throw new Error('The picker test backend did not start.');
    await new Promise((r) => setTimeout(r, 300));
  }
  app = await openApp({ backend: API });
  await app.h.newThread();
});

after(async () => {
  await app?.close();
  try {
    process.kill(-backend.pid, 'SIGKILL');
  } catch {
    // gone already
  }
  if (logFd !== undefined) closeSync(logFd);
  await usage?.stop();
  world?.dispose();
});

describe('the model picker', () => {
  it('opens upward from the composer chip: Pinned first, then a section per provider with its state and usage', async () => {
    await openFromChip();
    const keys = await picker().getByTestId('picker-section').evaluateAll((els) => els.map((el) => el.getAttribute('data-section')));
    assert.equal(keys[0], 'pinned');
    for (const wanted of ['provider:anthropic', 'provider:openrouter', 'provider:radius', 'provider:google', 'provider:llama.cpp']) assert.ok(keys.includes(wanted), `${wanted} in ${keys}`);
    // The subscription comes before the key, the key before the environment, the local server last.
    assert.ok(keys.indexOf('provider:anthropic') < keys.indexOf('provider:openrouter'));
    assert.ok(keys.indexOf('provider:openrouter') < keys.indexOf('provider:google'));
    assert.equal(keys.at(-1), 'provider:llama.cpp');
    // Pinned are the two models of the scratch settings, in ⌘⇧M order, with the provider in their detail line.
    assert.deepEqual(await picker().locator('[data-testid="picker-row"]').evaluateAll((els) => els.slice(0, 2).map((el) => el.getAttribute('data-model'))), [`llama-swap/${MODEL.id}`, `llama-swap/${ALT_MODEL.id}`]);
    assert.match(await row(`llama-swap/${MODEL.id}`).innerText(), /llama.cpp · 262k context · free/);
    assert.match(await section('pinned').innerText(), /⌘⇧M cycles these/);
    assert.match(await picker().getByTestId('picker-pinned-count').innerText(), /^2 of \d+$/);
    // The states and the usage that the fake endpoints gave.
    const anthropic = await section('provider:anthropic').innerText();
    assert.match(anthropic, /subscription/);
    await section('provider:anthropic').getByTestId('picker-usage').waitFor();
    assert.match(await section('provider:anthropic').getByTestId('picker-usage').innerText(), /38 % of 5 h\s*·?\s*12 % of week/);
    assert.match(await section('provider:openrouter').innerText(), /API key/);
    await section('provider:openrouter').getByTestId('picker-usage').waitFor();
    assert.match(await section('provider:openrouter').getByTestId('picker-usage').innerText(), /credit \$41\.20/);
    await section('provider:radius').getByTestId('picker-usage').waitFor();
    assert.match(await section('provider:radius').getByTestId('picker-usage').innerText(), /credit \$41\.20/);
    assert.match(await section('provider:google').innerText(), /env/);
    assert.equal(await section('provider:google').getByTestId('picker-usage').count(), 0, 'a provider with no source shows no usage');
    assert.match(await section('provider:llama.cpp').innerText(), /local/);
    assert.match(await section('provider:llama.cpp').innerText(), /127\.0\.0\.1:\d+/);
    // Upward: the panel is above the chip. Search is the field at the bottom, and it has the focus.
    const [panel, button] = await Promise.all([picker().boundingBox(), chip().boundingBox()]);
    assert.ok(panel.y + panel.height <= button.y + 2, 'the picker opens above the chip');
    const field = picker().getByTestId('picker-search');
    const [fieldBox, listBox] = await Promise.all([field.boundingBox(), picker().getByTestId('picker-list').boundingBox()]);
    assert.ok(fieldBox.y > listBox.y + listBox.height - 1, 'the search field is below the list');
    assert.equal(await field.evaluate((el) => el === document.activeElement), true);
    const lead = await app.page.locator('[data-testid="new-thread-page"] .lead').boundingBox();
    const suggestions = await app.page.getByTestId('copilot-suggestions').boundingBox();
    assert.ok(lead && suggestions && suggestions.y >= lead.y + lead.height + 12, 'suggestions sit below the empty-thread lead without overlap');
    await close();
  });

  it('searches with a glob and hides the sections with no match', async () => {
    await openFromChip();
    await picker().getByTestId('picker-search').fill(`*${MODEL.id}*`);
    const keys = await picker().getByTestId('picker-section').evaluateAll((els) => els.map((el) => el.getAttribute('data-section')));
    assert.ok(keys.includes('pinned'), 'the pinned gemma matches');
    assert.ok(!keys.includes('provider:anthropic'), 'a provider with no match hides');
    assert.match(await picker().getByTestId('picker-count').innerText(), /^\d+ models?$/);
    await picker().getByTestId('picker-search').fill('zzzzzz-no-such-model');
    assert.equal(await picker().getByTestId('picker-section').count(), 0);
    assert.match(await picker().innerText(), /No model matches/);
    assert.match(await picker().getByTestId('picker-count').innerText(), /^0 models$/);
    await app.page.keyboard.press('Escape');
    await picker().waitFor({ state: 'detached' });
  });

  it('pins and unpins from a row without closing, and ⌘⇧M cycles exactly the pinned set', async () => {
    await openFromChip();
    await picker().getByTestId('picker-search').fill(`${THINKING_MODEL.id}`);
    const qwen = row(`llama-swap/${THINKING_MODEL.id}`);
    await qwen.hover();
    await qwen.getByTestId('picker-pin').click();
    await pollUntil(() => pinnedNow().includes(`llama-swap/${THINKING_MODEL.id}`), 'the pin is written to pi’s settings.json');
    // pi's own key, in cycling order: the new pin joins at the end.
    assert.deepEqual(pinnedNow(), [`llama-swap/${MODEL.id}`, `llama-swap/${ALT_MODEL.id}`, `llama-swap/${THINKING_MODEL.id}`]);
    await picker().waitFor();
    assert.equal(await section('pinned').count(), 1);
    assert.equal(await qwen.getByTestId('picker-pin').getAttribute('aria-pressed'), 'true');
    await picker().getByTestId('picker-search').fill('');
    await pollUntil(async () => /^3 of \d+$/.test(await picker().getByTestId('picker-pinned-count').innerText()), 'the count says 3 pinned');
    await close();
    // ⌘⇧M: gemma, llama3.2, qwen, and back to gemma.
    for (const next of [`${ALT_MODEL.id}`, `${THINKING_MODEL.id}`, `${MODEL.id}`]) {
      await app.page.keyboard.press('Meta+Shift+M');
      await app.page.locator('.toast', { hasText: new RegExp(`Model: ${next.replace('.', '\\.')}`) }).waitFor();
      assert.match(await chip().innerText(), new RegExp(next.replace('.', '\\.')));
      await app.page.locator('.toast').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
    }
    // Unpin llama3.2 from the Pinned section: the cycle is gemma and qwen.
    await openFromChip();
    const pinned = picker().locator(`[data-testid="picker-row"][data-model="llama-swap/${ALT_MODEL.id}"]`).first();
    await pinned.hover();
    await pinned.getByTestId('picker-pin').click();
    await pollUntil(() => !pinnedNow().includes(`llama-swap/${ALT_MODEL.id}`), 'the unpin is written');
    assert.deepEqual(pinnedNow(), [`llama-swap/${MODEL.id}`, `llama-swap/${THINKING_MODEL.id}`]);
    await close();
    await app.page.keyboard.press('Meta+Shift+M');
    await app.page.locator('.toast', { hasText: `Model: ${THINKING_MODEL.id}` }).waitFor();
    await app.page.locator('.toast').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
    await app.page.keyboard.press('Meta+Shift+M');
    await app.page.locator('.toast', { hasText: new RegExp(`Model: ${MODEL.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).waitFor();
  });

  it('works from the keyboard: ↑↓ move, ⏎ uses the model, ⇧⏎ pins or unpins it', async () => {
    await openFromChip();
    const search = picker().getByTestId('picker-search');
    await search.fill(`llama-swap/${ALT_MODEL.id}*`);
    // The first match is the highlighted row; ⇧⏎ pins it again, the field keeps the focus.
    await search.press('Shift+Enter');
    await pollUntil(() => pinnedNow().includes(`llama-swap/${ALT_MODEL.id}`), '⇧⏎ pinned the highlighted model');
    await search.press('Shift+Enter');
    await pollUntil(() => !pinnedNow().includes(`llama-swap/${ALT_MODEL.id}`), '⇧⏎ unpinned it');
    // ⏎ chooses the highlighted model: llama3.2 (not pinned now) and the chip shows it.
    await search.press('Enter');
    await picker().waitFor({ state: 'detached' });
    await chip().filter({ hasText: `${ALT_MODEL.id}` }).waitFor();
    // ↓ walks the list: the second row of an empty search is the second pinned model.
    await openFromChip();
    const first = await picker().locator('.opt.active').getAttribute('data-model');
    await picker().getByTestId('picker-search').press('ArrowDown');
    const activeModel = () => picker().locator('.opt.active').getAttribute('data-model');
    await pollUntil(async () => (await activeModel()) !== first, '↓ moved the highlight');
    const second = await activeModel();
    await picker().getByTestId('picker-search').press('Enter');
    await picker().waitFor({ state: 'detached' });
    await chip().filter({ hasText: second.split('/')[1] }).waitFor();
  });

  it('sets effort in a model-aware popover and disables the slider for a model that cannot think', async () => {
    await openFromChip();
    await picker().getByTestId('picker-search').fill(`${MODEL.id}`);
    await row(`llama-swap/${MODEL.id}`).first().click();
    await picker().waitFor({ state: 'detached' });
    await chip().filter({ hasText: `${MODEL.id}` }).waitFor();
    const slider = app.page.getByTestId('composer-effort-slider');
    const control = app.page.getByTestId('composer-effort-control');
    assert.equal(await slider.count(), 0, 'the toolbar contains a brain button, with the slider in its popup');
    // Right after a model switch the first click can come before the chip settles: click until the popover says it is open.
    await pollUntil(async () => (await control.getAttribute('aria-expanded')) === 'true' || (await control.click(), false), 'the effort popover opens');
    await pollUntil(() => slider.isDisabled(), 'gemma has no adjustable effort');
    await app.page.getByRole('dialog', { name: 'Thinking effort', exact: true }).getByText(`${MODEL.id} does not think`).waitFor();
    assert.equal(await slider.getAttribute('aria-valuetext'), 'off');
    await app.page.getByRole('button', { name: 'Close thinking effort', exact: true }).click();

    await openFromChip();
    await picker().getByTestId('picker-search').fill(`${THINKING_MODEL.id}`);
    await row(`llama-swap/${THINKING_MODEL.id}`).first().click();
    await chip().filter({ hasText: `${THINKING_MODEL.id}` }).waitFor();
    await pollUntil(async () => (await control.getAttribute('aria-expanded')) === 'true' || (await control.click(), false), 'the effort popover opens');
    await pollUntil(() => slider.isEnabled(), 'qwen supports adjustable thinking');
    const thread = (await call('/api/threads')).toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
    const models = await call(`/api/models?thread=${thread.id}`);
    const supported = models.models.find(model => model.provider === 'llama-swap' && model.id === `${THINKING_MODEL.id}`).levels;
    assert.equal(Number(await slider.getAttribute('max')), supported.length - 1, 'every slider stop comes from this model’s capabilities');
    assert.equal(supported.at(-1), 'high');
    const track = await slider.boundingBox();
    await app.page.mouse.move(track.x + 8, track.y + track.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(track.x + track.width - 8, track.y + track.height / 2, { steps: 4 });
    await pollUntil(async () => (await slider.getAttribute('aria-valuetext')) === 'high', 'dragging previews high');
    assert.equal((await call(`/api/threads/${thread.id}/stats`)).thinkingLevel, 'off', 'a drag is saved only when released');
    await app.page.mouse.up();
    await pollUntil(async () => (await call(`/api/threads/${thread.id}/stats`)).thinkingLevel === 'high', 'the committed effort is saved by pi');
    assert.equal(await picker().count(), 0, 'adjusting effort never opens model selection');
    assert.equal(await control.getAttribute('aria-expanded'), 'true');
    assert.equal(await control.locator('pk-flask').getAttribute('data-level'), 'high');
    if (process.env.E2E_CAPTURE_EFFORT) {
      await app.h.shot('effort-slider-desktop.png');
      await app.h.theme('pi-dark');
      await app.h.shot('effort-slider-desktop-dark.png');
      await app.h.theme('pi-light');
    }
    const viewport = app.page.viewportSize();
    await app.page.setViewportSize({ width: 390, height: 844 });
    await pollUntil(async () => {
      const sidebar = await app.page.locator('pk-thread-sidebar').boundingBox();
      return sidebar.x + sidebar.width <= 1;
    }, 'the phone drawer has finished closing');
    const geometry = await slider.boundingBox();
    assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= 390, 'the slider stays within the phone viewport');
    if (process.env.E2E_CAPTURE_EFFORT) await app.h.shot('effort-slider-phone.png');
    await app.page.setViewportSize(viewport);
    await slider.press('Home');
    await pollUntil(async () => (await call(`/api/threads/${thread.id}/stats`)).thinkingLevel === 'off', 'the native slider keyboard controls are saved');
    await slider.press('End');
    await pollUntil(async () => (await call(`/api/threads/${thread.id}/stats`)).thinkingLevel === 'high', 'End selects the highest supported level');
    await app.page.keyboard.press('Meta+Shift+E');
    await app.page.locator('.toast', { hasText: /Effort: off/ }).waitFor();
    await pollUntil(async () => (await slider.getAttribute('aria-valuetext')) === 'off', 'keyboard cycling updates the slider');
    await slider.press('Escape');
    await app.page.getByTestId('effort-popover').waitFor({ state: 'detached' });
  });

  it('/thinking opens and focuses the effort popover while /model opens model selection', async () => {
    const box = app.page.getByLabel('Message to pi');
    // Reopening immediately after Escape must not leave the signal open with a detached CDK overlay.
    for (let attempt = 0; attempt < 5; attempt++) {
      await box.fill('/thinking ');
      await box.press('Enter');
      try {
        await pollUntil(() => app.page.getByTestId('composer-effort-slider').evaluate(el => el === document.activeElement), 'the focus is on the effort slider');
      } catch (error) {
        console.error('effort focus diagnostics', { attempt, errors: app.errors }, await app.page.evaluate(() => ({ active: document.activeElement?.outerHTML, popover: document.querySelector('[data-testid="effort-popover"]')?.outerHTML, trigger: document.querySelector('[data-testid="composer-effort-control"]')?.outerHTML, draft: document.querySelector('textarea')?.value })));
        throw error;
      }
      assert.equal(await picker().count(), 0);
      if (attempt < 4) {
        await app.page.getByTestId('composer-effort-slider').press('Escape');
        await app.page.getByTestId('effort-popover').waitFor({ state: 'detached' });
      }
    }
    await box.fill('/model ');
    await box.press('Enter');
    await picker().waitFor();
    await pollUntil(() => picker().getByTestId('picker-search').evaluate(el => el === document.activeElement), 'the focus is on the search field');
    await close();
    await box.fill('');
  });

  it('asks the providers for usage with the stored token, once a minute, and never logs a token', async () => {
    const asked = usage.requests.filter((r) => r.path === '/anthropic/api/oauth/usage');
    assert.ok(asked.length >= 1, 'the picker asked for the Anthropic usage');
    // The subscription's OAuth token and the beta header the endpoint wants went to the fake server only.
    assert.equal(asked[0].authorization, `Bearer ${FAKE_TOKEN}`);
    assert.equal(asked[0].beta, 'oauth-2025-04-20');
    assert.equal(usage.requests.find((r) => r.path === '/openrouter/credits')?.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(usage.requests.find((r) => r.path === '/v1/organizations/picker-org/billing')?.authorization, `Bearer ${FAKE_RADIUS_TOKEN}`);
    // Opened again inside the minute: answered from the cache, the provider is not asked again.
    const before = usage.requests.length;
    await openFromChip();
    await section('provider:anthropic').getByTestId('picker-usage').waitFor();
    await close();
    assert.equal(usage.requests.length, before, 'no new request inside the minute');
    // The endpoint of the backend answers the same, and a provider with no source answers null.
    const answer = await call('/api/providers/anthropic/usage');
    assert.equal(answer.windows[0].name, '5 h');
    assert.equal(answer.windows[0].used, 38);
    assert.equal(await call('/api/providers/llama-swap/usage').catch(() => null), null);
    // Neither token is in the backend's log or in what the endpoint answers.
    const text = readFileSync(logPath, 'utf8');
    assert.ok(!text.includes(FAKE_TOKEN) && !text.includes(FAKE_KEY) && !text.includes(FAKE_RADIUS_TOKEN), 'a token reached the log');
    assert.ok(!JSON.stringify(answer).includes(FAKE_TOKEN));
  });

  it('reconciles Radius spending and top-ups on focus even while both usage caches are fresh', async () => {
    await openFromChip();
    const credit = section('provider:radius').getByTestId('picker-usage');
    await credit.waitFor();
    const before = usage.requests.filter((request) => request.path.endsWith('/billing')).length;
    usage.answer.radius.balance.available = 39.25;
    await app.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await pollUntil(async () => (await credit.innerText()).includes('$39.25'), 'Radius credits reflect spending');
    usage.answer.radius.balance.available = 59.25;
    await app.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await pollUntil(async () => (await credit.innerText()).includes('$59.25'), 'Radius credits reflect the top-up');
    assert.equal(usage.requests.filter((request) => request.path.endsWith('/billing')).length, before + 2);
    await close();
  });

  it('shows and refreshes the same Radius balance in Settings Providers', async () => {
    const dialog = await app.h.openSettings('Providers');
    const radius = dialog.locator('[data-provider="radius"]');
    await pollUntil(async () => (await radius.innerText()).includes('$59.25'), 'Settings reads shared Radius credits');
    usage.answer.radius.balance.available = 69.25;
    await app.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await pollUntil(async () => (await radius.innerText()).includes('$69.25'), 'Settings reconciles the top-up');
    await dialog.getByRole('button', { name: /^Close settings/ }).click();
  });

  it('groups llama.cpp connections in Settings, the catalog and the picker while keeping real model routing', async () => {
    const dialog = await app.h.openSettings('Providers');
    const group = dialog.locator('[data-provider-group="llama.cpp"]');
    assert.match(await dialog.getByRole('tab', { name: /^Providers/ }).innerText(), /5 signed in/);
    assert.equal(await group.count(), 1);
    assert.equal(await group.getAttribute('open'), null);
    const localModels = 5;
    assert.match((await group.locator('summary').innerText()).replace(/\s+/g, ' '), new RegExp(`${localModels} models · 3 connections`));
    await group.locator('summary').click();
    for (const id of ['ds4', 'glm', 'llama-swap']) await group.locator(`[data-provider="${id}"]`).waitFor();
    await group.getByRole('button', { name: 'Edit DeepSeek (llama-swap)', exact: true }).waitFor();
    if (process.env.E2E_CAPTURE_SETTINGS) {
      mkdirSync(process.env.E2E_CAPTURE_SETTINGS, { recursive: true });
      await app.page.screenshot({ animations: 'disabled', path: join(process.env.E2E_CAPTURE_SETTINGS, 'provider-group.png') });
    }
    await dialog.getByRole('tab', { name: 'Chat models', exact: true }).click();
    const models = dialog.getByTestId('section-models');
    const defaults = models.getByTestId('default-model');
    await defaults.waitFor();
    assert.equal(await defaults.locator('optgroup[label="llama.cpp"]').count(), 1);
    await models.getByRole('tab', { name: /^Catalog/ }).click();
    await models.getByRole('combobox', { name: 'Filter by provider' }).selectOption('llama.cpp');
    await pollUntil(async () => await models.locator('[data-testid="price-table"] tbody tr').count() === localModels, 'all local connection models share one catalog filter');
    await dialog.getByRole('button', { name: /^Close settings/ }).click();
    await openFromChip();
    await picker().getByTestId('picker-search').fill('llama.cpp');
    await section('provider:llama.cpp').waitFor();
    assert.equal(await picker().locator('[data-section^="provider:"]').count(), 1);
    await row('ds4/gemma-4-26b').waitFor();
    await row(`glm/${THINKING_MODEL.id}`).waitFor();
    if (process.env.E2E_CAPTURE_SETTINGS) await app.page.screenshot({ animations: 'disabled', path: join(process.env.E2E_CAPTURE_SETTINGS, 'picker-provider-group.png') });
    const change = app.page.waitForRequest((request) => /\/api\/threads\/[^/]+\/model$/.test(request.url()) && request.method() === 'PATCH');
    await row('ds4/gemma-4-26b').click();
    assert.equal((await change).postDataJSON().provider, 'ds4');
    await picker().waitFor({ state: 'detached' });
    await chip().filter({ hasText: 'gemma-4-26b' }).waitFor();
  });
});
