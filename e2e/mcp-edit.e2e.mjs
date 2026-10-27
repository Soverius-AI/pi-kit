// End to end: editing MCP servers and their files from Settings. A backend of this file's own on a scratch pi folder, a scratch credential store and a scratch `mcp.json`;
// nothing outside the scratch folder is touched, and no real keychain.
//
// Walk: add a command server through the wizard's form with an environment secret (the file has the command that prints it, the store has the value, no file has the value, `pi mcp list`
// agrees) -> Edit: the form is prefilled and the secret shows as stored, a change reaches the file, a typed secret replaces the stored one, a rename moves the entry -> Edit here: the file in the
// editor, a mistake marks its line and disables Save, ⌘S saves and the servers are read again, a file changed behind the editor is refused -> Remove server… asks first and takes the secret with it ->
// a project server cannot hold a secret.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { env, openApp } from './support/app.mjs';
import { createWorld, isUp, root } from './support/env.mjs';

const PORT = Number(new URL(env.api).port) + 25;
const API = `http://127.0.0.1:${PORT}`;
const SERVER = join(root, 'examples', 'mcp-app-server', 'server.mjs');
const SECRET = 'sk-e2e-edit-0123456789abcdef0123456789abcdef';
const SECOND = 'sk-e2e-edit-fedcba9876543210fedcba9876543210';
const ACCOUNT = 'mcp-files-env-API_KEY';
const COMMAND = `!pi-kit-secret get ${ACCOUNT}`;

let world;
let backend;
let app;
let logFd;
let secretsFile;
let launcherDir;

async function call(path, init = {}) {
  const { token } = await (await fetch(`${API}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = execFile(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
    child.stdin.end();
  });

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const userFile = () => join(world.agent, 'mcp.json');
const projectFile = () => join(world.project, '.pi', 'mcp.json');
const servers = (file) => (existsSync(file) ? (readJson(file).mcpServers ?? {}) : {});
const secrets = () => (existsSync(secretsFile) ? readJson(secretsFile) : {});

function filesContaining(dir, needle, skip = []) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (skip.includes(path) || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) walk(path);
      else if (statSync(path).size < 50_000_000 && readFileSync(path).includes(Buffer.from(needle))) found.push(path);
    }
  };
  walk(dir);
  return found;
}

/** `pi mcp list --json` the way a terminal runs it: pi's own CLI against the scratch agent folder, with `pi-kit-secret` on PATH for the credential command. */
async function piMcpList() {
  const piCli = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
  const terminal = { ...process.env, PI_CODING_AGENT_DIR: world.agent, PI_KIT_SECRET_STORE: `file:${secretsFile}`, PATH: `${launcherDir}:${process.env.PATH}`, PI_OFFLINE: '1', NO_COLOR: '1' };
  const listed = await run('node', [piCli, 'mcp', 'list', '--json'], { env: terminal, cwd: world.base });
  let json;
  try {
    json = JSON.parse(listed.stdout);
  } catch {
    json = undefined;
  }
  return { ...listed, json };
}

before(async () => {
  world = createWorld({ extraEnv: ({ base }) => ({ PI_KIT_NO_BROWSER: '1', PI_KIT_HOME: join(base, 'home') }) });
  mkdirSync(join(world.base, 'home'), { recursive: true });
  secretsFile = join(world.base, 'secrets.json');
  launcherDir = join(world.data, 'bin');
  logFd = openSync(join(world.base, 'mcp-edit-backend.log'), 'w');
  backend = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: root,
    env: { ...process.env, ...world.env, NODE_ENV: 'development', PI_KIT_PORT: String(PORT), PI_KIT_ORIGIN: env.base, PI_KIT_VERSION: '0.0.0-e2e' },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  const deadline = Date.now() + 60_000;
  while (!(await isUp(`${API}/api/dev/token`, { Origin: env.base }))) {
    if (Date.now() > deadline) throw new Error('The mcp-edit test backend did not start.');
    await new Promise((r) => setTimeout(r, 300));
  }
  app = await openApp({ backend: API });
  await app.h.newThread();
});

after(async () => {
  await app?.close();
  try {
    process.kill(-backend.pid, 'SIGKILL');
  } catch {
    // gone already
  }
  if (logFd !== undefined) closeSync(logFd);
  world?.dispose();
});

const settings = () => app.page.getByRole('dialog', { name: 'Settings' });
const row = (name) => settings().getByTestId(`mcp-row-${name}`);
const inState = (name, state, timeout = 60_000) => settings().locator(`[data-testid="mcp-row-${name}"][data-state="${state}"]`).waitFor({ timeout });
const gone = (name, timeout = 60_000) => settings().getByTestId(`mcp-row-${name}`).waitFor({ state: 'detached', timeout });
const wizard = () => app.page.getByTestId('add-server-wizard');
const edit = (name) => app.page.getByRole('dialog', { name: `Edit ${name}` });
const editor = () => app.page.getByTestId('file-editor');
async function list() {
  if ((await settings().count()) === 0) await app.h.openSettings();
  await settings().getByRole('tab', { name: /MCP servers/ }).click();
  await settings().getByTestId('section-mcp').waitFor();
  await settings().getByTestId('section-mcp').getByRole('tab', { name: 'Servers', exact: true }).click();
}
/** The wizard to the details of a server of your own, a command. */
async function custom(fill) {
  await list();
  await settings().getByTestId('add-server').click();
  await wizard().getByTestId('tile-custom').click();
  await wizard().getByTestId('server-form').waitFor();
  await fill(wizard());
}

describe('add a server of your own through the form', () => {
  it('a command with arguments and an environment: the secret goes to the credential store, the file gets the command that prints it', async () => {
    await custom(async (w) => {
      await w.getByTestId('custom-name').fill('files');
      await w.getByTestId('custom-kind').selectOption('command');
      await w.getByTestId('custom-command').fill('node');
      await w.getByTestId('custom-args').fill(SERVER);
      await w.getByTestId('custom-description').fill('A toy issue tracker');
      await w.getByTestId('env-add').click();
      await w.getByTestId('env-key-0').fill('ROOT');
      await w.getByTestId('env-value-0').fill('/srv/data');
      await w.getByTestId('env-add').click();
      await w.getByTestId('env-key-1').fill('API_KEY');
      await w.getByTestId('env-value-1').fill(SECRET);
      assert.equal(await w.getByTestId('env-value-0').getAttribute('type'), 'text', 'a path is not a secret');
      assert.equal(await w.getByTestId('env-value-1').getAttribute('type'), 'password', 'its name says it is');
      // "As it will be written": the command, never the value
      await w.locator('[data-testid="as-written"] summary').click();
      const written = await w.getByTestId('as-written-text').innerText();
      assert.match(written, /"ROOT": "\/srv\/data"/);
      assert.match(written, new RegExp(`"API_KEY": "!pi-kit-secret get ${ACCOUNT}"`));
      assert.doesNotMatch(written, new RegExp(SECRET));
      assert.doesNotMatch(await w.innerText(), new RegExp(SECRET));
    });
    await wizard().getByTestId('server-add').click();
    await wizard().waitFor({ state: 'detached' });
    await row('files').waitFor();
    await inState('files', 'connected');
    assert.deepEqual(servers(userFile()).files, { command: 'node', args: [SERVER], env: { ROOT: '/srv/data', API_KEY: COMMAND }, description: 'A toy issue tracker' });
    assert.equal(secrets()[ACCOUNT], SECRET);
    assert.deepEqual(filesContaining(world.base, SECRET, [secretsFile]), [], 'the secret is in the credential store only');
    const { status, json } = await piMcpList();
    assert.equal(status, 0, 'pi lists the file without an error');
    assert.ok(JSON.stringify(json).includes('"files"'), 'and knows the server');
  });
});

describe('edit it', () => {
  it('the form is prefilled from the file, the secret shows as stored and its value is nowhere on the page', async () => {
    await row('files').getByTestId('edit-files').click();
    const dialog = edit('files');
    await dialog.getByTestId('custom-command').waitFor();
    assert.equal(await dialog.getByTestId('custom-name').inputValue(), 'files');
    assert.equal(await dialog.getByTestId('custom-command').inputValue(), 'node');
    assert.equal(await dialog.getByTestId('custom-args').inputValue(), SERVER);
    assert.equal(await dialog.getByTestId('env-key-0').inputValue(), 'ROOT');
    assert.equal(await dialog.getByTestId('env-value-0').inputValue(), '/srv/data');
    const stored = dialog.getByTestId('env-value-1');
    assert.equal(await stored.inputValue(), '');
    assert.equal(await stored.getAttribute('type'), 'password');
    assert.match(await stored.getAttribute('placeholder'), /Stored in your keychain/);
    assert.equal(await dialog.getByTestId('details-scope').isDisabled(), true);
    assert.doesNotMatch(await dialog.innerText(), new RegExp(SECRET));
    assert.doesNotMatch(await app.page.content(), new RegExp(SECRET));
  });

  it('a change reaches the file, the stored secret is kept as it is, and the server reconnects', async () => {
    const dialog = edit('files');
    await dialog.getByTestId('custom-description').fill('Files, edited');
    await dialog.getByTestId('details-exposure').selectOption('deferred');
    await dialog.getByTestId('env-value-0').fill('/srv/other');
    await dialog.getByTestId('server-save').click();
    await dialog.waitFor({ state: 'detached' });
    await inState('files', 'connected');
    assert.deepEqual(servers(userFile()).files, { command: 'node', args: [SERVER], env: { ROOT: '/srv/other', API_KEY: COMMAND }, description: 'Files, edited', exposure: 'deferred' });
    assert.equal(secrets()[ACCOUNT], SECRET, 'a row nobody touched keeps its stored value');
    assert.match(await row('files').innerText(), /Files, edited/);
  });

  it('typing over a stored secret replaces it in the store, and the file does not change', async () => {
    await row('files').getByTestId('edit-files').click();
    const dialog = edit('files');
    await dialog.getByTestId('env-value-1').fill(SECOND);
    await dialog.getByTestId('server-save').click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(secrets()[ACCOUNT], SECOND);
    assert.equal(servers(userFile()).files.env.API_KEY, COMMAND);
    assert.deepEqual(filesContaining(world.base, SECOND, [secretsFile]), []);
    assert.deepEqual(filesContaining(world.base, SECRET, [secretsFile]), []);
  });

  it('a rename moves the entry; a name that is taken is refused and the dialog stays', async () => {
    writeFileSync(userFile(), JSON.stringify({ mcpServers: { ...servers(userFile()), other: { command: 'node', args: [SERVER] } } }, null, 2));
    await settings().getByTestId('mcp-reload').click();
    await row('other').waitFor();
    await row('files').getByTestId('edit-files').click();
    const dialog = edit('files');
    await dialog.getByTestId('custom-name').fill('other');
    await dialog.getByTestId('server-save').click();
    await dialog.getByTestId('server-notice').waitFor();
    assert.match(await dialog.getByTestId('server-notice').innerText(), /named “other” already/);
    assert.ok('files' in servers(userFile()), 'nothing moved');
    await dialog.getByTestId('custom-name').fill('files2');
    await dialog.getByTestId('server-save').click();
    await dialog.waitFor({ state: 'detached' });
    await row('files2').waitFor();
    await gone('files');
    assert.deepEqual(Object.keys(servers(userFile())).sort(), ['files2', 'other']);
    assert.equal(servers(userFile()).files2.env.API_KEY, COMMAND, 'the secret is still read from the same account');
    await inState('files2', 'connected');
  });
});

describe('Edit here: the file in an editor', () => {
  it('shows the file with line numbers and colours, and a mistake marks its line and disables Save', async () => {
    await settings().getByTestId('section-mcp').getByRole('tab', { name: 'Configuration', exact: true }).click();
    await settings().getByTestId('edit-file-user').click();
    const e = editor();
    await e.locator('textarea').waitFor();
    const text = await e.locator('textarea').inputValue();
    assert.equal(text, readFileSync(userFile(), 'utf8'));
    assert.equal(await e.locator('.ln span').count(), text.split('\n').length);
    assert.ok((await e.locator('.hl .k').count()) > 5, 'property names are coloured');
    assert.equal(await e.getByTestId('editor-status').getAttribute('data-valid'), 'yes');
    assert.equal(await e.getByTestId('editor-save').isDisabled(), true, 'nothing changed yet');
    // a mistake in the value of "exposure"
    const lineOf = (s, needle) => s.split('\n').findIndex((l) => l.includes(needle)) + 1;
    const broken = text.replace('"exposure": "deferred"', '"exposure": "deferd"');
    await e.locator('textarea').fill(broken);
    const line = lineOf(broken, '"deferd"');
    await e.getByTestId('editor-problem').waitFor();
    assert.equal((await e.getByTestId('editor-problem').innerText()).trim(), `Line ${line}: exposure must be one of codemode, deferred, direct, hidden.`);
    assert.equal(await e.locator('.ln span.err').innerText(), String(line), 'the gutter marks the line');
    assert.equal(await e.getByTestId('editor-save').isDisabled(), true);
    // a syntax error is on its line too
    const syntax = text.replace('"command": "node",', '"command": "node"');
    await e.locator('textarea').fill(syntax);
    assert.match(await e.getByTestId('editor-problem').innerText(), /^Line \d+: Expected "," or "}"/);
    assert.equal(await e.getByTestId('editor-save').isDisabled(), true);
  });

  it('⌘S saves a valid text, the editor closes, the file has it and the servers are read again', async () => {
    const e = editor();
    const file = readJson(userFile());
    file.mcpServers.third = { command: 'node', args: [SERVER], description: 'Added in the editor' };
    const next = `${JSON.stringify(file, null, 2)}\n`;
    await e.locator('textarea').fill(next);
    await e.getByTestId('editor-status').locator('.dot:not(.bad)').waitFor();
    assert.equal(await e.getByTestId('editor-save').isDisabled(), false);
    await e.locator('textarea').press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
    await e.waitFor({ state: 'detached' });
    assert.equal(readFileSync(userFile(), 'utf8'), next);
    await settings().getByTestId('section-mcp').getByRole('tab', { name: 'Servers', exact: true }).click();
    await row('third').waitFor();
    await inState('third', 'connected');
    assert.match(await row('third').innerText(), /Added in the editor/);
  });

  it('a file that changed behind the editor is refused with "Reload and try again", and Reload reads it', async () => {
    await settings().getByTestId('section-mcp').getByRole('tab', { name: 'Configuration', exact: true }).click();
    await settings().getByTestId('edit-file-user').click();
    const e = editor();
    await e.locator('textarea').waitFor();
    const behind = readJson(userFile());
    behind.mcpServers.third.description = 'Changed behind the editor';
    writeFileSync(userFile(), `${JSON.stringify(behind, null, 2)}\n`);
    const future = new Date(Date.now() + 10_000);
    utimesSync(userFile(), future, future);
    const mine = (await e.locator('textarea').inputValue()).replace('Added in the editor', 'Mine');
    await e.locator('textarea').fill(mine);
    await e.getByTestId('editor-save').click();
    await e.getByTestId('editor-error').waitFor();
    assert.match(await e.getByTestId('editor-error').innerText(), /Reload and try again/);
    assert.equal(await e.getByTestId('editor-save').isDisabled(), true);
    assert.match(readFileSync(userFile(), 'utf8'), /Changed behind the editor/, 'the file was not overwritten');
    await e.getByTestId('editor-revert').click();
    await app.page.waitForFunction(() => /Changed behind the editor/.test(document.querySelector('[data-testid="file-editor"] textarea')?.value ?? ''));
    assert.equal(await e.getByTestId('editor-error').count(), 0);
    await app.page.keyboard.press('Escape');
    await e.waitFor({ state: 'detached' });
  });

  it('closing an editor with unsaved changes asks first', async () => {
    await settings().getByTestId('section-mcp').getByRole('tab', { name: 'Configuration', exact: true }).click();
    await settings().getByTestId('edit-file-user').click();
    const e = editor();
    await e.locator('textarea').fill('{}');
    await app.page.keyboard.press('Escape');
    await e.getByTestId('discard').waitFor();
    assert.match(await e.innerText(), /Discard your changes\?/);
    await e.getByTestId('keep-editing').click();
    await e.getByTestId('discard').waitFor({ state: 'detached' });
    assert.equal(await e.locator('textarea').evaluate((el) => document.activeElement === el), true, 'the caret is back in the text, so Escape still reaches the dialog');
    await app.page.keyboard.press('Escape');
    await e.getByTestId('discard').click();
    await e.waitFor({ state: 'detached' });
    assert.ok('third' in servers(userFile()), 'nothing was saved');
  });
});

describe('Remove server…', () => {
  it('asks first, and then takes the entry and the secret it kept', async () => {
    await list();
    await row('files2').getByTestId('edit-files2').click();
    const dialog = edit('files2');
    await dialog.getByTestId('remove-server').click();
    assert.match(await dialog.getByTestId('remove-confirm').innerText(), /Remove files2\?/);
    await dialog.getByTestId('remove-cancel').click();
    assert.ok('files2' in servers(userFile()), 'asking changed nothing');
    await dialog.getByTestId('remove-server').click();
    await dialog.getByTestId('remove-confirm-yes').click();
    await dialog.waitFor({ state: 'detached' });
    await gone('files2');
    assert.equal(servers(userFile()).files2, undefined);
    assert.equal(secrets()[ACCOUNT], undefined, 'the secret went with the server');
    for (const name of ['other', 'third']) {
      await row(name).getByTestId(`edit-${name}`).click();
      await edit(name).getByTestId('remove-server').click();
      await edit(name).getByTestId('remove-confirm-yes').click();
      await edit(name).waitFor({ state: 'detached' });
      await gone(name);
    }
    assert.deepEqual(servers(userFile()), {});
  });
});

describe('a project server', () => {
  it('goes into the folder’s .pi/mcp.json, and cannot hold a secret: the dialog says where credentials stay', async () => {
    await custom(async (w) => {
      await w.getByTestId('details-scope').selectOption('project');
      await w.getByTestId('custom-name').fill('local-docs');
      await w.getByTestId('custom-url').fill('http://127.0.0.1:9/mcp');
      await w.getByTestId('headers-add').click();
      await w.getByTestId('headers-key-0').fill('Authorization');
      await w.getByTestId('headers-value-0').fill('Bearer project-token-0123456789abcdef');
    });
    // the check finds nothing at that address; "Add anyway" goes ahead to the request, which the backend refuses
    await wizard().getByTestId('server-add').click();
    await wizard().getByTestId('check-result').waitFor();
    await wizard().getByTestId('server-add').click();
    await wizard().getByTestId('server-notice').waitFor();
    assert.match(await wizard().getByTestId('server-notice').innerText(), /stays in your user file/);
    assert.equal(existsSync(projectFile()), false, 'nothing was written');
    // without the secret it is a project server
    await wizard().getByTestId('headers-remove-0').click();
    await wizard().getByTestId('server-add').click();
    await wizard().waitFor({ state: 'detached' });
    await row('local-docs').waitFor();
    assert.equal(servers(projectFile())['local-docs'].url, 'http://127.0.0.1:9/mcp');
    assert.equal(servers(userFile())['local-docs'], undefined);
    await row('local-docs').getByTestId('edit-local-docs').click();
    const dialog = edit('local-docs');
    await dialog.getByTestId('custom-url').waitFor();
    assert.equal(await dialog.locator('.head .chip').innerText(), 'project');
    await dialog.getByTestId('remove-server').click();
    await dialog.getByTestId('remove-confirm-yes').click();
    await gone('local-docs');
    assert.deepEqual(servers(projectFile()), {});
    assert.equal((await call('/api/mcp/servers/nope?scope=user')).status, 404);
  });
});
