// End to end: the record of a learned skill. Run with `pnpm run e2e -- --file z-learned`.
//
// The name sorts it after z-learn (it adds a project, `learned-app`, and threads the earlier files' assumptions do not allow for). Nothing here needs a language model: the threads run on
// the fake model of e2e/support/fake-model.mjs (it writes the notes a prompt names, runs the check the prompt names, and drafts a skill when it is asked for one).
// The skill is a user-scope skill (`tidy-notes` in the scratch agent folder): a worktree thread does not see a project's untracked `.pi/skills/`, and the point of the record is uses in
// threads of any kind. The file leaves the skill retired, so no later file's world has an extra skill.
//   1. The attendant is on: a thread that wrote six notes and was merged back gets a draft on its own and the `learn` chip on its row. The draft is approved.
//   2. Settings › Skills shows the learned skill's record under its row: where it came from, not verified, not used yet.
//   3. The skill is used in two threads: a typed `/skill:tidy-notes` in a worktree thread that is then merged, and a chip added from Settings in a plain thread that ends without an
//      outcome. The record says "used 2 times, merged after 1".
//   4. Re-verify replays the skill from the base commit of its thread: the row shows the phase, then "verified …, pass", the file states it, the draft stays approved.
//   5. Edit opens the review dialog on the saved text: Save writes the file through the one writer with the provenance stamped again; the report is marked "edited since".
//   6. Retire asks first, moves the folder to `.retired/`, and the skill is gone from the `/` menu; the Retired list has it with Restore, which brings it back with its record.
//   7. Three more threads use it and end without an outcome: the row carries the warning.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { api, env, openApp } from './support/app.mjs';
import { FAKE_MODEL, FAKE_PROVIDER, cannedSkill, notesAgent, registerFakeModel, startFakeModel } from './support/fake-model.mjs';
import { commitFile, gitIn, writeWorktreeProject } from './support/worktree-world.mjs';

const NAME = 'learned-app';
const SKILL = 'tidy-notes';
const TITLE_A = 'Add six notes';
const TITLE_B = 'Add three more notes';
const PROMPT_A =
  'Use the write tool, one call per file, to create notes/one.md, notes/two.md, notes/three.md, notes/four.md, notes/five.md and notes/six.md. ' +
  'Every file has exactly three lines: "# Note N", "A short note.", "Note N of six." with N replaced by the number. Then run `node --test notes.test.mjs` and say done in one short sentence.';
const PROMPT_B =
  'Use the write tool, one call per file, to create notes/seven.md, notes/eight.md and notes/nine.md. ' +
  'Every file has exactly three lines: "# Note N", "A short note.", "Note N of three." with N replaced by the number. Then run `node --test notes.test.mjs` and say done in one short sentence.';
const TEST_FILE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('every note has three lines', () => {
  const notes = readdirSync('notes').filter((name) => name.endsWith('.md'));
  assert.ok(notes.length > 0, 'there are notes');
  for (const name of notes) assert.equal(readFileSync(\`notes/\${name}\`, 'utf8').trim().split('\\n').length, 3, name);
});
`;

let app;
let project;
let fake;
let idA;
let skillId;
const spawned = [];

async function call(method, path, body) {
  const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${env.api}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
}

/** The backend an earlier file's restart test left running (or not): this file brings one up when none answers, as z-learn.e2e.mjs does. */
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

const isLearnPrompt = (body) => JSON.stringify(body.messages?.[0] ?? '').includes('reusable skill');

before(async () => {
  await ensureBackend();
  fake = await startFakeModel({ answer: (body) => (isLearnPrompt(body) ? cannedSkill({ name: SKILL }) : notesAgent(body, { slowMs: 15_000 })) });
  registerFakeModel(env.agentDir, fake.url);
  app = await openApp();
  project = writeWorktreeProject({ base: join(env.project, '..'), name: NAME });
  commitFile(project, 'notes.test.mjs', TEST_FILE, 'Add the notes check');
  await call('POST', '/api/workspaces', { cwd: project });
  // The other projects' threads are none of this file's business: the attendant is kept away from them.
  await call('PATCH', '/api/workspaces', { cwd: env.project, attendant: false });
  // The attendant drafts after an outcome (its third job); the schedule switches stay off so it does not rename or summarise anything.
  await call('PATCH', '/api/attendant/settings', { enabled: true, model: { provider: FAKE_PROVIDER, modelId: FAKE_MODEL }, dailyCostCap: null, when: { onEnd: false, onInterrupt: false, everyMinutes: 0 } });
  await app.page.reload();
  await app.page.waitForSelector('pk-root .pk-shell');
  await head().waitFor();
});
after(async () => {
  // Leaves the skill retired: pi does not load it, so no later file sees an extra skill.
  if (skillId) await call('POST', `/api/skills/learned/${skillId}/retire`).catch(() => undefined);
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
const userSkillFile = () => join(env.agentDir, 'skills', SKILL, 'SKILL.md');
const retiredSkillFile = () => join(env.agentDir, 'skills', '.retired', SKILL, 'SKILL.md');
const learned = async () => (await call('GET', '/api/skills/learned')).body.find((s) => s.name === SKILL);

async function eventually(check, what, ms = 30_000) {
  const deadline = Date.now() + ms;
  let value;
  do {
    value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 150));
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${what}`);
}

async function prompt(text, timeout = 240_000) {
  await box().fill(text);
  // A message that opens with `/` keeps the command menu open, where Enter may be taken by the menu: the Send button always sends.
  if (text.startsWith('/')) await app.page.getByTestId('send').click();
  else await box().press('Enter');
  const stop = app.page.getByTestId('stop');
  await stop.waitFor({ timeout: 30_000 }).catch(() => undefined);
  await stop.waitFor({ state: 'detached', timeout });
  await app.h.settle(800);
}

async function plainThread(title) {
  await head().hover();
  await app.page.getByRole('button', { name: `New thread in ${NAME}` }).click();
  await box().waitFor();
  await app.h.settle(500);
  const created = (await threads()).filter((t) => !t.title && t.messageCount === 0).sort((a, b) => b.createdAt - a.createdAt)[0];
  assert.ok(created, 'the new thread is listed');
  await call('PATCH', `/api/threads/${created.id}`, { title });
  await eventually(async () => (await rowOf(title).count()) > 0, `the row of ${title}`);
  await call('PATCH', `/api/threads/${created.id}/model`, { provider: FAKE_PROVIDER, modelId: FAKE_MODEL });
  return created.id;
}

async function worktreeThread(title) {
  const created = (await call('POST', '/api/threads', { cwd: project, worktree: {} })).body;
  await call('PATCH', `/api/threads/${created.id}`, { title });
  await call('PATCH', `/api/threads/${created.id}/model`, { provider: FAKE_PROVIDER, modelId: FAKE_MODEL });
  await eventually(async () => (await rowOf(title).count()) > 0, `the row of ${title}`);
  await rowOf(title).click();
  await box().waitFor();
  return created.id;
}

/** Settings › Skills, with the skill's row loaded. */
async function openSkills() {
  // A failed test may have left Settings open: start from the page.
  if ((await app.page.getByRole('dialog', { name: 'Settings' }).count()) > 0) await closeSettings();
  const settings = await app.h.openSettings('Skills');
  await settings.getByTestId(`resource-skills-${SKILL}`).waitFor();
  return settings;
}
const closeSettings = async () => {
  await app.page.keyboard.press('Escape');
  await app.page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });
};
const learnedBlock = (settings) => settings.locator(`[data-testid=learned-skill][data-skill=${SKILL}]`);
const recordText = async (settings) => (await learnedBlock(settings).getByTestId('learned-record').innerText()).replace(/\s+/g, ' ').trim();

/** Types `/skill:tidy` in the open thread's composer and looks at the `/` menu: is the skill offered? Waits for the answer to be `expected` (the commands load a moment after a change). */
async function menuOffers(expected) {
  const option = app.page.locator('[role="option"][id^="pk-composer-opt-"]', { hasText: `skill:${SKILL}` });
  const offered = async () => {
    await box().fill('');
    await box().fill('/skill:tidy');
    await app.h.settle(500);
    return (await option.count()) > 0;
  };
  const deadline = Date.now() + (expected ? 15_000 : 4_000);
  let seen = await offered();
  while (seen !== expected && Date.now() < deadline) seen = await offered();
  if (!expected) await app.h.settle(1500);
  seen = await offered();
  await box().fill('');
  return seen;
}

describe('the attendant proposes learning from a merged thread', () => {
  it('a thread that wrote six notes and was merged back gets a draft on its own, with the learn chip on its row', async () => {
    idA = await worktreeThread(TITLE_A);
    await prompt(PROMPT_A);
    const merged = await call('POST', `/api/threads/${idA}/worktree/merge`, { mode: 'merge', message: 'Add six notes', remove: true });
    assert.equal(merged.body.status, 'merged', JSON.stringify(merged.body));
    const draft = await eventually(async () => {
      const got = await call('GET', `/api/threads/${idA}/skill-draft`);
      return got.status === 200 ? got.body : undefined;
    }, 'the attendant’s draft', 60_000);
    assert.equal(draft.madeBy, 'attendant');
    assert.equal(draft.name, SKILL);
    assert.equal(draft.state, 'pending');
    await eventually(async () => (await rowOf(TITLE_A).getByTestId('learn-chip').count()) > 0, 'the learn chip on the row');
    assert.match(await rowOf(TITLE_A).getByTestId('learn-chip').innerText(), /Skill “tidy-notes”, drafted/);
    assert.equal(existsSync(userSkillFile()), false, 'a draft is a database row; no skill folder exists for it');
  });

  it('Approve (user scope) writes the skill; it is a learned skill with an empty record', async () => {
    const draft = (await call('GET', `/api/threads/${idA}/skill-draft`)).body;
    const approved = await call('POST', `/api/skill-drafts/${draft.id}/approve`, { name: SKILL, scope: 'user', text: draft.text, verify: false });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    skillId = draft.id;
    assert.equal(approved.body.path, userSkillFile());
    const skill = await learned();
    assert.equal(skill.id, draft.id);
    assert.deepEqual({ uses: skill.uses, mergedAfterUse: skill.mergedAfterUse, threads: skill.threads, lastUsedAt: skill.lastUsedAt, retiredAt: skill.retiredAt, flag: skill.flag, verification: skill.verification }, { uses: 0, mergedAfterUse: 0, threads: 0, lastUsedAt: null, retiredAt: null, flag: null, verification: null });
    assert.equal(skill.learnedFrom.threadId, idA);
    assert.equal(skill.learnedFrom.title, TITLE_A);
    assert.match(skill.learnedFrom.base, /^[0-9a-f]{40}$/);
    assert.match(skill.learnedFrom.head, /^[0-9a-f]{40}$/);
    assert.equal((await call('GET', `/api/skills/learned/${draft.id}`)).body.text, readFileSync(userSkillFile(), 'utf8'));
    assert.equal((await call('GET', '/api/skills/learned/nope')).status, 404);
  });
});

describe('Settings shows the record under the skill’s row', () => {
  it('says where it was learned from, that it was never verified or used, and offers Re-verify, Edit and Retire', async () => {
    const settings = await openSkills();
    await learnedBlock(settings).waitFor();
    assert.equal(await recordText(settings), `Learned from ${TITLE_A} · not verified · not used yet`);
    const block = learnedBlock(settings);
    assert.deepEqual(await block.locator('button').allInnerTexts(), ['Re-verify', 'Edit', 'Retire']);
    assert.equal(await block.getByTestId('learned-flag').count(), 0);
    // A skill that was not learned has no record (an earlier file's world may hold another learned skill, which has its own): each record is under a row of the learned list.
    const learnedNames = (await call('GET', '/api/skills/learned')).body.filter((s) => s.retiredAt === null).map((s) => s.name);
    const shown = await settings.locator('[data-testid=learned-skill]').evaluateAll((els) => els.map((el) => el.getAttribute('data-skill')));
    assert.ok(shown.every((name) => learnedNames.includes(name)), `only learned skills have a record: ${shown}`);
    assert.equal(shown.filter((name) => name === SKILL).length, 1);
    await closeSettings();
  });
});

describe('a use of the skill is recorded with the outcome of its thread', () => {
  let idB;

  it('a typed /skill:tidy-notes in a worktree thread is a use; after the thread is merged it is "merged after use"', async () => {
    idB = await worktreeThread(TITLE_B);
    await prompt(`/skill:${SKILL} ${PROMPT_B}`);
    let skill = await learned();
    assert.equal(skill.uses, 1);
    assert.equal(skill.threads, 1);
    assert.equal(skill.mergedAfterUse, 0, 'no outcome yet');
    assert.ok(skill.lastUsedAt > Date.now() - 120_000);
    const request = fake.requests.findLast((r) => !isLearnPrompt(r) && JSON.stringify(r.messages).includes(`<skill name=\\"${SKILL}\\"`));
    assert.ok(request, 'pi expanded the typed command into the skill block');
    const merged = await call('POST', `/api/threads/${idB}/worktree/merge`, { mode: 'merge', message: 'Add three more notes', remove: true });
    assert.equal(merged.body.status, 'merged', JSON.stringify(merged.body));
    skill = await eventually(async () => {
      const s = await learned();
      return s.mergedAfterUse === 1 ? s : undefined;
    }, 'the use to be marked with the merge');
    assert.equal(skill.uses, 1);
  });

  it('a chip added from Settings in a plain thread is a use; the thread ends without an outcome', async () => {
    const idC = await plainThread('Say hello');
    await rowOf('Say hello').click();
    await box().waitFor();
    const settings = await openSkills();
    await settings.getByTestId(`resource-skills-${SKILL}`).getByTestId('add-to-composer').click();
    await settings.waitFor({ state: 'detached' });
    await app.page.getByTestId('chip-strip').getByTestId('skill-chip').first().waitFor();
    await prompt('Say hello in one short sentence.');
    const skill = await learned();
    assert.equal(skill.uses, 2);
    assert.equal(skill.threads, 2);
    assert.equal(skill.mergedAfterUse, 1);
    assert.equal(skill.flag, null, 'two threads are not enough for a flag');
    assert.equal((await threads()).find((t) => t.id === idC).state.outcome, null);
  });

  it('the row says "used 2 times, merged after 1" and when it was last used', async () => {
    const settings = await openSkills();
    await learnedBlock(settings).waitFor();
    assert.equal(await recordText(settings), `Learned from ${TITLE_A} · not verified · used 2 times, merged after 1 · last used just now`);
    await closeSettings();
  });

  it('a prompt that does not name the skill is not a use', async () => {
    const before = (await learned()).uses;
    await prompt('Say hello again in one short sentence.');
    assert.equal((await learned()).uses, before);
  });
});

describe('Re-verify replays the approved skill from the base commit of its thread', () => {
  it('the row shows the replay running, then "verified …, pass"; the file states it and the draft stays approved', async () => {
    const settings = await openSkills();
    await learnedBlock(settings).getByTestId('learned-reverify').click();
    await learnedBlock(settings).getByTestId('learned-running').waitFor();
    assert.equal(await learnedBlock(settings).getByTestId('learned-reverify').isDisabled(), true);
    assert.equal(await learnedBlock(settings).getByTestId('learned-edit').isDisabled(), true);
    assert.equal(await learnedBlock(settings).getByTestId('learned-retire').isDisabled(), true);
    await eventually(async () => (await learned()).verification?.state === 'done', 'the replay to finish', 120_000);
    await learnedBlock(settings).getByTestId('learned-running').waitFor({ state: 'detached' });
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    assert.match(await recordText(settings), new RegExp(`^Learned from ${TITLE_A} · verified ${today}, pass · used 2 times, merged after 1 · last used (just now|\\d+ min ago)$`));
    const skill = await learned();
    assert.equal(skill.verification.result, 'pass');
    assert.equal(skill.verification.stale, false);
    assert.match(readFileSync(userSkillFile(), 'utf8'), /verified:\n {4}result: pass\n {4}at: [\d\-T:.Z]+\n {4}files: 6\/6\n/);
    const draft = (await call('GET', `/api/threads/${idA}/skill-draft`)).body;
    assert.equal(draft.state, 'approved');
    assert.equal(draft.verification.result, 'pass');
    assert.equal(draft.path, userSkillFile());
    // The replay is a verification record, not a use.
    assert.equal(skill.uses, 2);
    await closeSettings();
  });
});

describe('Edit opens the review dialog on the saved text', () => {
  const EXTRA = '4. Keep every note to three lines.';

  it('Save is off until the text changes; Save writes the file with the provenance stamped again, and the report is marked edited', async () => {
    const before = readFileSync(userSkillFile(), 'utf8');
    const settings = await openSkills();
    await learnedBlock(settings).getByTestId('learned-edit').click();
    await app.page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });
    await dialog().waitFor();
    assert.equal(await dialog().getAttribute('aria-label'), 'Edit the skill');
    assert.equal((await app.page.getByTestId('draft-state').innerText()).trim(), 'approved');
    const text = app.page.getByTestId('skill-text');
    assert.equal(await text.inputValue(), before);
    assert.equal(await app.page.getByTestId('edit-save').isDisabled(), true);
    assert.equal(await app.page.getByTestId('skill-name').evaluate((el) => el.readOnly), true);
    // The verification box shows the report of the replay; an edit makes it stale.
    assert.equal((await app.page.getByTestId('verification-result').innerText()).trim(), 'Pass');
    const forged = before.replace('learnedFrom: ' + idA, 'learnedFrom: somewhere-else').replace('3. Check the folder listing before you say you are done.', `${EXTRA}\n3. Check the folder listing before you say you are done.`);
    await text.fill(forged);
    await app.page.getByTestId('verification-stale').waitFor();
    assert.equal(await app.page.getByTestId('edit-save').isEnabled(), true);
    // A text pi would not load cannot be saved.
    await text.fill('just words');
    assert.equal(await app.page.getByTestId('edit-save').isDisabled(), true);
    await text.fill(forged);
    await app.page.getByTestId('edit-save').click();
    await dialog().waitFor({ state: 'detached' });

    const written = readFileSync(userSkillFile(), 'utf8');
    assert.ok(written.includes(EXTRA), 'the edit is in the file');
    assert.match(written, new RegExp(`learnedFrom: ${idA}\\n`), 'the provenance was stamped again');
    assert.ok(!written.includes('somewhere-else'));
    assert.match(written, /^name: tidy-notes$/m);
    assert.match(written, /verified: null/, 'the report is for the earlier text, so the file states none');
    const skill = await learned();
    assert.equal(skill.verification.stale, true);
    assert.equal((await call('GET', `/api/threads/${idA}/skill-draft`)).body.state, 'approved');
    assert.equal(skill.uses, 2, 'an edit is not a use');

    const again = await openSkills();
    await learnedBlock(again).waitFor();
    assert.match(await recordText(again), /^Learned from Add six notes · verified [A-Z][a-z]{2} \d{1,2}, pass \(edited since\) · used 2 times/);
    await closeSettings();
  });

  it('Cancel leaves the file alone', async () => {
    const before = readFileSync(userSkillFile(), 'utf8');
    const settings = await openSkills();
    await learnedBlock(settings).getByTestId('learned-edit').click();
    await dialog().waitFor();
    await app.page.getByTestId('skill-text').fill(`${before}\nSomething else.\n`);
    await app.page.getByTestId('edit-cancel').click();
    await dialog().waitFor({ state: 'detached' });
    assert.equal(readFileSync(userSkillFile(), 'utf8'), before);
  });
});

describe('Retire moves the folder to.retired; Restore brings it back', () => {
  it('the skill is offered in the / menu before', async () => {
    await app.h.newThread();
    assert.equal(await menuOffers(true), true);
  });

  it('Retire asks first and says what happens; Cancel changes nothing', async () => {
    const settings = await openSkills();
    await learnedBlock(settings).getByTestId('learned-retire').click();
    const confirm = learnedBlock(settings).getByTestId('learned-confirm');
    await confirm.waitFor();
    assert.match(await confirm.innerText(), /Retire tidy-notes\? pi stops loading it\. Its folder moves to skills\/\.retired\/tidy-notes\/ in pi’s folder; nothing is deleted and Restore brings it back\./);
    await learnedBlock(settings).getByTestId('learned-retire-cancel').click();
    await confirm.waitFor({ state: 'detached' });
    assert.equal(existsSync(userSkillFile()), true);
    assert.equal((await learned()).retiredAt, null);
  });

  it('confirming moves the folder, drops the row, and the skill is gone from the / menu', async () => {
    const settings = await app.page.getByRole('dialog', { name: 'Settings' });
    const before = readFileSync(userSkillFile(), 'utf8');
    await learnedBlock(settings).getByTestId('learned-retire').click();
    await learnedBlock(settings).getByTestId('learned-retire-confirm').click();
    await settings.getByTestId(`resource-skills-${SKILL}`).waitFor({ state: 'detached' });
    assert.equal(existsSync(userSkillFile()), false);
    assert.equal(readFileSync(retiredSkillFile(), 'utf8'), before, 'moved, not rewritten or deleted');
    const skill = await learned();
    assert.ok(skill.retiredAt > 0);
    assert.equal(skill.missing, false);
    assert.equal((await call('GET', `/api/threads/${idA}/skill-draft`)).body.state, 'approved', 'the draft records the retirement; it stays approved');
    // The Retired group is there, collapsed, with the count.
    const retired = settings.getByTestId('retired-group');
    await retired.waitFor();
    assert.equal((await retired.getByTestId('retired-count').innerText()).trim(), '1');
    assert.equal(await retired.getByTestId('retired-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await retired.getByTestId(`retired-${SKILL}`).count(), 0);
    await closeSettings();
    // The thread that was open when the skill was retired reads its commands again, so neither the menu nor its chips offer the skill.
    assert.equal(await menuOffers(false), false, 'gone from the / menu');
  });

  it('a thread opened after that does not have the skill either', async () => {
    await app.h.newThread();
    assert.equal(await menuOffers(false), false);
  });

  it('the Retired list opens, and Restore moves the folder back with the record intact', async () => {
    const settings = await app.h.openSettings('Skills');
    const retired = settings.getByTestId('retired-group');
    await retired.waitFor();
    await retired.getByTestId('retired-toggle').click();
    const row = retired.getByTestId(`retired-${SKILL}`);
    await row.waitFor();
    assert.match(await row.innerText(), /retired just now|retired \d+ min ago/);
    assert.match(await row.innerText(), /Learned from Add six notes/);
    await row.getByTestId('learned-restore').click();
    await settings.getByTestId(`resource-skills-${SKILL}`).waitFor();
    await retired.waitFor({ state: 'detached' });
    assert.equal(existsSync(userSkillFile()), true);
    assert.equal(existsSync(retiredSkillFile()), false);
    const skill = await learned();
    assert.equal(skill.retiredAt, null);
    assert.equal(skill.uses, 2, 'the record survived');
    assert.equal(skill.mergedAfterUse, 1);
    await closeSettings();
    assert.equal(await menuOffers(true), true, 'back in the / menu');
  });
});

describe('a skill whose last three threads ended without an outcome is flagged', () => {
  it('three plain threads use it and say hello; the row carries the warning', async () => {
    for (const n of [1, 2, 3]) {
      await plainThread(`Use the skill ${n}`);
      await rowOf(`Use the skill ${n}`).click();
      await box().waitFor();
      await prompt(`/skill:${SKILL} say hello ${n}`);
    }
    const skill = await eventually(async () => {
      const s = await learned();
      return s.threads === 5 ? s : undefined;
    }, 'five threads that used the skill');
    assert.equal(skill.uses, 5);
    assert.equal(skill.flag?.reason, 'no-outcomes');
    const settings = await openSkills();
    await learnedBlock(settings).getByTestId('learned-flag').waitFor();
    assert.match(await learnedBlock(settings).getByTestId('learned-flag').innerText(), /Its last three threads ended without a commit, merge or pull request\./);
    assert.equal(await learnedBlock(settings).getAttribute('data-flagged'), 'no-outcomes');
    await closeSettings();
  });
});

describe('the writers', () => {
  it('the project’s own files were not touched by retiring, restoring or editing a user skill', async () => {
    assert.equal(gitIn(project, 'status', '--porcelain', '--', ':!.pi').trim(), '');
    assert.equal(existsSync(join(project, '.pi')), false);
  });
});
