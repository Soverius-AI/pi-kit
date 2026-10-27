// End to end: connectors, now rows of Settings › MCP servers added through the "+" wizard. A backend of this file's own on a scratch pi folder and the scratch credential store, and a mock MCP server with a mock OAuth authorization server
// in front of it (e2e/support/mock-oauth-mcp.mjs) that the catalog's endpoints are pointed at (`PI_KIT_CONNECTOR_URLS`, development only). Nothing leaves the machine, no vendor account is used.
// The "browser" is this test: pi does not open one (`PI_KIT_NO_BROWSER`), the test opens the authorization URL the card shows, as a browser does, and pi's loopback callback answers.
//
// Walk: a clean config (an empty list, the wizard's gallery) -> add Linear (OAuth: the waiting row with its fallback link, the browser, connected with its tools and an MCP App, the group in the
// / menu, `pi mcp list` agrees) -> More › Remove takes out the entry and the token -> the sign-in state machine (refused at the authorization page, given up, refreshed after the token expired,
// revoked at the vendor) -> the token path through the wizard's details (GitHub: the token is in the credential store and in no file, `pi mcp list` resolves it) -> project only (appears only in
// that folder, needs trust) -> a custom server and its reachability check -> The files group -> tooltips -> the sidebar count and `/connect` open the MCP servers section.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { env, openApp } from './support/app.mjs';
import { createWorld, isUp, root } from './support/env.mjs';
import { BEARER_TOKEN, openAuthorizationUrl, startMockOAuthMcp } from './support/mock-oauth-mcp.mjs';

const PORT = Number(new URL(env.api).port) + 21;
const API = `http://127.0.0.1:${PORT}`;
const TOKEN = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

let world;
let mock;
let backend;
let app;
let logFd;
let secretsFile;
let launcherDir;
let other;

async function call(path, init = {}) {
  const { token } = await (await fetch(`${API}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
const post = (path, body) => call(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = execFile(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
    child.stdin.end();
  });

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const userFile = () => join(world.agent, 'mcp.json');
const projectFile = () => join(world.project, '.pi', 'mcp.json');
const servers = (file) => (existsSync(file) ? (readJson(file).mcpServers ?? {}) : {});
const authFile = () => join(world.agent, 'mcp-auth.json');
const stored = () => (existsSync(authFile()) ? readJson(authFile()) : {});
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
  mock = await startMockOAuthMcp();
  world = createWorld({
    extraEnv: () => ({
      PI_KIT_NO_BROWSER: '1',
      PI_KIT_CONNECTOR_URLS: JSON.stringify({ linear: `${mock.url}/mcp`, 'linear/readonly': `${mock.url}/readonly/mcp`, notion: `${mock.url}/mcp`, sentry: `${mock.url}/mcp`, github: `${mock.url}/bearer/mcp` }),
    }),
  });
  secretsFile = join(world.base, 'secrets.json');
  launcherDir = join(world.data, 'bin');
  logFd = openSync(join(world.base, 'connectors-backend.log'), 'w');
  backend = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: root,
    env: { ...process.env, ...world.env, NODE_ENV: 'development', PI_KIT_PORT: String(PORT), PI_KIT_ORIGIN: env.base, PI_KIT_VERSION: '0.0.0-e2e' },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  const deadline = Date.now() + 60_000;
  while (!(await isUp(`${API}/api/dev/token`, { Origin: env.base }))) {
    if (Date.now() > deadline) throw new Error('The connectors test backend did not start.');
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
  await mock?.close();
  if (logFd !== undefined) closeSync(logFd);
  world?.dispose();
});

const settings = () => app.page.getByRole('dialog', { name: 'Settings' });
const row = (name) => settings().getByTestId(`mcp-row-${name}`);
const inState = (name, state, timeout = 60_000) => settings().locator(`[data-testid="mcp-row-${name}"][data-state="${state}"]`).waitFor({ timeout });
const gone = (name, timeout = 60_000) => settings().getByTestId(`mcp-row-${name}`).waitFor({ state: 'detached', timeout });
const wizard = () => app.page.getByTestId('add-server-wizard');
async function list() {
  if ((await settings().count()) === 0) await app.h.openSettings();
  await settings().getByRole('tab', { name: /MCP servers/ }).click();
  await settings().getByTestId('section-mcp').waitFor();
  await settings().getByTestId('section-mcp').getByRole('tab', { name: 'Servers', exact: true }).click();
}
const threadId = async () => (await call('/api/threads')).body[0].id;
const mcpServer = async (name) => (await call(`/api/mcp?thread=${await threadId()}`)).body.servers.find((s) => s.name === name);
/** The "+" and the gallery: a catalog tile, then "Add and sign in / connect" on its details. `scope` is the gallery's select; `fill` types into the details first. */
async function add(id, { scope, fill } = {}) {
  await list();
  await settings().getByTestId('add-server').click();
  await wizard().getByTestId(`tile-${id}`).waitFor();
  if (scope) await wizard().getByTestId('gallery-scope').selectOption(scope);
  await wizard().getByTestId(`tile-${id}`).click();
  await wizard().getByTestId('server-form').waitFor();
  await fill?.(wizard());
  await wizard().getByTestId('server-add').click();
}
/** More › Remove of a row. */
async function remove(name) {
  await row(name).getByTestId(`more-${name}`).click();
  await app.page.getByRole('menuitem', { name: 'Remove' }).click();
}
/** The authorization URL the row shows while it waits, opened the way a browser would. */
async function browse(name) {
  const link = row(name).getByTestId(`signin-url-${name}`);
  await link.waitFor();
  return openAuthorizationUrl(await link.getAttribute('href'));
}

describe('a clean user config', () => {
  it('lists no server, invites with the "+", and the wizard’s gallery has the catalog and "Your own server" last; looking writes nothing', async () => {
    await list();
    await settings().getByTestId('mcp-empty').waitFor();
    assert.match(await settings().getByTestId('mcp-empty').innerText(), /No MCP servers yet/);
    // the Connectors section is gone from the nav, its count and its catalog moved into this one
    assert.equal(await settings().getByRole('tab', { name: /^Connectors/ }).count(), 0);
    await settings().getByTestId('add-server').click();
    await wizard().getByTestId('tile-linear').waitFor();
    const tiles = await wizard().locator('.pk-gallery button').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-testid')));
    assert.deepEqual(tiles, ['linear', 'github', 'slack', 'notion', 'sentry', 'atlassian', 'figma'].map((id) => `tile-${id}`).concat('tile-custom'));
    assert.match(await wizard().innerText(), /unverified|Your own server/);
    assert.equal(existsSync(userFile()), false, 'looking at the gallery wrote nothing');
    await app.page.keyboard.press('Escape');
    await wizard().waitFor({ state: 'detached' });
    assert.equal(await settings().count(), 1, 'Escape closed the wizard and not the Settings window behind it');
    assert.match(await settings().getByTestId('section-mcp').innerText(), /Endpoints were read from each vendor/);
  });
});

describe('Linear: OAuth through the browser', () => {
  it('Add and sign in writes the entry, waits for the browser and shows the authorization link with a Copy button', async () => {
    await add('linear');
    await wizard().waitFor({ state: 'detached' });
    await inState('linear', 'signing-in');
    const panel = row('linear').getByTestId('signin-panel-linear');
    assert.match(await panel.innerText(), /Waiting for your browser/);
    const href = await row('linear').getByTestId('signin-url-linear').getAttribute('href');
    assert.match(href, new RegExp(`^${mock.url}/authorize\\?`));
    const url = new URL(href);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // pi registered itself (dynamic client registration), as pi
    assert.equal(mock.registrations.length, 1);
    assert.equal(mock.registrations[0].client_name, 'pi');
    // the entry is pi's own format, in the user file: the URL, nothing secret
    assert.deepEqual(servers(userFile()).linear, { url: `${mock.url}/mcp`, description: 'Find, create and update issues, projects and comments in Linear.', exposure: 'direct' });
    assert.equal(existsSync(projectFile()), false);
  });

  it('the Copy button puts the link on the clipboard', async () => {
    const context = app.page.context();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.base });
    await row('linear').getByTestId('copy-url-linear').click();
    const href = await row('linear').getByTestId('signin-url-linear').getAttribute('href');
    assert.equal(await app.page.evaluate(() => navigator.clipboard.readText()), href);
  });

  it('back from the browser the row is connected, lists its tools and the MCP App, and the tools are in the / menu', async () => {
    const answered = await browse('linear');
    assert.equal(answered.status, 200, 'pi’s callback page answered');
    assert.match(answered.page, /Signed in/i);
    await inState('linear', 'connected');
    assert.match(await row('linear').getByTestId('tools-count-linear').innerText(), /2 tools/);
    await row('linear').getByTestId('toggle-tools-linear').click();
    const tools = await row('linear').getByTestId('tools-linear').innerText();
    assert.match(tools, /open_issue_form/);
    assert.match(tools, /create_issue/);
    assert.match(await row('linear').innerText(), /1 app/, 'a tool that opens an MCP App is counted');
    // the sign-in left a token pi keeps, and the nav says one server is on
    assert.ok(Object.keys(stored()).some((key) => key.includes('linear')), 'pi stored the token in mcp-auth.json');
    assert.match(await settings().getByRole('tab', { name: /MCP servers/ }).innerText(), /1 on/);
    // the / menu: a group of its own, named like the issue says
    await app.page.keyboard.press('Escape');
    await settings().waitFor({ state: 'detached' });
    const box = app.page.getByLabel('Message to pi');
    await box.fill('/');
    await app.page.getByText('Linear: open issue form, create issue').first().waitFor();
    assert.ok((await app.page.getByText('Connectors', { exact: true }).count()) > 0, 'the group has its heading');
    await box.fill('');
  });

  it('pi mcp list, run in a terminal against the same agent folder, sees the connector connected with its tools', async () => {
    const listed = await piMcpList();
    assert.equal(listed.status, 0, `pi mcp list exited ${listed.status}: ${listed.stderr}${listed.stdout}`);
    const text = JSON.stringify(listed.json ?? listed.stdout);
    assert.match(text, /linear/);
    assert.match(text, /open_issue_form/);
  });

  it('the Tools select saves to the file and the session reloads', async () => {
    await list();
    await row('linear').getByTestId('exposure-linear').selectOption('deferred');
    // The row shows no spinner before the save starts as well as after it ends: wait for the file itself.
    for (let i = 0; i < 100 && servers(userFile()).linear.exposure !== 'deferred'; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(servers(userFile()).linear.exposure, 'deferred');
    await inState('linear', 'connected');
    await row('linear').getByTestId('exposure-linear').selectOption('direct');
    await app.page.waitForFunction(() => !document.querySelector('[data-testid="mcp-row-linear"] .loading'), null);
    assert.equal(servers(userFile()).linear.exposure, 'direct');
    await inState('linear', 'connected');
  });

  it('More › Remove takes out the entry and the token', async () => {
    await remove('linear');
    await gone('linear');
    assert.equal(servers(userFile()).linear, undefined, 'the entry is gone');
    assert.deepEqual(Object.keys(stored()).filter((key) => key.includes('linear')), [], 'pi signed out: the token is gone');
    const listed = await piMcpList();
    assert.doesNotMatch(JSON.stringify(listed.json ?? listed.stdout), /linear/);
  });
});

describe('the sign-in state machine, against the mock authorization server', () => {
  it('a sign-in refused at the authorization page shows pi’s error text and the vendor’s docs link, and can be tried again', async () => {
    mock.mode = 'deny';
    await add('notion');
    const answered = await browse('notion');
    assert.equal(answered.redirected, true);
    await inState('notion', 'error');
    assert.match(await row('notion').getByTestId('error-notion').innerText(), /The user denied the request/);
    assert.equal(await row('notion').getByRole('link', { name: /documentation/ }).getAttribute('href'), 'https://developers.notion.com/guides/mcp/get-started-with-mcp');
    mock.mode = 'approve';
    await row('notion').getByTestId('signin-notion').click();
    await browse('notion');
    await inState('notion', 'connected');
    assert.equal((await mcpServer('notion')).signIn, undefined);
  });

  it('giving up on a sign-in that waits stops it: the row says so and offers the sign-in again', async () => {
    mock.mode = 'hold';
    await add('sentry');
    await inState('sentry', 'signing-in');
    await row('sentry').getByTestId('cancel-signin-sentry').click();
    await inState('sentry', 'needs-signin');
    assert.match(await row('sentry').innerText(), /Sign-in cancelled/);
    assert.equal((await mcpServer('sentry')).signIn?.phase, 'cancelled');
    mock.mode = 'approve';
    await row('sentry').getByTestId('signin-sentry').click();
    await browse('sentry');
    await inState('sentry', 'connected');
  });

  it('pi refreshes an expired token by itself and stays connected', async () => {
    const before = mock.refreshes;
    mock.expire();
    const id = await threadId();
    const result = await post(`/api/mcp/servers/notion/reconnect?thread=${id}`);
    assert.equal(result.status, 200);
    await inState('notion', 'connected');
    assert.ok(mock.refreshes > before, 'the token endpoint was asked for a refresh');
  });

  it('a token revoked at the vendor sends the row back to sign-in needed', async () => {
    mock.revoke();
    const id = await threadId();
    const reconnect = await post(`/api/mcp/servers/notion/reconnect?thread=${id}`);
    assert.match(reconnect.body.message, /requires sign-in/);
    // The page does not poll a connection that was fine; showing the section asks for fresh states (and so does a reconnect from the row).
    await settings().getByRole('tab', { name: 'Extensions' }).click();
    await list();
    await inState('notion', 'needs-signin');
    mock.mode = 'approve';
    await row('notion').getByTestId('signin-notion').click();
    await browse('notion');
    await inState('notion', 'connected');
  });

  it('the redirect URL pasted from a browser on another machine finishes a sign-in', async () => {
    await remove('sentry');
    await gone('sentry');
    mock.mode = 'approve';
    await add('sentry');
    const link = row('sentry').getByTestId('signin-url-sentry');
    await link.waitFor();
    // The authorization server answers with a redirect to pi's loopback address; this "other machine" copies it from the address bar instead of letting the callback run.
    const authorize = await fetch(await link.getAttribute('href'), { redirect: 'manual' });
    const redirect = authorize.headers.get('location');
    await row('sentry').getByRole('button', { name: 'Browser on another machine?' }).click();
    await row('sentry').getByTestId('paste-sentry').fill(redirect);
    await row('sentry').getByRole('button', { name: 'Finish sign-in' }).click();
    await inState('sentry', 'connected');
    await remove('sentry');
    await gone('sentry');
    await remove('notion');
    await gone('notion');
  });
});

describe('a token connector (the example server behind a bearer token)', () => {
  it('a wrong token is an error with pi’s own text; the wizard never shows what was typed', async () => {
    await add('github', {
      fill: async (w) => {
        assert.equal(await w.getByTestId('connector-token').getAttribute('type'), 'password');
        assert.match(await w.innerText(), /pi-kit-secret|scratch|keychain|Keychain|credential store/i);
        // nothing is sent before there is a token
        await w.getByTestId('server-add').click();
        await w.getByTestId('server-error').waitFor();
        await w.getByTestId('connector-token').fill('not-the-token');
      },
    });
    await wizard().waitFor({ state: 'detached' });
    await inState('github', 'error');
    assert.ok((await row('github').getByTestId('error-github').innerText()).length > 0, 'pi’s error is shown');
    await remove('github');
    await gone('github');
  });

  it('the token goes to the credential store, mcp.json holds only the command that prints it, and nothing else on disk or on the page has it', async () => {
    await add('github', { fill: (w) => w.getByTestId('connector-token').fill(BEARER_TOKEN) });
    await wizard().waitFor({ state: 'detached' });
    await inState('github', 'connected');
    assert.match(await row('github').getByTestId('tools-count-github').innerText(), /2 tools/);
    assert.equal(secrets()['connector-github'], BEARER_TOKEN);
    assert.equal(servers(userFile()).github.headers.Authorization, '!pi-kit-secret get connector-github --bearer');
    assert.deepEqual(filesContaining(world.base, BEARER_TOKEN, [secretsFile]), [], 'the token is in the credential store only');
    assert.equal((await app.page.content()).includes(BEARER_TOKEN), false);
    assert.equal(JSON.stringify((await call(`/api/mcp?thread=${await threadId()}`)).body).includes(BEARER_TOKEN), false);
    assert.deepEqual(mock.mcpCalls.filter((c) => c.path === '/bearer/mcp' && c.status === 200).length > 0, true, 'the server saw authorized calls');
  });

  it('pi mcp list in a terminal resolves the command and connects with the token', async () => {
    const listed = await piMcpList();
    assert.equal(listed.status, 0, `pi mcp list exited ${listed.status}: ${listed.stderr}${listed.stdout}`);
    assert.match(JSON.stringify(listed.json ?? listed.stdout), /github/);
    assert.match(JSON.stringify(listed.json ?? listed.stdout), /create_issue/);
  });

  it('More › Remove takes out the entry and the stored token', async () => {
    await remove('github');
    await gone('github');
    assert.equal(servers(userFile()).github, undefined);
    assert.equal(secrets()['connector-github'], undefined);
  });
});

describe('project only', () => {
  it('writes the folder’s .pi/mcp.json, shows the row as project, and the server is there only', async () => {
    await add('sentry', { scope: 'project' });
    await wizard().waitFor({ state: 'detached' });
    await browse('sentry');
    await inState('sentry', 'connected');
    assert.equal(await row('sentry').locator('.chip.off').filter({ hasText: 'project' }).count(), 1, 'the scope chip says project');
    assert.deepEqual(Object.keys(servers(projectFile())), ['sentry']);
    assert.equal(servers(userFile()).sentry, undefined, 'the user file does not have it');
    // another folder: a thread there does not see it
    other = join(world.base, 'other-folder');
    mkdirSync(other, { recursive: true });
    const second = (await post('/api/threads', { cwd: other })).body;
    const seen = (await call(`/api/mcp?thread=${second.id}`)).body.servers.map((s) => s.name);
    assert.deepEqual(seen, [], 'the other folder has no servers');
    // and a folder pi does not trust cannot be written to
    const refused = await post(`/api/connectors/connect?thread=${second.id}`, { id: 'notion', scope: 'project' });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /not trusted/);
    assert.equal(existsSync(join(other, '.pi', 'mcp.json')), false);
    // once the person has answered for the folder (the wizard's "Trust this folder" does this), the same request goes through and only that folder has it
    const answered = await post(`/api/workspaces/${encodeURIComponent(other)}/trust`, { decision: 'remember' });
    assert.equal(answered.status, 200);
    const allowed = await post(`/api/connectors/connect?thread=${second.id}`, { id: 'sentry', scope: 'project' });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.deepEqual(Object.keys(servers(join(other, '.pi', 'mcp.json'))), ['sentry']);
    const there = (await call(`/api/mcp?thread=${second.id}`)).body.servers.map((s) => s.name);
    assert.ok(there.includes('sentry'), 'the folder that was trusted has it');
    assert.equal(servers(userFile()).sentry, undefined);
    await post(`/api/connectors/sentry/disconnect?thread=${second.id}`);
  });

  it('More › Remove takes it out of the project file and leaves the rest of the file as it was', async () => {
    const file = readJson(projectFile());
    file.somethingElse = { keep: true };
    writeFileSync(projectFile(), JSON.stringify(file, null, 2));
    await remove('sentry');
    await gone('sentry');
    assert.deepEqual(readJson(projectFile()), { somethingElse: { keep: true }, mcpServers: {} });
  });
});

describe('a server of your own', () => {
  it('a command on this machine is checked on the PATH, connects with no sign-in and is a row of the list', async () => {
    await add('custom', {
      fill: async (w) => {
        await w.getByTestId('custom-name').fill('issues');
        await w.getByTestId('custom-kind').selectOption('command');
        await w.getByTestId('custom-command').fill('node');
        await w.getByTestId('custom-args').fill(join(root, 'examples', 'mcp-app-server', 'server.mjs'));
        await w.getByTestId('custom-description').fill('A toy issue tracker');
        await w.getByTestId('check-server').click();
        assert.match(await w.getByTestId('check-result').innerText(), /found/);
      },
    });
    await wizard().waitFor({ state: 'detached' });
    await row('issues').waitFor();
    await inState('issues', 'connected');
    assert.deepEqual(servers(userFile()).issues, { command: 'node', args: [join(root, 'examples', 'mcp-app-server', 'server.mjs')], description: 'A toy issue tracker' });
    assert.match(await row('issues').innerText(), /A toy issue tracker/);
    await remove('issues');
    await gone('issues');
    assert.equal(servers(userFile()).issues, undefined);
  });

  it('a URL is checked with an MCP initialize: reachable with its tools, then added with its token', async () => {
    await add('custom', {
      fill: async (w) => {
        await w.getByTestId('custom-name').fill('mock-docs');
        await w.getByTestId('custom-url').fill(`${mock.url}/bearer/mcp`);
        // a header row: its name says it carries a credential, so the value is a password field and goes to the credential store
        await w.getByTestId('headers-add').click();
        await w.getByTestId('headers-key-0').fill('Authorization');
        await w.getByTestId('headers-value-0').fill(`Bearer ${BEARER_TOKEN}`);
        assert.equal(await w.getByTestId('headers-value-0').getAttribute('type'), 'password');
        await w.getByTestId('check-server').click();
        const result = w.getByTestId('check-result');
        await result.waitFor();
        assert.equal(await result.getAttribute('data-status'), 'reachable');
        assert.match(await result.innerText(), /create_issue/);
      },
    });
    await wizard().waitFor({ state: 'detached' });
    await inState('mock-docs', 'connected');
    assert.equal(servers(userFile())['mock-docs'].url, `${mock.url}/bearer/mcp`);
    assert.equal(secrets()['mcp-mock-docs-header-Authorization'], `Bearer ${BEARER_TOKEN}`);
    assert.match(servers(userFile())['mock-docs'].headers.Authorization, /^!pi-kit-secret get mcp-mock-docs-header-Authorization$/, 'the file has the command that prints it');
    assert.deepEqual(filesContaining(world.base, BEARER_TOKEN, [secretsFile]), [], 'the token is in the credential store only');
    await remove('mock-docs');
    await gone('mock-docs');
  });

  it('an address that does not answer is said plainly, stops the add once, and "Add anyway" goes ahead', async () => {
    await add('custom', {
      fill: async (w) => {
        await w.getByTestId('custom-name').fill('nowhere');
        await w.getByTestId('custom-url').fill('http://127.0.0.1:9/mcp');
      },
    });
    const result = wizard().getByTestId('check-result');
    await result.waitFor();
    assert.equal(await result.getAttribute('data-status'), 'unreachable');
    assert.equal(servers(userFile()).nowhere, undefined, 'nothing was written');
    assert.equal((await wizard().getByTestId('server-add').innerText()).trim(), 'Add anyway');
    await wizard().getByTestId('server-add').click();
    await wizard().waitFor({ state: 'detached' });
    await row('nowhere').waitFor();
    assert.equal(servers(userFile()).nowhere.url, 'http://127.0.0.1:9/mcp');
    await remove('nowhere');
    await gone('nowhere');
  });

  it('a name pi would refuse is refused in the wizard before anything is written', async () => {
    await add('custom', {
      fill: async (w) => {
        await w.getByTestId('custom-name').fill('bad name');
        await w.getByTestId('custom-url').fill('https://example.com/mcp');
      },
    });
    await wizard().getByTestId('server-error').waitFor();
    assert.match(await wizard().getByTestId('server-error').innerText(), /letters, digits/);
    await app.page.keyboard.press('Escape');
    await wizard().waitFor({ state: 'detached' });
    assert.equal(Object.keys(servers(userFile())).includes('bad name'), false);
  });

  it('Edit opens the form of the server, prefilled, and saving writes the entry again (the full form is mcp-edit.e2e.mjs)', async () => {
    await add('custom', {
      fill: async (w) => {
        await w.getByTestId('custom-name').fill('editable');
        await w.getByTestId('custom-kind').selectOption('command');
        await w.getByTestId('custom-command').fill('node');
        await w.getByTestId('custom-args').fill(join(root, 'examples', 'mcp-app-server', 'server.mjs'));
      },
    });
    await wizard().waitFor({ state: 'detached' });
    await inState('editable', 'connected');
    await row('editable').getByTestId('edit-editable').click();
    const edit = app.page.getByRole('dialog', { name: 'Edit editable' });
    await edit.getByTestId('custom-command').waitFor();
    assert.equal(await edit.getByTestId('custom-name').inputValue(), 'editable');
    assert.equal(await edit.getByTestId('details-scope').isDisabled(), true, 'the file is fixed');
    assert.equal(await edit.getByTestId('custom-command').inputValue(), 'node');
    assert.match(await edit.getByTestId('custom-args').inputValue(), /server\.mjs$/);
    await edit.getByTestId('details-exposure').selectOption('deferred');
    await edit.getByTestId('server-save').click();
    await edit.waitFor({ state: 'detached' });
    await app.page.waitForFunction(() => !document.querySelector('[data-testid="mcp-row-editable"] .loading'), null);
    assert.equal(servers(userFile()).editable.exposure, 'deferred');
    await remove('editable');
    await gone('editable');
  });
});

describe('The files, tooltips and the way in', () => {
  it('The files lists both mcp.json files with their counts; Open and Reveal ask the desktop, which the browser build does not have, and say so', async () => {
    await list();
    await settings().getByTestId('section-mcp').getByRole('tab', { name: 'Configuration', exact: true }).click();
    const files = settings().getByTestId('mcp-files');
    await files.waitFor();
    assert.match(await files.getByTestId('file-user').innerText(), new RegExp(userFile().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(await files.getByTestId('file-project').innerText(), /\.pi\/mcp\.json/);
    assert.equal(await files.getByRole('button', { name: 'Edit here' }).first().isDisabled(), false, 'the editor is mcp-edit.e2e.mjs');
    await files.getByTestId('open-user').click();
    await app.page.getByText(/needs the desktop app/).first().waitFor();
    await files.getByTestId('reveal-project').click();
    await app.page.getByText(/file manager needs the desktop app/).first().waitFor();
  });

  it('a tooltip shows after its delay, on hover and on keyboard focus, and Escape hides it without closing Settings', async () => {
    await list();
    const add = settings().getByTestId('add-server');
    await app.page.mouse.move(0, 0);
    await add.hover();
    const tip = app.page.locator('.pk-tt');
    assert.equal(await tip.count(), 0, 'not at once');
    await tip.filter({ hasText: 'Add a server' }).waitFor();
    assert.equal(await add.getAttribute('aria-describedby'), await tip.getAttribute('id'));
    // the group's overflow does not cut it: the bubble is outside the settings window's own box
    assert.equal(await settings().locator('.pk-tt').count(), 0);
    await app.page.keyboard.press('Escape');
    await tip.waitFor({ state: 'detached' });
    assert.equal(await settings().count(), 1, 'the first Escape hid the tooltip only');
    // keyboard focus shows it as well: Tab from Reload lands on the "+"
    await app.page.mouse.move(0, 0);
    await settings().getByTestId('mcp-reload').focus();
    await app.page.keyboard.press('Tab');
    await app.page.locator('.pk-tt').filter({ hasText: 'Add a server' }).waitFor();
    await app.page.keyboard.press('Escape');
  });
});

describe('getting to the MCP servers', () => {
  it('the sidebar’s MCP count opens the section, and so does /connect', async () => {
    await app.page.keyboard.press('Escape');
    await settings().waitFor({ state: 'detached' });
    await app.page.getByTestId('mcp-count').click();
    await settings().getByTestId('section-mcp').waitFor();
  await settings().getByTestId('section-mcp').getByRole('tab', { name: 'Servers', exact: true }).click();
    await app.page.keyboard.press('Escape');
    await settings().waitFor({ state: 'detached' });
    const box = app.page.getByLabel('Message to pi');
    await box.fill('/connect');
    await box.press('Enter');
    await settings().getByTestId('section-mcp').waitFor();
  await settings().getByTestId('section-mcp').getByRole('tab', { name: 'Servers', exact: true }).click();
    assert.match(await app.page.getByRole('tab', { name: /^MCP servers/ }).getAttribute('aria-selected'), /true/);
  });
});
