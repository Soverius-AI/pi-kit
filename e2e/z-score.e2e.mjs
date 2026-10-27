// End to end: the Meat Proxy Score and the Vibe Score. Run with `npm run e2e -- --file z-score`.
//
// The name sorts it last, with z-outcomes and z-learn: it adds a project (a repository of its own, `score-app`) and threads that are newer than every other thread. The attendant's model is
// a fake one (e2e/support/fake-model.mjs): it labels the hunks of an attribution prompt by rules about the files (`cannedLabels`) and records what it was sent. The threads themselves run on
// the local model.
//   1. The package: `pi list` shows @pi-kit/meat-proxy next to @pi-kit/learn (pi-kit installed both), and `/score` is in the `/` menu.
//   2. A thread with two prompts, a review comment and a hand edit is committed in the folder; the attendant (on) scores the outcome by itself: the ledger reaches the model (the review comment,
//      the hand edit), every hunk carries a label and what it traces to (the hand-edited file is manual by rule, without the model), the score is the line-weighted share, the activity lists a
//      `score` call, the badge's tooltip has the sentence as its second line, the badge's menu shows it, the Outcome view shows the meter and a label on every hunk.
//   3. Relabelling a hunk in the Outcome view moves the score; the correction is kept; scoring again shows the model the correction as an example and the person's label stands.
//   4. With the attendant off, `/score` asks for the person's agreement before anything is sent, then scores; the badge menu scores again without asking twice.
//   5. Settings › Projects has the histogram of the project.
//   6. `pi remove` takes the package away and nothing of it is left in the UI: the badge shows the outcome alone (tooltip and menu), the Outcome view has plain hunks, Settings has no histogram, the
//      score route answers 404; `pi install` brings all of it back from what was stored.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { env, openApp } from './support/app.mjs';
import { CANNED_SKILL, FAKE_MODEL, FAKE_PROVIDER, cannedLabels, isScorePrompt, registerFakeModel, startFakeModel, userTextOf } from './support/fake-model.mjs';
import { gitIn, writeWorktreeProject } from './support/worktree-world.mjs';

const NAME = 'score-app';
const TITLE = 'Add notes';
let app;
let project;
let fake;
let id;

async function call(method, path, body) {
  const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${env.api}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
}

const spawned = [];
/** The backend that an earlier file's restart test left running (or not): this file brings one up when none answers, as z-learn.e2e.mjs does. */
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

const pi = (...args) =>
  spawnSync(join(new URL('..', import.meta.url).pathname, 'node_modules', '.bin', 'pi'), args, {
    env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
    encoding: 'utf8',
  });
const packageFolder = (name) => JSON.parse(readFileSync(join(env.agentDir, 'settings.json'), 'utf8')).packages.map(String).find((p) => p.includes(name));

before(async () => {
  await ensureBackend();
  fake = await startFakeModel({
    answer: (body) => (isScorePrompt(body) ? cannedLabels(userTextOf(body)) : JSON.stringify(body.messages?.[0] ?? '').includes('reusable skill') ? CANNED_SKILL : 'Notes work'),
  });
  registerFakeModel(env.agentDir, fake.url);
  app = await openApp();
  project = writeWorktreeProject({ base: join(env.project, '..'), name: NAME });
  await call('POST', '/api/workspaces', { cwd: project });
  // The other project's threads are none of this file's business: the attendant is kept away from them (the per-project opt-out).
  await call('PATCH', '/api/workspaces', { cwd: env.project, attendant: false });
  await app.page.reload();
  await app.page.waitForSelector('pk-root .pk-shell');
  await head().waitFor();
});
after(async () => {
  await call('PATCH', '/api/attendant/settings', { enabled: false }).catch(() => undefined);
  await call('PATCH', '/api/workspaces', { cwd: env.project, attendant: true }).catch(() => undefined);
  await app?.close();
  await fake?.stop();
  for (const pid of spawned) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone already
    }
  }
});

const head = () => app.page.locator(`.pk-project[data-project="${NAME}"] .pk-project-head`);
const group = () => app.page.locator(`.pk-project[data-project="${NAME}"]`);
const rowOf = (text) => group().locator('.pk-thread', { hasText: text }).first();
const threads = async () => (await call('GET', '/api/threads')).body.filter((t) => t.cwd === project);
const box = () => app.page.getByLabel('Message to pi');
const scorePrompts = () => fake.requests.filter(isScorePrompt);
const scoreOf = async () => call('GET', `/api/threads/${id}/score`);
const lastScorePrompt = () => userTextOf(scorePrompts().at(-1));

async function eventually(check, what, ms = 30_000) {
  const deadline = Date.now() + ms;
  let value;
  do {
    value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${what}`);
}

async function idle(timeout = 240_000) {
  const stop = app.page.getByTestId('stop');
  await stop.waitFor({ timeout: 30_000 }).catch(() => undefined);
  await stop.waitFor({ state: 'detached', timeout });
  await app.h.settle(800);
}

async function prompt(text) {
  await box().fill(text);
  await box().press('Enter');
  await idle();
}

/** A thread in the project's folder itself, named. */
async function plainThread(title) {
  await head().hover();
  await app.page.getByRole('button', { name: `New thread in ${NAME}` }).click();
  await box().waitFor();
  await app.h.settle(500);
  const created = (await threads()).filter((t) => !t.title && t.messageCount === 0).sort((a, b) => b.createdAt - a.createdAt)[0];
  assert.ok(created, 'the new thread is listed');
  await call('PATCH', `/api/threads/${created.id}`, { title });
  await eventually(async () => (await rowOf(title).count()) > 0, `the row of ${title}`);
  return created.id;
}

/** The lines a file changed in the outcome, by `git diff --numstat`. */
function numstat(base, head) {
  const lines = new Map();
  for (const row of gitIn(project, 'diff', '--numstat', `${base}..${head}`).split('\n').filter(Boolean)) {
    const [added, removed, file] = row.split('\t');
    lines.set(file, Number(added) + Number(removed));
  }
  return lines;
}

/** Opens a file of the review list and waits until the diff on screen is that file's (the previous file's diff stays until the new one is loaded). */
const openFile = async (file) => {
  await app.page.locator('.pk-file', { hasText: file }).first().click();
  await app.page.locator('pk-review-view .pk-diff .hd code', { hasText: file }).waitFor();
};

/** Back from review mode to the chat (the header's "Chat" button), when it is open. */
const toChat = async () => {
  const chat = app.page.getByRole('button', { name: /Chat/ }).first();
  if (await app.page.locator('pk-review-view').count()) await chat.click();
  await app.page.locator('pk-review-view').waitFor({ state: 'detached' });
  await app.h.closePanel();
};

const openMenu = async () => {
  await rowOf(TITLE).getByTestId('outcome-badge').click();
  const menu = app.page.getByRole('menu', { name: 'Outcome' });
  await menu.waitFor();
  return menu;
};

describe('the package', () => {
  it('is installed into the scratch pi next to @pi-kit/learn: `pi list` shows both, and /score is in the / menu', async () => {
    const listed = pi('list');
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /User packages:[\s\S]*pi-kit-meat-proxy/, listed.stdout);
    assert.match(listed.stdout, /pi-kit-learn/, listed.stdout);
    const folder = packageFolder('pi-kit-meat-proxy');
    assert.ok(folder, 'the package is in pi’s settings');
    assert.ok(existsSync(join(folder.startsWith('/') ? folder : join(env.agentDir, folder), 'extensions', 'meat-proxy.ts')));

    id = await plainThread(TITLE);
    await rowOf(TITLE).click();
    await box().waitFor();
    await box().fill('/scor');
    await app.page.locator('[role="option"][id^="pk-composer-opt-"]', { hasText: 'score' }).first().waitFor();
    await box().fill('');
  });
});

describe('a finished thread: two prompts, a review comment and a hand edit', () => {
  let outcome;

  it('the person works with pi, edits a file by hand and commits; the attendant scores the outcome by itself', async () => {
    // The attendant on with the fake model, looking only when an outcome lands.
    await call('PATCH', '/api/attendant/settings', { enabled: true, model: { provider: FAKE_PROVIDER, modelId: FAKE_MODEL }, dailyCostCap: null, when: { onEnd: false, onInterrupt: false, everyMinutes: 0 } });
    await prompt(
      'Use the write tool twice. First create notes/alpha.md with exactly three lines: "# Alpha", "The first note.", "It has two lines of text." ' +
        'Then create notes/beta.md with exactly two lines: "# Beta", "The second note." Then say done in one short sentence.',
    );
    await prompt('Use the write tool once to create notes/index.md that lists the two notes, one bullet per note, two lines in all. Then say done in one short sentence.');

    // A review comment on a line of alpha.md, sent to pi as a message of its own.
    await app.h.openPanel('Changes');
    await app.page.locator('.pk-file', { hasText: 'alpha.md' }).first().click();
    await app.page.locator('pk-review-view .pk-diff').waitFor();
    await app.h.discardComments();
    await app.h.comment('The first note.', 'Write the word FIRST in capitals on this line.');
    await app.page.getByRole('button', { name: /^Send 1 comment to pi$/ }).click();
    await app.page.getByRole('button', { name: '1 review comment' }).waitFor();
    await idle();
    await app.h.closePanel();
    assert.equal(readFileSync(join(project, 'notes', 'alpha.md'), 'utf8').includes('FIRST'), true, 'pi applied the review comment');

    // A file the person writes by hand, after pi stopped (the folder watcher sees it; no run is writing).
    await app.h.settle(4000);
    writeFileSync(join(project, 'notes', 'gamma.md'), '# Gamma\nWritten by hand.\nThree lines in all.\n');
    await app.h.settle(2500);

    assert.equal(scorePrompts().length, 0, 'nothing was sent to the model before an outcome');
    gitIn(project, 'add', '-A');
    gitIn(project, 'commit', '-q', '-m', 'Add notes');

    // The outcome lands, the attendant scores it.
    outcome = (await eventually(async () => {
      const got = await call('GET', `/api/threads/${id}/outcome`);
      return got.status === 200 ? got : undefined;
    }, 'the committed outcome')).body;
    assert.equal(outcome.kind, 'committed');
    const scored = await eventually(async () => {
      const got = await scoreOf();
      return got.status === 200 ? got.body : undefined;
    }, 'the attendant’s score', 120_000);
    assert.equal(scorePrompts().length, 1, 'one model call for the attribution');

    // What the model was sent: the ledger (the review comment, the hand edit), the hunks of the files pi touched; the hand-edited file is not listed.
    const sent = lastScorePrompt();
    assert.match(sent, /review comment on notes\/alpha\.md:\d+: Write the word FIRST/);
    assert.match(sent, /- notes\/gamma\.md: pi never edited it; changed by hand \d+ times? outside pi/);
    assert.match(sent, /h\d+ \| notes\/alpha\.md \| @@/);
    assert.match(sent, /h\d+ \| notes\/beta\.md \| @@/);
    assert.doesNotMatch(sent, /h\d+ \| notes\/gamma\.md/);
    assert.match(sent, /1 hunks? in files only the person changed by hand are labelled manual without you/);

    // Every hunk is labelled, and the label traces to an input.
    const byFile = Object.fromEntries(scored.hunks.map((h) => [h.file, h]));
    assert.deepEqual(Object.keys(byFile).sort(), ['notes/alpha.md', 'notes/beta.md', 'notes/gamma.md', 'notes/index.md']);
    assert.equal(byFile['notes/alpha.md'].label, 'corrected');
    assert.equal(byFile['notes/alpha.md'].input, 'review');
    assert.equal(byFile['notes/beta.md'].label, 'specified');
    assert.equal(byFile['notes/beta.md'].input, 'first-prompt');
    assert.equal(byFile['notes/index.md'].label, 'autonomous');
    assert.equal(byFile['notes/index.md'].input, 'none');
    assert.deepEqual([byFile['notes/gamma.md'].label, byFile['notes/gamma.md'].input, byFile['notes/gamma.md'].by], ['manual', 'hand', 'ledger']);
    assert.ok(scored.hunks.every((h) => h.trace.length > 0), 'every label says why');

    // The score is the line-weighted share of specified, corrected and manual hunks.
    const lines = numstat(outcome.base, outcome.head);
    const total = [...lines.values()].reduce((a, b) => a + b, 0);
    const steered = ['notes/alpha.md', 'notes/beta.md', 'notes/gamma.md'].reduce((n, f) => n + (lines.get(f) ?? 0), 0);
    assert.equal(scored.scores.meat, Math.round((steered / total) * 100));
    assert.equal(scored.scores.vibe, 100 - scored.scores.meat);
    assert.equal(scored.scores.hunks, 4);
    assert.equal(scored.scores.steered, 3);
    assert.match(scored.scores.line, new RegExp(`^${scored.scores.meat} % steered: 3 of 4 hunks, 1 by the first prompt, 1 by review comments, 1 by hand$`));
    assert.equal(scored.stale, false);
    assert.equal(scored.corrected, 0);

    // The activity lists the call as `score` and then what came of it.
    const actions = (await call('GET', '/api/attendant')).body.actions.filter((a) => a.kind === 'score' && a.threadId === id);
    assert.ok(actions.some((a) => a.status === 'done' && a.text === scored.scores.line), JSON.stringify(actions));
    assert.ok(actions.some((a) => a.model === `${FAKE_PROVIDER}/${FAKE_MODEL}`), 'the call is listed with its model');
  });

  it('the badge’s tooltip has the sentence as its second line, and its menu shows it with “Score this thread again”', async () => {
    const scored = (await scoreOf()).body;
    const title = await eventually(async () => {
      const got = await rowOf(TITLE).getByTestId('outcome-badge').getAttribute('title');
      return got?.includes('\n') ? got : undefined;
    }, 'the badge’s second line');
    assert.match(title, /^Committed as [0-9a-f]{7}, .+\n/);
    assert.equal(title.split('\n')[1], scored.scores.line);
    const menu = await openMenu();
    const items = await menu.getByRole('menuitem').allInnerTexts();
    assert.equal(items[0], 'Show the outcome');
    assert.ok(items.includes(scored.scores.line), items.join(' | '));
    assert.ok(items.includes('Score this thread again'), items.join(' | '));
    await app.page.keyboard.press('Escape');
  });

  it('the Outcome view shows the meter and a label on every hunk, with what it traces to', async () => {
    const scored = (await scoreOf()).body;
    const menu = await openMenu();
    await menu.getByRole('menuitem', { name: 'Show the outcome' }).click();
    const meter = app.page.getByTestId('score-meter');
    await meter.waitFor();
    assert.equal((await app.page.getByTestId('score-meat').innerText()).trim(), `${scored.scores.meat} % steered`);
    assert.equal((await app.page.getByTestId('score-vibe').innerText()).trim(), `${scored.scores.vibe} % vibe`);
    assert.match(await app.page.getByTestId('score-line').innerText(), /3 of 4 hunks, 1 by the first prompt, 1 by review comments, 1 by hand/);

    const expected = { 'alpha.md': 'corrected', 'beta.md': 'specified', 'gamma.md': 'manual', 'index.md': 'autonomous' };
    for (const [file, label] of Object.entries(expected)) {
      await openFile(file);
      const mark = app.page.getByTestId('hunk-label').first();
      await mark.waitFor();
      assert.equal((await mark.innerText()).trim(), label, file);
      assert.ok((await app.page.getByTestId('hunk-trace').first().innerText()).trim().length > 0);
    }
    await openFile('gamma.md');
    assert.match(await app.page.getByTestId('hunk-trace').first().innerText(), /changed by hand outside pi/);
  });
});

describe('the person relabels a hunk', () => {
  it('the score moves, the correction is kept, and scoring again shows it to the model as an example', async () => {
    const before = (await scoreOf()).body;
    await openFile('index.md');
    await app.page.getByTestId('hunk-label').first().waitFor();
    await app.page.getByTestId('hunk-relabel').first().selectOption('specified');
    await eventually(async () => (await app.page.getByTestId('hunk-label').first().innerText()).trim() === 'specified', 'the relabelled hunk');
    const after = (await scoreOf()).body;
    assert.ok(after.scores.meat > before.scores.meat, `${before.scores.meat} -> ${after.scores.meat}`);
    assert.equal(after.scores.steered, 4);
    assert.equal(after.corrected, 1);
    const index = after.hunks.find((h) => h.file === 'notes/index.md');
    assert.deepEqual([index.label, index.was, index.by], ['specified', 'autonomous', 'person']);
    assert.equal(await app.page.getByTestId('hunk-label').first().getAttribute('data-by'), 'person');
    await eventually(async () => (await app.page.getByTestId('score-meat').innerText()).trim() === `${after.scores.meat} % steered`, 'the meter');
    assert.match(await app.page.getByTestId('score-corrected').innerText(), /1 label corrected by you/);

    // The model is not asked for that: relabelling is arithmetic.
    assert.equal(scorePrompts().length, 1);

    // Scoring again (the badge menu, the attendant is on): the correction is in the prompt, and the person’s label stands.
    const menu = await openMenu();
    await menu.getByRole('menuitem', { name: 'Score this thread again' }).click();
    await eventually(async () => scorePrompts().length === 2, 'the second attribution', 60_000);
    assert.match(lastScorePrompt(), /## The person corrected earlier labels of this thread[\s\S]*- notes\/index\.md @@[^\n]*the model said autonomous, the person says specified/);
    await eventually(async () => (await app.page.getByTestId('toast').count().catch(() => 0)) >= 0, 'the toast settles');
    const again = (await eventually(async () => {
      const got = await scoreOf();
      return got.status === 200 && got.body.at > after.at ? got.body : undefined;
    }, 'the new score')).body ?? (await scoreOf()).body;
    const kept = again.hunks.find((h) => h.file === 'notes/index.md');
    assert.deepEqual([kept.label, kept.by], ['specified', 'person']);
    assert.equal(again.scores.steered, 4);
    assert.equal(again.corrected, 1);

    // Taking the correction back: the label is the model’s own again. The model has just learned from the correction, so it agrees with the person now and the score stays.
    await app.page.getByTestId('hunk-relabel').first().selectOption('reset');
    await eventually(async () => (await scoreOf()).body.corrected === 0, 'the correction taken back');
    const reset = (await scoreOf()).body.hunks.find((h) => h.file === 'notes/index.md');
    assert.deepEqual([reset.label, reset.by], ['specified', 'model']);
    await toChat();
  });
});

describe('with the attendant off', () => {
  it('/score asks for the person’s agreement before anything is sent, then scores', async () => {
    await call('PATCH', '/api/attendant/settings', { enabled: false });
    await toChat();
    await rowOf(TITLE).click();
    await box().waitFor();
    const asked = scorePrompts().length;
    const scoredAt = (await scoreOf()).body.at;
    // The trailing space closes the menu, so Enter sends the command instead of completing it.
    await box().fill('/score ');
    await box().press('Enter');
    const approval = app.page.locator('.pk-approval', { hasText: 'Score this thread?' });
    await approval.waitFor();
    assert.match(await approval.innerText(), /This sends the thread’s transcript[\s\S]*learn-fake\/canned[\s\S]*The attendant is off/);
    assert.equal(scorePrompts().length, asked, 'nothing was sent before the answer');
    await approval.getByRole('button', { name: 'Allow' }).click();
    await eventually(async () => scorePrompts().length === asked + 1, 'the attribution after the agreement', 60_000);
    // pi-kit stored the labels the extension handed back (`pi-kit:thread:annotate`): the score is new.
    await eventually(async () => (await scoreOf()).body.at > scoredAt, 'the score /score wrote back', 60_000);
    assert.equal((await scoreOf()).status, 200);
  });

  it('the badge menu scores again without asking a second time', async () => {
    const asked = scorePrompts().length;
    const menu = await openMenu();
    await menu.getByRole('menuitem', { name: 'Score this thread again' }).click();
    await eventually(async () => scorePrompts().length === asked + 1, 'the attribution from the menu', 60_000);
  });

  it('a request with no agreement for a thread that never agreed answers consent and sends nothing', async () => {
    // A thread that is scored by the route without the person’s agreement: the route asks first (the thread has no outcome here, so it refuses before any consent either).
    const other = await call('POST', '/api/threads', { cwd: project });
    const refused = await call('POST', `/api/threads/${other.body.id}/score`, {});
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /no outcome/);
  });
});

describe('Settings › Projects', () => {
  it('has the histogram of the project’s scored threads', async () => {
    const dialog = await app.h.openSettings('Projects');
    await dialog.getByTestId('section-projects').getByRole('tab', { name: 'Scores', exact: true }).click();
    const histograms = dialog.getByTestId('score-histograms');
    await histograms.waitFor();
    const projectRow = dialog.getByTestId(`score-${NAME}`);
    await projectRow.waitFor();
    assert.match(await projectRow.innerText(), /1 scored/);
    const bins = await projectRow.getByTestId('score-bin').evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-count'))));
    assert.equal(bins.length, 10);
    assert.equal(bins.reduce((a, b) => a + b, 0), 1);
    const meat = (await scoreOf()).body.scores.meat;
    assert.equal(bins[Math.min(9, Math.floor(meat / 10))], 1);
    assert.match(await projectRow.getByTestId('score-mean').innerText(), new RegExp(`On average ${meat} % steered over 1 scored thread`));
    await app.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  });
});

describe('pi remove leaves no trace in the UI', () => {
  it('the badge shows the outcome alone, the Outcome view has plain hunks, Settings has no histogram, the route answers 404', async () => {
    const folder = packageFolder('pi-kit-meat-proxy');
    const removed = pi('remove', folder);
    assert.equal(removed.status, 0, removed.stderr + removed.stdout);
    assert.doesNotMatch(pi('list').stdout, /meat-proxy/);

    await eventually(async () => (await scoreOf()).status === 404, 'the score route to answer 404', 30_000);
    await eventually(async () => !(await rowOf(TITLE).getByTestId('outcome-badge').getAttribute('title'))?.includes('\n'), 'the badge to lose its second line');
    const menu = await openMenu();
    const items = await menu.getByRole('menuitem').allInnerTexts();
    assert.equal(items[0], 'Show the outcome');
    assert.ok(!items.some((t) => /score|steered/i.test(t)), items.join(' | '));
    await menu.getByRole('menuitem', { name: 'Show the outcome' }).click();
    await app.page.locator('pk-review-view .pk-diff').waitFor();
    assert.equal(await app.page.getByTestId('score-meter').count(), 0);
    assert.equal(await app.page.getByTestId('hunk-label').count(), 0);
    assert.equal(await app.page.getByTestId('hunk-relabel').count(), 0);
    await app.h.closePanel();

    const dialog = await app.h.openSettings('Projects');
    await dialog.getByTestId('section-projects').waitFor();
    assert.equal(await dialog.getByTestId('score-histograms').count(), 0);
    await app.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });

    // The labels it stored are still in the database, so it comes back as it was.
    const installed = pi('install', folder);
    assert.equal(installed.status, 0, installed.stderr + installed.stdout);
    await eventually(async () => (await scoreOf()).status === 200, 'the score to come back', 30_000);
    await eventually(async () => (await rowOf(TITLE).getByTestId('outcome-badge').getAttribute('title'))?.includes('\n'), 'the badge’s second line to come back');
  });
});
