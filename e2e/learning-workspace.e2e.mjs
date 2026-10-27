// Real UI + backend, with a controlled model response to prove that learning never holds the app's navigation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import { env, openApp } from './support/app.mjs';
import { createWorld, isUp, root } from './support/env.mjs';
import { CANNED_SKILL, FAKE_MODEL, FAKE_PROVIDER, registerFakeModel, startFakeModel } from './support/fake-model.mjs';

const API = `http://127.0.0.1:${Number(new URL(env.api).port) + 49}`;
let app, fake, releaseDraft, world, backend, log;
let learnCalls = 0;
async function call(method, path, body) {
  const { token } = await (await fetch(`${API}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const response = await fetch(`${API}/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < end);
  assert.fail(`Timed out: ${label}`);
}
const row = title => app.page.locator('.pk-thread', { hasText: title }).first();
const review = () => app.page.getByTestId('review-dialog');

before(async () => {
  fake = await startFakeModel({ answer: body => {
    if (!JSON.stringify(body.messages?.[0] ?? '').includes('reusable skill')) return 'Ready.';
    learnCalls++;
    return new Promise(resolve => { releaseDraft = () => resolve(CANNED_SKILL); });
  } });
  // Own the model, settings and backend lifetime; the shared restart suite may already have stopped its backend.
  world = createWorld({ setup: ({ agent }) => registerFakeModel(agent, fake.url) });
  log = openSync(join(world.base, 'learning-backend.log'), 'w');
  backend = spawn('node', ['dist/apps/backend/main.js'], { cwd: root, env: { ...process.env, ...world.env, NODE_ENV: 'development', PI_KIT_PORT: new URL(API).port, PI_KIT_ORIGIN: env.base }, stdio: ['ignore', log, log], detached: true });
  await until(() => isUp(`${API}/api/dev/token`, { Origin: env.base }), 'the isolated learning backend', 60000);
  app = await openApp({ backend: API });
  await call('PATCH', '/attendant/settings', { enabled: false, model: { provider: FAKE_PROVIDER, modelId: FAKE_MODEL } });
});
after(async () => {
  releaseDraft?.();
  await app?.close();
  if (backend?.exitCode === null) {
    const exited = new Promise(resolve => backend.once('exit', resolve));
    const deadline = setTimeout(() => { try { process.kill(-backend.pid, 'SIGKILL'); } catch { /* Already stopped. */ } }, 10000);
    backend.kill('SIGTERM');
    await exited;
    clearTimeout(deadline);
  }
  if (log !== undefined) closeSync(log);
  await fake?.stop();
  world?.dispose();
});

it('drafts in a persistent learning chat while another chat stays usable, then restores inline review', async () => {
  const source = await call('POST', '/threads', { cwd: world.project, title: 'Learning source' });
  await call('PATCH', `/threads/${source.id}/model`, { provider: FAKE_PROVIDER, modelId: FAKE_MODEL });
  await call('POST', '/threads', { cwd: world.project, title: 'Other chat' });
  await row('Learning source').waitFor();
  await row('Learning source').click();
  await app.h.prompt('Say ready.');
  await row('Learning source').hover();
  await row('Learning source').locator('summary').click();
  await row('Learning source').getByTestId('menu-learn').click();
  await app.page.getByRole('heading', { name: 'Learn: Learning source', exact: true }).waitFor();
  await app.page.getByTestId('consent-text').waitFor();
  assert.equal(await review().getAttribute('role'), 'region');
  assert.equal(await review().getAttribute('aria-modal'), null);
  assert.equal(await app.page.locator('pk-skill-review-dialog .pk-backdrop').count(), 0);
  assert.equal(learnCalls, 0, 'the transcript is sent only after consent');
  await app.page.getByTestId('consent-agree').click();
  await until(() => learnCalls === 1, 'the background model request');
  await row('Other chat').click();
  const composer = app.page.getByLabel('Message to pi');
  await composer.waitFor();
  await composer.fill('Keep this draft in the other chat.');
  assert.equal(await review().count(), 0, 'learning does not overlay another chat');
  releaseDraft();
  await until(async () => (await call('GET', `/threads/${source.id}/skill-draft`)).state === 'pending', 'the completed skill draft');
  assert.equal(await composer.inputValue(), 'Keep this draft in the other chat.');
  await app.page.getByRole('heading', { name: 'Other chat', exact: true }).waitFor();

  const workspaces = (await call('GET', '/threads')).filter(thread => thread.learning?.sourceThreadId === source.id);
  assert.equal(workspaces.length, 1);
  const again = await Promise.all([call('POST', `/threads/${source.id}/learning-thread`), call('POST', `/threads/${source.id}/learning-thread`)]);
  assert.deepEqual(again.map(thread => thread.id), [workspaces[0].id, workspaces[0].id]);
  await row('Learn: Learning source').click();
  await app.page.getByTestId('skill-text').waitFor();
  assert.match(await app.page.getByTestId('skill-text').inputValue(), /name: add-notes-with-an-index/);
  const edited = await app.page.getByTestId('skill-text').inputValue() + '\nKeep this review edit.\n';
  await app.page.getByTestId('skill-text').fill(edited);
  await row('Other chat').click();
  await composer.waitFor();
  await row('Learn: Learning source').click();
  await app.page.getByTestId('skill-text').waitFor();
  assert.equal(await app.page.getByTestId('skill-text').inputValue(), edited);
  await until(async () => (await call('GET', '/settings')).thread === workspaces[0].id, 'the learning selection to be persisted');
  await app.page.reload();
  await app.page.getByTestId('skill-text').waitFor();
  assert.match(await app.page.getByTestId('skill-text').inputValue(), /name: add-notes-with-an-index/);
  assert.equal(await review().getAttribute('aria-modal'), null);
  assert.equal(learnCalls, 1, 'reopening or reloading never drafts twice');
  if (process.env.E2E_CAPTURE_LEARNING) await app.h.shot('learning-workspace.png');
});

it('creates one workspace for concurrent opens and reopens its archived sidebar entry', async () => {
  const source = await call('POST', '/threads', { cwd: world.project, title: 'Concurrent learning source' });
  const opened = await Promise.all(Array.from({ length: 3 }, () => call('POST', `/threads/${source.id}/learning-thread`)));
  assert.equal(new Set(opened.map(thread => thread.id)).size, 1);
  assert.deepEqual(opened[0].learning, { sourceThreadId: source.id });
  await call('PATCH', `/threads/${opened[0].id}`, { archived: true });
  const reopened = await call('POST', `/threads/${source.id}/learning-thread`);
  assert.equal(reopened.id, opened[0].id);
  assert.equal(reopened.archived, false);
  assert.equal((await call('GET', '/threads')).filter(thread => thread.learning?.sourceThreadId === source.id).length, 1);
});
