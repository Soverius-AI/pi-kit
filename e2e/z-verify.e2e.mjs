// End to end: verifying a learned skill against the base commit. Run with `npm run e2e -- --file z-verify`.
//
// The name sorts it last, after z-learn and z-outcomes: it adds a project (a repository of its own, `verify-app`) and threads that are newer than every other thread. Nothing here
// needs a language model: the threads run on a fake one (e2e/support/fake-model.mjs, registered as a provider of the scratch agent folder) that writes the notes a prompt names, runs
// the check command the prompt names, and drafts a skill when it is asked for one. The same fake answers the replay, so the outcome is deterministic: the skill as it was drafted
// reproduces the thread (pass), a skill that narrows the work to five of the six notes does not (partial).
//   1. A thread writes six notes and runs `node --test notes.test.mjs`; it is merged back; a skill is drafted from it. The plan says what a replay would do.
//   2. Read, then Approve with "Verify first" on: the button replays instead of writing. While it runs the thread "Verify: …" is in the sidebar, in a scratch worktree at the base
//      commit with the draft pinned; the main checkout and the project's skills folder are untouched. The report says pass with its numbers; Approve is then available.
//   3. The skill is edited: the report is stale, the button says "Verify again"; the narrower skill is partial (5 of 6 files). Approve writes the skill with the result in its frontmatter.
//   4. A replay can be stopped from the dialog and from the thread itself; the scratch worktree and its branch are gone after every kind of end.
//   5. `/learn verify` in the composer does the same through the plugin events.
//   6. A thread without an outcome cannot be replayed: the reason is shown and Approve goes ahead.
//   7. Nothing was left behind, and the replay threads got no outcome, no draft and no attendant summary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { api, env, openApp } from './support/app.mjs';
import { FAKE_MODEL, FAKE_PROVIDER, cannedSkill, notesAgent, registerFakeModel, startFakeModel } from './support/fake-model.mjs';
import { commitFile, gitIn, writeWorktreeProject } from './support/worktree-world.mjs';

const NAME = 'verify-app';
const SKILL = 'replay-notes';
const TITLE = 'Add six notes';
const REPLAY = `Verify: ${SKILL}`;
const PROMPT =
  'Use the write tool, one call per file, to create notes/one.md, notes/two.md, notes/three.md, notes/four.md, notes/five.md and notes/six.md. ' +
  'Every file has exactly three lines: "# Note N", "A short note.", "Note N of six." with N replaced by the number. Then run `node --test notes.test.mjs` and say done in one short sentence.';
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
let worktreeRoot;
let id;
let draftId;
const spawned = [];

async function call(method, path, body) {
  const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${env.api}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
}

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

const isLearnPrompt = (body) => JSON.stringify(body.messages?.[0] ?? '').includes('reusable skill');

before(async () => {
  await ensureBackend();
  fake = await startFakeModel({ answer: (body) => (isLearnPrompt(body) ? cannedSkill({ name: SKILL }) : notesAgent(body, { slowMs: 15_000 })) });
  registerFakeModel(env.agentDir, fake.url);
  worktreeRoot = join(env.project, '..', 'worktrees');
  app = await openApp();
  project = writeWorktreeProject({ base: join(env.project, '..'), name: NAME });
  commitFile(project, 'notes.test.mjs', TEST_FILE, 'Add the notes check');
  await call('POST', '/api/workspaces', { cwd: project });
  // The other projects' threads are none of this file's business: the attendant is kept away from them, so switching it on does not rename them.
  await call('PATCH', '/api/workspaces', { cwd: env.project, attendant: false });
  // The attendant's model is the fake one, which is also the model of the threads: a replay on it counts under the attendant's cap.
  await call('PATCH', '/api/attendant/settings', { enabled: true, model: { provider: FAKE_PROVIDER, modelId: FAKE_MODEL }, dailyCostCap: null, when: { onEnd: false, onInterrupt: false, everyMinutes: 0 } });
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
/** Opens a thread from its title: the row also carries chips (a drafted skill's opens the Learn chat), so its middle is not a safe place to click. */
const openRow = (text) => rowOf(text).getByText(text, { exact: true }).first().click();
const threads = async () => (await api('/api/threads')).filter((t) => t.cwd === project);
const box = () => app.page.getByLabel('Message to pi');
const dialog = () => app.page.getByTestId('review-dialog');
const git = (...args) => gitIn(project, ...args).trim();
const draftOf = async (threadId) => call('GET', `/api/threads/${threadId}/skill-draft`);
const verificationOf = async () => (await draftOf(id)).body.verification;
const projectSkills = () => (existsSync(join(project, '.pi', 'skills')) ? readdirSync(join(project, '.pi', 'skills')) : []);

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

/** Waits until the draft's verification is over (not running) and returns it. */
const verificationDone = (ms = 120_000) =>
  eventually(async () => {
    const v = await verificationOf();
    return v && v.state !== 'running' ? v : undefined;
  }, 'the verification to end', ms);

const replayThread = async () => (await threads()).find((t) => t.title === REPLAY);

async function prompt(text, timeout = 240_000) {
  await box().fill(text);
  await box().press('Enter');
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

const scratchFolders = () => (existsSync(join(worktreeRoot, NAME)) ? readdirSync(join(worktreeRoot, NAME)).filter((n) => n.startsWith('verify-')) : []);
const verifyBranches = () => git('branch', '--list', 'pi-kit/verify-*');

describe('the thread that will be replayed', () => {
  it('writes six notes, runs the check, is merged back, and a skill is drafted from it', async () => {
    const created = (await call('POST', '/api/threads', { cwd: project, worktree: {} })).body;
    id = created.id;
    await call('PATCH', `/api/threads/${id}`, { title: TITLE });
    await call('PATCH', `/api/threads/${id}/model`, { provider: FAKE_PROVIDER, modelId: FAKE_MODEL });
    await eventually(async () => (await rowOf(TITLE).count()) > 0, `the row of ${TITLE}`);
    await openRow(TITLE);
    await box().waitFor();
    await prompt(PROMPT);
    const worktree = (await threads()).find((t) => t.id === id).worktree.path;
    const written = gitIn(worktree, 'status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => /notes\/.+\.md/.test(l));
    assert.equal(written.length, 6, `the six notes are in the worktree:\n${written.join('\n')}`);
    const merged = await call('POST', `/api/threads/${id}/worktree/merge`, { mode: 'merge', message: 'Add six notes', remove: true });
    assert.equal(merged.body.status, 'merged', JSON.stringify(merged.body));
    const outcome = (await call('GET', `/api/threads/${id}/outcome`)).body;
    assert.equal(outcome.kind, 'merged');
    assert.equal(outcome.files.length, 6);
    const asked = await call('POST', `/api/threads/${id}/skill-draft`, {});
    assert.equal(asked.body.status, 'drafted', JSON.stringify(asked.body));
    draftId = asked.body.draft.id;
    assert.equal(asked.body.draft.name, SKILL);
    assert.equal(asked.body.draft.verification, null);
    assert.equal(projectSkills().length, 0, 'a draft is in the database; no skills folder exists for it');
  });

  it('the plan says what a replay would do: the first prompt, the commit, the files, the check, the model', async () => {
    const outcome = (await call('GET', `/api/threads/${id}/outcome`)).body;
    const plan = (await call('GET', `/api/skill-drafts/${draftId}/verify`)).body;
    assert.equal(plan.canVerify, true, JSON.stringify(plan));
    assert.equal(plan.prompt, PROMPT);
    assert.equal(plan.base, outcome.base);
    assert.equal(plan.head, outcome.head);
    assert.equal(plan.files, 6);
    assert.deepEqual(plan.checks, [{ command: 'node --test notes.test.mjs', originalPassed: true }]);
    assert.equal(plan.model, `${FAKE_PROVIDER}/${FAKE_MODEL}`);
    assert.equal(plan.busy, false);
  });
});

describe('Approve with Verify first on replays the skill from the base commit', () => {
  let slowThread;

  it('Read shows Verify first, the prompt and what will be compared; the primary button says Verify first', async () => {
    await eventually(async () => (await app.page.getByTestId('draft-card').count()) > 0, 'the card');
    await app.page.getByTestId('draft-read').click();
    await dialog().waitFor();
    assert.equal(await app.page.getByTestId('verify-switch').isChecked(), true);
    await app.page.getByTestId('verify-prompt').waitFor();
    assert.equal(await app.page.getByTestId('verify-prompt').inputValue(), PROMPT);
    const planText = await app.page.getByTestId('verify-plan').innerText();
    assert.match(planText, /sent from commit [0-9a-f]{7} with the skill pinned and learn-fake\/canned/);
    assert.match(planText, /compared with the 6 files of the outcome; it runs the thread’s 1 check again/);
    const approve = app.page.getByTestId('approve');
    assert.equal((await approve.innerText()).trim(), 'Verify first');
    assert.equal(await approve.getAttribute('data-step'), 'verify');
    assert.equal(await app.page.getByTestId('verification').getAttribute('data-state'), 'none');
  });

  it('while it runs the thread is in the sidebar, in a scratch worktree at the base commit with the draft pinned; the main checkout is untouched', async () => {
    const mainHead = git('rev-parse', 'HEAD');
    // Slow, so there is time to look: the fake model waits before it answers a prompt that says so.
    await app.page.getByTestId('verify-prompt').fill(`${PROMPT} Take your time.`);
    await app.page.getByTestId('approve').click();
    await app.page.getByTestId('verification-running').waitFor();
    assert.equal(await app.page.getByTestId('verification').getAttribute('data-state'), 'running');
    assert.equal((await app.page.getByTestId('approve').innerText()).trim(), 'Verifying…');
    assert.equal(await app.page.getByTestId('approve').isDisabled(), true);

    slowThread = await eventually(async () => {
      const t = await replayThread();
      return t?.running ? t : undefined;
    }, 'the replay thread to run');
    assert.equal(slowThread.cwd, project, 'the replay is a thread under the project');
    assert.equal(slowThread.worktree.exists, true);
    const scratch = slowThread.worktree.path;
    assert.ok(scratch.startsWith(worktreeRoot), `the scratch worktree is under the worktree root: ${scratch}`);
    assert.equal(gitIn(scratch, 'rev-parse', 'HEAD').trim(), (await call('GET', `/api/threads/${id}/outcome`)).body.base, 'it starts at the base commit');
    const pinned = join(scratch, '.pi', 'skills', SKILL, 'SKILL.md');
    await eventually(() => existsSync(pinned), 'the pinned skill');
    assert.match(readFileSync(pinned, 'utf8'), new RegExp(`^---\\nname: ${SKILL}\\n`));
    await rowOf(REPLAY).waitFor();
    // The dialog asks for the report every second and a half.
    await eventually(async () => (await app.page.getByTestId('verification-phase').innerText()) === 'The thread is running with the skill pinned…', 'the phase in the dialog', 10_000);
    // The model was sent the skill block in the replay's first message, with the thread's prompt.
    const replayRequest = await eventually(() => fake.requests.find((r) => !isLearnPrompt(r) && JSON.stringify(r.messages).includes(`<skill name=\\"${SKILL}\\"`)), 'the pinned skill in a request');
    assert.match(JSON.stringify(replayRequest.messages), /Take your time\./);

    assert.equal(git('rev-parse', 'HEAD'), mainHead, 'the main checkout did not move');
    assert.equal(git('status', '--porcelain'), '', 'nothing changed in the main checkout');
    assert.equal(existsSync(join(project, '.pi')), false, 'nothing in the project’s skills folder');
    assert.equal(git('log', '--oneline', `${mainHead}..HEAD`), '', 'no commit in the main checkout');
  });

  it('the report says pass with its numbers, and Approve is available', async () => {
    const done = await verificationDone();
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.equal(done.result, 'pass');
    assert.deepEqual(done.files, { reproduced: 6, expected: 6, extra: 0 });
    assert.deepEqual(done.hunks, { matched: 6, expected: 6, actual: 6 });
    assert.equal(done.score, 1);
    assert.equal(done.checks.length, 1);
    assert.deepEqual({ ...done.checks[0], seconds: 0, output: '' }, { command: 'node --test notes.test.mjs', originalPassed: true, state: 'passed', exitCode: 0, seconds: 0, output: '' });
    assert.equal(done.summary, 'Reproduced 6 of 6 files and 6 of 6 hunks; 1 of 1 check passes again.');
    assert.match(done.prompt, /Take your time\.$/);
    assert.equal(done.model, `${FAKE_PROVIDER}/${FAKE_MODEL}`);
    assert.equal(done.threadId, slowThread.id);

    // The dialog asks for the report every second and a half.
    await app.page.locator('[data-testid=verification][data-state=done]').waitFor();
    assert.equal((await app.page.getByTestId('verification-result').innerText()).trim(), 'Pass');
    assert.equal(await app.page.getByTestId('verification').getAttribute('data-result'), 'pass');
    assert.equal((await app.page.getByTestId('verification-summary').innerText()).trim(), done.summary);
    assert.match(await app.page.getByTestId('verification-score').innerText(), /100 % of the changed lines match/);
    const files = app.page.getByTestId('verification-files').locator('li');
    assert.equal(await files.count(), 6);
    assert.deepEqual(await files.evaluateAll((items) => items.map((li) => li.getAttribute('data-status'))), Array(6).fill('same'));
    assert.match(await app.page.getByTestId('verification-checks').innerText(), /node --test notes\.test\.mjs\s+passed\s+passed in the thread/);
    const approve = app.page.getByTestId('approve');
    assert.equal((await approve.innerText()).trim(), 'Approve');
    assert.equal(await approve.getAttribute('data-step'), 'approve');
    assert.equal(await approve.isEnabled(), true);
    // The verdict is in the text the person will approve, with the numbers.
    const text = await app.page.getByTestId('skill-text').inputValue();
    assert.match(text, /verified:\n {4}result: pass\n {4}at: \d{4}-\d\d-\d\dT[\d:.]+Z\n {4}files: 6\/6\n {4}hunks: 6\/6\n {4}checks: 1\/1\n {4}similarity: 1\.00\n {4}replayedFrom: [0-9a-f]{40}/);
    assert.equal(await app.page.getByTestId('verification-stale').count(), 0);
  });

  it('the scratch worktree and its branch are gone, the thread is kept as the record, and nothing was learned from it', async () => {
    await eventually(async () => scratchFolders().length === 0, 'the scratch worktree to be removed');
    assert.equal(verifyBranches(), '');
    assert.equal(git('worktree', 'list').split('\n').length, 1, 'only the main checkout is a worktree of the project');
    assert.equal(existsSync(slowThread.worktree.path), false);
    assert.equal(git('status', '--porcelain'), '');
    assert.equal((await threads()).some((t) => t.title === REPLAY), false, 'the record is archived, not in the sidebar');
    const archived = (await api('/api/threads?archived=1')).find((t) => t.id === slowThread.id);
    assert.equal(archived.archived, true);
    assert.equal(archived.messageCount > 0, true);
    assert.equal((await call('GET', `/api/threads/${slowThread.id}/outcome`)).status, 404, 'a replay has no outcome');
    assert.equal((await call('GET', `/api/threads/${slowThread.id}/skill-draft`)).status, 404, 'and no draft');
    const refused = await call('POST', `/api/threads/${slowThread.id}/skill-draft`, {});
    assert.equal(refused.status, 409);
    assert.match(JSON.stringify(refused.body), /replayed a skill/);
    // The attendant lists the replay in its activity, under the thread the skill was learned from, with the model and the tokens: that is what the cap counts. It did nothing to the replay.
    const all = (await call('GET', '/api/attendant')).body.actions;
    const verified = all.filter((a) => a.threadId === id && /^Verified the skill/.test(a.text));
    assert.equal(verified.length, 1);
    assert.equal(verified[0].kind, 'learn');
    assert.match(verified[0].text, /Verified the skill replay-notes: pass\. Reproduced 6 of 6 files/);
    assert.equal(verified[0].model, `${FAKE_PROVIDER}/${FAKE_MODEL}`, 'on the attendant’s own model, so it counts under the cap');
    assert.ok(verified[0].inputTokens > 0, 'with the tokens of the replay');
    assert.deepEqual(all.filter((a) => a.threadId === slowThread.id), [], 'nothing was done to the replay thread itself');
  });

  it('returning to the source keeps the draft pending, and its card says what the replay found', async () => {
    await dialog().getByRole('button', { name: 'Back to source chat', exact: true }).click();
    await dialog().waitFor({ state: 'detached' });
    await openRow(TITLE);
    await app.page.getByTestId('draft-card').waitFor();
    await eventually(async () => /verified: it reproduces its thread/.test(await app.page.getByTestId('draft-card').innerText()), 'the verified note on the card');
    assert.equal(projectSkills().length, 0);
  });
});

describe('a skill that was edited is replayed again and found partial', () => {
  it('the edit makes the report stale and the button says Verify again', async () => {
    await app.page.getByTestId('draft-read').click();
    await dialog().waitFor();
    await app.page.getByTestId('verification-result').waitFor();
    assert.equal((await app.page.getByTestId('approve').innerText()).trim(), 'Approve');
    const text = await app.page.getByTestId('skill-text').inputValue();
    const narrower = text.replace('1. Create each note in its own file under the notes folder, one tool call per file.', '1. Create the first five notes only, each in its own file under the notes folder.');
    assert.notEqual(narrower, text);
    await app.page.getByTestId('skill-text').fill(narrower);
    await app.page.getByTestId('verification-stale').waitFor();
    assert.match(await app.page.getByTestId('verification-stale-note').innerText(), /report is for the earlier text/);
    const approve = app.page.getByTestId('approve');
    assert.equal((await approve.innerText()).trim(), 'Verify again');
    assert.equal(await approve.getAttribute('data-step'), 'verify');
  });

  it('replays the edited text and reports partial: five of the six files', async () => {
    await app.page.getByTestId('approve').click();
    await app.page.getByTestId('verification-running').waitFor();
    const done = await verificationDone();
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.equal(done.result, 'partial');
    assert.deepEqual(done.files, { reproduced: 5, expected: 6, extra: 0 });
    assert.deepEqual(done.hunks, { matched: 5, expected: 6, actual: 5 });
    assert.ok(done.score > 0.9 && done.score < 0.92, `score ${done.score}`);
    assert.equal(done.summary, 'Reproduced 5 of 6 files and 5 of 6 hunks; 1 of 1 check passes again.');
    assert.equal(done.prompt, PROMPT, 'the thread’s own prompt this time');
    assert.deepEqual(done.fileList.filter((f) => f.status === 'missing').map((f) => f.path), ['notes/six.md']);

    await eventually(async () => (await app.page.getByTestId('verification-result').innerText()).trim() === 'Partial', 'the Partial chip');
    assert.equal(await app.page.getByTestId('verification-stale').count(), 0, 'the report is for the text in the editor again');
    const rows = await app.page.getByTestId('verification-files').locator('li').evaluateAll((items) => items.map((li) => [li.getAttribute('data-status'), li.querySelector('.path').textContent]));
    assert.deepEqual(rows.filter(([status]) => status === 'missing'), [['missing', 'notes/six.md']]);
    assert.equal(rows.filter(([status]) => status === 'same').length, 5);
    assert.match(await app.page.getByTestId('verification-score').innerText(), /91 % of the changed lines match/);
    // Partial does not block Approve: it is information, and the person decides.
    assert.equal((await app.page.getByTestId('approve').innerText()).trim(), 'Approve');
    assert.equal(await app.page.getByTestId('approve').isEnabled(), true);
    await eventually(async () => scratchFolders().length === 0, 'the scratch worktree to be removed');
  });

  it('Approve writes the skill with the result in its frontmatter', async () => {
    await app.page.getByTestId('approve').click();
    await dialog().waitFor({ state: 'detached' });
    // A project skill is project resources: pi asks to trust the folder now, as it does for any project that gets one. The answer goes into the scratch agent folder.
    const trusted = await call('POST', `/api/workspaces/${encodeURIComponent(project)}/trust`, { decision: 'remember' });
    assert.equal(trusted.status, 200, JSON.stringify(trusted.body));
    await app.page.reload();
    await app.page.waitForSelector('pk-root .pk-shell');
    await head().waitFor();
    const file = join(project, '.pi', 'skills', SKILL, 'SKILL.md');
    assert.ok(existsSync(file));
    const written = readFileSync(file, 'utf8');
    assert.match(written, /first five notes only/);
    assert.match(written, /verified:\n {4}result: partial\n {4}at: [\d\-T:.Z]+\n {4}files: 5\/6\n {4}hunks: 5\/6\n {4}checks: 1\/1\n/);
    const draft = (await draftOf(id)).body;
    assert.equal(draft.state, 'approved');
    assert.equal(draft.verification.result, 'partial');
    assert.equal(draft.verification.requested, true);
    assert.match(draft.text, /result: partial/);
    assert.equal(git('status', '--porcelain', '--', ':!.pi'), '', 'nothing but the skill changed in the project');
  });
});

describe('a replay can be stopped, and nothing stays behind', () => {
  it('Stop in the API ends it as stopped and removes the scratch worktree', async () => {
    const before = readFileSync(join(project, '.pi', 'skills', SKILL, 'SKILL.md'), 'utf8');
    const started = await call('POST', `/api/skill-drafts/${draftId}/verify`, { prompt: `${PROMPT} Take your time.` });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.verification.state, 'running');
    const second = await call('POST', `/api/skill-drafts/${draftId}/verify`, {});
    assert.equal(second.status, 409, 'one replay of a draft at a time');
    const thread = await eventually(async () => {
      const t = await replayThread();
      return t?.running ? t : undefined;
    }, 'the replay thread to run');
    assert.equal(thread.worktree.exists, true);
    const stopped = await call('POST', `/api/skill-drafts/${draftId}/verify/stop`);
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    const done = await verificationDone();
    assert.equal(done.state, 'stopped', JSON.stringify(done));
    assert.equal(done.result, undefined);
    await eventually(async () => scratchFolders().length === 0, 'the scratch worktree to be removed');
    assert.equal(verifyBranches(), '');
    assert.equal((await call('POST', `/api/skill-drafts/${draftId}/verify/stop`)).status, 409, 'nothing to stop now');
    assert.equal(readFileSync(join(project, '.pi', 'skills', SKILL, 'SKILL.md'), 'utf8'), before, 'a stopped replay leaves the written skill as it was');
  });

  it('the verification thread itself has the ordinary Stop button', async () => {
    const started = await call('POST', `/api/skill-drafts/${draftId}/verify`, { prompt: `${PROMPT} Take your time.` });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const thread = await eventually(async () => {
      const t = await replayThread();
      return t?.running ? t : undefined;
    }, 'the replay thread to run');
    await openRow(REPLAY);
    await app.page.getByTestId('stop').waitFor();
    await app.page.getByTestId('stop').click();
    const done = await verificationDone();
    assert.equal(done.state, 'stopped', JSON.stringify(done));
    assert.equal(done.threadId, thread.id);
    await eventually(async () => scratchFolders().length === 0, 'the scratch worktree to be removed');
    assert.equal(verifyBranches(), '');
    assert.equal((await threads()).some((t) => t.title === REPLAY), false);
  });

  it('an approved skill can be verified again, and the written file gets the new result', async () => {
    const file = join(project, '.pi', 'skills', SKILL, 'SKILL.md');
    const body = readFileSync(file, 'utf8').split('\n---\n').slice(1).join('\n---\n');
    const started = await call('POST', `/api/skill-drafts/${draftId}/verify`, {});
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const done = await verificationDone();
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.equal(done.result, 'partial');
    const written = readFileSync(file, 'utf8');
    assert.match(written, /verified:\n {4}result: partial/);
    assert.equal(written.split('\n---\n').slice(1).join('\n---\n'), body, 'only the frontmatter’s verified lines changed');
    await eventually(async () => scratchFolders().length === 0, 'the scratch worktree to be removed');
  });
});

describe('/learn verify in the composer', () => {
  it('replays through the plugin events and says the result in the thread', async () => {
    const before = (await verificationOf()).finishedAt;
    await openRow(TITLE);
    await box().waitFor();
    await box().fill('/learn verify ');
    // The Send button, not Enter: Enter did not send this message in the test (the composer kept the text), where `/learn ` alone is sent by Enter in z-learn.e2e.mjs; the button always sends.
    await app.page.getByTestId('send').click();
    await eventually(async () => {
      const v = await verificationOf();
      return v.finishedAt > before && v.state === 'done' ? v : undefined;
    }, 'the verification started by /learn verify', 120_000);
    await app.page.getByText(/replay-notes: partial\. Reproduced 5 of 6 files and 5 of 6 hunks/).first().waitFor();
    await eventually(async () => scratchFolders().length === 0, 'the scratch worktree to be removed');
  });
});

describe('a thread without an outcome cannot be replayed', () => {
  let plain;

  it('says why, and Approve goes ahead with the reason shown', async () => {
    plain = await plainThread('Add one note');
    await openRow('Add one note');
    await box().waitFor();
    await prompt('Use the write tool once to create notes/solo.md with the single line "A solo note." Then say done in one short sentence.');
    const asked = await call('POST', `/api/threads/${plain}/skill-draft`, {});
    assert.equal(asked.body.status, 'drafted', JSON.stringify(asked.body));
    const plan = (await call('GET', `/api/skill-drafts/${asked.body.draft.id}/verify`)).body;
    assert.equal(plan.canVerify, false);
    assert.match(plan.reason, /no outcome yet/);
    const refused = await call('POST', `/api/skill-drafts/${asked.body.draft.id}/verify`, {});
    assert.equal(refused.status, 409);
    assert.match(JSON.stringify(refused.body), /no outcome yet/);

    await eventually(async () => (await app.page.getByTestId('draft-card').count()) > 0, 'the card');
    await app.page.getByTestId('draft-read').click();
    await dialog().waitFor();
    await app.page.getByTestId('verify-reason').waitFor();
    assert.match(await app.page.getByTestId('verify-reason').innerText(), /Cannot be verified now: .*no outcome yet/);
    assert.equal((await app.page.getByTestId('approve').innerText()).trim(), 'Approve');
    assert.match(await app.page.getByTestId('step-note').innerText(), /Cannot verify first/);
    assert.equal(await app.page.getByTestId('verify-run').count(), 0);
    await dialog().getByRole('button', { name: 'Back to source chat', exact: true }).click();
    await dialog().waitFor({ state: 'detached' });
  });
});

describe('nothing was left behind', () => {
  it('no scratch worktree, branch, skill or note in the main checkout; the replay threads are archived records without an outcome or draft', async () => {
    assert.deepEqual(scratchFolders(), []);
    assert.equal(verifyBranches(), '');
    assert.equal(git('worktree', 'list').split('\n').length, 1);
    assert.deepEqual(projectSkills(), [SKILL]);
    // The plain thread of the test before wrote notes/solo.md in the project's own folder, as a thread without a worktree does; nothing else is there.
    assert.equal(git('status', '--porcelain', '--', ':!.pi'), '?? notes/solo.md');
    const all = await api('/api/threads?archived=1');
    const replays = all.filter((t) => t.cwd === project && t.title === REPLAY);
    assert.ok(replays.length >= 4, `the replays are kept as records (${replays.length})`);
    for (const t of replays) {
      assert.equal(t.archived, true, t.id);
      assert.equal(t.running, false);
      assert.equal(t.state.outcome, null, 'no outcome');
      assert.equal(t.state.draft, null, 'no draft');
      assert.equal((await call('GET', `/api/threads/${t.id}/outcome`)).status, 404);
    }
    const actions = (await call('GET', '/api/attendant')).body.actions.filter((a) => replays.some((t) => t.id === a.threadId));
    assert.deepEqual(actions, [], 'the attendant did not name, summarise or look at a replay');
  });
});
