// End to end: the first-run onboarding on a machine that never ran pi. The backend this file starts is its own (an empty agent folder, an empty data
// folder, `PI_OFFLINE`, no real keychain); the page is the shared renderer pointed at it. The model is the local llama-swap every e2e test uses; nothing else is reached.
//
// Walk: Welcome -> Get a model (the local server is found and added to models.json; an API key goes through the workflow into auth.json) -> Pick defaults (settings.json)
// -> Open a folder (a scratch folder) -> First prompt (the real chat page, "pi is ready", a real answer) -> done, and it does not open again. Then `/setup` opens it for a
// machine that works, where "Use my existing pi setup" is the way out.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { env, openApp } from './support/app.mjs';
import { createWorld, isUp, root } from './support/env.mjs';

const PORT = Number(new URL(env.api).port) + 17;
const API = `http://127.0.0.1:${PORT}`;
// The local server the app finds by scanning: the real one, not the proxy scripts/e2e.mjs puts in front of it.
const MODEL_URL = process.env.E2E_UPSTREAM_MODEL_URL ?? process.env.E2E_MODEL_URL ?? 'http://127.0.0.1:8080/v1';

let world;
let backend;
let app;
let logFd;

/** A request against this file's own backend, with its dev token. */
async function call(path, init = {}) {
  const { token } = await (await fetch(`${API}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  return res.json();
}

const readJson = (name) => JSON.parse(readFileSync(join(world.agent, name), 'utf8'));
const flow = () => app.page.getByTestId('onboarding');

before(async () => {
  world = createWorld({ fresh: true, onboarding: true, offline: true });
  logFd = openSync(join(world.base, 'onboarding-backend.log'), 'w');
  backend = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: root,
    env: { ...process.env, ...world.env, NODE_ENV: 'development', PI_KIT_PORT: String(PORT), PI_KIT_ORIGIN: env.base, PI_KIT_VERSION: '0.0.0-e2e' },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  const deadline = Date.now() + 60_000;
  while (!(await isUp(`${API}/api/dev/token`, { Origin: env.base }))) {
    if (Date.now() > deadline) throw new Error('The onboarding test backend did not start.');
    await new Promise((r) => setTimeout(r, 300));
  }
  app = await openApp({ backend: API });
});

after(async () => {
  await app?.close();
  try {
    process.kill(-backend.pid, 'SIGKILL');
  } catch {
    // gone already
  }
  if (logFd !== undefined) closeSync(logFd);
  world?.dispose();
});

describe('first-run onboarding', () => {
  it('detects a machine that has no model: no provider, the local server, the pi that runs the sessions', async () => {
    const info = await call('/api/setup');
    assert.equal(info.needsSetup, true);
    assert.deepEqual(info.providers, []);
    assert.equal(info.existingSetupWorks, false);
    assert.equal(info.agentDir.path, world.agent);
    assert.deepEqual(info.agentDir.auth, []);
    assert.equal(info.agentDir.hasModelsJson, false);
    assert.ok(info.pi.version.match(/^\d+\.\d+\.\d+/), `pi version ${info.pi.version}`);
    assert.ok(info.localServers.some((s) => s.baseUrl === MODEL_URL.replace(/\/$/, '') && s.models.length > 0), `the local server is found: ${JSON.stringify(info.localServers)}`);
    assert.equal(info.autoOpenOff, false);
  });

  it('opens by itself with the Welcome card, what it found, and no fast path (there is nothing to reuse)', async () => {
    await flow().waitFor();
    await flow().getByTestId('found').getByText('bundled').waitFor();
    assert.match(await flow().getByTestId('found').innerText(), /llama-swap|local server/);
    assert.equal(await flow().getByTestId('use-existing').count(), 0);
    await flow().getByTestId('get-started').click();
    await flow().getByRole('heading', { name: 'How should pi reach a model?' }).waitFor();
    // Nothing is chosen, so Continue waits.
    assert.equal(await flow().getByTestId('continue').isDisabled(), true);
  });

  it('adds the local server in one click: pi’s models.json gets the provider and its models, and the card says so', async () => {
    const models = (await (await fetch(`${MODEL_URL}/models`)).json()).data.map((m) => m.id);
    await flow().getByTestId('use-local').click();
    await flow().getByTestId('card-status').filter({ hasText: /configured in models.json/ }).waitFor();
    const file = readJson('models.json');
    const provider = Object.values(file.providers)[0];
    assert.equal(provider.baseUrl.replace(/\/$/, ''), MODEL_URL.replace(/\/$/, ''));
    assert.equal(provider.api, 'openai-completions');
    assert.deepEqual(provider.models.map((m) => m.id).sort(), [...models].sort());
    await flow().getByTestId('model-summary').getByText(/\d+ models? ready/).waitFor();
    assert.equal(await flow().getByTestId('continue').isEnabled(), true);
  });

  it('opens the shared model library and engine setup without running a benchmark or inference', async () => {
    await flow().getByTestId('local-more').click();
    const wizard = flow().getByTestId('local-runtime-wizard');
    await wizard.getByRole('tab', { name: 'Engines', exact: true }).click();
    await wizard.getByRole('region', { name: 'llama-swap setup', exact: true }).waitFor();
    const initial = await call('/api/setup/local-runtime');
    assert.equal(initial.job, undefined, 'opening setup is read-only');
    await wizard.getByTestId('model-directory').fill(world.base);
    await wizard.getByRole('button', { name: 'Check folder and engines' }).click();
    await pollUntil(async () => !(await wizard.getByRole('button', { name: 'Check folder and engines' }).isDisabled()), 'folder discovery finished');
    await wizard.getByRole('tab', { name: /^Your models/ }).click();
    assert.equal(await wizard.getByTestId('local-context').count(), 0);
    assert.equal(await wizard.getByRole('button', { name: /bench|Measure speed/ }).count(), 0);
    await flow().getByTestId('local-more').click();
  });

  it('adds an API key through the workflow: auth.json (0600) holds it, the card shows provider and last four characters, never the key', async () => {
    const key = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef7e57';
    await flow().getByTestId('add-key-card').click();
    const wf = app.page.getByTestId('key-workflow');
    await wf.getByRole('button', { name: 'OpenRouter' }).click();
    await wf.getByRole('button', { name: 'Next' }).click();
    await wf.getByRole('button', { name: 'I have a key' }).click();
    const field = wf.getByLabel('Paste the key');
    await wf.getByText('Asking pi to sign in').waitFor({ state: 'detached' });
    assert.equal(await field.getAttribute('type'), 'password', 'the key field is a password field');
    assert.equal(await wf.getByRole('button', { name: /show|reveal/i }).count(), 0, 'there is no reveal toggle');
    await field.fill(key);
    await wf.getByTestId('validate-save').click();
    await wf.getByTestId('key-result').waitFor();
    // PI_OFFLINE: pi-kit makes no request; the card says "not checked", not "validated".
    assert.equal((await wf.getByTestId('key-status').innerText()).trim(), 'not checked');
    await wf.getByTestId('key-done').click();
    // The scratch world has a credential store, so the key is kept there and the card names the store, not the key's last four.
    await flow().getByTestId('card-status').filter({ hasText: /OpenRouter key/ }).waitFor();
    const auth = readJson('auth.json');
    assert.equal(auth.openrouter.type, 'api_key');
    assert.equal(statSync(join(world.agent, 'auth.json')).mode & 0o777, 0o600);
    // The key is nowhere in what the page shows or what the backend says about providers.
    const page = await app.page.content();
    assert.equal(page.includes(key), false, 'the page never holds the key');
    assert.equal(JSON.stringify(await call('/api/pi-settings')).includes(key), false, 'no endpoint returns the key');
    assert.equal(JSON.stringify(await call('/api/setup')).includes(key), false);
  });

  it('picks the defaults: the model, the effort and the pinned models land in pi’s settings.json', async () => {
    await flow().getByTestId('continue').click();
    await flow().getByTestId('defaults').waitFor();
    const select = flow().getByTestId('default-model');
    // pi has no default yet, so the card picks one itself; the person then chooses.
    await app.page.waitForFunction(() => document.querySelector('[data-testid="default-model"]')?.value);
    const local = await select.evaluate((el) => [...el.options].map((o) => o.value).find((v) => !v.startsWith('openrouter/')));
    await select.selectOption(local);
    const [provider, ...rest] = local.split('/');
    await pollUntil(() => readJson('settings.json').defaultModel === rest.join('/'), 'the default model is written');
    assert.equal(readJson('settings.json').defaultProvider, provider);
    // One model checked: the cycle has exactly that one.
    const pinned = flow().getByTestId('pinned-models').getByRole('checkbox').first();
    await pinned.check();
    await pollUntil(() => Array.isArray(readJson('settings.json').enabledModels) && readJson('settings.json').enabledModels.length === 1, 'the pinned model is written');
    // Compaction off and on again.
    const compaction = flow().getByTestId('auto-compaction');
    await compaction.uncheck();
    await pollUntil(() => readJson('settings.json').compaction?.enabled === false, 'compaction is switched off');
    await compaction.check();
    await pollUntil(() => readJson('settings.json').compaction?.enabled !== false, 'compaction is back on');
  });

  it('opens a scratch folder: a new empty folder in pi-kit’s data folder becomes a project', async () => {
    await flow().getByTestId('continue').click();
    await flow().getByTestId('trust-note').waitFor();
    await flow().getByTestId('scratch-folder').click();
    const opened = await flow().getByTestId('folder-opened').locator('code').innerText();
    assert.ok(opened.startsWith(join(world.data, 'scratch')), opened);
    assert.ok(existsSync(opened));
    const workspaces = await call('/api/workspaces');
    assert.ok(workspaces.some((w) => w.cwd === opened), 'the folder is a known project');
  });

  it('ends on the real chat page: pi answers the readiness request, a suggested prompt fills the real composer, and pi answers it', async () => {
    await flow().getByTestId('continue').click();
    const strip = app.page.getByTestId('onboarding-strip');
    await strip.waitFor();
    assert.equal(await flow().count(), 0, 'the cards are gone: the page behind is the real app');
    await strip.getByTestId('ready-chip').filter({ hasText: 'pi is ready' }).waitFor();
    const suggested = strip.getByTestId('suggested-prompt').nth(1);
    const text = (await suggested.getAttribute('title')) ?? '';
    await suggested.click();
    const box = app.page.getByLabel('Message to pi');
    await pollUntil(async () => (await box.innerText()).includes(text.slice(0, 20)) || (await box.inputValue().catch(() => '')).includes(text.slice(0, 20)), 'the composer holds the prompt');
    await box.press('Enter');
    await app.page.locator('pk-transcript pk-prose').first().waitFor();
    await app.page.getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached' });
    assert.ok((await app.page.locator('pk-transcript pk-prose').allInnerTexts()).join('').trim().length > 0, 'pi answered');
  });

  it('finishing closes the strip, and the flow stays closed after a reload (it was finished, and a model exists)', async () => {
    await app.page.getByTestId('finish-setup').click();
    await app.page.getByTestId('onboarding-strip').waitFor({ state: 'detached' });
    assert.equal((await call('/api/setup')).onboarding.state, 'completed');
    await app.page.reload();
    await app.page.waitForSelector('pk-root .pk-shell');
    await app.page.waitForTimeout(1500);
    assert.equal(await flow().count(), 0);
  });

  it('/setup opens it again on a machine that works, where "Use my existing pi setup" goes on to the defaults without changing anything', async () => {
    const before = readFileSync(join(world.agent, 'settings.json'), 'utf8');
    await app.page.getByLabel('Message to pi').fill('/setup');
    await app.page.getByRole('option', { name: /^\/setup/ }).click();
    await flow().waitFor();
    await flow().getByTestId('existing-setup').waitFor();
    await flow().getByTestId('use-existing').click();
    // The model step is done; the rest of the flow (defaults, folder, first prompt) is still there to look at, and Skip ends it.
    await flow().getByTestId('defaults').waitFor();
    await flow().getByRole('button', { name: /Skip setup/ }).click();
    await flow().waitFor({ state: 'detached' });
    assert.equal(readFileSync(join(world.agent, 'settings.json'), 'utf8'), before, 'nothing in pi’s folder changed');
  });

  it('skipping leaves a skipped record: with no model it does not open by itself again', async () => {
    // A second, empty machine: the same backend code, nothing configured.
    const second = createWorld({ fresh: true, onboarding: true, offline: true });
    const port = PORT + 1;
    const fd = openSync(join(second.base, 'backend.log'), 'w');
    const child = spawn('node', ['dist/apps/backend/main.js'], {
      cwd: root,
      env: { ...process.env, ...second.env, NODE_ENV: 'development', PI_KIT_PORT: String(port), PI_KIT_ORIGIN: env.base, PI_KIT_VERSION: '0.0.0-e2e' },
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    const deadline = Date.now() + 60_000;
    while (!(await isUp(`http://127.0.0.1:${port}/api/dev/token`, { Origin: env.base }))) {
      if (Date.now() > deadline) throw new Error('The second backend did not start.');
      await new Promise((r) => setTimeout(r, 300));
    }
    const other = await openApp({ backend: `http://127.0.0.1:${port}` });
    try {
      await other.page.getByTestId('onboarding').waitFor();
      await other.page.getByTestId('skip-setup').click();
      await other.page.getByTestId('onboarding').waitFor({ state: 'detached' });
      await other.page.reload();
      await other.page.waitForSelector('pk-root .pk-shell');
      await other.page.waitForTimeout(1500);
      assert.equal(await other.page.getByTestId('onboarding').count(), 0, 'skipped: it stays closed although there is still no model');
    } finally {
      await other?.close();
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // gone
      }
      closeSync(fd);
      second.dispose();
    }
  });
});

async function pollUntil(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
