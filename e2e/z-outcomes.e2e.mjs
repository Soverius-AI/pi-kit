// End to end: how a thread ends. Run with `pnpm run e2e -- --file z-outcomes`.
//
// The file's name sorts it last, after worktrees.e2e.mjs, on purpose: it adds a project (a repository of its own) and threads that are newer than every other
// thread, and the files before it assume the world they made (the sidebar test lists exactly its two projects and the order of /api/workspaces; the skills and
// dialog tests take the newest thread of all). The backend an earlier file's restart test left running (or not) is brought up here when none answers.
//
// A repository of its own (`outcomes-app`, written next to the scratch project) so what the other files leave uncommitted never reaches these threads.
//   1. A thread without an outcome has no badge and a disabled Outcome toggle.
//   2. A thread edits a file; a commit made in the Terminal panel contains it: the `committed` badge appears within the watcher's debounce, the Outcome toggle
//      shows the diff, the badge's menu opens review mode on it, and a second commit in the terminal extends the outcome.
//   3. A thread in a worktree writes a file and merges back: `merged` with the merge commit, and the Outcome diff the API serves is `git diff base..head`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { api, env, openApp } from './support/app.mjs';
import { gitIn, writeWorktreeProject } from './support/worktree-world.mjs';

const NAME = 'outcomes-app';
let app;
let project;

async function call(method, path, body) {
  const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${env.api}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
}

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

before(async () => {
  await ensureBackend();
  app = await openApp();
  project = writeWorktreeProject({ base: join(env.project, '..'), name: NAME });
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
const git = (...args) => gitIn(project, ...args).trim();

async function eventually(check, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  let value;
  do {
    value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 150));
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${what}`);
}

/** A new thread in the project through its own "+", named through the API so its row can be found. */
async function newThread(title) {
  await head().hover();
  await app.page.getByRole('button', { name: `New thread in ${NAME}` }).click();
  await app.page.getByLabel('Message to pi').waitFor();
  await app.h.settle(500);
  const created = (await threads()).filter((t) => !t.title && t.messageCount === 0).sort((a, b) => b.createdAt - a.createdAt)[0];
  assert.ok(created, 'the new thread is listed');
  await call('PATCH', `/api/threads/${created.id}`, { title });
  await eventually(async () => (await group().locator('.pk-thread', { hasText: title }).count()) > 0, `the row of ${title}`);
  return created.id;
}

async function prompt(text, timeout = 240_000) {
  const box = app.page.getByLabel('Message to pi');
  await box.fill(text);
  await box.press('Enter');
  const stop = app.page.getByTestId('stop');
  await stop.waitFor({ timeout: 30_000 }).catch(() => undefined);
  await stop.waitFor({ state: 'detached', timeout });
  await app.h.settle(800);
}

const outcomeOf = async (id) => (await call('GET', `/api/threads/${id}/outcome`));
const badge = (title) => rowOf(title).getByTestId('outcome-badge');

/** What the Outcome source serves, next to what git itself says for the same two commits. */
async function assertOutcomeDiffIsGits(id, folder) {
  const outcome = (await outcomeOf(id)).body;
  const served = (await call('GET', `/api/threads/${id}/changes?source=outcome`)).body;
  const numstat = gitIn(folder, 'diff', '--numstat', '--no-renames', `${outcome.base}..${outcome.head}`)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .map(([added, removed, path]) => ({ path, added: Number(added), removed: Number(removed) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(
    served.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed })),
    numstat,
    'the Outcome file list is git diff --numstat base..head',
  );
  for (const file of served.files) {
    const model = (await call('GET', `/api/threads/${id}/changes/${encodeURIComponent(file.path)}?source=outcome`)).body;
    const patch = gitIn(folder, 'diff', '--no-renames', '-U3', `${outcome.base}..${outcome.head}`, '--', file.path);
    const changed = patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
    const modelled = model.hunks.flatMap((h) => h.lines).filter((l) => l.kind === 'add' || l.kind === 'del').map((l) => `${l.kind === 'add' ? '+' : '-'}${l.text}`);
    assert.deepEqual(modelled, changed, `the diff of ${file.path} is git's`);
  }
  return { outcome, served };
}

describe('a thread without an outcome', () => {
  it('has no badge, no outcome, and a disabled Outcome toggle', async () => {
    const id = await newThread('Plain thread');
    assert.equal(await badge('Plain thread').count(), 0);
    assert.equal((await outcomeOf(id)).status, 404);
    assert.equal((await api(`/api/threads/${id}`)).state.outcome, null);
    await app.h.openPanel('Changes');
    const toggle = app.page.getByTestId('source-outcome');
    await toggle.waitFor();
    assert.equal(await toggle.isDisabled(), true);
    assert.match(await toggle.getAttribute('title'), /no outcome yet/);
    await app.h.closePanel();
  });
});

describe('a commit made in the folder', () => {
  const TITLE = 'Map the rows';
  let id;
  let base;

  it('is the thread\'s outcome when it contains a file the thread changed: the badge appears and the Outcome toggle shows the diff', async () => {
    base = git('rev-parse', 'HEAD');
    id = await newThread(TITLE);
    assert.equal((await api(`/api/threads/${id}`)).state.outcome, null);
    await prompt('Use the write tool to overwrite src/map.ts with exactly this one line: export const mapped = true;\nThen say done in one short sentence.');
    assert.match(gitIn(project, 'status', '--porcelain'), /src\/map\.ts/, 'pi changed the file in the folder');
    assert.equal(await badge(TITLE).count(), 0, 'an uncommitted change is no outcome');

    // The person commits in the Terminal panel.
    await app.h.openPanel('Terminal');
    const term = app.page.locator('.pk-term');
    await term.waitFor();
    await app.h.settle(1500);
    await term.click();
    await app.page.keyboard.type("git add -A && git -c user.name=e2e -c user.email=e2e@example.com commit -q -m 'Map rows to the dashboard shape'");
    await app.page.keyboard.press('Enter');
    await eventually(() => git('log', '-1', '--format=%s') === 'Map rows to the dashboard shape', 'the commit to be made in the terminal', 30_000);
    const commit = git('rev-parse', 'HEAD');
    await app.h.closePanel();

    // The watcher debounces by 300 ms; the badge follows the pushed state.
    await badge(TITLE).waitFor();
    assert.equal(await badge(TITLE).getAttribute('data-kind'), 'committed');
    assert.match(await badge(TITLE).getAttribute('title'), new RegExp(`^Committed as ${commit.slice(0, 7)}, (just now|1 min ago)$`));
    const outcome = (await outcomeOf(id)).body;
    assert.equal(outcome.kind, 'committed');
    assert.equal(outcome.head, commit);
    assert.equal(outcome.base, base, 'the base is HEAD as it was when the thread started');
    assert.equal(outcome.baseSource, 'start');
    assert.ok(outcome.files.includes('src/map.ts'));
    assert.equal((await api(`/api/threads/${id}`)).state.outcome.head, commit);
  });

  it('serves the Outcome diff of the commit, and the toggle and the badge menu open it in review mode', async () => {
    const { outcome } = await assertOutcomeDiffIsGits(id, project);
    assert.equal(outcome.base, base);
    await app.h.openPanel('Changes');
    const toggle = app.page.getByTestId('source-outcome');
    await eventually(async () => !(await toggle.isDisabled()), 'the Outcome toggle to be enabled');
    await toggle.click();
    await app.page.locator('pk-changes-panel a.pk-file', { hasText: 'map.ts' }).waitFor();
    await app.h.closePanel();

    // The badge's menu: "Show the outcome" opens review mode on the Outcome source.
    await badge(TITLE).click();
    const menu = app.page.getByRole('menu', { name: 'Outcome' });
    await menu.waitFor();
    // 10b adds "Learn a skill from this thread" after the built-in item (OutcomeMenuStore.extend), 10e "Score this thread".
    assert.deepEqual(await menu.getByRole('menuitem').allInnerTexts(), ['Show the outcome', 'Learn a skill from this thread', 'Score this thread']);
    await menu.getByRole('menuitem', { name: 'Show the outcome' }).click();
    await app.page.locator('pk-review-view').waitFor();
    const diff = app.page.locator('pk-review-view .pk-diff');
    await diff.waitFor();
    assert.ok((await diff.innerText()).includes('mapped = true'), 'the diff is the committed change');
    // The source is the diff's subtitle under the file name (the toolbar keeps it only as the progress title).
    await app.page.locator('pk-review-view').getByText(/in the outcome, committed as/).first().waitFor();
    await app.page.getByRole('button', { name: /Chat/ }).first().click();
  });

  it('is extended by a later commit that contains the same file', async () => {
    const before = (await outcomeOf(id)).body;
    await app.h.openPanel('Terminal');
    await app.page.locator('.pk-term').click();
    await app.page.keyboard.type("echo 'export const second = 2;' >> src/map.ts && git add -A && git -c user.name=e2e -c user.email=e2e@example.com commit -q -m 'Second change'");
    await app.page.keyboard.press('Enter');
    await eventually(() => git('log', '-1', '--format=%s') === 'Second change', 'the second commit', 30_000);
    const second = git('rev-parse', 'HEAD');
    await app.h.closePanel();
    const after = await eventually(async () => {
      const o = (await outcomeOf(id)).body;
      return o.head === second ? o : undefined;
    }, 'the outcome to move to the second commit', 15_000);
    assert.equal(after.kind, 'committed');
    assert.equal(after.base, before.base, 'the base stays where the first commit put it');
    assert.ok(after.files.includes('src/map.ts'));
    await assertOutcomeDiffIsGits(id, project);
  });
});

describe('a worktree merged back', () => {
  const TITLE = 'Worktree outcome';
  let id;
  let worktree;

  it('merges back into main: `merged`, the merge commit, and the Outcome diff is git\'s base..head', async () => {
    // The page opens with the row showing Worktree; the first message makes the worktree and starts the thread in it.
    const before = new Set((await threads()).map((t) => t.id));
    await app.page.getByTestId('new-thread-menu').click();
    await app.page.getByTestId('new-in-worktree').click();
    await app.page.getByTestId('where-row').waitFor();
    const draft = (await threads()).find((t) => !before.has(t.id));
    await prompt('Use the write tool to create docs/outcome.md containing exactly: # Outcome\nThen say done in one short sentence.');
    const created = await eventually(async () => (await threads()).find((t) => t.id === draft.id && t.worktree?.exists), 'the worktree thread');
    id = created.id;
    worktree = created.worktree.path;
    await call('PATCH', `/api/threads/${id}`, { title: TITLE });
    await eventually(async () => (await rowOf(TITLE).count()) > 0, 'the row');
    const startedAt = gitIn(worktree, 'rev-parse', 'HEAD').trim();
    assert.equal(startedAt, git('rev-parse', 'main'), 'a worktree starts at the tip of its base branch');
    assert.equal(await badge(TITLE).count(), 0);

    const merged = await call('POST', `/api/threads/${id}/worktree/merge`, { mode: 'merge', message: 'Document the outcome', remove: true });
    assert.equal(merged.body.status, 'merged', JSON.stringify(merged.body));
    const mergeCommit = git('rev-parse', 'HEAD');
    assert.match(merged.body.commit, /^[0-9a-f]+$/);
    assert.ok(mergeCommit.startsWith(merged.body.commit));

    await badge(TITLE).waitFor();
    assert.equal(await badge(TITLE).getAttribute('data-kind'), 'merged');
    assert.match(await badge(TITLE).getAttribute('title'), new RegExp(`^Merged into main as ${mergeCommit.slice(0, 7)}, (just now|1 min ago)$`));
    const { outcome, served } = await assertOutcomeDiffIsGits(id, project);
    assert.equal(outcome.kind, 'merged');
    assert.equal(outcome.head, mergeCommit);
    assert.equal(outcome.merge, mergeCommit);
    assert.equal(outcome.base, git('rev-parse', `${mergeCommit}^1`), 'the base is the tip the merge landed on');
    assert.equal(outcome.base, startedAt, 'which is where the thread started');
    assert.equal(outcome.baseBranch, 'main');
    assert.deepEqual(served.files.map((f) => f.path), ['docs/outcome.md']);
    assert.equal(git('show', 'main:docs/outcome.md'), '# Outcome');
  });

  it('still shows the Outcome once the worktree is gone: the commits are on the project\'s branch', async () => {
    const thread = await api(`/api/threads/${id}`);
    assert.equal(thread.worktree.exists, false);
    await rowOf(TITLE).click();
    await app.page.getByLabel('Message to pi').waitFor();
    await app.h.openPanel('Changes');
    const toggle = app.page.getByTestId('source-outcome');
    await eventually(async () => !(await toggle.isDisabled()), 'the toggle');
    await toggle.click();
    await app.page.locator('pk-changes-panel a.pk-file', { hasText: 'outcome.md' }).waitFor();
    await app.h.closePanel();
  });

  it('is not turned into a terminal commit by the watcher seeing the merge in the main checkout', async () => {
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal((await outcomeOf(id)).body.kind, 'merged');
  });
});
