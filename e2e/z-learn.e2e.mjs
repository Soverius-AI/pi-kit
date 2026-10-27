// End to end: skills learned from finished threads. Run with `pnpm run e2e -- --file z-learn`.
//
// The name sorts it last, with z-outcomes: it adds a project (a repository of its own, `learn-app`) and threads that are newer than every other thread, and the files before it
// assume the world they made. The attendant's model here is a fake one (e2e/support/fake-model.mjs): an OpenAI-compatible server in this process that answers a learn
// prompt with a canned SKILL.md and records what it was sent, registered as a provider in the scratch agent folder. The threads themselves run on the local model.
//   1. The package: `pi list` in the scratch agent folder shows @pi-kit/learn (pi-kit installed it into pi's settings), and `/learn` is in the `/` menu.
//   2. An outcome lands with the attendant on and the thread did enough (6 or more tool calls, 10 or more changed lines): the draft appears as a card at the end of the thread
//      and as a chip on the sidebar row; the model was sent the redacted transcript; nothing is written to any skills folder. Read opens the dialog (SKILL.md with its
//      provenance, scope, Verify first); a name that is taken is refused and the dialog stays; another name is approved, the folder is written, and the skill is in the `/`
//      menu and can be added as a chip at once.
//   3. A thread that is too small is not drafted by the attendant (its activity says why). A draft asked for by hand is discarded: nothing is written, the chip and card go,
//      the thread is not drafted again (the model is not asked), and the thread menu reopens the draft.
//   4. With the attendant off, `/learn` in the composer asks for the person's agreement first (nothing is sent before), then drafts; the thread menu does the same with a dialog.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { api, env, openApp } from './support/app.mjs';
import { CANNED_SKILL, FAKE_MODEL, FAKE_PROVIDER, registerFakeModel, startFakeModel } from './support/fake-model.mjs';
import { gitIn, writeWorktreeProject } from './support/worktree-world.mjs';

const NAME = 'learn-app';
const SECRET = `sk-${'q7Zr3Kd9'.repeat(5)}`;
let app;
let project;
let fake;
let userSkills;

async function call(method, path, body) {
  const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${env.api}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
}

const spawned = [];
/** The backend that an earlier file's restart test left running (or not): this file brings one up when none answers, as z-outcomes.e2e.mjs does. */
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
  await ensureBackend();
  fake = await startFakeModel({ answer: (body) => (JSON.stringify(body.messages?.[0] ?? '').includes('reusable skill') ? CANNED_SKILL : 'Notes work') });
  registerFakeModel(env.agentDir, fake.url);
  userSkills = join(env.agentDir, 'skills');
  app = await openApp();
  project = writeWorktreeProject({ base: join(env.project, '..'), name: NAME });
  await call('POST', '/api/workspaces', { cwd: project });
  // The other project's threads are none of this file's business: the attendant is kept away from them (the per-project opt-out), so switching it on does not rename them.
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
const rowOf = (text) => group().locator('.pk-thread').filter({ has: app.page.getByText(text, { exact: true }) }).first();
const threads = async () => (await api('/api/threads')).filter((t) => t.cwd === project);
const box = () => app.page.getByLabel('Message to pi');
const dialog = () => app.page.getByTestId('review-dialog');

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

async function prompt(text, timeout = 240_000) {
  await box().fill(text);
  await box().press('Enter');
  const stop = app.page.getByTestId('stop');
  await stop.waitFor({ timeout: 30_000 }).catch(() => undefined);
  await stop.waitFor({ state: 'detached', timeout });
  await app.h.settle(800);
}

/** A thread in a new worktree of the project, named, and opened. Returns its id. */
async function worktreeThread(title) {
  const created = (await call('POST', '/api/threads', { cwd: project, worktree: {} })).body;
  assert.ok(created?.id, 'the worktree thread was made');
  await call('PATCH', `/api/threads/${created.id}`, { title });
  await eventually(async () => (await rowOf(title).count()) > 0, `the row of ${title}`);
  await rowOf(title).click();
  await box().waitFor();
  await app.h.settle(500);
  return created.id;
}

/** A thread in the project's folder itself. */
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

const skillFolders = () => [...(existsSync(userSkills) ? readdirSync(userSkills) : []), ...(existsSync(join(project, '.pi', 'skills')) ? readdirSync(join(project, '.pi', 'skills')).map((n) => `project:${n}`) : [])];
const draftOf = async (id) => call('GET', `/api/threads/${id}/skill-draft`);
const learnRequests = () => fake.requests.filter((r) => JSON.stringify(r.messages?.[0] ?? '').includes('reusable skill')).length;
/** The user prompt of the last learn request: with the attendant on, an outcome also queues a score, so the fake model's last request may be the attribution prompt. */
const lastLearnPrompt = () => {
  const r = [...fake.requests].reverse().find((r) => JSON.stringify(r.messages?.[0] ?? '').includes('reusable skill'));
  const user = [...(r?.messages ?? [])].reverse().find((m) => m.role === 'user');
  return typeof user?.content === 'string' ? user.content : (user?.content ?? []).map((part) => part.text ?? '').join('\n');
};
const attendantActions = async () => (await call('GET', '/api/attendant')).body.actions;

describe('the package', () => {
  it('is installed into the scratch pi: `pi list` shows it, and /learn is in the / menu', async () => {
    const listed = spawnSync(join(new URL('..', import.meta.url).pathname, 'node_modules', '.bin', 'pi'), ['list'], {
      env: { ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
      encoding: 'utf8',
    });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /User packages:[\s\S]*pi-kit-learn/, listed.stdout);
    const settings = JSON.parse(readFileSync(join(env.agentDir, 'settings.json'), 'utf8'));
    const learnFolder = settings.packages.map(String).find((p) => /pi-kit-learn\/?$/.test(p));
    assert.ok(learnFolder, JSON.stringify(settings.packages));
    assert.ok(existsSync(join(learnFolder.startsWith('/') ? learnFolder : join(env.agentDir, learnFolder), 'extensions', 'learn.ts')));

    await plainThread('Command list');
    await rowOf('Command list').click();
    await box().fill('/lear');
    await app.page.locator('[role="option"][id^="pk-composer-opt-"]', { hasText: 'learn' }).first().waitFor();
    await box().fill('');
  });
});

describe('an outcome lands with the attendant on', () => {
  const TITLE = 'Add six notes';
  let id;
  let worktree;
  let skillName;

  it('drafts a skill from a thread that did enough, and shows the card and the chip; nothing is written', async () => {
    // The attendant on with the fake model, looking only when an outcome lands (its other jobs would send the canned skill to the title and the summary).
    await call('PATCH', '/api/attendant/settings', { enabled: true, model: { provider: FAKE_PROVIDER, modelId: FAKE_MODEL }, dailyCostCap: null, when: { onEnd: false, onInterrupt: false, everyMinutes: 0 } });
    id = await worktreeThread(TITLE);
    worktree = (await threads()).find((t) => t.id === id).worktree.path;
    await prompt(
      `My deploy key is ${SECRET}, never write it anywhere. Use the write tool six times, one call per file, to create notes/one.md, notes/two.md, notes/three.md, notes/four.md, notes/five.md and notes/six.md. ` +
        'Every file has exactly three lines: "# Note N", "A short note.", "Note N of six." with N replaced by the number. Then say done in one short sentence.',
    );
    const written = gitIn(worktree, 'status', '--porcelain', '--untracked-files=all')
      .split('\n')
      .filter((l) => /notes\/.+\.md/.test(l));
    assert.ok(written.length >= 6, `pi wrote the six notes in the worktree:\n${written.join('\n')}`);
    assert.equal(learnRequests(), 0, 'nothing was sent to the model before an outcome');

    const merged = await call('POST', `/api/threads/${id}/worktree/merge`, { mode: 'merge', message: 'Add six notes', remove: true });
    assert.equal(merged.body.status, 'merged', JSON.stringify(merged.body));

    const draft = await eventually(async () => {
      const got = await draftOf(id);
      return got.status === 200 ? got.body : undefined;
    }, 'the attendant’s draft', 90_000);
    assert.equal(draft.state, 'pending');
    assert.equal(draft.madeBy, 'attendant');
    assert.equal(draft.name, 'add-notes-with-an-index');
    assert.equal(draft.scope, 'project');
    skillName = draft.name;
    assert.match(draft.text, new RegExp(`x-pi-kit:\\n  learnedFrom: ${id}\\n  base: [0-9a-f]{40}\\n  head: [0-9a-f]{40}\\n  verified: null`));
    assert.equal(learnRequests(), 1, 'one model call for the draft');
    assert.deepEqual(skillFolders(), [], 'a draft is in the database; no skills folder exists for it');
    assert.equal(existsSync(join(project, '.pi')), false);

    // What the model was sent: the reduced transcript, after the redaction pass.
    const sent = JSON.stringify(fake.requests.at(-1));
    assert.ok(!sent.includes(SECRET), 'the key never reached the model');
    assert.match(lastLearnPrompt(), /First prompt: My deploy key is \[redacted openai key …/);
    assert.match(lastLearnPrompt(), /\d+\. write notes\/one\.md/);
    assert.match(lastLearnPrompt(), /Final diff \(\d+ changed lines\)/);
    assert.match(lastLearnPrompt(), /\+# Note (1|one)\b/i); // the local model sometimes spells the number out

    // The activity says so, with the cost line.
    const action = (await attendantActions()).find((a) => a.kind === 'learn' && a.threadId === id);
    assert.equal(action?.status, 'done');
    assert.match(action.text, /Drafted the skill add-notes-with-an-index/);

    // The thread: the card at its end; the sidebar row: the chip.
    await eventually(async () => (await app.page.getByTestId('learn-chip').count()) > 0, 'the chip on the row');
    assert.equal(await rowOf(TITLE).getByTestId('learn-chip').innerText(), 'Skill “add-notes-with-an-index”, drafted');
    const card = app.page.getByTestId('draft-card');
    await card.waitFor();
    assert.match(await card.innerText(), /The attendant drafted a skill from this thread:\s*add-notes-with-an-index\s*Read/);
  });

  it('Read opens the review dialog: the SKILL.md as pi will load it, the scope, Verify first, where it comes from', async () => {
    await app.page.getByTestId('draft-read').click();
    await dialog().waitFor();
    const text = await app.page.getByTestId('skill-text').inputValue();
    assert.match(text, /^---\nname: add-notes-with-an-index\ndescription: Use when adding several short notes/);
    assert.match(text, /x-pi-kit:\n {2}learnedFrom: /);
    assert.equal(await app.page.getByTestId('skill-name').inputValue(), 'add-notes-with-an-index');
    assert.equal(await app.page.getByTestId('scope-project').getAttribute('aria-pressed'), 'true');
    assert.match(await app.page.getByTestId('scope-project').innerText(), /\.pi\/skills\/add-notes-with-an-index\/SKILL\.md/);
    assert.equal(await app.page.getByTestId('verify-switch').isChecked(), true);
    assert.match(await app.page.getByTestId('provenance').innerText(), /Add six notes[\s\S]*the attendant with learn-fake\/canned/);
    assert.equal(await app.page.getByTestId('approve').isEnabled(), true);
    await app.h.settle(300);
  });

  it('refuses a name that is taken and keeps the dialog open; another name is approved and the folder is written', async () => {
    // The name is taken in the user's folder.
    mkdirSync(join(userSkills, skillName), { recursive: true });
    writeFileSync(join(userSkills, skillName, 'SKILL.md'), '---\nname: add-notes-with-an-index\ndescription: Mine\n---\n\nMy own.\n');
    await app.page.getByTestId('scope-user').click();
    // "Verify first" is on by default, and the button then replays the skill before it approves (z-verify.e2e.mjs covers that). These checks are about the approval itself.
    assert.equal(await app.page.getByTestId('verify-switch').isChecked(), true);
    await app.page.getByTestId('verify-switch').click();
    await eventually(async () => (await app.page.getByTestId('approve').innerText()).trim() === 'Approve', 'the button to say Approve');
    await app.page.getByTestId('approve').click();
    const error = await app.page.getByTestId('learn-error').waitFor().then(() => app.page.getByTestId('learn-error').innerText());
    assert.match(error, /Choose another name/);
    assert.equal(readFileSync(join(userSkills, skillName, 'SKILL.md'), 'utf8').includes('My own.'), true, 'the existing skill was not overwritten');
    assert.equal((await draftOf(id)).body.state, 'pending');
    assert.ok(await dialog().isVisible());

    // A name pi would refuse keeps Approve disabled.
    await app.page.getByTestId('skill-name').fill('Not A Name');
    assert.equal(await app.page.getByTestId('approve').isDisabled(), true);
    assert.match(await app.page.getByTestId('learn-problems').innerText(), /lowercase letters/);

    skillName = 'add-notes-v2';
    await app.page.getByTestId('skill-name').fill(skillName);
    await app.page.getByTestId('approve').click();
    await dialog().waitFor({ state: 'detached' });
    const file = join(userSkills, skillName, 'SKILL.md');
    assert.ok(existsSync(file), 'the skill folder was written');
    const written = readFileSync(file, 'utf8');
    assert.match(written, new RegExp(`^---\\nname: ${skillName}\\n`));
    assert.match(written, new RegExp(`learnedFrom: ${id}`), 'the thread is recorded as its origin');
    const draft = (await draftOf(id)).body;
    assert.equal(draft.state, 'approved');
    assert.equal(draft.path, file);
    assert.equal(draft.scope, 'user');
    assert.equal(draft.verification, null, 'Verify first was switched off: nothing was asked of the draft');
    assert.equal(await app.page.getByTestId('draft-card').count(), 0, 'the card is gone');
    assert.equal(await rowOf(TITLE).getByTestId('learn-chip').count(), 0, 'the chip is gone');
    assert.deepEqual(skillFolders().sort(), [skillName, 'add-notes-with-an-index'].sort());
  });

  it('is in the / menu at once, and can be added to a message as a chip', async () => {
    await box().fill('/skill:add-notes-v');
    await app.page.locator('[role="option"][id^="pk-composer-opt-"]', { hasText: `skill:${skillName}` }).first().waitFor();
    await box().press('Enter');
    const chip = app.page.getByTestId('chip-strip').getByTestId('skill-chip').filter({ has: app.page.locator(`.name:text-is("${skillName}")`) });
    await chip.first().waitFor();
    assert.equal(await box().inputValue(), '');
    await chip.first().getByTestId('skill-chip-remove').click();
  });
});

describe('a thread that is too small, and a draft that is discarded', () => {
  const TITLE = 'Add one note';
  let id;
  let draftId;

  it('is not drafted by the attendant: the activity says why, and nothing is asked of the model', async () => {
    const before = learnRequests();
    id = await worktreeThread(TITLE);
    await prompt('Use the write tool once to create notes/solo.md with the single line "A solo note." Then say done in one short sentence.');
    const merged = await call('POST', `/api/threads/${id}/worktree/merge`, { mode: 'merge', message: 'Add one note', remove: true });
    assert.equal(merged.body.status, 'merged', JSON.stringify(merged.body));
    const action = await eventually(async () => (await attendantActions()).find((a) => a.kind === 'learn' && a.threadId === id), 'the attendant’s note', 60_000);
    assert.equal(action.status, 'skipped');
    assert.match(action.text, /Not worth a skill: Only \d+ tool calls? \(a draft needs 6\)/);
    assert.equal(learnRequests(), before, 'no model call');
    assert.equal((await draftOf(id)).status, 404);
  });

  it('a draft asked for from the thread menu is made with the attendant’s model', async () => {
    await rowOf(TITLE).hover();
    await rowOf(TITLE).locator('summary').click();
    await rowOf(TITLE).getByTestId('menu-learn').click();
    await dialog().waitFor();
    await app.page.getByTestId('skill-text').waitFor();
    draftId = (await draftOf(id)).body.id;
    assert.equal((await draftOf(id)).body.madeBy, 'person');
    assert.equal(learnRequests() >= 2, true);
  });

  it('Discard writes nothing, removes the card and the chip, and the thread is not drafted again', async () => {
    const folders = skillFolders().sort();
    const asked = learnRequests();
    await app.page.getByTestId('discard').click();
    await dialog().waitFor({ state: 'detached' });
    assert.deepEqual(skillFolders().sort(), folders, 'discarding writes nothing');
    const draft = (await draftOf(id)).body;
    assert.equal(draft.state, 'discarded');
    assert.equal(draft.path, null);
    assert.equal(await rowOf(TITLE).getByTestId('learn-chip').count(), 0);
    await rowOf(TITLE).click();
    await box().waitFor();
    assert.equal(await app.page.getByTestId('draft-card').count(), 0);

    // Asking again returns the discarded draft; the model is not asked.
    const again = await call('POST', `/api/threads/${id}/skill-draft`, {});
    assert.equal(again.body.draft.id, draftId);
    assert.equal(again.body.draft.state, 'discarded');
    assert.equal(learnRequests(), asked);
  });

  it('the thread menu reopens the draft', async () => {
    await rowOf(TITLE).hover();
    await rowOf(TITLE).locator('summary').click();
    assert.equal((await rowOf(TITLE).getByTestId('menu-learn').innerText()).trim(), 'Reopen the skill draft');
    await rowOf(TITLE).getByTestId('menu-learn').click();
    await dialog().waitFor();
    assert.equal((await draftOf(id)).body.state, 'pending');
    assert.ok(await app.page.getByTestId('approve').isEnabled());
    await app.page.keyboard.press('Escape');
    await dialog().waitFor({ state: 'detached' });
    await eventually(async () => (await app.page.getByTestId('draft-card').count()) > 0, 'the card of the reopened draft');
    assert.deepEqual(skillFolders().includes('add-notes-with-an-index'), true);
  });
});

describe('with the attendant off', () => {
  const TITLE = 'Ask for a skill';
  let id;

  it('/learn asks for the person’s agreement before anything is sent, then drafts', async () => {
    await call('PATCH', '/api/attendant/settings', { enabled: false });
    id = await plainThread(TITLE);
    await rowOf(TITLE).click();
    await box().waitFor();
    await prompt('Use the write tool once to create notes/off.md with the single line "Written with the attendant off." Then say done in one short sentence.');
    const asked = learnRequests();
    // The trailing space closes the menu, so Enter sends the command instead of completing it.
    await box().fill('/learn ');
    await box().press('Enter');
    const approval = app.page.locator('.pk-approval', { hasText: 'Learn a skill from this thread?' });
    await approval.waitFor();
    assert.match(await approval.innerText(), /This sends the thread’s transcript[\s\S]*learn-fake\/canned[\s\S]*The attendant is off/);
    assert.equal(learnRequests(), asked, 'nothing was sent before the answer');
    assert.equal((await draftOf(id)).status, 404);

    await approval.getByRole('button', { name: 'Allow' }).click();
    await app.page.getByTestId('draft-card').waitFor();
    assert.equal(learnRequests(), asked + 1);
    const draft = (await draftOf(id)).body;
    assert.equal(draft.state, 'pending');
    assert.equal(draft.madeBy, 'person');
    assert.match(await app.page.getByTestId('draft-card').innerText(), /A skill was drafted from this thread:\s*add-notes-with-an-index/);
  });

  it('the thread menu asks too, with a dialog, and drafts after the agreement', async () => {
    const other = await plainThread('Ask from the menu');
    await rowOf('Ask from the menu').click();
    await box().waitFor();
    await prompt('Use the write tool once to create notes/menu.md with the single line "Menu." Then say done in one short sentence.');
    const asked = learnRequests();
    await rowOf('Ask from the menu').hover();
    await rowOf('Ask from the menu').locator('summary').click();
    await rowOf('Ask from the menu').getByTestId('menu-learn').click();
    await dialog().waitFor();
    await app.page.getByTestId('consent-text').waitFor();
    assert.equal(await dialog().getAttribute('data-view'), 'consent');
    assert.match(await app.page.getByTestId('consent-text').innerText(), /This sends the thread’s transcript[\s\S]*to learn-fake\/canned/);
    assert.equal(learnRequests(), asked, 'nothing sent yet');
    await app.page.getByTestId('consent-agree').click();
    await app.page.getByTestId('skill-text').waitFor();
    assert.equal(learnRequests(), asked + 1);
    assert.equal((await draftOf(other)).body.state, 'pending');
    await app.page.keyboard.press('Escape');
  });

  it('nothing was written to a skills folder by any of this', async () => {
    assert.deepEqual(skillFolders().sort(), ['add-notes-v2', 'add-notes-with-an-index']);
    assert.equal(existsSync(join(project, '.pi')), false);
  });
});
