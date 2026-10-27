// End to end: projects, thread state at a glance and the attendant, and the sidebar (quick actions, Needs you,
// the status line, the rail). Run with `pnpm run e2e`; the to 8 suite in app.e2e.mjs covers the sidebar's old behaviour on the same DOM (rows are still
// `.pk-thread`). The attendant is off by default and these tests leave it off.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { api, env, git, hitlLog, nextHitl, openApp } from './support/app.mjs';
import { FAKE_MODEL, FAKE_PROVIDER, registerFakeModel, startFakeModel, userTextOf } from './support/fake-model.mjs';
import { writeSecondProject } from './support/sidebar-world.mjs';
import { MODEL as INFERENCE_MODEL } from './support/env.mjs';

let app;
let second;
let model;
let originalModels;
let pendingAnswer;
let releaseAnswer;
const numbers = Array.from({ length: 150 }, (_, i) => String(i + 1)).join('\n');
const FIRST = basename(env.project ?? 'project');
const SECOND = 'reporting-api';
const MODEL = `${INFERENCE_MODEL.provider}/${INFERENCE_MODEL.id}`;

const spawned = [];
/** The backend that `app.e2e.mjs` last started (its restart test) ended with that file; this file brings one up when none answers, as `update.e2e.mjs` does. */
async function ensureBackend() {
  const up = async () => {
    try {
      return (await fetch(`${env.api}/api/health`, { headers: { Authorization: `Bearer ${env.server.PI_KIT_TOKEN}` } })).ok;
    } catch {
      return false;
    }
  };
  if (await up()) return;
  const child = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env.server, NODE_ENV: 'development', PI_KIT_PORT: new URL(env.api).port, PI_KIT_ORIGIN: env.base },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  spawned.push(child.pid);
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
}

before(async () => {
  originalModels = readFileSync(join(env.agentDir, 'models.json'), 'utf8');
  model = await startFakeModel({ answer: () => pendingAnswer ?? numbers });
  registerFakeModel(env.agentDir, model.url);
  await ensureBackend();
  app = await openApp();
  second = writeSecondProject({ base: join(env.project, '..'), agentDir: env.agentDir, name: SECOND });
});
after(async () => {
  // Whatever happened, the attendant is off again, so the files after this one see the world they expect.
  await api('/api/attendant/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).catch(() => undefined);
  releaseAnswer?.(numbers);
  await app?.close();
  await model?.stop();
  if (originalModels !== undefined) writeFileSync(join(env.agentDir, 'models.json'), originalModels);
  for (const pid of spawned) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone already
    }
  }
});

const projectNames = () => app.page.locator('.pk-project').evaluateAll((els) => els.map((e) => e.getAttribute('data-project')));
const head = (name) => app.page.locator(`.pk-project[data-project="${name}"] .pk-project-head`);
const group = (name) => app.page.locator(`.pk-project[data-project="${name}"]`);
const row = (text) => app.page.locator('.pk-thread', { hasText: text }).first();
const rowIn = (name, text) => group(name).locator('.pk-thread', { hasText: text }).first();
const threadsOf = async () => await api('/api/threads');
/** An extension command is not a message in pi's session, so a thread that only ran one has no preview: it is named through the API to find its row. */
const rename = (id, title) => api(`/api/threads/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
const ASKING = 'Asks for the unit tests';
const DRAFTING = 'Asks about the project tests';
/** Polls until `check` holds (the page answers at once, the backend a moment later). */
async function eventually(check, what, ms = 8000) {
  const deadline = Date.now() + ms;
  let value;
  do {
    value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${what}`);
}

/** Waits (the page answers at once, the backend a moment later) until the backend lists the projects in this order. */
async function backendOrder(expected) {
  const deadline = Date.now() + 5000;
  let names;
  do {
    names = (await api('/api/workspaces')).map((w) => w.name);
    if (JSON.stringify(names) === JSON.stringify(expected)) return;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() < deadline);
  assert.deepEqual(names, expected);
}

/** A new thread in a project through its own "+" (the project must be on screen); it opens. */
async function newThreadIn(name) {
  await head(name).hover();
  await app.page.getByRole('button', { name: `New thread in ${name}` }).click();
  await app.page.getByLabel('Message to pi').waitFor();
  await app.h.settle(500);
}

describe('projects in the sidebar', () => {
  it('lists every known folder as a group with its branch, found without a reload, and folds and unfolds a group', async () => {
    const { page } = app;
    await head(SECOND).waitFor();
    assert.deepEqual(await projectNames(), [FIRST, SECOND]);
    // The branch is the repository's own, read from HEAD.
    assert.equal((await head(SECOND).getByTestId('project-branch').innerText()).trim(), 'feature/summary');
    assert.equal((await head(FIRST).getByTestId('project-branch').innerText()).trim(), git('rev-parse', '--abbrev-ref', 'HEAD').trim());
    // Folding is remembered by the backend: it survives a reload.
    await rowIn(SECOND, 'Quarter used').waitFor();
    await head(SECOND).click();
    await page.locator(`.pk-project[data-project="${SECOND}"][data-collapsed="true"]`).waitFor();
    assert.equal(await group(SECOND).locator('.pk-thread').count(), 0);
    await page.reload();
    await page.waitForSelector('pk-root .pk-shell');
    await page.locator(`.pk-project[data-project="${SECOND}"][data-collapsed="true"]`).waitFor();
    assert.equal((await api('/api/workspaces')).find((w) => w.name === SECOND).collapsed, true);
    await head(SECOND).click();
    await rowIn(SECOND, 'Quarter used').waitFor();
  });

  it('reorders by drag and by the menu, hides a project and brings it back from the filter menu', async () => {
    const { page } = app;
    // Both headers on screen: the first project may hold many threads by now.
    await head(FIRST).click();
    await page.locator(`.pk-project[data-project="${FIRST}"][data-collapsed="true"]`).waitFor();
    await head(SECOND).dragTo(head(FIRST), { targetPosition: { x: 40, y: 2 } });
    await page.waitForFunction(([a]) => document.querySelector('.pk-project')?.getAttribute('data-project') === a, [SECOND]);
    await backendOrder([SECOND, FIRST]);
    await page.reload();
    await page.waitForSelector('pk-root .pk-shell');
    await head(SECOND).waitFor();
    assert.deepEqual(await projectNames(), [SECOND, FIRST]);
    // The menu does the same for the keyboard.
    await head(SECOND).hover();
    await group(SECOND).getByTestId('project-menu').click();
    await page.getByRole('button', { name: 'Move down' }).first().click();
    await page.waitForFunction(([a]) => document.querySelector('.pk-project')?.getAttribute('data-project') === a, [FIRST]);
    await backendOrder([FIRST, SECOND]);
    // Hide, and show again from the filter menu.
    await head(SECOND).hover();
    await group(SECOND).getByTestId('project-menu').click();
    await page.getByRole('button', { name: 'Hide project' }).first().click();
    await group(SECOND).waitFor({ state: 'detached' });
    assert.equal((await api('/api/workspaces')).find((w) => w.name === SECOND).hidden, true);
    await page.getByTestId('filter-menu').click();
    await page.getByRole('button', { name: new RegExp(`${SECOND}\\s*Show`) }).click();
    await head(SECOND).waitFor();
    assert.equal((await api('/api/workspaces')).find((w) => w.name === SECOND).hidden, false);
    if ((await group(FIRST).getAttribute('data-collapsed')) === 'true') await head(FIRST).click();
  });

  it('⌘1 and ⌘2 jump to the first and second project, ⌘] and ⌘[ step through the threads of the open one', async () => {
    const { page } = app;
    // The first project may have no thread yet when this file runs alone: an empty one is enough to jump to.
    if ((await group(FIRST).locator('.pk-thread').count()) === 0) await newThreadIn(FIRST);
    await rowIn(SECOND, 'Quarter used').click();
    await page.keyboard.press('Meta+2');
    await group(SECOND).locator('.pk-thread[aria-current="true"]').waitFor();
    await page.keyboard.press('Meta+1');
    await group(FIRST).locator('.pk-thread[aria-current="true"]').waitFor();
    // Inside the second project, in the order the sidebar lists them.
    await page.keyboard.press('Meta+2');
    const titles = await group(SECOND).locator('.pk-thread .title').allInnerTexts();
    await rowIn(SECOND, titles[0]).click();
    await group(SECOND).locator('.pk-thread[aria-current="true"]', { hasText: titles[0] }).waitFor();
    await page.keyboard.press('Meta+]');
    await group(SECOND).locator('.pk-thread[aria-current="true"]', { hasText: titles[1] }).waitFor();
    await page.keyboard.press('Meta+[');
    await group(SECOND).locator('.pk-thread[aria-current="true"]', { hasText: titles[0] }).waitFor();
    // Not while the focus is in a text field of the terminal; here the composer takes ⌘1 like any other key and the shortcut still fires.
    assert.equal(await group(SECOND).locator('.pk-thread[aria-current="true"]').count(), 1);
  });

  it('/project opens the menu of the current project, /attendant turns the attendant off and on for it', async () => {
    const { page } = app;
    await rowIn(SECOND, 'Quarter used').click();
    const box = page.getByLabel('Message to pi');
    await box.waitFor();
    await box.fill('/project');
    await page.getByRole('option', { name: /^\/project/ }).click();
    await page.locator(`details[data-project-menu][open]`).waitFor();
    assert.equal(await page.locator('details[data-project-menu][open]').getAttribute('data-project-menu'), second);
    await page.keyboard.press('Escape');
    await page.locator('details[data-project-menu][open]').evaluate((el) => el.removeAttribute('open')).catch(() => undefined);

    // It takes an optional argument, so the menu completes the name and Enter sends it.
    await box.fill('/attendant');
    await page.getByRole('option', { name: /^\/attendant/ }).click();
    await box.press('Enter');
    await page.getByText(/The attendant is turned off for reporting-api/).first().waitFor();
    assert.equal((await api('/api/workspaces')).find((w) => w.name === SECOND).attendant, false);
    await box.fill('/attendant');
    await page.getByRole('option', { name: /^\/attendant/ }).click();
    await box.press('Enter');
    await page.getByText(/The attendant is allowed for reporting-api/).first().waitFor();
    assert.equal((await api('/api/workspaces')).find((w) => w.name === SECOND).attendant, true);
  });
});

describe('thread state at a glance', () => {
  it('shows the context share as a ring from 70 %, in warning and error colours, and a folded project shows the strongest one', async () => {
    const { page } = app;
    const full = rowIn(SECOND, 'Context nearly full').getByTestId('thread-gauge');
    await full.waitFor();
    assert.equal(await full.getAttribute('data-level'), 'err');
    // The state of the row in words: the context is the status when nothing else is going on.
    assert.match(await full.innerText(), /96 % context/);
    const filling = rowIn(SECOND, 'Filling up').getByTestId('thread-gauge');
    assert.equal(await filling.getAttribute('data-level'), 'warn');
    assert.match(await filling.innerText(), /73 % context/);
    assert.equal(await rowIn(SECOND, 'Quarter used').getByTestId('thread-gauge').count(), 0);
    // The backend computed it from the session files, the same numbers the context meter shows.
    const states = Object.fromEntries((await threadsOf()).map((t) => [t.title, t.state.context]));
    assert.equal(states['Context nearly full'], 96);
    assert.equal(states['Filling up'], 73);
    // Folded, the project still shows the worst.
    await head(SECOND).click();
    const badge = group(SECOND).getByTestId('collapsed-state');
    await badge.waitFor();
    assert.equal(await badge.getAttribute('data-kind'), 'context-high');
    assert.match(await badge.innerText(), /96%/);
    await head(SECOND).click();
    await rowIn(SECOND, 'Quarter used').waitFor();
  });

  it('a thread that asks a question says so with the first words, in its project even when folded, and the badge opens the approval', async () => {
    const { page } = app;
    await newThreadIn(FIRST);
    const box = page.getByLabel('Message to pi');
    await box.fill('/pk-confirm Run the unit tests (npm test).');
    await box.press('Enter');
    const question = page.getByRole('group', { name: 'Proceed with the test?' });
    await question.waitFor();
    // Look at another project's thread: the question stays where it is.
    await rowIn(SECOND, 'Quarter used').click();
    await page.getByLabel('Message to pi').waitFor();
    // Pushed over the status channel: well inside the poll interval.
    // (A thread whose first run is still waiting has no preview yet: its row says "New thread".)
    // (Earlier test files may leave another thread of this project on a question: the count is of all of them.)
    const badge = group(FIRST).getByTestId('waiting-badge').filter({ hasText: 'Proceed with the test?' });
    await badge.waitFor();
    assert.equal((await badge.innerText()).trim(), 'Proceed with the test?');
    const count = head(FIRST).getByTestId('count-waiting');
    const others = (await threadsOf()).filter((t) => basename(t.cwd) === FIRST && t.state.activity === 'waiting' && t.state.question !== 'Proceed with the test?').length;
    assert.equal((await count.innerText()).trim(), String(others + 1));
    const waiting = (await threadsOf()).find((t) => t.state.question === 'Proceed with the test?');
    await rename(waiting.id, ASKING);
    await row(ASKING).getByTestId('waiting-badge').waitFor();
    // Folded, the count is still there; clicking it opens the thread at its approval block.
    await head(FIRST).click();
    await page.locator(`.pk-project[data-project="${FIRST}"][data-collapsed="true"]`).waitFor();
    await count.waitFor();
    await count.click();
    await question.waitFor();
    // Opening a thread unfolds its project: the open thread's row is on screen.
    await page.locator(`.pk-project[data-project="${FIRST}"][data-collapsed="false"]`).waitFor();
    const inView = await question.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
    assert.equal(inView, true, 'the approval is scrolled into view');
    // Answering ends the waiting state.
    await question.getByRole('button', { name: 'Allow' }).click();
    await page.getByText('Confirmed by the user').first().waitFor();
    if (others === 0) await head(FIRST).locator('[data-testid=count-waiting]').waitFor({ state: 'detached' });
    else await eventually(async () => (await count.innerText().catch(() => '')).trim() === String(others), 'the waiting count to drop by one');
    await row(ASKING).waitFor();
    assert.equal(await row(ASKING).getByTestId('waiting-badge').count(), 0);
  });

  it('a run in another thread shows as running in its row and in the project count, and what finished while you were away is unread until opened', async () => {
    const { page } = app;
    const thread = (await threadsOf()).find((t) => t.title === ASKING);
    const original = await api(`/api/threads/${thread.id}/stats`);
    const setModel = (provider, modelId) => api(`/api/threads/${thread.id}/model`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, modelId }),
    });
    // Hold the actual model HTTP response until the background running state has been observed.
    // Generation speed is unrelated to the sidebar's running → unread contract.
    pendingAnswer = new Promise((resolve) => { releaseAnswer = resolve; });
    const requestsBefore = model.requests.length;
    await setModel(FAKE_PROVIDER, FAKE_MODEL);
    try {
      await row(ASKING).click();
      const box = page.getByLabel('Message to pi');
      await box.waitFor();
      await box.fill('Write the numbers from 1 to 150, one per line, and nothing else.');
      await box.press('Enter');
      await app.h.stopButton.waitFor();
      // The thread's own prompt, not another request to the fake model (the attendant's, say), and the run is still held there.
      await eventually(() => model.requests.slice(requestsBefore).some((body) => userTextOf(body).startsWith('Write the numbers from 1 to 150')), 'the thread’s prompt to reach the controlled model');
      const stats = await api(`/api/threads/${thread.id}/stats`);
      assert.equal(stats.streaming, true, `the run waits for the held answer (model ${stats.model?.provider}/${stats.model?.id})`);
      await rowIn(SECOND, 'Quarter used').click();
      // The other thread is the open one before the run can end: an end that arrives while this thread is still open is seen, not unread.
      await group(SECOND).locator('.pk-thread[aria-current="true"]', { hasText: 'Quarter used' }).waitFor();
      const running = row(ASKING).getByTestId('thread-state');
      await running.waitFor();
      assert.equal(await running.getAttribute('data-kind'), 'running');
      assert.equal((await head(FIRST).getByTestId('count-running').innerText()).trim(), '1');
      // It finishes while the other thread is open: unread, no longer running.
      releaseAnswer(numbers);
      await head(FIRST).getByTestId('count-running').waitFor({ state: 'detached' });
      const unread = row(ASKING).locator('[data-testid=thread-state][data-kind=unread]');
      await unread.waitFor();
      const before = (await threadsOf()).find((t) => t.title === ASKING);
      assert.equal(before.state.unread, true);
      // Opening it is looking at it: the dot goes, in the sidebar and in the backend.
      await row(ASKING).click();
      await row(ASKING).getByTestId('thread-state').waitFor({ state: 'detached' });
      await eventually(async () => (await threadsOf()).find((t) => t.id === before.id).state.unread === false, 'the backend to know the thread was seen');
    } finally {
      releaseAnswer(numbers);
      pendingAnswer = undefined;
      await eventually(async () => !(await api(`/api/threads/${thread.id}/stats`)).streaming, 'the held run to finish', 30_000);
      if (original.model) await setModel(original.model.provider, original.model.id);
    }
  });

  it('a stopped run is aborted and says so', async () => {
    const { page, h } = app;
    await newThreadIn(FIRST);
    const box = page.getByLabel('Message to pi');
    await box.fill('Write the numbers from 1 to 5000, one per line, and nothing else.');
    await box.press('Enter');
    await app.h.stopButton.waitFor();
    await h.settle(1500);
    await app.h.stopButton.click();
    await app.h.stopButton.waitFor({ state: 'detached' });
    const stopped = row('Write the numbers from 1 to 5000').getByTestId('thread-state');
    await stopped.waitFor();
    assert.equal(await stopped.getAttribute('data-kind'), 'aborted');
    assert.equal((await row('Write the numbers from 1 to 5000').locator('[data-testid=thread-status] .lbl').innerText()).trim(), 'Aborted');
    const thread = (await threadsOf()).find((t) => t.preview?.startsWith('Write the numbers from 1 to 5000'));
    assert.equal(thread.state.lastRun, 'aborted');
  });

  it('what the pi command line wrote to a session file shows as cli until you open the thread', async () => {
    const { page, h } = app;
    // A finished thread that has been looked at: its log matches its file.
    const thread = (await threadsOf()).find((t) => t.title === ASKING);
    await row(ASKING).click();
    // Until the transcript is replayed the app is still connecting to the thread, and a connect that arrives after the file changed rebuilds the log (the app has "seen" the change).
    await page.locator('pk-transcript').getByText('Write the numbers from 1 to 150').first().waitFor();
    await h.settle(1500);
    const { sessionPath } = await api(`/api/threads/${thread.id}`);
    const last = readFileSync(sessionPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    const user = { type: 'message', id: 'cli10001', parentId: last.id, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'A question typed in the terminal.' }], timestamp: Date.now() } };
    const answer = { type: 'message', id: 'cli10002', parentId: 'cli10001', timestamp: new Date(Date.now() + 500).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'An answer from the terminal.' }], api: 'openai-completions', provider: 'llama-swap', model: 'gemma-4-26b', usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0 } }, stopReason: 'stop', timestamp: Date.now() } };
    await rowIn(SECOND, 'Quarter used').click();
    // The other thread is open (and this one no longer looked at) before the file changes.
    await group(SECOND).locator('.pk-thread[aria-current="true"]', { hasText: 'Quarter used' }).waitFor();
    await h.settle(500);
    // The CLI continues the session: its file changes behind the app's back, a few seconds after the app's own last write.
    appendFileSync(sessionPath, `${JSON.stringify(user)}\n${JSON.stringify(answer)}\n`);
    const cli = row(ASKING).locator('[data-testid=thread-state][data-kind=cli]');
    await cli.waitFor();
    assert.equal((await threadsOf()).find((t) => t.id === thread.id).state.cli, true);
    await row(ASKING).click();
    await cli.waitFor({ state: 'detached' });
    await eventually(async () => (await threadsOf()).find((t) => t.id === thread.id).state.cli === false, 'the backend to drop the cli state');
  });
});

describe('the thread sidebar', () => {
  const needs = () => app.page.getByTestId('needs-you');
  const needsItem = (text) => app.page.getByTestId('needs-item').filter({ hasText: text });
  const quick = (id) => app.page.getByTestId(`quick-${id}`);

  /** A thread of FIRST that asks `command`'s question; another project's thread is then the open one, so the strip is the way to the question. */
  async function ask(command, title) {
    const { page } = app;
    await newThreadIn(FIRST);
    const box = page.getByLabel('Message to pi');
    await box.fill(command);
    await box.press('Enter');
    await page.getByRole('group', { name: title }).waitFor();
    await rowIn(SECOND, 'Quarter used').click();
    await group(SECOND).locator('.pk-thread[aria-current="true"]', { hasText: 'Quarter used' }).waitFor();
  }

  /** The strip counts the threads still waiting (earlier test files may leave one on a question), and is gone when none is. */
  async function stripCountsWaiting() {
    await eventually(async () => {
      const waiting = (await threadsOf()).filter((t) => t.state.activity === 'waiting').length;
      if (waiting === 0) return (await needs().count()) === 0;
      return (await needs().getByTestId('needs-count').innerText().catch(() => '')).startsWith(`${waiting} `);
    }, 'the Needs you strip to count just the waiting threads');
  }

  it('Needs you lists a waiting thread with the question and Allow and Deny; a chip answers it, pi gets the answer, the thread does not open, and the item goes', async () => {
    const { page } = app;
    const before = hitlLog().filter((e) => e.kind === 'confirm').length;
    await ask('/hitl-confirm Tag v2.0.0 and push it.', 'Publish the release?');
    const item = needsItem('Publish the release?');
    await item.waitFor();
    assert.equal((await item.locator('.p').innerText()).trim(), FIRST);
    assert.deepEqual((await item.getByTestId('needs-answer').allInnerTexts()).map((t) => t.trim()), ['Allow', 'Deny']);
    assert.match(await needs().getByTestId('needs-count').innerText(), /^\d+ threads?$/);
    await item.getByTestId('needs-answer').filter({ hasText: 'Deny' }).click();
    assert.equal(await nextHitl('confirm', before), false, 'pi was told no');
    await item.waitFor({ state: 'detached' });
    assert.equal(await group(SECOND).locator('.pk-thread[aria-current="true"]', { hasText: 'Quarter used' }).count(), 1, 'the open thread did not change');
    assert.equal((await threadsOf()).filter((t) => t.state.question === 'Publish the release?').length, 0);
    await stripCountsWaiting();
  });

  it('a select dialog offers its options as chips; the one pressed is what pi is given; the title opens the thread', async () => {
    const { page } = app;
    const before = hitlLog().filter((e) => e.kind === 'select').length;
    await ask('/hitl-select now', 'Pick a deploy target');
    const item = needsItem('Pick a deploy target');
    await item.waitFor();
    assert.deepEqual((await item.getByTestId('needs-answer').allInnerTexts()).map((t) => t.trim()), ['staging', 'production', 'canary']);
    // The title opens the thread (and its approval block is there too).
    await item.getByTestId('needs-open').click();
    await page.getByRole('group', { name: 'Pick a deploy target' }).waitFor();
    await rowIn(SECOND, 'Quarter used').click();
    await item.getByTestId('needs-answer').filter({ hasText: 'canary' }).click();
    assert.equal(await nextHitl('select', before), 'canary');
    await item.waitFor({ state: 'detached' });
  });

  it('an input dialog has no answer to give from the strip: its chip is Open, which opens the thread at the question', async () => {
    const { page } = app;
    await ask('/hitl-input now', 'Release name?');
    const item = needsItem('Release name?');
    await item.waitFor();
    assert.deepEqual((await item.getByTestId('needs-answer').allInnerTexts()).map((t) => t.trim()), ['Open']);
    await item.getByTestId('needs-answer').click();
    const q = page.getByRole('group', { name: 'Release name?' });
    await q.waitFor();
    const before = hitlLog().filter((e) => e.kind === 'input').length;
    await q.getByRole('textbox', { name: 'Release name?' }).fill('v9.9.9');
    await page.keyboard.press('Enter');
    assert.equal(await nextHitl('input', before), 'v9.9.9');
    await item.waitFor({ state: 'detached' });
    await stripCountsWaiting();
  });

  it('the quick actions are on screen without a hover: the project, the worktree thread, the terminal, the editor, the changes with a count, the settings', async () => {
    const { page } = app;
    await rowIn(SECOND, 'Quarter used').click();
    const strip = page.getByTestId('quick-actions');
    await strip.and(page.locator(`[data-project="${SECOND}"]`)).waitFor();
    assert.equal((await strip.locator('.br').innerText()).trim(), 'feature/summary');
    for (const id of ['worktree', 'terminal', 'editor', 'changes', 'settings']) assert.equal(await quick(id).isVisible(), true, id);
    // A change shows as a count (git status, read again within seconds): two more files, two more on the badge (the project may hold changes from earlier tests).
    const badge = page.getByTestId('quick-changes-count');
    const shown = async () => ((await badge.count()) === 0 ? 0 : Number((await badge.innerText()).trim()));
    const baseline = (await api(`/api/workspaces/${encodeURIComponent(second)}/status`)).entries.length;
    await eventually(async () => (await shown()) === baseline, 'the selected folder’s initial change count');
    writeFileSync(join(second, 'quick-a.md'), 'a\n');
    writeFileSync(join(second, 'quick-b.md'), 'b\n');
    try {
      await eventually(async () => (await shown()) === baseline + 2, 'the badge to count the two new files', 40_000);
      // The terminal opens the Terminal panel; the changes button the Changes panel on the working tree.
      await quick('terminal').click();
      await page.locator('.pk-term').waitFor();
      await quick('changes').click();
      await page.getByRole('button', { name: 'Working tree', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Working tree', exact: true }).getAttribute('aria-pressed'), 'true');
      const panelPocket = page.getByRole('button', { name: 'Side panels', exact: true });
      if (await panelPocket.isVisible()) {
        await panelPocket.click();
        await page.getByRole('menuitemcheckbox', { name: 'Changes', exact: true }).click();
      } else {
        await page.getByRole('group', { name: 'Side panel' }).getByRole('button', { name: 'Changes', exact: true }).click();
      }
      // In a browser the editor is a desktop thing, and says so.
      assert.equal(await quick('editor').getAttribute('aria-disabled'), 'true');
      await quick('editor').hover();
      await page.locator('.pk-tt', { hasText: 'Desktop only' }).waitFor();
      // The tooltips carry the shortcut.
      await quick('worktree').hover();
      await page.locator('.pk-tt', { hasText: /New worktree thread \(.*N\)/ }).waitFor();
      // The settings open on Projects and trust.
      await quick('settings').click();
      const dialog = page.getByRole('dialog', { name: 'Settings' });
      await dialog.waitFor();
      await dialog.getByTestId('section-projects').waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    } finally {
      rmSync(join(second, 'quick-a.md'), { force: true });
      rmSync(join(second, 'quick-b.md'), { force: true });
    }
  });

  it('the switcher lists the projects; the worktree button starts a worktree thread of the project, which waits for its first message', async () => {
    const { page } = app;
    await page.getByTestId('quick-switch').click();
    await page.getByTestId('quick-switch-menu').getByRole('button', { name: new RegExp(FIRST) }).click();
    await page.getByTestId('quick-actions').and(page.locator(`[data-project="${FIRST}"]`)).waitFor();
    await quick('worktree').click();
    await page.getByTestId('where-row').waitFor();
    await eventually(async () => (await page.getByTestId('where-worktree').getAttribute('aria-checked')) === 'true', 'the row to show Worktree');
  });

  it('a row has three lines: the title, a summary line and a status line in words; pin and archive join ⋯ on hover', async () => {
    const { page } = app;
    const quarter = rowIn(SECOND, 'Quarter used');
    await quarter.waitFor();
    assert.equal(await quarter.locator('.title').innerText(), 'Quarter used');
    // The summary line is the last answer's first line (the attendant is off), straight from the session file.
    assert.equal((await quarter.getByTestId('thread-meta').innerText()).trim(), 'Second answer.');
    assert.equal((await quarter.locator('[data-testid=thread-status] .lbl').innerText()).trim(), 'Idle');
    assert.equal(await quarter.locator('.time, .when').first().isVisible(), true);
    // ⋯ is always there; pin and archive are not until the row is hovered.
    await page.mouse.move(700, 600);
    assert.equal(await quarter.locator('summary[aria-label="Thread actions"]').isVisible(), true);
    assert.equal(await quarter.getByTestId('thread-pin').isVisible(), false);
    await quarter.hover();
    assert.equal(await quarter.getByTestId('thread-pin').isVisible(), true);
    assert.equal(await quarter.getByTestId('thread-archive').isVisible(), true);
    // Pin moves the thread to the top of its project and Unpin brings it back.
    const titles = () => group(SECOND).locator('.pk-thread .title').allInnerTexts();
    const first = (await titles())[0];
    await quarter.getByTestId('thread-pin').click();
    await eventually(async () => (await titles())[0] === 'Quarter used', 'the pinned thread first');
    await rowIn(SECOND, 'Quarter used').hover();
    await rowIn(SECOND, 'Quarter used').getByTestId('thread-pin').click();
    await eventually(async () => (await titles())[0] === first, 'the thread back in its place');
  });

  it('the band of a project is sticky: it stays at the top of the list while its threads scroll, and the next band pushes it out', async () => {
    const { page } = app;
    // A short window, so the list overflows whatever the threads of this run are.
    await page.setViewportSize({ width: 1440, height: 520 });
    try {
      await stickyBands();
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  async function stickyBands() {
    const { page } = app;
    const list = page.getByTestId('projects');
    for (const name of [FIRST, SECOND]) if ((await group(name).getAttribute('data-collapsed')) === 'true') await head(name).click();
    assert.equal(await head(FIRST).evaluate((el) => getComputedStyle(el).position), 'sticky');
    assert.equal(Math.round((await head(FIRST).boundingBox()).height), 40, 'a band is 40px');
    const rect = (locator) => locator.evaluate((el) => el.getBoundingClientRect().toJSON());
    // Scroll 80px into the first project: its band is still at the top of the list.
    await group(FIRST).evaluate((el) => {
      const scroller = el.parentElement;
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 80;
    });
    const listTop = (await rect(list)).top;
    const stuckAt = (await rect(head(FIRST))).top;
    assert.ok((await rect(group(FIRST))).top < listTop, 'the list scrolled into the first project');
    assert.ok(Math.abs(stuckAt - listTop) <= 1, `the band stays at the top while its threads scroll (band ${stuckAt}, list ${listTop})`);
    // Scroll to the second project: its band takes the top, and the first is out of the way (not underneath).
    await group(SECOND).evaluate((el) => {
      const scroller = el.parentElement;
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 4;
    });
    // (The last project cannot always be scrolled to the top: the list ends.)
    const ended = await list.evaluate((el) => el.scrollTop >= el.scrollHeight - el.clientHeight - 1);
    if (!ended) assert.ok(Math.abs((await rect(head(SECOND))).top - (await rect(list)).top) <= 1, 'the next band took the top');
    assert.ok((await rect(head(FIRST))).bottom <= (await rect(head(SECOND))).top + 1, 'the first band was pushed out');
    await list.evaluate((el) => (el.scrollTop = 0));
  }

  it('⌘B collapses the sidebar to the rail: the "+", a tile per project with a dot, the count of what needs you; a tile opens the sidebar on that project; the edge is gone', async () => {
    const { page } = app;
    // A question that waits, so the rail has a count and a dot.
    await ask('/hitl-confirm Tag v3 and push it.', 'Publish the release?');
    await page.keyboard.press('Meta+b');
    const rail = page.getByTestId('rail');
    await rail.waitFor();
    assert.equal(Math.round((await page.locator('pk-thread-sidebar').boundingBox()).width), 48);
    assert.equal(await page.getByTestId('sidebar-resize').isVisible(), false);
    assert.equal(await rail.getByTestId('rail-new').isVisible(), true);
    const tiles = await rail.getByTestId('rail-project').evaluateAll((els) => els.map((e) => e.getAttribute('data-project')));
    assert.ok(tiles.includes(FIRST) && tiles.includes(SECOND), `tiles: ${tiles}`);
    const mine = rail.locator(`[data-testid=rail-project][data-project="${FIRST}"]`);
    assert.equal(await mine.getByTestId('rail-dot').getAttribute('data-kind'), 'wait');
    assert.match(await rail.getByTestId('rail-needs').innerText(), /^\d+$/);
    // The projects are still there to see and to use: a tile opens the sidebar on its project.
    await rail.locator(`[data-testid=rail-project][data-project="${SECOND}"]`).click();
    await page.getByTestId('projects').waitFor({ state: 'visible' });
    await rail.waitFor({ state: 'hidden' });
    assert.ok(Math.round((await page.locator('pk-thread-sidebar').boundingBox()).width) > 200);
    // The strip is one click on the rail's count.
    await page.keyboard.press('Meta+b');
    await rail.waitFor();
    await rail.getByTestId('rail-needs').click();
    await needs().waitFor({ state: 'visible' });
    await needsItem('Publish the release?').getByTestId('needs-answer').filter({ hasText: 'Deny' }).click();
    await needsItem('Publish the release?').waitFor({ state: 'detached' });
    await stripCountsWaiting();
    // ⌘B and the toggle button are the same switch as before; the header button says what a click does.
    await page.keyboard.press('Meta+b');
    await rail.waitFor();
    await page.getByTestId('toggle-sidebar').click();
    await page.getByTestId('projects').waitFor({ state: 'visible' });
  });

  it('the search is the width of the sidebar and has its own shortcut (⌘K is the palette); the filter menu keeps Show archived, hidden projects and the attendant', async () => {
    const { page } = app;
    const search = page.getByLabel('Search threads');
    const box = await search.boundingBox();
    assert.ok(box.width > 100, `the field is ${box.width}px wide`);
    await page.getByLabel('Message to pi').focus().catch(() => undefined);
    await page.keyboard.press('Meta+Shift+k');
    await eventually(async () => (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Search threads', 'the search to take the focus');
    await page.getByTestId('filter-menu').click();
    await page.getByRole('menuitemcheckbox', { name: 'Show archived threads' }).waitFor();
    await page.getByRole('button', { name: 'Attendant activity…' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByTestId('filter-menu').evaluate((el) => el.closest('details').removeAttribute('open'));
  });
});

describe('the attendant', () => {
  const openAttendant = async () => {
    const { page, h } = app;
    const dialog = await h.openSettings('Attendant');
    await dialog.getByTestId('section-attendant').waitFor();
    return dialog;
  };
  const closeSettings = async () => {
    await app.page.keyboard.press('Escape');
    await app.page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });
  };

  it('is off by default and has made no model call: nothing ran, nothing is listed', async () => {
    const status = await api('/api/attendant');
    assert.equal(status.settings.enabled, false);
    assert.equal(status.calls, 0, 'no model request since the backend started');
    assert.deepEqual(status.actions, []);
    // The sidebar shows no summaries and no suggestions: the meta line is a plain fact.
    assert.equal((await threadsOf()).every((t) => t.state.summary === null && t.state.suggestions.length === 0), true);
    const dialog = await openAttendant();
    assert.equal(await dialog.getByTestId('attendant-toggle').isChecked(), false);
    const section = dialog.getByTestId('section-attendant');
    assert.deepEqual((await section.getByRole('tab').allTextContents()).map((label) => label.trim()), ['General', 'Automation', 'Projects', 'Activity']);
    assert.equal(await dialog.getByTestId('attendant-activity').isVisible(), false);
    await section.getByRole('tab', { name: 'Automation', exact: true }).click();
    await dialog.getByTestId('attendant-on-end').waitFor();
    assert.equal(await dialog.getByTestId('attendant-on-end').isVisible(), true);
    assert.equal(await dialog.getByTestId('attendant-cap').isVisible(), true);
    assert.equal(await dialog.getByTestId('attendant-toggle').isVisible(), false);
    await section.getByRole('tab', { name: 'Activity', exact: true }).click();
    await dialog.getByTestId('attendant-activity').waitFor();
    assert.match(await dialog.getByTestId('attendant-activity').innerText(), /While it is off it does nothing and calls no model/);
    assert.equal(await dialog.getByTestId('attendant-run').isDisabled(), true);
    // A manual run is refused too.
    const refused = await fetch(`${env.api}/api/attendant/run`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.server.PI_KIT_TOKEN}` }, body: '{}' });
    assert.equal(refused.status, 409);
    await closeSettings();
  });

  it('on, with the local model: a new thread gets a title and a summary within a minute, and the activity view lists each action with its cost', async () => {
    const { page } = app;
    let dialog = await openAttendant();
    await dialog.getByTestId('attendant-model').selectOption(MODEL);
    await dialog.getByTestId('attendant-toggle').check();
    await dialog.getByTestId('attendant-state').filter({ hasText: 'on' }).waitFor();
    const settings = (await api('/api/attendant')).settings;
    assert.equal(settings.enabled, true);
    assert.deepEqual(settings.model, { provider: INFERENCE_MODEL.provider, modelId: INFERENCE_MODEL.id });
    await closeSettings();

    await newThreadIn(FIRST);
    const box = page.getByLabel('Message to pi');
    await box.fill('In one short sentence, what is a monad in functional programming?');
    await box.press('Enter');
    await app.h.stopButton.waitFor();
    await app.h.stopButton.waitFor({ state: 'detached' });
    const find = async () => (await threadsOf()).find((t) => t.preview?.startsWith('In one short sentence, what is a monad'));
    // "Within a minute", counted from the end of the run, plus the request the attendant may be busy with (the sweep that follows switching it on).
    const deadline = Date.now() + 75_000;
    let thread = await find();
    while ((!thread.title || thread.state.summary === null) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      thread = await find();
    }
    assert.ok(thread.title, 'the attendant named the thread');
    assert.notEqual(thread.title, thread.preview);
    assert.ok(thread.title.split(/\s+/).length >= 2 && thread.title.length <= 80, thread.title);
    assert.ok(thread.state.summary, 'the attendant summarised the thread');
    // The title is in pi's session_info, so `pi --resume` shows it too; the sidebar shows the summary as the meta line.
    const { sessionPath } = await api(`/api/threads/${thread.id}`);
    assert.match(readFileSync(sessionPath, 'utf8'), new RegExp(`"type":"session_info"[^\\n]*${thread.title.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await row(thread.title).waitFor();
    assert.equal((await row(thread.title).getByTestId('thread-meta').innerText()).trim(), thread.state.summary);

    dialog = await openAttendant();
    await dialog.getByTestId('section-attendant').getByRole('tab', { name: 'Activity', exact: true }).click();
    const actions = dialog.getByTestId('attendant-action');
    await actions.first().waitFor();
    const kinds = await actions.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    assert.ok(kinds.includes('title') && kinds.includes('summary'), `actions: ${kinds}`);
    for (const cost of await dialog.getByTestId('attendant-action-cost').allInnerTexts()) assert.match(cost, /^\$\d/);
    const status = await api('/api/attendant');
    assert.ok(status.calls >= 2);
    assert.ok(status.today.inputTokens > 0 && status.today.outputTokens > 0);
    await dialog.getByTestId('section-attendant').getByRole('tab', { name: 'Automation', exact: true }).click();
    await dialog.getByTestId('attendant-today').waitFor();
    assert.match(await dialog.getByTestId('attendant-today').innerText(), /Today:\s+\$0\.00\s+of\s+\$0\.50/);
    await closeSettings();
  });

  it('drafts an answer to a routine question as a chip the user accepts; it answers nothing itself', async () => {
    const { page } = app;
    await newThreadIn(FIRST);
    const box = page.getByLabel('Message to pi');
    await box.fill('/pk-confirm Run the project unit tests (npm test).');
    await box.press('Enter');
    const question = page.getByRole('group', { name: 'Proceed with the test?' });
    await question.waitFor();
    await rename((await threadsOf()).find((t) => t.state.activity === 'waiting').id, DRAFTING);
    await rowIn(SECOND, 'Quarter used').click();
    // Within a minute the attendant has looked at the question: a draft action is listed, and the thread is still waiting, unanswered.
    const deadline = Date.now() + 90_000;
    let draft;
    while (!draft && Date.now() < deadline) {
      draft = (await api('/api/attendant')).actions.find((a) => a.kind === 'draft');
      if (!draft) await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(draft, 'the attendant looked at the question');
    const waiting = (await threadsOf()).find((t) => t.state.activity === 'waiting');
    assert.ok(waiting, 'nothing answered the question');
    // The suggested answer is the first chip of the thread's item in "Needs you" (with the attendant's summary, the row shows that instead of the question).
    const item = page.getByTestId('needs-item').filter({ hasText: 'Proceed with the test?' });
    const chip = item.locator('[data-testid=needs-answer][data-suggested=true]');
    if ((await chip.count()) === 0 && waiting.state.suggestions.length === 0) {
      // A cautious model may leave a question to the user: that is recorded as such and nothing is offered.
      assert.match(draft.text, /left to you|Suggested/);
      await item.getByTestId('needs-answer').filter({ hasText: 'Allow' }).click();
      await item.waitFor({ state: 'detached' });
      return;
    }
    await chip.waitFor();
    assert.match(await chip.innerText(), /^(Allow|Deny)$/);
    // Accepting is the user's click, and it answers the question without opening the thread; the suggestion is then closed.
    await chip.click();
    await item.waitFor({ state: 'detached' });
    await eventually(async () => (await threadsOf()).find((t) => t.id === waiting.id).state.suggestions.length === 0, 'the suggestion to be closed');
    assert.equal(await group(SECOND).locator('.pk-thread[aria-current="true"]', { hasText: 'Quarter used' }).count(), 1, 'the thread of the answer did not open');
  });

  it('stays out of a project that opted out, and makes no further call once it is switched off', async () => {
    const { page } = app;
    // The per-project opt-out is a switch in Settings › Attendant.
    let dialog = await openAttendant();
    await dialog.getByTestId('section-attendant').getByRole('tab', { name: 'Projects', exact: true }).click();
    await dialog.getByTestId(`attendant-project-${FIRST}`).locator('input[type=checkbox]').uncheck();
    await closeSettings();
    assert.equal((await api('/api/workspaces')).find((w) => w.name === FIRST).attendant, false);
    // What the earlier tests left in its queue (the end of their runs) is done before the count is taken.
    await eventually(async () => (await api('/api/attendant')).queued === 0, 'the attendant to finish what it was doing', 120_000);
    await app.h.settle(2500);
    await eventually(async () => (await api('/api/attendant')).queued === 0, 'the attendant to stay idle', 120_000);
    const before = (await api('/api/attendant')).calls;
    await newThreadIn(FIRST);
    const box = page.getByLabel('Message to pi');
    await box.fill('Say the word omega and nothing else.');
    await box.press('Enter');
    await app.h.stopButton.waitFor();
    await app.h.stopButton.waitFor({ state: 'detached' });
    await app.h.settle(8000);
    assert.equal((await api('/api/attendant')).calls, before, 'the opted-out project was left alone');

    // Off: no call even where it is allowed.
    dialog = await openAttendant();
    await dialog.getByTestId('section-attendant').getByRole('tab', { name: 'Projects', exact: true }).click();
    await dialog.getByTestId(`attendant-project-${FIRST}`).locator('input[type=checkbox]').check();
    await dialog.getByTestId('section-attendant').getByRole('tab', { name: 'General', exact: true }).click();
    await dialog.getByTestId('attendant-toggle').uncheck();
    await dialog.getByTestId('attendant-state').filter({ hasText: 'off' }).waitFor();
    await closeSettings();
    await eventually(async () => (await api('/api/attendant')).queued === 0, 'the attendant to be off and idle', 120_000);
    const calls = (await api('/api/attendant')).calls;
    await newThreadIn(FIRST);
    await box.fill('Say the word sigma and nothing else.');
    await box.press('Enter');
    await app.h.stopButton.waitFor();
    await app.h.stopButton.waitFor({ state: 'detached' });
    await app.h.settle(8000);
    assert.equal((await api('/api/attendant')).calls, calls, 'switched off: no model request');
    assert.equal((await api('/api/attendant')).settings.enabled, false);
  });
});
