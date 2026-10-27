// End to end: the new-thread page and its Where row. Run with `npm run e2e`.
//
// The tests work in a repository of their own (`where-row`, written next to the scratch project, on `main` with a `develop` branch) so what they leave uncommitted never reaches
// the other files. The first message of every thread is a few words long: the model answers at once and the thread is on its way.
//   1. Local on another branch with a clean tree: the row's branch menu switches the checkout when the first message is sent; the crumbs and the hint say so.
//   2. A dirty folder: the other branches are off with the reason, the API answers 409 with the same sentence, "New branch from main…" takes the changes along.
//   3. A worktree with carried changes, named from the message, with Remember; the next new thread opens on Worktree with the changes ticked.
//   4. A detached worktree, given a branch from the thread menu.
//   5. Hand off to local (the folder must be clean first), the session goes on in the folder; Move into a worktree for a Local thread.
//   6. The setup scripts: the one the lockfile suggests, a saved list, the files a script copies.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { api, env, openApp } from './support/app.mjs';
import { gitIn, writeWorktreeProject } from './support/worktree-world.mjs';

const NAME = 'where-row';
let app;
let project;
const spawned = [];

/** The backend that an earlier file's restart test left running (or not): this file brings one up when none answers, as worktrees.e2e.mjs does. */
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

async function call(method, path, body) {
  const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${env.api}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

before(async () => {
  await ensureBackend();
  app = await openApp();
  project = writeWorktreeProject({ base: join(env.project, '..'), name: NAME });
  gitIn(project, 'branch', 'develop');
  await call('POST', '/api/workspaces', { cwd: project });
  await app.page.reload();
  await app.page.waitForSelector('pk-root .pk-shell');
  await head().waitFor();
});
after(async () => {
  await app?.close();
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
const threads = async () => (await api('/api/threads')).filter((t) => t.cwd === project);
const gitHere = (...args) => gitIn(project, ...args).trim();
const branchHere = () => gitHere('rev-parse', '--abbrev-ref', 'HEAD');

async function eventually(check, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  let value;
  do {
    value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 150));
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${what}`);
}

/** A new thread through the project's own "+": its page opens with the Where row. Returns the empty thread. */
async function newThread() {
  const before = new Set((await threads()).map((t) => t.id));
  await head().hover();
  await app.page.getByRole('button', { name: `New thread in ${NAME}` }).click();
  await app.page.getByTestId('where-row').waitFor();
  return eventually(async () => (await threads()).find((t) => !before.has(t.id)), 'the new empty thread');
}

/** Sends a message and waits until the run is over. */
async function send(text) {
  const box = app.page.getByLabel('Message to pi');
  await box.fill(text);
  await box.press('Enter');
  const stop = app.page.getByTestId('stop');
  await stop.waitFor({ timeout: 30_000 }).catch(() => undefined);
  await stop.waitFor({ state: 'detached' });
  await app.h.settle(600);
}

/** Waits until the element with this test id reads exactly `expected` (the page draws a moment after the click). */
const waitText = (id, expected, timeout = 5000) =>
  app.page.waitForFunction(([testId, want]) => (document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '').trim().replace(/\s+/g, ' ') === want, [id, expected], { timeout });

const rename = async (id, title) => {
  await call('PATCH', `/api/threads/${id}`, { title });
  await eventually(async () => (await rowOf(title).count()) > 0, `the row of ${title}`);
};

async function threadMenu(title, item) {
  await rowOf(title).hover();
  await rowOf(title).locator('details').first().locator('summary').click();
  await app.page.getByRole('button', { name: item }).first().click();
}

describe('the setup scripts of a project', () => {
  it('derives the default script from the lockfile when nothing is configured, and the single command of 8m wins over it', async () => {
    const workspace = async () => (await api('/api/workspaces')).find((w) => w.name === NAME).worktree;
    assert.deepEqual((await workspace()).setupScripts, []);
    writeFileSync(join(project, 'pnpm-lock.yaml'), '');
    assert.deepEqual((await workspace()).setupScripts, [{ id: 'pnpm', name: 'pnpm', command: 'pnpm install --frozen-lockfile' }]);
    assert.equal((await workspace()).setup, null, 'a suggestion is not a saved setting');
    rmSync(join(project, 'pnpm-lock.yaml'));
    writeFileSync(join(project, 'package-lock.json'), '{}');
    assert.equal((await workspace()).setupScripts[0].command, 'npm ci');
    // The single setup command of Settings › Projects is the first script and wins over the detection.
    await call('PATCH', '/api/workspaces', { cwd: project, worktree: { setup: 'make setup' } });
    assert.deepEqual((await workspace()).setupScripts, [{ id: 'setup', name: 'Setup', command: 'make setup' }]);
    assert.equal((await workspace()).setup, 'make setup');
    rmSync(join(project, 'package-lock.json'));
    // Cleared: "none", and the lockfile is not suggested again. The tests below use their own scripts.
    await call('PATCH', '/api/workspaces', { cwd: project, worktree: { setup: null } });
    assert.deepEqual((await workspace()).setupScripts, []);
  });
});

describe('Local on another branch', () => {
  let id;
  it('shows the row with the branch that is checked out, and switches the checkout when the first message is sent', async () => {
    const empty = await newThread();
    id = empty.id;
    assert.equal(await app.page.getByTestId('where-local').getAttribute('aria-checked'), 'true');
    assert.match(await app.page.getByTestId('where-sentence').innerText(), /as it is$/);
    assert.equal((await app.page.getByTestId('where-branch-button').innerText()).trim(), 'main');
    assert.equal((await app.page.getByTestId('where-from').innerText()).trim(), 'the folder as it is');
    assert.match(await app.page.getByTestId('new-thread-page').innerText(), /What are we doing in where-row\?/);
    // Nothing is switched by looking at the menu.
    await app.page.getByTestId('where-branch-button').click();
    const develop = app.page.getByTestId('where-branch-develop');
    assert.notEqual(await develop.getAttribute('aria-disabled'), 'true');
    await develop.click();
    await waitText('where-branch-button', 'develop');
    assert.equal(branchHere(), 'main', 'the checkout moves at Send, not on the menu');
    assert.match(await app.page.getByTestId('where-hint').innerText(), /switches .* to develop/);
    assert.match(await app.page.locator('pk-breadcrumb-strip').innerText(), /switches to develop, runs in this folder/);
    await send('Say ok in one short word.');
    assert.equal(branchHere(), 'develop');
    const thread = (await threads()).find((t) => t.id === id);
    assert.ok(!thread.worktree, 'a Local thread has no worktree');
    assert.equal(thread.cwd, project);
    // The row is gone once the thread has begun: its folder is fixed.
    await eventually(async () => (await app.page.getByTestId('where-row').count()) === 0, 'the row to leave');
    assert.equal(await app.page.getByTestId('new-thread-page').count(), 0);
    await rename(id, 'On develop');
    gitHere('checkout', '-q', 'main');
  });
});

describe('a folder with uncommitted files', () => {
  it('turns the other branches off with the reason, and the API says the same with a 409', async () => {
    writeFileSync(join(project, 'dirty.txt'), 'wip\n');
    const empty = await newThread();
    await app.page.getByTestId('where-branch-button').click();
    const develop = app.page.getByTestId('where-branch-develop');
    assert.equal(await develop.getAttribute('aria-disabled'), 'true');
    assert.match(await develop.innerText(), /stash or commit the 1 file first/);
    assert.match(await app.page.getByTestId('where-from').innerText(), /the folder as it is/);
    await develop.click({ force: true });
    await app.h.settle(300);
    assert.equal((await app.page.getByTestId('where-branch-button').innerText()).trim(), 'main', 'a disabled entry does nothing');
    // The same rule on the server, for a request that does not come from the row.
    const refused = await call('POST', '/api/threads', { cwd: project, local: { branch: 'develop' } });
    assert.equal(refused.status, 409);
    assert.match(refused.body.detail ?? refused.body.message ?? JSON.stringify(refused.body), /1 uncommitted file\. Stash or commit it, then switch to develop/);
    const placed = await call('POST', `/api/threads/${empty.id}/placement`, { local: { branch: 'develop' } });
    assert.equal(placed.status, 409);
    assert.equal(branchHere(), 'main');
    // Staying where it is needs no permission.
    await call('POST', `/api/threads/${empty.id}/placement`, { local: { branch: 'main' } }).then((r) => assert.equal(r.status, 200));
    await app.page.keyboard.press('Escape');
  });

  it('"New branch from main…" makes a branch and takes the changes along', async () => {
    await app.page.getByTestId('where-branch-button').click();
    await app.page.getByTestId('where-new-branch').click();
    await app.page.getByTestId('where-new-branch-name').fill('feature/carry');
    await app.page.getByTestId('where-new-branch-make').click();
    await waitText('where-branch-button', 'feature/carry');
    await send('Say ok in one short word.');
    assert.equal(branchHere(), 'feature/carry');
    assert.ok(existsSync(join(project, 'dirty.txt')), 'the uncommitted file came along');
    assert.equal(gitHere('status', '--porcelain'), '?? dirty.txt');
    gitHere('checkout', '-q', 'main');
  });
});

describe('a worktree from the Where row', () => {
  let id;
  let path;
  const TITLE = 'Carried changes';

  it('carries the folder\'s uncommitted changes, is named from the first message, and leaves the folder as it was', async () => {
    writeFileSync(join(project, 'README.md'), '# where-row\n\nEdited but not committed.\n');
    const status = gitHere('status', '--porcelain');
    assert.equal(status.split('\n').length, 2);
    const known = new Set((await threads()).map((t) => t.id));
    await app.page.getByTestId('new-thread-menu').click();
    await app.page.getByTestId('new-in-worktree').click();
    await app.page.getByTestId('where-row').waitFor();
    const empty = await eventually(async () => (await threads()).find((t) => !known.has(t.id)), 'the new empty thread');
    assert.equal(await app.page.getByTestId('where-worktree').getAttribute('aria-checked'), 'true');
    await waitText('where-branch-button', 'pi-kit/<name>');
    assert.match(await app.page.getByTestId('where-sentence').innerText(), /^a fresh checkout under .*\/where-row\/$/);
    assert.match(await app.page.getByTestId('where-from').innerText(), /main\s+carry 2 changes/);
    assert.match(await app.page.locator('pk-breadcrumb-strip').innerText(), /starts in a new worktree from main/);
    // The mode switch changes values, never the layout: the same three labels in the same order.
    const labels = () => app.page.locator('.pk-where .grid .k').allInnerTexts();
    assert.deepEqual(await labels(), ['branch', 'from', 'setup']);
    await app.page.getByTestId('where-local').click();
    assert.deepEqual(await labels(), ['branch', 'from', 'setup']);
    await app.page.getByTestId('where-worktree').click();
    await app.page.getByTestId('where-carry').check();
    await app.page.getByTestId('where-remember').check();
    await send('Say ok in one short sentence.');
    const thread = await eventually(async () => (await threads()).find((t) => t.id === empty.id && t.worktree?.exists), 'the thread in its worktree');
    id = thread.id;
    path = thread.worktree.path;
    assert.equal(thread.worktree.branch, 'pi-kit/say-ok-in-one-short-sentence');
    assert.equal(thread.worktree.base, 'main');
    assert.ok(!thread.worktree.detached);
    assert.ok(path.startsWith(env.server.PI_KIT_WORKTREE_ROOT));
    assert.equal(gitIn(path, 'rev-parse', 'HEAD').trim(), gitHere('rev-parse', 'main'), 'cut from the tip of main');
    assert.equal(readFileSync(join(path, 'dirty.txt'), 'utf8'), 'wip\n');
    assert.match(readFileSync(join(path, 'README.md'), 'utf8'), /Edited but not committed/);
    assert.equal(gitHere('status', '--porcelain'), status, 'the folder is exactly as it was');
    assert.equal(branchHere(), 'main');
    await rename(id, TITLE);
    await rowOf(TITLE).getByTestId('worktree-badge').waitFor();
  });

  it('Remember made Worktree, branches named from the message and carrying the changes the project\'s default', async () => {
    const settings = (await api('/api/workspaces')).find((w) => w.name === NAME).worktree;
    assert.equal(settings.start, 'worktree');
    assert.equal(settings.carryChanges, 'always');
    assert.equal(settings.branchMode, 'named');
    // The next new thread opens on Worktree with the changes ticked, no menu needed.
    await newThread();
    assert.equal(await app.page.getByTestId('where-worktree').getAttribute('aria-checked'), 'true');
    assert.equal(await app.page.getByTestId('where-carry').isChecked(), true);
    // Put the default back so the next tests choose for themselves.
    await call('PATCH', '/api/workspaces', { cwd: project, worktree: { start: 'local', carryChanges: 'ask' } });
  });

  it('a detached worktree has no branch until the thread menu gives it one', async () => {
    const empty = await newThread();
    await app.page.getByTestId('where-worktree').click();
    await app.page.getByTestId('where-branch-button').click();
    await app.page.getByTestId('where-detached').click();
    await waitText('where-branch-button', 'detached');
    assert.match(await app.page.getByTestId('where-hint').innerText(), /detached checkout from main/);
    await send('Say ok in one short word.');
    const thread = await eventually(async () => (await threads()).find((t) => t.id === empty.id && t.worktree?.exists), 'the detached thread');
    assert.equal(thread.worktree.branch, null);
    assert.equal(thread.worktree.detached, true);
    assert.equal(gitIn(thread.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD');
    await rename(empty.id, 'Loose idea');
    // The menu entries: Create branch here applies, Hand off to local does too, Move into a worktree does not (with its reason).
    await rowOf('Loose idea').hover();
    await rowOf('Loose idea').locator('details').first().locator('summary').click();
    assert.equal(await rowOf('Loose idea').getByTestId('menu-move').isDisabled(), true);
    assert.match((await rowOf('Loose idea').getByTestId('menu-move').getAttribute('title')) ?? '', /worktree already/);
    await rowOf('Loose idea').getByTestId('menu-branch').click();
    const dialog = app.page.getByRole('dialog', { name: 'Create branch here' });
    await dialog.waitFor();
    await dialog.getByRole('textbox').fill('feature/loose-idea');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await eventually(async () => (await threads()).find((t) => t.id === empty.id)?.worktree?.branch === 'feature/loose-idea', 'the branch to be created');
    assert.equal(gitIn(thread.worktree.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature/loose-idea');
    assert.ok(!(await threads()).find((t) => t.id === empty.id).worktree.detached);
  });

  it('hands off to local: the folder must be clean first, then the branch and the changes move into it and the session goes on there', async () => {
    await selectThread(TITLE);
    const before = (await threads()).find((t) => t.id === id);
    const branch = before.worktree.branch;
    // The folder still holds the same two uncommitted changes that were carried: the dialog says so and keeps the button off.
    await threadMenu(TITLE, /Hand off to local/);
    const dialog = app.page.getByTestId('handoff-dialog');
    await dialog.waitFor();
    await app.page.getByTestId('handoff-blocked').waitFor();
    assert.match(await app.page.getByTestId('handoff-blocked').innerText(), /The folder has 2 uncommitted files\. Commit or stash them, then hand off\./);
    assert.equal(await app.page.getByTestId('do-handoff').isDisabled(), true);
    const refused = await call('POST', `/api/threads/${id}/worktree/handoff`, { to: 'local', remove: true });
    assert.equal(refused.status, 409);
    assert.ok(existsSync(path), 'a refused hand off changes nothing');
    await app.page.keyboard.press('Escape');
    // Stash the folder's copies; now it can move.
    gitHere('stash', 'push', '--include-untracked', '-m', 'the copies');
    await threadMenu(TITLE, /Hand off to local/);
    await app.page.getByTestId('handoff-summary').waitFor();
    assert.match(await app.page.getByTestId('handoff-summary').innerText(), /The folder switches to pi-kit\/say-ok-in-one-short-sentence/);
    assert.equal(await app.page.getByTestId('handoff-remove').isChecked(), true, 'the project\'s rule is ask: removing is offered, on');
    await app.page.getByTestId('do-handoff').click();
    await app.page.getByTestId('handoff-result').waitFor();
    assert.equal(branchHere(), branch);
    assert.equal(readFileSync(join(project, 'dirty.txt'), 'utf8'), 'wip\n');
    assert.match(readFileSync(join(project, 'README.md'), 'utf8'), /Edited but not committed/);
    assert.ok(!existsSync(path), 'the worktree folder is removed');
    await app.page.getByRole('button', { name: 'Done', exact: true }).click();
    const after = (await threads()).find((t) => t.id === id);
    assert.ok(!after.worktree?.exists, 'the thread has no worktree any more');
    assert.equal(after.cwd, project);
    await eventually(async () => (await rowOf(TITLE).getByTestId('worktree-badge').count()) === 0, 'the badge to go');
    // The session goes on in the folder: pi's working directory is the project now.
    await selectThread(TITLE);
    await send('Use the bash tool to run exactly: pwd and tell me the output.');
    assert.equal((await api(`/api/threads/${id}/stats`)).cwd, project);
    assert.ok((await app.page.locator('pk-transcript').innerText()).includes(project));
    gitHere('checkout', '-q', '--', '.');
    rmSync(join(project, 'dirty.txt'), { force: true });
    gitHere('checkout', '-q', 'main');
  });

  it('moves a Local thread into a worktree, with the folder\'s changes', async () => {
    await selectThread('On develop');
    writeFileSync(join(project, 'moving.txt'), 'm\n');
    await threadMenu('On develop', /Move into a worktree/);
    await app.page.getByTestId('handoff-dialog').waitFor();
    await app.page.getByTestId('move-summary').waitFor();
    assert.equal(await app.page.getByTestId('move-carry').isChecked(), true);
    await app.page.getByTestId('do-handoff').click();
    await app.page.getByTestId('handoff-result').waitFor();
    await app.page.getByRole('button', { name: 'Done', exact: true }).click();
    const thread = await eventually(async () => (await threads()).find((t) => t.title === 'On develop' && t.worktree?.exists), 'the thread in its worktree');
    assert.equal(thread.worktree.base, 'main');
    assert.equal(readFileSync(join(thread.worktree.path, 'moving.txt'), 'utf8'), 'm\n');
    assert.ok(!existsSync(join(project, 'moving.txt')), 'the change left the folder');
    assert.match(gitHere('stash', 'list'), /pi-kit: moved to /);
    await rowOf('On develop').getByTestId('worktree-badge').waitFor();
    await selectThread('On develop');
    await send('Use the bash tool to run exactly: pwd and tell me the output.');
    assert.equal((await api(`/api/threads/${thread.id}/stats`)).cwd, thread.worktree.path);
  });
});

describe('setup scripts in a new worktree', () => {
  it('copies a script\'s files and runs its command in the new folder\'s terminal; the row offers the scripts', async () => {
    writeFileSync(join(project, '.gitignore'), '.env.local\n');
    writeFileSync(join(project, '.env.local'), 'SECRET=1\n');
    await call('PATCH', '/api/workspaces', {
      cwd: project,
      worktree: {
        setupScripts: [
          { id: 'node', name: 'Node', command: "printf 'node:%s\\n' ok", copy: ['.env.local'] },
          { id: 'docs', name: 'Docs', command: "printf 'docs:%s\\n' ok" },
        ],
      },
    });
    const made = await call('POST', '/api/threads', { cwd: project, worktree: { setup: 'node' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(readFileSync(join(made.body.worktree.path, '.env.local'), 'utf8'), 'SECRET=1\n');
    // Its command ran in the new folder's terminal: the stream has the output.
    const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 8000);
    let seen = '';
    try {
      const res = await fetch(`${env.api}/api/workspaces/${encodeURIComponent(made.body.worktree.path)}/terminal/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
      for await (const chunk of res.body) {
        seen += Buffer.from(chunk).toString('utf8');
        if (seen.includes('node:ok')) break;
      }
    } catch {
      // the stream was cut after eight seconds
    } finally {
      abort.abort();
    }
    assert.ok(seen.includes('node:ok'), `the script's command ran in the worktree's terminal: ${seen.slice(-300)}`);
    const none = await call('POST', '/api/threads', { cwd: project, worktree: { setup: null } });
    assert.ok(!existsSync(join(none.body.worktree.path, '.env.local')));
    const bad = await call('POST', '/api/threads', { cwd: project, worktree: { setup: 'gone' } });
    assert.equal(bad.status, 400);
    // The row lists them, the first being the default for a worktree and "none" for Local. A fresh page reads the project's settings that the calls above changed.
    await app.page.reload();
    await app.page.waitForSelector('pk-root .pk-shell');
    await head().waitFor();
    await newThread();
    assert.equal((await app.page.getByTestId('where-setup-button').innerText()).trim(), 'none');
    await app.page.getByTestId('where-worktree').click();
    await waitText('where-setup-button', 'Node');
    await app.page.getByTestId('where-setup-button').click();
    assert.match(await app.page.getByTestId('where-setup-menu').innerText(), /Node · default[\s\S]*Docs[\s\S]*none/);
    await app.page.getByTestId('where-setup-docs').click();
    await waitText('where-setup-button', 'Docs');
  });
});

/** Opens a thread of the project from its row. */
async function selectThread(title) {
  await rowOf(title).click();
  await rowOf(title).and(app.page.locator('[aria-current="true"]')).waitFor();
  await app.page.getByLabel('Message to pi').waitFor();
  await app.h.settle(800);
}
