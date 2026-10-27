// End to end: a worktree per thread and the coordination of agents that share a folder. Run with `pnpm run e2e`.
//
// The tests work in a repository of their own (`reporting-adapter`, written next to the scratch project) so merging a worktree back never meets what
// the other test files left uncommitted in the shared project. Worktrees go to PI_KIT_WORKTREE_ROOT, a folder of the scratch world; the GitHub CLI is off.
//   1. Two threads in one folder: a thread that is alone gets no "Other agents in this workspace"; once another works next to it, its next prompt carries the
//      section and, for a file the other one wrote after it read it, the notice, both visible in the Entries inspector; the Files panel shows the lease.
//   2. A worktree thread: created from the + menu, its branch in the crumbs and a badge in the sidebar, panels on the worktree's folder, `pi -c` there sees
//      the same session, Sync with base (clean, then conflicting and routed to review mode), Merge back with a merge commit on main and the worktree removed.
//   3. Archive asks what happens to the worktree; `/worktree new` and Settings › Projects.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { api, env, openApp } from './support/app.mjs';
import { commitFile, gitIn, writeWorktreeProject } from './support/worktree-world.mjs';

const NAME = 'reporting-adapter';
const PI_CLI = new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url).pathname;
let app;
let project;

const spawned = [];
/** The backend that an earlier file's restart test left running (or not): this file brings one up when none answers, as sidebar.e2e.mjs does. */
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

async function post(path, body) {
  const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${env.api}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body ?? {}) });
  return res.status === 204 ? undefined : res.json();
}

async function patch(path, body) {
  const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${env.api}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return res.status === 204 ? undefined : res.json();
}

before(async () => {
  await ensureBackend();
  app = await openApp();
  project = writeWorktreeProject({ base: join(env.project, '..'), name: NAME });
  await post('/api/workspaces', { cwd: project });
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
const byTitle = async (title) => (await threads()).find((t) => t.title === title);

/** Polls until `check` holds (the page answers at once, the backend a moment later). */
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

/** A new thread in the project through its own "+", named through the API so its row can be found (a thread with no message has no title). */
async function newThreadIn(title) {
  await head().hover();
  await app.page.getByRole('button', { name: `New thread in ${NAME}` }).click();
  await app.page.getByLabel('Message to pi').waitFor();
  await app.h.settle(500);
  const created = (await threads()).filter((t) => !t.title && t.messageCount === 0).sort((a, b) => b.createdAt - a.createdAt)[0];
  assert.ok(created, 'the new thread is listed');
  await patch(`/api/threads/${created.id}`, { title });
  await eventually(async () => (await group().locator('.pk-thread', { hasText: title }).count()) > 0, `the row of ${title}`);
  return created.id;
}

const sessionEntries = async (id) => {
  const { sessionPath } = await api(`/api/threads/${id}`);
  return readFileSync(sessionPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
};

/** The system messages of a session that carry the "other agents" section, and the notices put in front of the model. */
const coordination = async (id) => {
  const entries = await sessionEntries(id);
  return {
    sections: entries.filter((e) => e.type === 'message' && e.message?.role === 'system' && typeof e.message?.sections?.other_agents === 'string').map((e) => e.message.sections.other_agents),
    notices: entries.filter((e) => e.type === 'custom_message' && e.customType === 'pi-kit:coordination').map((e) => String(e.content)),
  };
};

/** Sends a prompt and waits until the run is over. The harness's own `prompt` finds the Stop button by name, which a running bash tool row has too. */
async function prompt(text, timeout = 240_000) {
  const box = app.page.getByLabel('Message to pi');
  await box.fill(text);
  await box.press('Enter');
  const stop = app.page.getByTestId('stop');
  await stop.waitFor({ timeout: 30_000 }).catch(() => undefined);
  await stop.waitFor({ state: 'detached', timeout });
  await app.h.settle(800);
}

/** Opens a thread of the project from its row and waits until it is the open one. */
async function selectThread(title) {
  await rowOf(title).click();
  await rowOf(title).and(app.page.locator('[aria-current="true"]')).waitFor();
  await app.page.getByLabel('Message to pi').waitFor();
  await app.h.settle(800);
}

const gitHere = (...args) => gitIn(project, ...args).trim();

/** The environment of the pi command line in these tests: the scratch agent folder and nothing of pi-kit's, never the user's own. */
const cliEnv = () => ({ ...process.env, PI_CODING_AGENT_DIR: env.agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' });

describe('two threads in one folder', () => {
  let fixId;
  let adapterId;

  it('gives a thread that is alone the prompt it always had: no "Other agents" section', async () => {
    adapterId = await newThreadIn('Reporting adapter');
    await prompt('Use the read tool to read src/map.ts, then say ok in one short sentence.');
    const { sections, notices } = await coordination(adapterId);
    assert.deepEqual(sections, []);
    assert.deepEqual(notices, []);
  });

  it('gives pi PI_KIT=1 and its thread id in the shell of the bash tool', async () => {
    await prompt('Use the bash tool to run exactly: echo "id=$PI_KIT_THREAD_ID kit=$PI_KIT" and tell me the output.');
    // Check what bash actually returned: the model can mistype a UUID when restating the output in prose.
    const result = (await sessionEntries(adapterId)).map((entry) => entry.message).findLast((message) => message?.role === 'toolResult' && message.toolName === 'bash');
    assert.ok(result, 'pi executed the bash tool');
    const output = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
    assert.equal(output, `id=${adapterId} kit=1`);
  });

  it('adds the section and the notice to the next prompt of a thread whose file another thread wrote', async () => {
    fixId = await newThreadIn('Fix e2e');
    await prompt('Use the write tool to overwrite src/map.ts with exactly this one line: export const mapped = true;\nThen say done in one short sentence.');
    assert.match(readFileSync(join(project, 'src', 'map.ts'), 'utf8'), /mapped = true/);
    // Fix e2e had a thread next to it (Reporting adapter, active a moment ago): its own prompt carries the section.
    const fix = await coordination(fixId);
    assert.ok(fix.sections.length >= 1, 'the writing thread was told about the other one');
    assert.match(fix.sections[0], /Other agents in this workspace/);
    assert.match(fix.sections[0], /"Reporting adapter"/);

    // Back in the thread that read map.ts before: its next prompt names the other agent, its edit, and the changed file.
    await selectThread('Reporting adapter');
    await prompt('Say hello in one short sentence.');
    const { sections, notices } = await coordination(adapterId);
    assert.equal(sections.length, 1, 'one section, in the system message of the later prompt');
    const section = sections[0];
    assert.match(section, /Other agents in this workspace/);
    assert.match(section, /"Fix e2e" \((running|idle), this same folder\): edited src\/map\.ts/);
    for (const rule of ['Do not edit a file another agent is editing without saying so first.', 'Prefer small, self-contained changes.', 'If a conflict is likely, say so in the answer instead of guessing.']) {
      assert.ok(section.includes(rule), rule);
    }
    assert.deepEqual(notices, ['*Fix e2e* changed `src/map.ts` since you last read it.']);
  });

  it('shows both in the Entries inspector', async () => {
    await app.h.openPanel('Tree');
    await app.page.getByRole('button', { name: 'Entries', exact: true }).click();
    const lines = app.page.getByTestId('entry-line');
    await lines.first().waitFor();
    const section = lines.filter({ hasText: 'Other agents in this workspace' });
    await section.first().waitFor();
    assert.match(await section.first().getAttribute('title'), /Fix e2e/);
    const notice = lines.filter({ hasText: 'changed `src/map.ts` since you last read it' });
    await notice.first().waitFor();
    assert.match(await notice.first().innerText(), /custom_message/);
    await app.h.closePanel();
  });

  it('says the same notice only once', async () => {
    await prompt('Say hello once more in one short sentence.');
    assert.equal((await coordination(adapterId)).notices.length, 1);
  });

  it('puts "being edited by" on the file in the Files panel of the other thread, and lists who is working here', async () => {
    // The file is Reporting adapter's own too, but the lease is Fix e2e's: this thread sees it as another thread's. Fix e2e wrote it a moment ago.
    await app.h.openPanel('Files');
    await app.page.locator('.pk-node', { hasText: 'src' }).first().click();
    const chip = app.page.locator('.pk-node', { hasText: 'map.ts' }).getByTestId('lease-chip');
    await chip.waitFor();
    assert.match(await chip.innerText(), /being edited by\s+Fix e2e/);
    assert.match(await app.page.getByTestId('others').innerText(), /Fix e2e/);
    // The leases are the backend's: the same thing over the API.
    const state = await api(`/api/threads/${adapterId}/coordination`);
    assert.deepEqual(state.leases.map((l) => [l.path, l.title]), [['src/map.ts', 'Fix e2e']]);
    await app.h.closePanel();
  });

  it('lists a pi started in a terminal in the same folder, without details', async () => {
    // What the pi command line writes: a session file in the project folder, changed just now.
    const out = spawnSync('node', [PI_CLI, '--no-extensions', '--no-skills', '--no-prompt-templates', '-p', 'Reply with the single word hi.'], {
      cwd: project,
      env: cliEnv(),
      encoding: 'utf8',
      
    });
    assert.equal(out.status, 0, out.stderr);
    const terminal = await eventually(async () => {
      const state = await api(`/api/threads/${adapterId}/coordination`);
      return state.others.find((o) => o.state === 'terminal');
    }, 'the terminal session among the other agents', 30_000);
    assert.equal(terminal.relation, 'same-folder');
    // And in the prompt: a line without file details.
    await prompt('Say hello a third time in one short sentence.');
    const { sections } = await coordination(adapterId);
    assert.match(sections.at(-1), /pi in a terminal, this same folder.*no file details/);
  });
});

describe('a thread in a worktree', () => {
  let id;
  let path;
  let branch;
  const WT_TITLE = 'Worktree thread';

  before(() => {
    // The first describe left src/map.ts overwritten and uncommitted in the main checkout; a merge back needs it clean (that is what the dialog says otherwise).
    gitIn(project, 'add', '-A');
    gitIn(project, 'commit', '-q', '-m', 'Keep what the other threads wrote');
  });

  const menuOf = (title) => rowOf(title).locator('details').first();
  async function threadMenu(title, item) {
    await rowOf(title).hover();
    await menuOf(title).locator('summary').click();
    // The row's own quick actions carry the same names, so the item is taken from the row's menu, never page-wide.
    await menuOf(title).getByRole('button', { name: item }).first().click();
  }

  /**
   * A thread in a new worktree from the + menu: the page opens with the row showing Worktree and nothing made yet; the first message makes the worktree,
   * named after it, and starts the thread there.
   */
  async function worktreeFromMenu(message) {
    const before = new Set((await threads()).map((t) => t.id));
    await app.page.getByTestId('new-thread-menu').click();
    await app.page.getByTestId('new-in-worktree').click();
    await app.page.getByTestId('where-row').waitFor();
    assert.equal(await app.page.getByTestId('where-worktree').getAttribute('aria-checked'), 'true', 'the row shows Worktree');
    const draft = (await threads()).find((t) => !before.has(t.id));
    assert.ok(draft && !draft.worktree, 'the empty thread has no worktree before the first message');
    await prompt(message);
    return eventually(async () => (await threads()).find((t) => t.id === draft.id && t.worktree?.exists), 'the thread in its worktree');
  }

  it('is made from the + menu: its own branch and folder under the worktree root, named from the first message, in the sidebar and in the crumbs', async () => {
    const created = await worktreeFromMenu('Say ok in one short sentence.');
    assert.ok(created, 'a thread with a worktree was created in the project');
    id = created.id;
    path = created.worktree.path;
    branch = created.worktree.branch;
    await patch(`/api/threads/${id}`, { title: WT_TITLE });
    assert.ok(path.startsWith(env.server.PI_KIT_WORKTREE_ROOT), `${path} is under the worktree root`);
    assert.equal(path.split('/').at(-2), NAME);
    assert.match(branch, /^pi-kit\/say-ok-in-one-short-sentence/);
    assert.equal(created.worktree.base, 'main');
    assert.equal(gitHere('rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the main checkout is untouched');
    assert.equal(gitIn(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), branch);
    assert.equal(created.cwd, project, 'the thread stays listed under its project');
    // The crumbs carry the branch; the row carries the badge.
    assert.equal((await app.page.getByTestId('branch-crumb').innerText()).trim(), branch);
    await eventually(async () => (await rowOf(WT_TITLE).count()) > 0, 'the row');
    await rowOf(WT_TITLE).getByTestId('worktree-badge').waitFor();
  });

  it('runs pi in the worktree and binds the Files and Changes panels to it', async () => {
    await prompt('Use the write tool to create docs/wt.md containing exactly: # From the worktree\nThen say done in one short sentence.');
    assert.ok(existsSync(join(path, 'docs', 'wt.md')), 'the file is in the worktree');
    assert.ok(!existsSync(join(project, 'docs', 'wt.md')), 'and not in the main checkout');
    const stats = await api(`/api/threads/${id}/stats`);
    assert.equal(stats.cwd, path);
    // Files shows the worktree's tree with its own change; Changes lists the file this thread wrote.
    await app.h.openPanel('Files');
    await app.page.locator('.pk-node', { hasText: 'docs' }).first().waitFor();
    await app.h.openPanel('Changes');
    await app.page.locator('pk-changes-panel').getByText('wt.md').waitFor();
    await app.h.closePanel();
  });

  it('is found again by `pi -c` in the worktree folder: the same session, continued', async () => {
    const before = await api(`/api/threads/${id}`);
    const out = spawnSync('node', [PI_CLI, '-c', '--no-extensions', '--no-skills', '--no-prompt-templates', '-p', 'Reply with the single word pong.'], {
      cwd: path,
      env: cliEnv(),
      encoding: 'utf8',
      
    });
    assert.equal(out.status, 0, out.stderr);
    // The CLI appended to the thread's own session file, so the app's thread has the new messages and no second thread appeared.
    const entries = await sessionEntries(id);
    const users = entries.filter((e) => e.type === 'message' && e.message.role === 'user').map((e) => JSON.stringify(e.message.content));
    assert.ok(users.some((u) => u.includes('single word pong')), 'the CLI prompt is in the thread session');
    const after = await eventually(async () => {
      const t = await api(`/api/threads/${id}`);
      return t.messageCount > before.messageCount ? t : undefined;
    }, 'the app to see the CLI messages', 30_000);
    assert.equal(after.sessionPath, before.sessionPath);
    assert.equal((await threads()).filter((t) => t.worktree?.path === path).length, 1, 'no second thread for the same worktree');
  });

  it('syncs with the base: behind by one commit, then brought in with a merge', async () => {
    commitFile(project, 'src/other.ts', 'export const other = 1;\n', 'main moves on');
    await threadMenu(WT_TITLE, /Sync with main/);
    const dialog = app.page.getByTestId('sync-dialog');
    await dialog.waitFor();
    await app.page.getByTestId('worktree-counts').waitFor();
    assert.match(await app.page.getByTestId('worktree-counts').innerText(), /1 commit behind main/);
    assert.match(await app.page.getByTestId('worktree-branch').innerText(), /pi-kit\/say-ok-in-one-short-sentence/);
    await app.page.getByTestId('do-sync').click();
    await app.page.getByTestId('sync-result').waitFor();
    assert.ok(existsSync(join(path, 'src', 'other.ts')), 'main\'s commit is in the worktree');
    assert.match(await app.page.getByTestId('sync-result').innerText(), /main is in/);
    await app.page.getByRole('button', { name: 'Done', exact: true }).click();
  });

  it('merges back: a merge commit on main with the edited message, and the worktree is removed', async () => {
    await threadMenu(WT_TITLE, /Merge back/);
    await app.page.getByTestId('merge-dialog').waitFor();
    const message = app.page.getByTestId('commit-message');
    await message.waitFor();
    // The proposal is fetched after the dialog opens; under load it lands a moment after the field does.
    await app.page.waitForFunction(() => (document.querySelector('[data-testid="commit-message"]')?.value ?? '').includes('wt.md'), undefined).catch(() => undefined);
    assert.ok((await message.inputValue()).includes('wt.md'), 'the proposed message names the changed file');
    await message.fill('Document the worktree\n\nWritten by pi in its own worktree.');
    assert.ok(await app.page.getByTestId('remove-after').isChecked(), 'removing the worktree is offered, on');
    await app.page.getByTestId('do-merge').click();
    await app.page.getByTestId('merge-result').waitFor();
    // A merge commit on main: two parents, the thread's commit among its ancestors, the file in the tree.
    assert.equal(gitHere('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    assert.equal(gitHere('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'a merge commit has two parents');
    assert.equal(gitHere('log', '-1', '--format=%s'), `Merge ${branch} into main`);
    assert.ok(gitHere('log', '--format=%s', 'main').split('\n').includes('Document the worktree'), 'the edited commit message is on main');
    assert.equal(gitHere('show', 'main:docs/wt.md'), '# From the worktree');
    // The worktree folder and its branch are gone; the thread carries on in the project, without a badge.
    assert.ok(!existsSync(path), 'the worktree folder is removed');
    assert.equal(gitHere('branch', '--list', branch), '');
    await app.page.getByRole('button', { name: 'Done', exact: true }).click();
    await eventually(async () => (await rowOf(WT_TITLE).getByTestId('worktree-badge').count()) === 0, 'the badge to go');
    const thread = await byTitle(WT_TITLE);
    assert.equal(thread.worktree.exists, false);
    assert.equal(thread.cwd, project);
  });

  it('opens conflicts in review mode when the sync stops on them, and merges back once they are resolved', async () => {
    const created = await worktreeFromMenu('Say hello in one short sentence.');
    const title = 'Conflicting thread';
    await patch(`/api/threads/${created.id}`, { title });
    await eventually(async () => (await rowOf(title).count()) > 0, 'the row');
    const wt = created.worktree.path;
    // The person (or a pi in a terminal) edits README.md in the worktree and commits it; main edits the same line.
    writeFileSync(join(wt, 'README.md'), '# reporting-adapter\n\nFrom the worktree.\n');
    gitIn(wt, 'add', '-A');
    gitIn(wt, 'commit', '-q', '-m', 'worktree readme');
    commitFile(project, 'README.md', '# reporting-adapter\n\nFrom main.\n', 'main readme');
    await threadMenu(title, /Sync with main/);
    await app.page.getByTestId('sync-dialog').waitFor();
    await app.page.getByTestId('do-sync').click();
    const conflicts = app.page.getByTestId('conflicts');
    await conflicts.waitFor();
    assert.match(await conflicts.innerText(), /1 file has conflicts/);
    assert.match(await conflicts.innerText(), /README\.md/);
    assert.match(readFileSync(join(wt, 'README.md'), 'utf8'), /<<<<<<</);
    // Review mode lists the file as a conflict, with its markers in the diff.
    await app.page.getByTestId('review-conflicts').click();
    await app.page.getByTestId('review-conflict').waitFor();
    assert.ok((await app.page.locator('pk-review-view .pk-diff').innerText()).includes('<<<<<<<'));
    await app.h.openPanel('Changes');
    await app.page.getByTestId('conflict-badge').first().waitFor();
    await app.page.getByRole('button', { name: /Chat/ }).first().click();
    // Resolved by hand; Merge back finishes the merge in the worktree and merges into main.
    writeFileSync(join(wt, 'README.md'), '# reporting-adapter\n\nFrom main and the worktree.\n');
    await threadMenu(title, /Merge back/);
    await app.page.getByTestId('merge-dialog').waitFor();
    await app.page.getByTestId('commit-message').waitFor();
    await app.page.getByTestId('remove-after').uncheck();
    await app.page.getByTestId('do-merge').click();
    await app.page.getByTestId('merge-result').waitFor();
    assert.equal(gitHere('show', 'main:README.md'), '# reporting-adapter\n\nFrom main and the worktree.');
    assert.ok(existsSync(wt), 'the worktree stays when removal is switched off');
    await app.page.getByRole('button', { name: 'Done', exact: true }).click();
    // Keep it for the next test, which archives the thread with its worktree.
    assert.ok((await byTitle(title)).worktree.exists);
  });

  it('asks what happens to the worktree when the thread is archived', async () => {
    const title = 'Conflicting thread';
    const thread = await byTitle(title);
    await rowOf(title).hover();
    await menuOf(title).locator('summary').click();
    await menuOf(title).getByRole('button', { name: 'Archive' }).first().click();
    await app.page.getByTestId('archive-dialog').waitFor();
    assert.ok(await app.page.getByTestId('keep-worktree').getAttribute('aria-pressed').then((v) => v === 'true'), 'keep is the default');
    await app.page.getByTestId('remove-worktree').click();
    await app.page.getByTestId('confirm-archive').click();
    await eventually(async () => !existsSync(thread.worktree.path), 'the worktree folder to be removed');
    const archived = (await api('/api/threads?archived=1')).find((t) => t.id === thread.id);
    assert.equal(archived.archived, true);
    // The branch stays: removing the folder is not discarding the work.
    assert.match(gitHere('branch', '--list', thread.worktree.branch), new RegExp(thread.worktree.branch));
  });

  it('inherits the trust of the main checkout: the project extension loads in a worktree of the trusted scratch project', async () => {
    // The shared scratch project is trusted by path (PI_KIT_TRUSTED_CWDS) and has the test extension in `.pi/extensions`; its worktree is a folder elsewhere with the same resources.
    const made = await post('/api/threads', { cwd: env.project, worktree: {} });
    assert.ok(made.worktree?.exists, JSON.stringify(made));
    assert.ok(existsSync(join(made.worktree.path, '.pi', 'extensions', 'pk-hitl.ts')), 'the worktree has the project extension');
    const commands = await api(`/api/threads/${made.id}/commands`);
    assert.ok(commands.some((c) => c.name === 'hitl-confirm'), 'the project extension loaded in the worktree, so its trust was inherited');
    const res = await fetch(`${env.api}/api/threads/${made.id}?worktree=force`, { method: 'DELETE', headers: { Authorization: `Bearer ${(await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json()).token}` } });
    assert.equal(res.status, 204);
    assert.ok(!existsSync(made.worktree.path), 'deleting with the worktree removed its folder');
  });

  it('starts one with /worktree new, and Settings › Projects holds the per-project worktree settings', async () => {
    await selectThread(WT_TITLE);
    const box = app.page.getByLabel('Message to pi');
    await box.fill('/worktree new');
    await box.press('Enter');
    const made = await eventually(async () => (await threads()).find((t) => t.worktree?.exists && !t.title), 'the thread from /worktree new', 60_000);
    assert.ok(made.worktree.path.startsWith(env.server.PI_KIT_WORKTREE_ROOT));
    const dialog = await app.h.openSettings('Projects');
    // The project's own page holds them: the folder, and the setup scripts, of which the first is the command typed into a new worktree's terminal.
    await dialog.getByTestId(`project-${NAME}`).click();
    await dialog.getByTestId('project-root').waitFor();
    const SETUP = "printf 'setup:%s\\n' ok";
    await dialog.getByTestId('add-script').click();
    await dialog.getByTestId('script-name').fill('Printf');
    await dialog.getByTestId('script-command').fill(SETUP);
    await dialog.getByTestId('script-save').click();
    await eventually(async () => (await api('/api/workspaces')).find((w) => w.name === NAME)?.worktree?.setup === SETUP, 'the setup command to be saved');
    const settings = (await api('/api/workspaces')).find((w) => w.name === NAME).worktree;
    assert.equal(settings.git, true);
    assert.equal(settings.defaultRoot, env.server.PI_KIT_WORKTREE_ROOT);
    await app.page.keyboard.press('Escape');
    // A new worktree runs the setup command in its own folder's terminal: the Terminal panel's stream has its output.
    const withSetup = await post('/api/threads', { cwd: project, worktree: {} });
    assert.ok(withSetup.worktree?.exists, JSON.stringify(withSetup));
    const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 8000);
    let seen = '';
    try {
      const res = await fetch(`${env.api}/api/workspaces/${encodeURIComponent(withSetup.worktree.path)}/terminal/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
      for await (const chunk of res.body) {
        seen += Buffer.from(chunk).toString('utf8');
        if (seen.includes('setup:ok')) break;
      }
    } catch {
      // the stream was cut after eight seconds
    } finally {
      abort.abort();
    }
    assert.ok(seen.includes('setup:ok'), `the setup command ran in the worktree's terminal: ${seen.slice(-300)}`);
    await patch(`/api/workspaces`, { cwd: project, worktree: { setup: null } });
  });
});
