import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { env, openApp } from './support/app.mjs';
import { ALT_MODEL, THINKING_MODEL, createWorld, isUp, root } from './support/env.mjs';

const PORT = Number(new URL(env.api).port) + 39;
const API = `http://127.0.0.1:${PORT}`;
const KEY = 'sk-litellm-test-virtual-key-123456';
let world, backend, app, proxy, proxyUrl, logFd;
let proxyStatus = 200;
let ids = Array.from({ length: 35 }, (_, i) => `team/model-${i}`);
const requests = [];
const settings = () => app.page.getByRole('dialog', { name: 'Settings', exact: true });
const wizard = () => app.page.getByTestId('add-provider-wizard');
const config = () => JSON.parse(readFileSync(join(world.agent, 'models.json'), 'utf8'));
async function call(path) {
  const { token } = await (await fetch(`${API}/api/dev/token`, { headers: { Origin: env.base } })).json();
  return (await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })).json();
}

before(async () => {
  proxy = createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401).end('{}'); return; }
    if (proxyStatus !== 200) { res.writeHead(proxyStatus).end('{}'); return; }
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: ids.map((id) => ({ id, max_input_tokens: 64000, max_output_tokens: 8000 })) }));
    else if (req.url === '/model/info') res.end(JSON.stringify({ data: ids.map((model_name) => ({ model_name, model_info: { supports_vision: true, supports_reasoning: true } })) }));
    else res.writeHead(404).end('{}');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}/v1`;
  world = createWorld({ offline: true, setup: ({ agent }) => {
    const path = join(agent, 'models.json'), config = JSON.parse(readFileSync(path, 'utf8'));
    const local = config.providers['llama-swap'], [gemma, llama, qwen] = local.models;
    const deepseek = { ...gemma, id: 'fixture/deepseek', name: 'DeepSeek', contextWindow: 393216 };
    config.providers.ds4 = { ...local, name: 'DeepSeek (llama-swap)', models: [deepseek] };
    config.providers.mlx = { ...local, name: 'MLX (llama-swap)', models: [{ ...gemma, contextWindow: 256000 }] };
    config.providers.qwen = { ...local, name: 'Qwen (llama-swap)', models: [qwen] };
    config.providers.glm = { ...local, name: 'GLM (llama-swap)', models: [llama] };
    config.providers['llama-swap'] = { ...local, models: [] };
    writeFileSync(path, JSON.stringify(config));
    const settingsPath = join(agent, 'settings.json'), settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    writeFileSync(settingsPath, JSON.stringify({ ...settings, defaultProvider: 'mlx', enabledModels: [`mlx/${gemma.id}`, `glm/${llama.id}`] }));
  } });
  logFd = openSync(join(world.base, 'litellm-backend.log'), 'w');
  backend = spawn('node', ['dist/apps/backend/main.js'], { cwd: root, env: { ...process.env, ...world.env, NODE_ENV: 'development', PI_KIT_PORT: String(PORT), PI_KIT_ORIGIN: env.base, PI_KIT_VERSION: '0.0.0-e2e' }, stdio: ['ignore', logFd, logFd], detached: true });
  const deadline = Date.now() + 60_000;
  while (!(await isUp(`${API}/api/dev/token`, { Origin: env.base }))) {
    if (Date.now() > deadline) throw new Error('LiteLLM test backend did not start');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  app = await openApp({ backend: API });
  await app.h.newThread();
});
after(async () => {
  await app?.close(); await new Promise((resolve) => proxy?.close(resolve));
  try { process.kill(-backend.pid, 'SIGKILL'); } catch { /* already stopped */ }
  if (logFd !== undefined) closeSync(logFd);
  world?.dispose();
});

describe('LiteLLM provider', () => {
  it('discovers a bounded catalog, handles a refused key and saves one real provider securely', async () => {
    await app.h.openSettings('Providers');
    await settings().getByTestId('add-provider').click();
    await wizard().getByTestId('choice-litellm').click();
    await wizard().getByLabel('Proxy URL', { exact: true }).fill(proxyUrl);
    await wizard().getByLabel('LiteLLM API key', { exact: true }).fill('wrong-key');
    await wizard().getByTestId('litellm-discover').click();
    await wizard().getByRole('alert').filter({ hasText: 'refused' }).waitFor();
    await wizard().getByLabel('LiteLLM API key', { exact: true }).fill(KEY);
    await wizard().getByTestId('litellm-discover').click();
    await wizard().getByTestId('litellm-models').waitFor();
    assert.equal(await wizard().getByTestId('litellm-models').locator('strong').count(), 35);
    assert.equal(await wizard().locator('pk-scroll-area').evaluate((el) => el.scrollHeight > el.clientHeight), true);
    assert.match(await wizard().innerText(), /64000 context tokens/);
    if (process.env.E2E_CAPTURE_SETTINGS) {
      mkdirSync(process.env.E2E_CAPTURE_SETTINGS, { recursive: true });
      await wizard().screenshot({ path: join(process.env.E2E_CAPTURE_SETTINGS, 'litellm-connection.png') });
    }
    await wizard().getByTestId('litellm-save').click();
    await wizard().getByTestId('provider-result').waitFor();
    assert.match(await wizard().innerText(), /Connection saved/);
    assert.equal((await wizard().innerText()).includes('One request succeeded'), false);
    await wizard().getByTestId('provider-done').click();
    await wizard().waitFor({ state: 'detached' });
    const provider = settings().locator('[data-provider="litellm"]');
    await provider.waitFor();
    assert.match(await provider.innerText(), /LiteLLM/);
    assert.match(await provider.innerText(), /Gateway/);
    assert.equal(config().providers.litellm.models.length, 35);
    assert.equal(JSON.stringify(config()).includes(KEY), false);
    assert.ok(config().providers['llama-swap']);
    assert.equal(JSON.stringify(await call('/api/setup/litellm')).includes(KEY), false);
    assert.equal(JSON.stringify(await call('/api/pi-settings')).includes(KEY), false);
  });

  it('reopens with saved credentials and refreshes removed aliases without duplicate provider rows', async () => {
    await settings().locator('[data-provider="litellm"]').getByRole('button', { name: 'Edit LiteLLM', exact: true }).click();
    await wizard().getByTestId('litellm-models').waitFor();
    assert.equal(await wizard().getByLabel('Authentication', { exact: true }).inputValue(), 'saved');
    ids = ['team/replacement'];
    await wizard().getByTestId('litellm-discover').click();
    await wizard().getByText('team/replacement', { exact: true }).waitFor();
    assert.equal(await wizard().getByTestId('litellm-models').locator('strong').count(), 1);
    await wizard().getByTestId('litellm-save').click();
    await wizard().getByTestId('provider-result').waitFor();
    await wizard().getByTestId('provider-done').click();
    await wizard().waitFor({ state: 'detached' });
    assert.equal(await settings().locator('[data-provider="litellm"]').count(), 1);
    assert.deepEqual(config().providers.litellm.models.map((m) => m.id), ids);
    await app.page.keyboard.press('Escape');
    await app.page.getByTestId('model-chip').click();
    const picker = app.page.getByTestId('model-picker');
    await picker.locator('[data-model="litellm/team/replacement"]').waitFor();
    assert.equal(await picker.locator('[data-model="litellm/team/model-0"]').count(), 0);
    assert.ok(requests.filter((r) => r.auth === `Bearer ${KEY}`).length >= 8);
    assert.deepEqual(app.errors, []);
    assert.equal(readFileSync(join(world.base, 'litellm-backend.log'), 'utf8').includes(KEY), false);
  });

  it('refreshes when reopening the picker without visiting Settings, and keeps the catalog when the proxy is down', async () => {
    await app.page.keyboard.press('Escape');
    ids = ['team/automatic'];
    await app.page.getByTestId('model-chip').click();
    const picker = app.page.getByTestId('model-picker');
    await picker.locator('[data-model="litellm/team/automatic"]').waitFor();
    assert.equal(await picker.locator('[data-model="litellm/team/replacement"]').count(), 0);
    assert.deepEqual(config().providers.litellm.models.map((m) => m.id), ids);
    await app.page.keyboard.press('Escape');
    proxyStatus = 503;
    const response = app.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/models');
    await app.page.getByTestId('model-chip').click();
    await response;
    await picker.locator('[data-model="litellm/team/automatic"]').waitFor();
    assert.equal(await picker.locator('[data-model="mlx/gemma-4-26b"]').count() > 0, true);
    assert.deepEqual(config().providers.litellm.models.map((m) => m.id), ids);
    assert.deepEqual(app.errors, []);
  });

  it('keeps cleaned local models pinned and shows a newly registered model once', async () => {
    const picker = app.page.getByTestId('model-picker');
    for (const id of ['gemma-4-26b', `${THINKING_MODEL.id}`, `${ALT_MODEL.id}`, 'fixture/deepseek']) {
      assert.equal(await picker.locator(`[data-model$="/${id}"]`).count(), 1, `${id} appears once across pinned and local sections`);
    }
    const gemma = picker.locator('[data-model="mlx/gemma-4-26b"]');
    assert.match(await gemma.innerText(), /256k context/);
    assert.equal(await gemma.getAttribute('aria-selected'), 'true');
    const stable = (await gemma.getAttribute('id')).match(/model-[a-f0-9]{16}$/)[0];
    await app.page.keyboard.press('Escape');
    const path = join(world.agent, 'models.json'), file = config();
    file.providers['llama-swap'].models.push({ id: 'new-download' });
    writeFileSync(path, JSON.stringify(file));
    await app.page.getByTestId('model-chip').click();
    await picker.locator('[data-model="llama-swap/new-download"]').waitFor();
    assert.equal(await picker.locator('[data-model$="/new-download"]').count(), 1);
    assert.equal((await picker.locator('[data-model="mlx/gemma-4-26b"]').getAttribute('id')).match(/model-[a-f0-9]{16}$/)[0], stable);
    assert.equal(await picker.locator('[data-model$="/gemma-4-26b"]').count(), 1);
    assert.deepEqual(app.errors, []);
  });

});
