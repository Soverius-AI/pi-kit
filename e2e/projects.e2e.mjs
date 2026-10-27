// End to end: Settings › Projects. Run with `pnpm run e2e --file projects`.
//
// The tests work in repositories of their own (`page-demo` on `main` with a `develop` branch, and a throwaway one to forget), written next to the scratch project, so what they
// change never reaches the other files. Thread titles never say "Settings": the harness finds the Settings button by that word.
//   1. The list: a row per project with its chips and counts, the defaults for every project, the "+" that adds a folder (a path is typed in a browser), drag and Alt+arrow to order.
//   2. A project's page: it slides in, Back and Esc return; Start, the prefix and the others save only what changed; hidden and shown; Trust and Review resources.
//   3. The setup scripts: the one the lockfile suggests, add, edit, make default, remove, saved whole.
//   4. Open worktrees: a thread in a worktree is a row with its branch, state and commits ahead; Hand off to local from the row; Merge back and Remove folder.
//   5. Forget: the project leaves the list and the sidebar, its folder is untouched, and adding it again brings it back.
//   6. The alignment rule: on every section the controls of a row share the column (the same left edge), and none has a width of its own.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { api, env, openApp } from './support/app.mjs';
import { commitFile, gitIn, writeWorktreeProject } from './support/worktree-world.mjs';

const NAME = 'page-demo';
const SPARE = 'spare-folder';
let app;
let project;
let spare;
const spawned = [];
const patches = [];

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

const workspace = async (name = NAME) => (await api('/api/workspaces')).find((w) => w.name === name);
const workspaceNames = async () => (await api('/api/workspaces')).map((w) => w.name);

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

before(async () => {
  await ensureBackend();
  app = await openApp();
  project = writeWorktreeProject({ base: join(env.project, '..'), name: NAME });
  gitIn(project, 'branch', 'develop');
  mkdirSync(join(project, '.pi', 'skills', 'release'), { recursive: true });
  writeFileSync(join(project, '.pi', 'skills', 'release', 'SKILL.md'), '---\nname: release\ndescription: Cut a release.\n---\nRun the release script.\n');
  // committed, so the folder is clean: a hand off needs that
  gitIn(project, 'add', '-A');
  gitIn(project, 'commit', '-q', '-m', 'A skill of its own');
  spare = join(env.project, '..', SPARE);
  mkdirSync(spare, { recursive: true });
  writeFileSync(join(spare, 'notes.md'), '# notes\n');
  await call('POST', '/api/workspaces', { cwd: project });
  await call('POST', '/api/workspaces', { cwd: spare });
  await app.page.reload();
  await app.page.waitForSelector('pk-root .pk-shell');
  await app.page.locator(`.pk-project[data-project="${NAME}"]`).waitFor();
  app.page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith('/api/workspaces')) patches.push(request.postDataJSON());
  });
});
after(async () => {
  // The projects of this file are forgotten again, so the files that count the known folders (sidebar.e2e.mjs) see the ones they expect.
  for (const cwd of [project, spare]) if (cwd) await call('DELETE', `/api/workspaces/${encodeURIComponent(cwd)}`).catch(() => undefined);
  await app?.close();
  for (const pid of spawned) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone already
    }
  }
});

const dialog = () => app.page.getByRole('dialog', { name: 'Settings' });
const row = (name = NAME) => dialog().getByTestId(`project-${name}`);
const page = () => dialog().getByTestId('project-page');

async function openProjects() {
  if ((await dialog().count()) === 0) await app.h.openSettings();
  // The tab of the section that is open leads back to its list from a project's page, so it is pressed only when another section is showing.
  if ((await dialog().getByTestId('section-projects').count()) === 0) await dialog().getByRole('tab', { name: 'Projects' }).click();
  await dialog().getByTestId('section-projects').waitFor();
  if ((await page().count()) > 0) await page().getByTestId('project-back').click();
  await dialog().getByTestId('section-projects').getByRole('tab', { name: 'Folders', exact: true }).click();
  await dialog().getByTestId('projects-list').waitFor();
}

async function openPage(name = NAME) {
  await openProjects();
  await row(name).click();
  await page().waitFor();
}

async function close() {
  for (let i = 0; i < 3 && (await dialog().count()) > 0; i++) {
    await app.page.keyboard.press('Escape');
    await app.h.settle(250);
  }
}

const facts = async (name = NAME) => (await row(name).locator('.ds').innerText()).replace(/\s+/g, ' ');
const chips = async (name = NAME) => {
  await row(name).waitFor();
  return (await row(name).locator('.nm .chip').allInnerTexts()).map((t) => t.trim());
};
/** The row's detail line, waited for until it says what is wanted (the list is drawn from the projects the store has read again). */
const factsMatch = (pattern, what) => eventually(async () => pattern.test(await facts().catch(() => '')), what);

describe('the list', () => {
  it('has a row for every project with its chips, path and counts, and the nav says how many', async () => {
    await openProjects();
    const names = await workspaceNames();
    assert.ok(names.includes(NAME) && names.includes(SPARE));
    await eventually(async () => (await chips()).includes('waiting'), 'the trust chip to be read');
    assert.deepEqual(await chips(), ['waiting', 'main']);
    assert.match(await facts(), /page-demo · 0 threads · no worktrees · starts in the folder · 1 project resource not loaded$/);
    assert.deepEqual(await chips(SPARE), ['nothing to trust', 'not git']);
    assert.match(await facts(SPARE), /^\S*spare-folder · 0 threads$/);
    assert.match(await dialog().getByRole('tab', { name: 'Projects' }).innerText(), new RegExp(`${names.length}$`));
    assert.equal(await dialog().getByTestId('projects-list').locator('header h4').innerText(), 'Projects');
  });

  it('the defaults for every project are in the control column, and a project that says nothing follows them', async () => {
    await openProjects();
    await dialog().getByTestId('section-projects').getByRole('tab', { name: 'Defaults', exact: true }).click();
    const defaults = dialog().getByTestId('project-defaults');
    assert.equal(await defaults.locator('header h4').innerText(), 'Defaults for every project');
    await defaults.getByTestId('default-start').selectOption('worktree');
    await eventually(async () => (await call('GET', '/api/workspaces/defaults')).body.start === 'worktree', 'the default start to be saved');
    await factsMatch(/starts in a worktree/, 'the row to follow the default start');
    // a worktree folder of its own for every project: new worktrees go there, the placeholder of a project's folder says so
    const root = join(env.project, '..', 'all-worktrees');
    await defaults.getByTestId('default-worktree-root').fill(root);
    await defaults.getByTestId('default-worktree-root').blur();
    await eventually(async () => (await call('GET', '/api/workspaces/defaults')).body.root === root, 'the default folder to be saved');
    assert.equal((await workspace()).worktree.defaultRoot, root);
    // the default trust is pi's own setting
    await defaults.getByTestId('default-trust').selectOption('never');
    await eventually(async () => (await api('/api/pi-settings')).settings?.defaultProjectTrust === 'never', 'pi to have the default trust');
    await defaults.getByTestId('default-trust').selectOption('ask');
    await eventually(async () => (await api('/api/pi-settings')).settings?.defaultProjectTrust === 'ask', 'pi to have the default trust back');
    // put the defaults back for the rest of the file
    await defaults.getByTestId('default-start').selectOption('local');
    await defaults.getByTestId('default-worktree-root').fill('');
    await defaults.getByTestId('default-worktree-root').blur();
    await eventually(async () => {
      const saved = (await call('GET', '/api/workspaces/defaults')).body;
      return saved.start === 'local' && saved.root === null;
    }, 'the defaults to be back');
    await factsMatch(/starts in the folder/, 'the row to follow the default start again');
  });

  it('orders the sidebar by dragging a row, and one place with Alt+arrow', async () => {
    await openProjects();
    const before = await workspaceNames();
    const cwds = (await api('/api/workspaces')).map((w) => w.cwd);
    const last = before.at(-1);
    const first = before[0];
    assert.notEqual(last, first);
    await row(last).dragTo(row(first));
    await eventually(async () => (await workspaceNames())[0] === last, 'the dragged project to be first');
    assert.equal(await row(last).evaluate((el) => el === el.parentElement.firstElementChild), true, 'the list shows the new order');
    // Alt+ArrowDown on the button of the first row moves it back down one place
    await dialog().getByTestId(`open-project-${last}`).focus();
    await app.page.keyboard.press('Alt+ArrowDown');
    await eventually(async () => (await workspaceNames())[0] === first, 'the project to move one place down');
    assert.deepEqual(await workspaceNames(), [first, last, ...before.slice(1, -1)]);
    await call('PUT', '/api/workspaces/order', { order: cwds });
  });

  it('adds a folder: a path is typed in a browser and the row appears; the picker is the desktop app’s', async () => {
    await openProjects();
    const extra = join(env.project, '..', 'added-by-plus');
    mkdirSync(extra, { recursive: true });
    await dialog().getByTestId('add-project').click();
    await dialog().getByTestId('add-project-path').fill(extra);
    await dialog().getByTestId('add-project-submit').click();
    await row('added-by-plus').waitFor();
    assert.ok((await workspaceNames()).includes('added-by-plus'));
    assert.equal(await dialog().getByTestId('add-project-form').count(), 0, 'the path row closes');
    await call('DELETE', `/api/workspaces/${encodeURIComponent(extra)}`);
    rmSync(extra, { recursive: true, force: true });
    await close();
  });
});

describe('a project’s page', () => {
  it('slides in over the list with the breadcrumb, and Back and Esc return', async () => {
    await openProjects();
    await row().click();
    await page().waitFor();
    assert.equal(await page().locator('.pk-path button').innerText(), 'Projects');
    assert.equal(await page().locator('.pk-path [aria-current]').innerText(), NAME);
    assert.equal(await dialog().getByTestId('projects-list').count(), 0, 'the list gives way to the page');
    assert.deepEqual(
      await page().locator('section.pk-group').evaluateAll((sections) => sections.map((s) => s.getAttribute('aria-label'))),
      ['Trust', 'New threads', 'Worktrees', 'Setup scripts', 'Open worktrees', 'Sidebar'],
    );
    await page().getByTestId('project-back').click();
    await dialog().getByTestId('section-projects').getByRole('tab', { name: 'Folders', exact: true }).click();
    await dialog().getByTestId('projects-list').waitFor();
    assert.equal(await page().count(), 0);
    // Esc goes back first, and only then closes Settings
    await row().click();
    await page().waitFor();
    await app.page.keyboard.press('Escape');
    await dialog().getByTestId('section-projects').getByRole('tab', { name: 'Folders', exact: true }).click();
    await dialog().getByTestId('projects-list').waitFor();
    assert.equal(await dialog().count(), 1);
    await app.page.keyboard.press('Escape');
    await dialog().waitFor({ state: 'detached' });
  });

  it('Start and the branch prefix save when changed, and a blur on an unchanged field sends nothing', async () => {
    await openPage();
    patches.length = 0;
    await page().getByTestId('project-start-worktree').check();
    await eventually(async () => (await workspace()).worktree.start === 'worktree', 'Start to be saved');
    assert.deepEqual(patches.at(-1), { cwd: project, worktree: { start: 'worktree' } });
    const prefix = page().getByTestId('project-prefix');
    assert.equal(await prefix.inputValue(), 'pi-kit/');
    await prefix.fill('feat');
    await prefix.blur();
    await eventually(async () => (await workspace()).worktree.branchPrefix === 'feat/', 'the prefix to be saved, with its slash');
    assert.deepEqual(patches.at(-1), { cwd: project, worktree: { branchPrefix: 'feat' } });
    const sent = patches.length;
    await prefix.focus();
    await prefix.blur();
    await page().getByTestId('project-root').focus();
    await page().getByTestId('project-root').blur();
    await app.h.settle(500);
    assert.equal(patches.length, sent, 'no request for a field that did not change');
    // the list says where a thread starts now
    await page().getByTestId('project-back').click();
    await factsMatch(/starts in a worktree/, 'the list to say where a thread starts');
  });

  it('Cut from lists the branches of the repository, and Carry, Remove the folder, Branch and Local switching save their fields', async () => {
    await openPage();
    const base = page().getByTestId('project-base');
    await eventually(async () => (await base.locator('option').count()) === 3, 'the branches to be read');
    assert.deepEqual(await base.locator('option').evaluateAll(options => options.map(option => option.label)), ['the checked-out branch', 'main', 'develop']);
    await base.selectOption('develop');
    await eventually(async () => (await workspace()).worktree.base === 'develop', 'Cut from to be saved');
    await page().getByTestId('project-carry').selectOption('always');
    await page().getByTestId('project-remove').selectOption('after-7-days');
    await page().getByTestId('project-switch').uncheck();
    await eventually(async () => {
      const w = (await workspace()).worktree;
      return w.carryChanges === 'always' && w.removeFolder === 'after-7-days' && w.allowBranchSwitch === false;
    }, 'the other fields to be saved');
    await page().getByTestId('project-branch').selectOption('detached');
    await eventually(async () => (await workspace()).worktree.branchMode === 'detached', 'detached to be saved');
    assert.equal(await page().getByTestId('project-prefix').count(), 0, 'a detached worktree has no prefix to type');
    // back to the defaults: the select goes back to the checked-out branch
    await base.selectOption('');
    await page().getByTestId('project-branch').selectOption('named');
    await page().getByTestId('project-carry').selectOption('ask');
    await page().getByTestId('project-remove').selectOption('ask');
    await page().getByTestId('project-switch').check();
    await page().getByTestId('project-start-local').check();
    await eventually(async () => {
      const w = (await workspace()).worktree;
      return w.base === null && w.branchMode === 'named' && w.carryChanges === 'ask' && w.removeFolder === 'ask' && w.allowBranchSwitch === true && w.start === 'local';
    }, 'the fields to be back');
  });

  it('Show in the sidebar hides the project from the sidebar and keeps it in the list', async () => {
    await openPage();
    const group = app.page.locator(`.pk-project[data-project="${NAME}"]`);
    assert.equal(await group.count(), 1);
    await page().getByTestId('project-shown').uncheck();
    await eventually(async () => (await workspace()).hidden === true, 'the project to be hidden');
    await eventually(async () => (await group.count()) === 0, 'the sidebar to drop the group');
    await page().getByTestId('project-back').click();
    assert.ok((await chips()).includes('hidden'));
    await row().click();
    await page().getByTestId('project-shown').check();
    await eventually(async () => (await workspace()).hidden === false, 'the project to be shown');
    await group.waitFor();
  });

  it('Trust: the switch trusts and remembers or never trusts, and Review resources opens the existing dialog', async () => {
    await openPage();
    const id = encodeURIComponent(project);
    assert.match(await page().getByTestId('project-trust-hint').innerText(), /^1 resource: 1 skill\./);
    assert.equal(await page().getByTestId('project-trusted').isChecked(), false);
    await page().getByTestId('project-review').click();
    const review = app.page.getByRole('dialog', { name: 'Trust this folder?' });
    await review.waitFor();
    assert.match(await review.innerText(), /\.pi\/skills\/release\/SKILL\.md/);
    await review.getByRole('button', { name: 'Skip this time' }).click();
    await review.waitFor({ state: 'detached' });
    await page().getByTestId('project-trusted').check();
    await eventually(async () => (await call('GET', `/api/workspaces/${id}/trust`)).body.status === 'trusted', 'the folder to be trusted');
    assert.equal(await page().getByTestId('project-trust-chip').innerText(), 'trusted');
    await page().getByTestId('project-trusted').uncheck();
    await eventually(async () => (await call('GET', `/api/workspaces/${id}/trust`)).body.status === 'untrusted', 'the folder to be not trusted');
    assert.equal(await page().getByTestId('project-trust-chip').innerText(), 'not trusted');
    await page().getByTestId('project-back').click();
    assert.ok((await chips()).includes('not trusted'));
  });

  it('a folder that is not a repository has no worktree groups and says why', async () => {
    await openPage(SPARE);
    assert.deepEqual(
      await page().locator('section.pk-group').evaluateAll((sections) => sections.map((s) => s.getAttribute('aria-label'))),
      ['Trust', 'New threads and worktrees', 'Sidebar'],
    );
    assert.match(await page().getByTestId('project-not-git').innerText(), /not a git repository/);
    await close();
  });
});

describe('the setup scripts', () => {
  it('shows the script the lockfile suggests first, until the list is saved', async () => {
    writeFileSync(join(project, 'pnpm-lock.yaml'), '');
    // the projects are read again when the window opens (and every half minute), so a lockfile written now is seen by a reload
    await close();
    await app.page.reload();
    await app.page.waitForSelector('pk-root .pk-shell');
    await openPage();
    const scripts = page().getByTestId('project-scripts');
    await scripts.getByTestId('script-pnpm').waitFor();
    assert.equal((await scripts.locator('.pk-item').count()), 1);
    assert.match(await scripts.getByTestId('script-pnpm').innerText(), /pnpm\s+default\s+suggested\s+pnpm install --frozen-lockfile/);
    assert.equal((await workspace()).worktree.setup, null, 'a suggestion is not a saved setting');
  });

  it('adds a script with files to copy, and the list is saved whole (the suggestion becomes a saved script)', async () => {
    const scripts = page().getByTestId('project-scripts');
    await scripts.getByTestId('add-script').click();
    await scripts.getByTestId('script-name').fill('Docs');
    await scripts.getByTestId('script-save').click();
    await scripts.getByTestId('script-error').waitFor();
    assert.equal(await scripts.getByTestId('script-error').innerText(), 'Add a command, or files to copy, or both.');
    await scripts.getByTestId('script-command').fill('make docs');
    await scripts.getByTestId('script-copy').fill('.env.local\nconfig/dev.json');
    await scripts.getByTestId('script-save').click();
    await scripts.getByTestId('script-docs').waitFor();
    assert.deepEqual((await workspace()).worktree.setupScripts, [
      { id: 'pnpm', name: 'pnpm', command: 'pnpm install --frozen-lockfile' },
      { id: 'docs', name: 'Docs', command: 'make docs', copy: ['.env.local', 'config/dev.json'] },
    ]);
    assert.equal((await workspace()).worktree.setupSuggested, undefined, 'saved now');
    assert.equal(await scripts.getByTestId('script-suggested').count(), 0);
    assert.match(await scripts.getByTestId('script-docs').locator('.ds').innerText(), /make docs\s*·\s*copies\s*\.env\.local,\s*config\/dev\.json/);
  });

  it('edits a script in place, makes another the default, and removes one', async () => {
    const scripts = page().getByTestId('project-scripts');
    await scripts.getByTestId('script-edit-docs').click();
    assert.equal(await scripts.getByTestId('script-name').inputValue(), 'Docs');
    await scripts.getByTestId('script-command').fill('make docs && make site');
    await scripts.getByTestId('script-save').click();
    await eventually(async () => (await workspace()).worktree.setupScripts[1].command === 'make docs && make site', 'the edit to be saved');
    // Cancel changes nothing
    await scripts.getByTestId('script-edit-docs').click();
    await scripts.getByTestId('script-command').fill('nope');
    await scripts.getByTestId('script-cancel').click();
    assert.equal((await workspace()).worktree.setupScripts[1].command, 'make docs && make site');
    await scripts.getByTestId('script-default-docs').click();
    await eventually(async () => (await workspace()).worktree.setupScripts[0].id === 'docs', 'Docs to be the default');
    assert.equal((await workspace()).worktree.setup, 'make docs && make site', 'the single command of 8m is the first script’s');
    assert.match(await scripts.locator('.pk-item').first().innerText(), /Docs\s+default/);
    await scripts.getByTestId('script-remove-pnpm').click();
    await eventually(async () => (await workspace()).worktree.setupScripts.length === 1, 'a script to be removed');
    await scripts.getByTestId('script-remove-docs').click();
    await eventually(async () => (await workspace()).worktree.setupScripts.length === 0, 'the list to be empty');
    // "none" stays none: the lockfile is not suggested again
    await scripts.getByTestId('scripts-empty').waitFor();
    await page().getByTestId('project-back').click();
    await row().click();
    await page().getByTestId('scripts-empty').waitFor();
    assert.deepEqual((await workspace()).worktree.setupScripts, []);
    rmSync(join(project, 'pnpm-lock.yaml'));
    await close();
  });
});

describe('the open worktrees', () => {
  let made;
  let loose;

  it('lists a worktree thread with its branch, state, title and commits ahead', async () => {
    made = (await call('POST', '/api/threads', { cwd: project, worktree: { branch: 'pi-kit/demo-branch' } })).body;
    await call('PATCH', `/api/threads/${made.id}`, { title: 'Cut the cramped rows' });
    commitFile(made.worktree.path, 'src/extra.ts', 'export const extra = 1;\n', 'Extra');
    loose = (await call('POST', '/api/threads', { cwd: project, worktree: { branch: null } })).body;
    await call('PATCH', `/api/threads/${loose.id}`, { title: 'A loose idea' });
    await openPage();
    const group = page().getByTestId('project-open-worktrees');
    const item = group.getByTestId(`worktree-${made.id}`);
    await item.waitFor();
    assert.equal(await item.getByTestId('worktree-branch').innerText(), 'pi-kit/demo-branch');
    assert.equal(await item.getByTestId('worktree-state').innerText(), 'idle');
    assert.equal(await item.getByTestId('worktree-thread').innerText(), 'Thread “Cut the cramped rows”');
    await eventually(async () => /1 commit ahead of main/.test(await item.getByTestId('worktree-ahead').innerText().catch(() => '')), 'the commits ahead');
    const detached = group.getByTestId(`worktree-${loose.id}`);
    assert.equal(await detached.getByTestId('worktree-branch').innerText(), 'detached');
    assert.equal(await group.locator('.pk-item').count(), 2);
    await page().getByTestId('project-back').click();
    await factsMatch(/2 worktrees/, 'the list to count the worktrees');
    await row().click();
  });

  it('Hand off to local from the row: the thread’s dialog opens, the folder moves to its branch, the row goes', async () => {
    const group = page().getByTestId('project-open-worktrees');
    await group.getByTestId(`handoff-${made.id}`).click();
    const handoff = app.page.getByTestId('handoff-dialog');
    await handoff.waitFor();
    await app.page.getByTestId('do-handoff').waitFor();
    await eventually(async () => !(await app.page.getByTestId('do-handoff').isDisabled()), 'the hand off to be possible');
    await app.page.getByTestId('do-handoff').click();
    await app.page.getByTestId('handoff-result').waitFor();
    assert.equal(gitIn(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'pi-kit/demo-branch');
    assert.equal(existsSync(made.worktree.path), false, 'the project’s rule is ask: the folder is removed');
    await handoff.getByRole('button', { name: 'Close' }).first().click();
    await handoff.waitFor({ state: 'detached' });
    await group.getByTestId(`worktree-${made.id}`).waitFor({ state: 'detached' });
    assert.equal(await group.locator('.pk-item').count(), 1, 'the detached one is left');
    assert.equal(await page().locator('.intro .chip.off').first().innerText(), 'pi-kit/demo-branch', 'the page shows the branch the folder is on now');
    gitIn(project, 'switch', 'main');
  });

  it('Merge back opens its dialog from the row, and Remove folder asks first and takes the folder away', async () => {
    const group = page().getByTestId('project-open-worktrees');
    await group.getByTestId(`merge-${loose.id}`).click();
    const merge = app.page.getByTestId('merge-dialog');
    await merge.waitFor();
    assert.match(await merge.innerText(), /Merge back/);
    await merge.getByRole('button', { name: 'Close' }).first().click();
    await merge.waitFor({ state: 'detached' });
    await group.getByTestId(`remove-folder-${loose.id}`).click();
    await group.getByTestId('remove-confirm').waitFor();
    assert.match(await group.getByTestId('remove-confirm').innerText(), /The thread carries on in the project folder/);
    await group.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(existsSync(loose.worktree.path), true, 'Cancel keeps the folder');
    await group.getByTestId(`remove-folder-${loose.id}`).click();
    await group.getByTestId('remove-confirm-yes').click();
    await group.getByTestId(`worktree-${loose.id}`).waitFor({ state: 'detached' });
    assert.equal(existsSync(loose.worktree.path), false);
    await group.getByTestId('worktrees-empty').waitFor();
    await close();
  });
});

describe('forgetting a project', () => {
  it('asks first, removes the project from the list and the sidebar, leaves its folder, and adding it again brings it back', async () => {
    const group = app.page.locator(`.pk-project[data-project="${SPARE}"]`);
    assert.equal(await group.count(), 1);
    await openPage(SPARE);
    await page().getByTestId('forget-project').click();
    await page().getByTestId('forget-confirm').waitFor();
    assert.equal(await page().getByTestId('forget-project').count(), 0);
    await page().getByRole('button', { name: 'Cancel' }).click();
    assert.ok((await workspaceNames()).includes(SPARE), 'Cancel forgets nothing');
    await page().getByTestId('forget-project').click();
    await page().getByTestId('forget-confirm').click();
    await dialog().getByTestId('section-projects').getByRole('tab', { name: 'Folders', exact: true }).click();
    await dialog().getByTestId('projects-list').waitFor();
    await eventually(async () => !(await workspaceNames()).includes(SPARE), 'the project to leave the list');
    assert.equal(await row(SPARE).count(), 0);
    await eventually(async () => (await group.count()) === 0, 'the sidebar to drop the project');
    assert.equal(existsSync(join(spare, 'notes.md')), true, 'its files stay');
    // the pass that reads pi’s session files does not bring it back, and the "+" does
    await app.h.settle(1500);
    assert.ok(!(await workspaceNames()).includes(SPARE));
    await dialog().getByTestId('add-project').click();
    await dialog().getByTestId('add-project-path').fill(spare);
    await dialog().getByTestId('add-project-submit').click();
    await row(SPARE).waitFor();
    await group.waitFor();
    await close();
  });
});

describe('the alignment rule', () => {
  /** The left edges of the controls of every row of every group, per section: one column, so one edge. */
  async function edges(section) {
    await app.h.openSettings(section);
    await dialog().getByTestId(`section-${await sectionId(section)}`).waitFor();
    if (section === 'Advanced') await dialog().getByTestId('section-advanced').getByRole('tab', { name: 'Security', exact: true }).click();
    await app.h.settle(400);
    return dialog().locator('.pk-group .row > .ctl.ctl-w').evaluateAll((columns) => {
      const lefts = new Set(columns.filter((c) => c.getBoundingClientRect().width > 0).map((c) => Math.round(c.getBoundingClientRect().left)));
      return { lefts: [...lefts], columns: columns.length };
    });
  }
  const sectionId = async (label) => ({ General: 'general', Appearance: 'appearance', Keybindings: 'keybindings', 'Chat models': 'models', Attendant: 'attendant', Advanced: 'advanced', Voice: 'voice' })[label];

  for (const label of ['General', 'Appearance', 'Chat models', 'Attendant', 'Advanced', 'Voice', 'Keybindings']) {
    it(`${label}: the controls of its rows share one column`, async () => {
      await close();
      const { lefts, columns } = await edges(label);
      assert.ok(columns > 0, `${label} has rows in the control column`);
      assert.equal(lefts.length, 1, `${label}: controls start at ${lefts.join(', ')}`);
      assert.equal(await dialog().locator('.pk-group .row .ctl:not(.ctl-w)').count(), 0, `${label}: every control column is ctl-w`);
    });
  }

  it('under 768px the column drops under the label and fills the row', async () => {
    await close();
    await app.page.setViewportSize({ width: 375, height: 812 });
    // On a phone the Settings button is in the drawer of the threads.
    const drawer = app.page.locator('#t-threads');
    if (!(await drawer.isChecked())) await app.page.locator('label[for="t-threads"]').click();
    await app.h.settle(400);
    await app.h.openSettings('General');
    await dialog().getByTestId('section-general').waitFor();
    await app.h.settle(400);
    const geometry = await dialog().locator('.pk-group .row').first().evaluate((r) => {
      const label = r.firstElementChild.getBoundingClientRect();
      const column = r.querySelector('.ctl').getBoundingClientRect();
      return { below: column.top >= label.bottom - 1, width: Math.round(column.width), row: Math.round(r.getBoundingClientRect().width) };
    });
    assert.equal(geometry.below, true);
    assert.ok(geometry.width > 250, `the column fills the row: ${JSON.stringify(geometry)}`);
    await app.page.setViewportSize({ width: 1440, height: 900 });
    await close();
  });
});
