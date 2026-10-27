// Reasoning rendering through pi's real streaming and replay paths. The local test model may not expose reasoning, so this
// file owns a scratch backend and an OpenAI-compatible fixture that always streams a timed reasoning block before each answer.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { env, openApp } from './support/app.mjs';
import { THINKING_MODEL, createWorld, isUp, root } from './support/env.mjs';
import { startFakeModel, userTextOf } from './support/fake-model.mjs';

const API = `http://127.0.0.1:${Number(new URL(env.api).port) + 32}`;
let model;
let world;
let backend;
let log;
let app;

before(async () => {
  model = await startFakeModel({ answer: (body) => ({
    reasoning: 'Multiply the two numbers, then check the result.',
    reasoningMs: 1100,
    text: userTextOf(body).includes('17') ? '17 times 23 is 391.' : '12 times 12 is 144.',
  }) });
  world = createWorld({ setup: ({ agent }) => {
    const file = join(agent, 'models.json');
    const models = JSON.parse(readFileSync(file, 'utf8'));
    models.providers['llama-swap'].baseUrl = model.url;
    writeFileSync(file, JSON.stringify(models));
  } });
  log = openSync(join(world.base, 'thinking-backend.log'), 'w');
  backend = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: root,
    env: { ...process.env, ...world.env, NODE_ENV: 'development', PI_KIT_PORT: new URL(API).port, PI_KIT_ORIGIN: env.base },
    stdio: ['ignore', log, log],
    detached: true,
  });
  const deadline = Date.now() + 60_000;
  while (!(await isUp(`${API}/api/dev/token`, { Origin: env.base }))) {
    if (Date.now() > deadline) throw new Error(`The thinking test backend did not start: ${world.base}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  app = await openApp({ backend: API });
});
after(async () => {
  await app?.close();
  if (backend) {
    try { process.kill(-backend.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
  }
  if (log !== undefined) closeSync(log);
  await model?.stop();
  world?.dispose();
});

describe('transcript de-clutter', () => {
  it('has no avatars, no per-turn labels at rest, and timed thinking before and after a reload', async () => {
    const { page, h } = app;
    await h.newThread();
    await page.getByRole('button', { name: 'Model', exact: true }).filter({ hasText: 'gemma-4-26b' }).waitFor();
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await page.getByRole('option', { name: THINKING_MODEL.id }).click();
    await page.getByRole('button', { name: 'Model', exact: true }).filter({ hasText: THINKING_MODEL.id }).waitFor();
    await page.locator('pk-composer-well').getByRole('button', { name: /^Thinking effort:/ }).click();
    const slider = page.getByRole('slider', { name: 'Thinking effort', exact: true });
    const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname.endsWith('/model') && response.request().postDataJSON()?.thinkingLevel === 'low');
    await slider.press('Home');
    await slider.press('ArrowRight');
    await slider.press('ArrowRight');
    const response = await saved;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).thinkingLevel, 'low');
    await page.keyboard.press('Escape');
    await h.prompt('What is 17 times 23? Answer in one short sentence.');
    await h.prompt('And 12 times 12? One short sentence.');
    assert.equal(model.requests.length, 2);
    assert.equal(await page.locator('pk-turn .who').count(), 0);
    const captions = page.locator('.pk-when');
    assert.equal(await captions.count(), 2);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    for (const opacity of await captions.evaluateAll((els) => els.map((el) => getComputedStyle(el).opacity))) assert.equal(opacity, '0');
    const think = async () => (await page.locator('pk-think summary').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim());
    assert.equal((await think()).length, 2);
    for (const row of await think()) assert.match(row, /^Thought for \d+s$/);
    await page.reload();
    await page.getByLabel('Message to pi').waitFor();
    await page.locator('pk-think summary').nth(1).waitFor();
    assert.equal((await think()).length, 2);
    for (const row of await think()) assert.match(row, /^Thought for \d+s$/);
    assert.equal(await page.locator('.pk-step').count(), 0);
  });
});
