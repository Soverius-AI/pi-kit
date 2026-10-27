// End to end: the real app (pnpm run dev:web) in Chromium against pi and a local model. Run with `pnpm run e2e`.
// The tests share one backend and one project and each makes its own thread; they run in order, and a few build on the thread
// a test before them made (the tree test needs two turns).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { appendFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { api, editProjectFile, env, git, openApp, proseTexts, readPiSettings } from './support/app.mjs';
import { writeUsageSession } from './support/demo-sessions.mjs';
import { ALT_MODEL, MODEL, THINKING_MODEL } from './support/env.mjs';

let app;
/** Backends this suite started itself (the restart test). */
const spawned = [];
before(async () => {
  app = await openApp();
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

const sidebarThreads = () => app.page.locator('.pk-thread');

/** The banner that says a session reload is needed (Settings). */
const banner = (dialog) => dialog.getByTestId('reload-banner');

/** Ends the backend and starts it again on the same port, token and folders, as the desktop app's watchdog does (dev:web has none); the page reconnects. */
async function restartBackend(page) {
  const { pid } = await (await fetch(`${env.api}/api/health`, { headers: { Authorization: `Bearer ${env.server.PI_KIT_TOKEN}` } })).json();
  process.kill(pid, 'SIGKILL');
  await page.getByText(/Backend unreachable/).first().waitFor();
  const { spawn } = await import('node:child_process');
  const child = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env.server, NODE_ENV: 'development', PI_KIT_PORT: new URL(env.api).port, PI_KIT_ORIGIN: env.base },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  spawned.push(child.pid);
  await page.locator('.toast', { hasText: /restarted|Reconnected/ }).first().waitFor();
  await page.getByText('Backend connected').first().waitFor();
}

describe('threads and streaming', () => {
  it('starts a new thread', async () => {
    const { page, h } = app;
    await h.newThread();
    await page.getByLabel('Message to pi').waitFor();
    // The empty thread has the new-thread page with the Where row above the message.
    assert.match(await page.locator('pk-transcript').innerText(), /What are we doing in project\?/);
    await page.getByTestId('where-row').waitFor();
  });

  it('streams an answer into the transcript while the run is going', async () => {
    const { page } = app;
    const box = page.getByLabel('Message to pi');
    await box.fill('Count from 1 to 40, one number per line, and write nothing else.');
    await box.press('Enter');
    const stop = page.getByTestId('stop');
    await stop.waitFor();
    // Sample the answer while Stop is on screen: the text must grow in more than one step.
    const lengths = new Set();
    const deadline = Date.now() + 120_000;
    while ((await stop.count()) > 0 && Date.now() < deadline) {
      const texts = await proseTexts(page);
      lengths.add((texts.at(-1) ?? '').length);
      await page.waitForTimeout(60);
    }
    assert.ok((await stop.count()) === 0, 'the run did not finish');
    assert.ok(lengths.size >= 3, `the answer arrived in ${lengths.size} step(s), expected a stream`);
    const final = (await proseTexts(page)).at(-1) ?? '';
    assert.match(final, /\b1\b[\s\S]*\b40\b/);
    // The thread is in the sidebar with its first message as the label.
    await page.locator('.pk-thread', { hasText: 'Count from 1 to 40' }).first().waitFor();
  });

  it('keeps the thread when the page is reloaded and replays it', async () => {
    const { page, h } = app;
    await page.reload();
    await page.waitForSelector('pk-root .pk-shell');
    await page.getByLabel('Message to pi').waitFor();
    await page.getByText('Count from 1 to 40').first().waitFor();
    assert.match((await proseTexts(page)).at(-1) ?? '', /\b40\b/);
    await h.settle(300);
  });
});

describe('extension dialogs (interrupts)', () => {
  it('asks a yes/no question from an extension, and the answer resumes pi', async () => {
    const { page, h } = app;
    await h.newThread();
    const box = page.getByLabel('Message to pi');
    await box.fill('/pk-confirm Delete the scratch file?');
    await box.press('Enter');
    const question = page.getByRole('group', { name: 'Proceed with the test?' });
    await question.waitFor();
    assert.match(await question.innerText(), /Delete the scratch file\?/);
    assert.match(await question.innerText(), /Asked by an extension/);
    await question.getByRole('button', { name: 'Allow' }).click();
    await question.waitFor({ state: 'detached' });
    // The extension reports the answer as a notice and in the status bar.
    await page.getByText('Confirmed by the user').first().waitFor();
    await page.locator('.pk-status', { hasText: 'last answer: yes' }).waitFor();
  });

  it('a denial reaches the extension as a no', async () => {
    const { page } = app;
    const box = page.getByLabel('Message to pi');
    await box.fill('/pk-confirm Again?');
    await box.press('Enter');
    const question = page.getByRole('group', { name: 'Proceed with the test?' });
    await question.waitFor();
    await question.getByRole('button', { name: 'Deny' }).click();
    await page.getByText('Denied by the user').first().waitFor();
    await page.locator('.pk-status', { hasText: 'last answer: no' }).waitFor();
  });

  it('a choice from a list reaches the extension', async () => {
    const { page } = app;
    const box = page.getByLabel('Message to pi');
    // Text after the command name closes the slash menu, so Enter sends instead of completing the name.
    await box.fill('/pk-select now');
    await box.press('Enter');
    const question = page.getByRole('group', { name: 'Which flavour?' });
    await question.waitFor();
    await question.getByRole('button', { name: 'pistachio' }).click();
    await page.getByText('You picked pistachio').first().waitFor();
  });
});

describe('tree', () => {
  it('goes back to an earlier turn and the transcript follows', async () => {
    const { page, h } = app;
    await h.newThread();
    await h.prompt('Remember the number 7. Answer only: ok.');
    await h.prompt('Now remember the number 9. Answer only: ok.');
    const transcript = page.locator('pk-transcript');
    await transcript.getByText('Now remember the number 9').first().waitFor();
    await h.openPanel('Tree');
    const graph = page.getByRole('listbox', { name: 'Session graph' });
    await graph.waitFor();
    const rows = graph.getByRole('option');
    assert.ok((await rows.count()) >= 2, 'the graph lists the turns');
    // The first turn is the second row from the bottom of the newest-first list: pick it by its text.
    // The actions are inline in the row (they show on hover and selection, so the button is looked up inside the row).
    const first = rows.filter({ hasText: 'Remember the number 7' }).first();
    await first.click();
    await first.getByRole('button', { name: 'Go here' }).click();
    await transcript.getByText('Now remember the number 9').first().waitFor({ state: 'detached' });
    // The transcript is replayed from the stored log, so it is empty for a moment before the first turn is back.
    await transcript.getByText('Remember the number 7').first().waitFor();
    // pi sees the same: a new prompt from here is a sibling of the second turn.
    await h.prompt('What number did I ask you to remember? Answer with the number only.');
    assert.match((await proseTexts(page)).at(-1) ?? '', /7/);
    assert.doesNotMatch(await transcript.innerText(), /remember the number 9/i);
    await h.closePanel();
  });

  it('draws two-line rows with inline actions and filters with "Find a turn"', async () => {
    const { page, h } = app;
    await h.openPanel('Tree');
    const graph = page.getByRole('listbox', { name: 'Session graph' });
    await graph.waitFor();
    const row = graph.getByRole('option').filter({ hasText: 'Remember the number 7' }).first();
    assert.equal(Math.round((await row.boundingBox())?.height ?? 0), 36, 'a turn row is 36px high');
    await row.hover();
    for (const name of ['Edit and branch', 'Fork to new thread', 'Label', 'More']) assert.ok(await row.getByRole('button', { name }).isVisible(), `${name} shows on hover`);
    await page.getByLabel('Find a turn').fill('remember the number 7');
    assert.equal(await graph.getByRole('option').count(), 1);
    assert.equal((await graph.locator('mark').first().innerText()).toLowerCase(), 'remember the number 7');
    await page.getByLabel('Find a turn').fill('');
    await h.closePanel();
  });
});

describe('files panel', () => {
  it('decorates changed files, follows the folder and reverts from the context menu', async () => {
    const { page, h } = app;
    await h.newThread();
    await h.openPanel('Files');
    const node = (path) => page.locator(`.pk-node[data-path="${path}"]`);
    await node('README.md').waitFor();
    // An edit from outside the app shows within a few seconds, as a badge in git's tint.
    editProjectFile('README.md', (text) => `${text}\nan edit from outside\n`);
    try {
      await node('README.md').locator('.bdg').waitFor();
      assert.equal((await node('README.md').locator('.bdg').innerText()).trim(), 'M');
      await node('README.md').click({ button: 'right' });
      const menu = page.getByRole('menu', { name: 'File actions' });
      await menu.waitFor();
      const labels = await menu.getByRole('menuitem').allInnerTexts();
      for (const label of ['Open in editor', 'Copy relative path', 'Add to message', 'Rename…', 'Delete…', 'Open diff', 'Revert…']) {
        assert.ok(labels.some((text) => text.startsWith(label)), `the menu offers ${label}`);
      }
      // "Add to message" is a UiBus request the composer answers with `@path` at the caret.
      await menu.getByRole('menuitem', { name: /^Add to message/ }).click();
      await page.waitForFunction(() => /@README\.md/.test(document.querySelector('[aria-label="Message to pi"]')?.value ?? ''), undefined);
      await page.getByLabel('Message to pi').fill('');
      await node('README.md').click({ button: 'right' });
      await menu.waitFor();
      await menu.getByRole('menuitem', { name: /^Revert/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Revert file' }).click();
      await page.locator('.toast').getByText(/Reverted README\.md/).waitFor();
      await page.waitForFunction(() => !document.querySelector('.pk-node[data-path="README.md"] .bdg'), undefined);
      assert.equal(git('status', '--porcelain', 'README.md').trim(), '', 'the file is back as HEAD has it');
    } finally {
      git('checkout', '--', 'README.md');
      await h.closePanel();
    }
  });

  it('creates a file, renames it with F2 and removes it only after Delete is confirmed', async () => {
    const { page, h } = app;
    const suffix = randomBytes(4).toString('hex');
    const original = `file-actions-${suffix}.txt`;
    const renamed = `renamed-${suffix}.txt`;
    const row = (path) => page.locator(`pk-files-panel .pk-node[data-path="${path}"]`);
    try {
      await h.newThread();
      await h.openPanel('Files');
      await row('src').click({ button: 'right' });
      await page.getByRole('menu', { name: 'File actions' }).getByRole('menuitem', { name: /^New file/ }).click();
      const name = page.getByRole('textbox', { name: 'New file in src', exact: true });
      await name.fill(original);
      await name.press('Enter');
      await row(`src/${original}`).waitFor();
      assert.ok(existsSync(join(env.project, 'src', original)), 'creation reached the scratch filesystem');
      await row(`src/${original}`).press('F2');
      const rename = page.getByRole('textbox', { name: `Rename ${original}`, exact: true });
      await rename.fill(renamed);
      await rename.press('Enter');
      await row(`src/${renamed}`).waitFor();
      assert.equal(existsSync(join(env.project, 'src', original)), false);
      assert.ok(existsSync(join(env.project, 'src', renamed)), 'rename moved the actual file');
      await row(`src/${renamed}`).press('Delete');
      const confirmation = page.getByRole('dialog', { name: `Delete ${renamed}?`, exact: true });
      await confirmation.waitFor();
      assert.ok(existsSync(join(env.project, 'src', renamed)), 'the confirmation does not delete yet');
      await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
      await row(`src/${renamed}`).waitFor({ state: 'detached' });
      assert.equal(existsSync(join(env.project, 'src', renamed)), false);
    } finally {
      rmSync(join(env.project, 'src', original), { force: true });
      rmSync(join(env.project, 'src', renamed), { force: true });
      await h.closePanel();
    }
  });
});

describe('command menu', () => {
  it('opens with Ctrl+K, filters, runs a command and closes with Esc', async () => {
    const { page, h } = app;
    await h.newThread();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.waitFor();
    await palette.getByLabel('Search commands').fill('settings');
    await palette.getByRole('option').first().waitFor();
    assert.match(await palette.innerText(), /settings/i);
    await page.keyboard.press('Enter');
    // Commands with optional arguments are prepared in the composer before execution.
    await palette.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('[aria-label="Message to pi"]')?.value === '/settings ');
    await page.getByLabel('Message to pi').press('Enter');
    await page.getByRole('dialog', { name: 'Settings' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Settings' }).waitFor({ state: 'detached' });
    await page.keyboard.press('Control+k');
    await palette.waitFor();
    await page.keyboard.press('Escape');
    await palette.waitFor({ state: 'detached' });
    await h.settle(200);
  });

  it('shows the extension commands in the slash menu', async () => {
    const { page, h } = app;
    await h.newThread();
    const box = page.getByLabel('Message to pi');
    await box.fill('/pk-');
    const menu = page.getByRole('listbox').filter({ hasText: 'pk-confirm' });
    await menu.waitFor();
    assert.match(await menu.innerText(), /pk-select/);
    await box.fill('');
  });
});

describe('review mode', () => {
  it('comments on a changed line and sends the batch to pi as one prompt', async () => {
    const { page, h } = app;
    await h.newThread();
    await h.prompt('Say ready.');
    // A change in the working tree that pi did not make: the review works on git's view as well.
    editProjectFile('src/math.ts', (text) => `${text}\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n`);
    try {
      await h.openPanel('Changes');
      await page.getByRole('button', { name: 'Working tree', exact: true }).click();
      await page.locator('.pk-file', { hasText: 'math.ts' }).first().click();
      await page.locator('pk-review-view .pk-diff').waitFor();
      await h.discardComments();
      await h.comment('export function mul', 'Add a doc comment to mul.');
      await page.getByRole('button', { name: /^Send 1 comment to pi$/ }).click();
      // Back in the chat: the message carries the batch as a chip, and pi answers it.
      await page.getByRole('button', { name: '1 review comment' }).waitFor();
      await page.getByTestId('stop').waitFor({ timeout: 30_000 }).catch(() => undefined);
      await page.getByTestId('stop').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: '1 review comment' }).click();
      const list = page.getByRole('list', { name: 'Review comments' });
      await list.waitFor();
      assert.match(await list.innerText(), /math\.ts:\d+/);
      assert.match(await list.innerText(), /Add a doc comment to mul\./);
    } finally {
      git('checkout', '--', 'src');
    }
  });
});

describe('settings', () => {
  const authFile = () => join(env.agentDir, 'auth.json');

  it('keeps three settings across a reload and a backend restart, each in its own store', async () => {
    const { page, h } = app;
    const dialog = await h.openSettings('Appearance');
    // 1. the theme, in pi-kit's database
    await dialog.getByRole('radio', { name: 'Light' }).check();
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'pi-light');
    await dialog.getByTestId('saved').getByText('Saved').waitFor();
    // 2. compaction, in pi's settings.json
    await dialog.getByRole('tab', { name: 'General' }).click();
    const compaction = dialog.getByRole('checkbox', { name: /Compact the context automatically/ });
    const before = await compaction.isChecked();
    await compaction.setChecked(!before);
    await dialog.getByTestId('saved').getByText('Saved').waitFor();
    // 3. the default effort, in pi's settings.json too (Models and effort)
    await dialog.getByRole('tab', { name: 'Chat models' }).click();
    await dialog.getByTestId('default-effort').selectOption('low');
    await h.settle(800);
    assert.equal(readPiSettings().compaction?.enabled, !before);
    assert.equal(readPiSettings().defaultThinkingLevel, 'low');
    assert.equal((await api('/api/settings')).theme, 'pi-light');

    const check = async (expectCompaction) => {
      await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'pi-light');
      const again = await h.openSettings('General');
      assert.equal(await again.getByRole('checkbox', { name: /Compact the context automatically/ }).isChecked(), expectCompaction);
      await again.getByRole('tab', { name: 'Chat models' }).click();
      assert.equal(await again.getByTestId('default-effort').inputValue(), 'low');
      await page.keyboard.press('Escape');
    };
    await page.reload();
    await page.waitForSelector('pk-root .pk-shell');
    await check(!before);
    await restartBackend(page);
    assert.equal((await api('/api/settings')).theme, 'pi-light', 'the theme is in the database, which survived the restart');
    assert.equal((await api('/api/pi-settings')).settings.defaultThinkingLevel, 'low');
    await page.reload();
    await page.waitForSelector('pk-root .pk-shell');
    await check(!before);

    // Put things back for the tests after this one.
    const again = await h.openSettings('General');
    await again.getByRole('checkbox', { name: /Compact the context automatically/ }).setChecked(before);
    await again.getByRole('tab', { name: 'Chat models' }).click();
    await again.getByTestId('default-effort').selectOption('off');
    await again.getByRole('tab', { name: 'Appearance' }).click();
    await again.getByRole('radio', { name: 'Dark' }).check();
    await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'pi-dark');
    await h.settle(800);
    assert.equal(readPiSettings().defaultThinkingLevel, 'off');
    await page.keyboard.press('Escape');
  });

  it('finds a setting by a word in its description and says where it is stored', async () => {
    const { page, h } = app;
    const dialog = await h.openSettings('General');
    const search = dialog.getByRole('searchbox', { name: 'Search settings' });
    await search.fill('summarises');
    const row = dialog.locator('[data-setting="auto-compaction"]');
    await row.waitFor();
    assert.equal(await dialog.locator('[data-setting="retry"]').isVisible(), false);
    assert.match(await row.innerText(), /pi settings\.json/, 'the storage chip');
    // The theme is pi-kit's own: its chip says so. A word nothing contains finds nothing.
    await search.fill('dark light');
    await dialog.locator('[data-setting="theme"]').getByText('pi-kit database').waitFor();
    await search.fill('zzzzqq');
    await dialog.getByTestId('no-results').waitFor();
    await search.fill('');
    await page.keyboard.press('Escape');
  });

  it('flags a shortcut that takes another one’s key, in pi-kit’s and in pi’s own, and exports and imports the changes', async () => {
    const { page, h } = app;
    const dialog = await h.openSettings('Keybindings');
    // pi-kit: ⌘N is "New thread"; recording ⌘K (the palette's) asks before it takes it.
    const row = dialog.getByTestId('key-new-thread');
    const keys = dialog.getByTestId('section-keybindings');
    const filter = keys.getByRole('searchbox', { name: 'Filter shortcuts', exact: true });
    await filter.fill('new thread');
    await row.waitFor();
    await keys.getByTestId('key-command-palette').waitFor({ state: 'detached' });
    await filter.fill('');
    await row.getByRole('button', { name: /^Change/ }).click();
    await row.getByTestId('recording').waitFor();
    await keys.getByRole('tab', { name: 'pi shortcuts', exact: true }).click();
    await keys.getByTestId('recording').waitFor({ state: 'detached' });
    await keys.getByRole('tab', { name: 'pi-kit shortcuts', exact: true }).click();
    await row.getByRole('button', { name: /^Change/ }).click();
    await row.getByTestId('recording').waitFor();
    await page.keyboard.press('Meta+K');
    await row.getByTestId('clash-message').getByText(/already used by Command palette/).waitFor();
    assert.equal(await page.getByLabel('Search commands').count(), 0, 'the recorded key did not reach the app');
    await row.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await dialog.getByTestId('kit-conflicts').count(), 0);
    // A free key is taken at once and saved in the database.
    await row.getByRole('button', { name: /^Change/ }).click();
    await page.keyboard.press('Meta+Shift+J');
    await row.getByText('changed').waitFor();
    assert.deepEqual((await api('/api/settings')).shortcuts, { 'new-thread': 'mod+shift+j' });
    // The shortcut works as set: the old key does nothing now, the new one starts a thread.
    await dialog.getByRole('button', { name: /^Close settings/ }).click();
    const threads = (await api('/api/threads')).length;
    await page.keyboard.press('Meta+N');
    await h.settle(600);
    assert.equal((await api('/api/threads')).length, threads, '⌘N is not "New thread" any more');
    await page.keyboard.press('Meta+Shift+J');
    await page.getByLabel('Message to pi').waitFor();
    await h.settle(600);
    // Export what changed, then import a file that makes a clash: it is applied and flagged.
    const again = await h.openSettings('Keybindings');
    await again.getByTestId('section-keybindings').getByRole('tab', { name: 'Export and import', exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), again.getByTestId('export-keys').click()]);
    const exported = JSON.parse(readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.format, 'pi-kit-keybindings');
    assert.deepEqual(exported['pi-kit'], { 'new-thread': 'mod+shift+j' });
    const clashing = { format: 'pi-kit-keybindings', version: 1, 'pi-kit': { 'new-thread': 'mod+k', nonsense: 'mod+x' }, pi: {} };
    await again.getByTestId('import-file').setInputFiles({ name: 'keys.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(clashing)) });
    await again.getByTestId('import-message').getByText(/Imported 1 shortcut.*Skipped: pi-kit shortcut nonsense/).waitFor();
    await again.getByTestId('section-keybindings').getByRole('tab', { name: 'pi-kit shortcuts', exact: true }).click();
    await again.getByTestId('kit-conflicts').getByText('2 clash').waitFor();
    await again.getByTestId('key-new-thread').getByText('Shares its key with Command palette').waitFor();
    await again.getByTestId('key-new-thread').getByRole('button', { name: /^Reset/ }).click();
    await again.getByTestId('kit-conflicts').waitFor({ state: 'detached' });
    assert.deepEqual((await api('/api/settings')).shortcuts, {});

    // pi's own: "Start a new session" has no key; ctrl+p is "Cycle to next model".
    await again.getByTestId('section-keybindings').getByRole('tab', { name: 'pi shortcuts', exact: true }).click();
    const piRow = again.getByTestId('key-app.session.new');
    await piRow.getByRole('button', { name: /^Change/ }).click();
    await page.keyboard.press('Control+p');
    await piRow.getByTestId('clash-message').getByText(/already used by Cycle to next model/).waitFor();
    await piRow.getByRole('button', { name: 'Use it anyway' }).click();
    await again.getByTestId('pi-conflicts').getByText('2 clash').waitFor();
    assert.deepEqual(JSON.parse(readFileSync(join(env.agentDir, 'keybindings.json'), 'utf8')), { 'app.session.new': 'ctrl+p' });
    // pi's keybindings need a reload of the session, and the dialog offers it.
    await banner(again).waitFor();
    await piRow.getByRole('button', { name: /^Reset/ }).click();
    await again.getByTestId('pi-conflicts').waitFor({ state: 'detached' });
    assert.deepEqual(JSON.parse(readFileSync(join(env.agentDir, 'keybindings.json'), 'utf8')), {});
    await banner(again).getByRole('button', { name: 'Later' }).click();
    await page.keyboard.press('Escape');
  });

  it('adds an API key through the workflow: it lands in the credential store, auth.json holds only the command, and the UI shows only its last four characters', async () => {
    const { page, h } = app;
    const key = `sk-or-v1-${randomBytes(28).toString('hex')}`;
    assert.ok(!existsSync(authFile()) || !JSON.parse(readFileSync(authFile(), 'utf8')).openrouter, 'a clean agent folder');
    const dialog = await h.openSettings('Providers');
    // The page lists what is signed in; adding is the "+" in the header, which opens the wizard: how, which, then the key workflow's own steps inside it.
    assert.equal(await dialog.getByTestId('section-providers').locator('pk-get-model').count(), 0, 'no "Add a provider" group on the page');
    await dialog.getByTestId('add-provider').click();
    const wf = page.getByTestId('add-provider-wizard');
    await wf.getByTestId('choice-api_key').click();
    await wf.getByTestId('which-search').fill('openrouter');
    await wf.locator('[data-provider="openrouter"]').click();
    await wf.getByTestId('wizard-continue').click();
    await wf.getByText(/openrouter\.ai\/settings\/keys/).waitFor();
    await wf.getByRole('button', { name: 'I have a key' }).click();
    // The key goes into a password field with nothing to reveal it; its shape is checked, and a key of the wrong shape is called out.
    const field = wf.getByLabel('Paste the key');
    assert.equal(await field.getAttribute('type'), 'password');
    assert.equal(await wf.getByRole('button', { name: /show|reveal|eye/i }).count(), 0);
    await field.fill('sk-ant-not-an-openrouter-key-0000000000000');
    await wf.locator('[data-testid="key-shape"][data-state="mismatch"]').waitFor();
    await field.fill(key);
    await wf.locator('[data-testid="key-shape"][data-state="ok"]').waitFor();
    await wf.getByTestId('validate-save').click();
    // pi stored it, then one request asked the provider (accepted, refused or not reachable; each is said plainly).
    await wf.getByTestId('key-result').waitFor();
    assert.match(await wf.getByTestId('key-status').innerText(), /validated|rejected|not checked/);
    // Settings does not read the keychain just to draw a page, so a stored key is shown without its last four characters.
    assert.match(await wf.getByTestId('saved-as').innerText(), /OpenRouter key, keychain \(.*\), today/);

    const auth = JSON.parse(readFileSync(authFile(), 'utf8'));
    assert.equal(auth.openrouter.type, 'api_key');
    // The world's credential store is a scratch file (PI_KIT_SECRET_STORE): the key is in it, and pi's own file holds the command that prints it (the key is not in auth.json).
    const storeFile = env.server.PI_KIT_SECRET_STORE.replace(/^file:/, '');
    assert.equal(auth.openrouter.key, '!pi-kit-secret get openrouter', 'auth.json holds the command, not the key');
    assert.equal(JSON.parse(readFileSync(storeFile, 'utf8')).openrouter, key, 'the key is in the credential store');
    assert.ok(!readFileSync(authFile(), 'utf8').includes(key.slice(9)), 'no part of the key is in auth.json');
    assert.equal(statSync(authFile()).mode & 0o777, 0o600, 'readable by the user only');
    // Nothing in the page, the DOM or the backend's answers holds the key.
    assert.ok(!(await page.content()).includes(key), 'not in the DOM');
    assert.ok(!(await page.locator('body').innerText()).includes(key), 'not on screen');
    assert.equal(await page.locator('input[type="password"]').count(), 0, 'the field is gone');
    const overview = await api('/api/pi-settings');
    assert.ok(!JSON.stringify(overview).includes(key), 'not in /api/pi-settings');
    assert.equal(overview.providers.find((p) => p.id === 'openrouter').credential.lastFour, undefined, 'a keychain entry is not read to show it');
    assert.equal(overview.providers.find((p) => p.id === 'openrouter').credential.store, 'keychain');
    // pi has a default model already, so the switch "Make … the default" is off and the person's default stays as it was.
    assert.equal(await wf.getByTestId('make-default').locator('input').isChecked(), false);
    await wf.getByTestId('key-done').click();
    await wf.waitFor({ state: 'detached' });
    const card = dialog.locator('[data-provider="openrouter"]');
    await card.getByTestId('credential-line').getByText(/key from keychain \(.*\) · added today/).waitFor();
    assert.ok(!(await dialog.innerText()).includes(key));

    // Sign out removes it from pi's file again.
    await card.getByRole('button', { name: 'Remove the key for OpenRouter' }).click();
    // A provider that is not signed in is not a row any more.
    await card.waitFor({ state: 'detached' });
    assert.equal(JSON.parse(readFileSync(authFile(), 'utf8')).openrouter, undefined);
    assert.equal(JSON.parse(readFileSync(storeFile, 'utf8')).openrouter, undefined, 'and from the credential store');
    await page.keyboard.press('Escape');
  });

  it('turns an extension off and on in the inventory and offers the reload', async () => {
    const { page, h } = app;
    await h.newThread();
    const settingsFile = join(env.project, '.pi', 'settings.json');
    try {
      const dialog = await h.openSettings('Extensions');
      await dialog.getByTestId('section-extensions').getByRole('tab', { name: 'Local files', exact: true }).click();
      const row = dialog.getByTestId('resource-extensions-pk-test');
      await row.waitFor();
      const toggle = row.getByRole('checkbox');
      assert.equal(await toggle.isChecked(), true);
      // pi writes the entry a moment after the click; wait for the file rather than for the spinner.
      const written = async (pattern) => {
        for (let i = 0; i < 40; i++) {
          try {
            if (JSON.parse(readFileSync(settingsFile, 'utf8')).extensions.some((e) => pattern.test(e))) return true;
          } catch {
            // not written yet
          }
          await page.waitForTimeout(250);
        }
        return false;
      };
      await toggle.uncheck();
      await banner(dialog).waitFor();
      assert.ok(await written(/^-.*pk-test/), 'a -path entry in the project settings, as pi config writes it');
      await toggle.check();
      assert.ok(await written(/^\+.*pk-test/), 'and a +path entry when it is turned on again');
      // Reload = /reload: the session reads its extensions again.
      await banner(dialog).getByRole('button', { name: 'Reload now' }).click();
      await banner(dialog).waitFor({ state: 'detached' });
    } finally {
      rmSync(settingsFile, { force: true });
    }
    await page.keyboard.press('Escape');
  });

  it('shows the app and pi versions and what the update check found', async () => {
    const { page, h } = app;
    const dialog = await h.openSettings('General');
    await dialog.getByTestId('section-general').getByRole('tab', { name: 'Versions', exact: true }).click();
    const versions = dialog.getByRole('region', { name: 'Versions' });
    await versions.waitFor();
    const pkg = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.match(await versions.innerText(), new RegExp(`pi-kit\\s+${pkg.version.replace(/\./g, '\\.')}`));
    assert.match(await versions.innerText(), /pi\s+\d+\.\d+\.\d+/);
    // The tests start the backend with PI_SKIP_VERSION_CHECK, as pi itself honours it: the line says so instead of calling pi.dev.
    await versions.getByTestId('pi-update').getByText(/turned off \(PI_SKIP_VERSION_CHECK is set\)/).waitFor();
    const about = await api('/api/about');
    assert.equal(about.app.version, pkg.version);
    await page.keyboard.press('Escape');
  });
});

/** The entries of a thread's pi session file, read from disk (what `pi -c` reads). */
function sessionEntries(file) {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

/** The thread that was changed last, from the backend (the one the test just made or used). */
async function newestThread() {
  const threads = await api('/api/threads');
  return threads.toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
}

describe('model and effort', () => {
  it('flips between the two scoped models with ⌘⇧M, and the next turn is answered by the new model', async () => {
    const { page, h } = app;
    await h.newThread();
    const modelChip = page.getByRole('button', { name: 'Model', exact: true });
    await modelChip.filter({ hasText: MODEL.id }).waitFor();
    assert.ok((await modelChip.innerText()).includes(MODEL.id));
    await h.prompt('Say the word alpha.');
    await page.keyboard.press('Meta+Shift+M');
    const toast = page.locator('.toast', { hasText: `Model: ${ALT_MODEL.id}` });
    await toast.waitFor();
    // The toast is short (1.5 s) and then goes away by itself.
    await toast.waitFor({ state: 'detached' });
    assert.ok((await modelChip.innerText()).includes(ALT_MODEL.id));
    // The small model likes to reach for tools; the proof is the first request it answers, so stop the run after that one.
    const stop = page.locator('pk-composer-well').getByRole('button', { name: 'Stop' });
    const box = page.getByLabel('Message to pi');
    await box.fill('Say the word beta.');
    await box.press('Enter');
    await page.locator('.pk-usage', { hasText: `${ALT_MODEL.id}` }).first().waitFor({ state: 'attached' });
    if (await stop.count()) await stop.click();
    await stop.waitFor({ state: 'detached' });
    await h.settle(500);
    // The turn's usage line names the model that answered it; the first turn names the first model.
    const lines = await page.locator('.pk-usage').allInnerTexts();
    assert.ok(lines[0].includes(MODEL.id));
    assert.ok(lines.at(-1).includes(ALT_MODEL.id));
    // pi's own file has the model_change entry the CLI (`pi -c`) restores the model from.
    const thread = await newestThread();
    const entries = sessionEntries((await api(`/api/threads/${thread.id}/stats`)).sessionFile);
    assert.deepEqual(entries.filter((e) => e.type === 'model_change').map((e) => e.modelId), [MODEL.id, ALT_MODEL.id]);
    const answered = entries.filter((e) => e.message?.role === 'assistant').map((e) => e.message.model);
    assert.equal(answered[0], MODEL.id);
    assert.equal(answered.at(-1), `${ALT_MODEL.id}`);
    // Cycling again returns to the first model: the scope has two entries.
    await page.keyboard.press('Meta+Shift+M');
    await page.locator('.toast', { hasText: `Model: ${MODEL.id}` }).waitFor();
    assert.ok((await modelChip.innerText()).includes(MODEL.id));
  });

  it('lists model metadata and shows an unavailable effort slider for a model that does not think', async () => {
    const { page } = app;
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    const menu = page.getByRole('listbox', { name: 'Models' });
    await menu.waitFor();
    await menu.getByRole('option', { name: THINKING_MODEL.id }).first().waitFor();
    const text = await menu.innerText();
    assert.match(text, /Pinned/);
    assert.match(text, /llama.cpp · 262k context · free/);
    assert.match(text.slice(text.indexOf(THINKING_MODEL.id)), /thinks/);
    const current = (await page.getByRole('button', { name: 'Model', exact: true }).innerText()).trim();
    await page.keyboard.press('Escape');
    // Effort has its own popup. The current model accepts only off, with an explicit explanation.
    await page.locator('pk-composer-well').getByRole('button', { name: /^Thinking effort:/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Thinking effort', exact: true });
    await dialog.waitFor();
    const slider = dialog.getByRole('slider', { name: 'Thinking effort', exact: true });
    assert.equal(await slider.isDisabled(), true);
    assert.equal(await slider.getAttribute('aria-valuetext'), 'off');
    await dialog.getByText(`${current} does not think`, { exact: true }).waitFor();
    await page.keyboard.press('Escape');
  });

  it('writes the effort change into the session, and a change during a run waits for the next request', async () => {
    const { page, h } = app;
    await h.newThread();
    await page.getByRole('button', { name: 'Model', exact: true }).filter({ hasText: MODEL.id }).waitFor();
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await page.getByRole('option', { name: THINKING_MODEL.id }).click();
    await page.getByRole('button', { name: 'Model', exact: true }).filter({ hasText: `${THINKING_MODEL.id}` }).waitFor();
    // qwen thinks: ⌘⇧E moves to the next level it accepts.
    await page.keyboard.press('Meta+Shift+E');
    await page.locator('.toast', { hasText: /Effort: minimal/ }).waitFor();
    await page.locator('pk-composer-well').getByRole('button', { name: 'Thinking effort: minimal', exact: true }).waitFor();
    // During a run the change is queued with a visible hint.
    const box = page.getByLabel('Message to pi');
    await box.fill('Count from 1 to 40, one number per line, and write nothing else.');
    await box.press('Enter');
    await page.locator('pk-composer-well').getByRole('button', { name: 'Stop' }).waitFor();
    await page.keyboard.press('Meta+Shift+E');
    await page.locator('.toast', { hasText: /applies to the next request/ }).waitFor();
    assert.match(await page.locator('.pk-hint').first().innerText(), /Effort low applies to the next request/);
    await page.locator('pk-composer-well').getByRole('button', { name: 'Stop' }).click();
    await page.locator('pk-composer-well').getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached' });
    const thread = await newestThread();
    const entries = sessionEntries((await api(`/api/threads/${thread.id}/stats`)).sessionFile);
    assert.deepEqual(entries.filter((e) => e.type === 'thinking_level_change').map((e) => e.thinkingLevel), ['off', 'minimal', 'low']);
    assert.equal(entries.filter((e) => e.type === 'model_change').at(-1).modelId, `${THINKING_MODEL.id}`);
  });
});

describe('usage and context', () => {
  const numbers = (text) => Number(text.replace(/[^\d.]/g, ''));
  const sessions = {};

  it('shows the context meter in its colour steps and the nearly-full warning', async () => {
    const { page } = app;
    const cases = [
      ['Meter fifteen', 40_000, 'ok', '16%'],
      ['Meter seventy-three', 190_000, 'warning', '73%'],
      ['Meter ninety-five', 250_000, 'error', '96%'],
    ];
    for (const [name, contextTokens] of cases) sessions[name] = writeUsageSession({ agentDir: env.agentDir, cwd: env.project, name, contextTokens });
    await page.reload();
    await page.waitForSelector('pk-root .pk-shell');
    for (const [name, , level, percent] of cases) {
      await page.locator('.pk-thread', { hasText: name }).first().waitFor();
      await page.locator('.pk-thread', { hasText: name }).first().click();
      const meter = page.getByTestId('context-meter');
      await meter.filter({ hasText: percent }).waitFor();
      assert.equal(await meter.getAttribute('data-level'), level, name);
      // From 90 % the composer warns and the transcript gets a marker; pi's threshold (94 %) decides what they say pi will do.
      assert.equal(await page.getByTestId('context-warning').count(), level === 'error' ? 1 : 0, name);
      if (level === 'error') {
        assert.match(await page.getByTestId('context-warning').innerText(), /Context nearly full, pi will compact on the next turn/);
        assert.match(await page.getByTestId('context-marker').innerText(), /Context 96% full/);
      } else {
        assert.equal(await page.getByTestId('context-marker').count(), 0);
      }
    }
  });

  it("matches pi's own session numbers, and the usage dialog totals equal the sum of its turns", async () => {
    const { page } = app;
    await page.locator('.pk-thread', { hasText: 'Meter seventy-three' }).first().click();
    await page.getByTestId('context-meter').filter({ hasText: '73%' }).waitFor();
    const thread = (await api('/api/threads')).find((t) => t.title === 'Meter seventy-three');
    const usage = await api(`/api/threads/${thread.id}/usage`);
    const stats = await api(`/api/threads/${thread.id}/stats`);
    // `/session` (pi's getSessionStats) and the aggregation of the file agree.
    assert.deepEqual({ input: usage.totals.input, output: usage.totals.output, cacheRead: usage.totals.cacheRead, cacheWrite: usage.totals.cacheWrite, total: usage.totals.total }, stats.tokens);
    assert.ok(Math.abs(usage.totals.cost - stats.cost) < 1e-9);
    assert.equal(usage.totals.turns, stats.userMessages);
    assert.equal(usage.totals.input, 1000 + 190_000);
    // The status bar shows the totals, and clicking them opens the dialog.
    assert.match(await page.getByTestId('status-totals').innerText(), /\$0\.0400 · 192k tokens · 2 turns/);
    await page.getByTestId('status-totals').click();
    const dialog = page.getByRole('dialog', { name: 'Usage' });
    await dialog.waitFor();
    const rows = dialog.getByTestId('usage-turn-row');
    assert.equal(await rows.count(), 2);
    const column = async (index) => (await rows.evaluateAll((els, i) => els.map((el) => el.children[i].textContent), index)).map(numbers);
    const sum = (list) => list.reduce((a, b) => a + b, 0);
    assert.equal(sum(await column(2)), numbers(await dialog.getByTestId('usage-sum-in').innerText()));
    assert.equal(sum(await column(2)), usage.totals.input);
    assert.equal(sum(await column(3)), usage.totals.output);
    assert.ok(Math.abs(sum(await column(6)) - numbers(await dialog.getByTestId('usage-cost').innerText())) < 1e-9);
    assert.match(await dialog.getByRole('table', { name: 'Usage by model' }).innerText(), /llama-swap\/gemma-4-26b/);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  });

  it('counts a turn the pi CLI added to the file, and opens the dialog with /cost', async () => {
    const { page } = app;
    const thread = (await api('/api/threads')).find((t) => t.title === 'Meter fifteen');
    const file = sessions['Meter fifteen'].file;
    const before = (await api(`/api/threads/${thread.id}/usage`)).totals;
    // A turn written by something else (the CLI) while the app has the file: appended as pi would.
    const leaf = sessionEntries(file).at(-1);
    const user = { type: 'message', id: 'cli00001', parentId: leaf.id, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'A question from the CLI.' }], timestamp: Date.now() } };
    const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0.5 } };
    const answer = { type: 'message', id: 'cli00002', parentId: 'cli00001', timestamp: new Date(Date.now() + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'An answer.' }], api: 'openai-completions', provider: 'llama-swap', model: 'gemma-4-26b', usage, stopReason: 'stop', timestamp: Date.now() } };
    appendFileSync(file, `${JSON.stringify(user)}\n${JSON.stringify(answer)}\n`);
    const after = (await api(`/api/threads/${thread.id}/usage`)).totals;
    assert.equal(after.input, before.input + 7);
    assert.equal(after.turns, before.turns + 1);
    assert.ok(Math.abs(after.cost - before.cost - 0.5) < 1e-9);
    await page.locator('.pk-thread', { hasText: 'Meter fifteen' }).first().click();
    const box = page.getByLabel('Message to pi');
    await box.waitFor();
    await box.fill('/cost');
    await page.getByRole('option', { name: /^\/cost/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Usage' });
    await dialog.waitFor();
    assert.equal(numbers(await dialog.getByTestId('usage-turns').innerText()), after.turns);
    await page.keyboard.press('Escape');
  });

  it('shows the usage line on hover and under every turn once "Show usage" is on', async () => {
    const { page } = app;
    await page.locator('.pk-thread', { hasText: 'Meter seventy-three' }).first().click();
    await page.getByTestId('context-meter').filter({ hasText: '73%' }).waitFor();
    const line = page.locator('.pk-usage').last();
    await line.waitFor({ state: 'attached' });
    const opacity = () => line.evaluate((el) => getComputedStyle(el).opacity);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    assert.equal(await opacity(), '0');
    assert.match(await line.innerText(), /^in 190k · out 200 · cache read 500 · \$0\.0300 · 2\.0s · gemma-4-26b$/);
    await page.locator('.pk-turn').last().hover();
    await page.waitForTimeout(250);
    assert.equal(await opacity(), '1');
    // the ring opens a popover; "Usage by turn" in it opens the dialog.
    await page.getByTestId('context-meter').click();
    await page.getByTestId('usage-by-turn').click();
    const dialog = page.getByRole('dialog', { name: 'Usage' });
    await dialog.getByRole('checkbox').check();
    await page.keyboard.press('Escape');
    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    assert.equal(await opacity(), '1');
    // Leave it as it was.
    // the ring opens a popover; "Usage by turn" in it opens the dialog.
    await page.getByTestId('context-meter').click();
    await page.getByTestId('usage-by-turn').click();
    await dialog.getByRole('checkbox').uncheck();
    await page.keyboard.press('Escape');
  });
});

describe('backend restarts', () => {
  it('shows a toast and reopens the thread when the backend process comes back', async () => {
    const { page, h } = app;
    await h.newThread();
    await h.prompt('Say the word alive.');
    await restartBackend(page);
    await page.getByText('Say the word alive.').first().waitFor();
    await h.prompt('Say the word again.');
  });
});
