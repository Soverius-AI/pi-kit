// End to end: secrets at rest. A backend of this file's own, on an empty pi folder, with the scratch credential store (`PI_KIT_SECRET_STORE=file:...`: no test reaches
// a real keychain) and an OpenRouter whose base URL is a stub that forwards to the local model and records the key it is sent.
//
// Walk: an API key through the workflow ends as a `!` command in auth.json (no key in the file, in the data folder or on the page) and `pi` in a terminal still resolves it and answers ->
// "Move my existing keys" -> the database is encrypted and its recovery key is shown once -> a key pasted into a prompt shows as [redacted ...] in the transcript, is not in the database,
// and is masked in an export, while pi's own session file keeps it -> a pattern of the person's own, and the switch for a folder.
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import { env, openApp } from './support/app.mjs';
import { MODEL, createWorld, isUp, root } from './support/env.mjs';
import { startKeyProxy } from './support/key-proxy.mjs';

const PORT = Number(new URL(env.api).port) + 19;
const API = `http://127.0.0.1:${PORT}`;
const MODEL_URL = process.env.E2E_MODEL_URL ?? 'http://127.0.0.1:8080/v1';
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef5ec7';
const GROQ = 'gsk_abcdefghijklmnopqrstuvwxyz0123456789ABCD';
const PASTED = 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789zz42';
const CUSTOM = 'acme_abcdef123456';
const GITHUB = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

let world;
let backend;
let app;
let logFd;
let proxy;
let secretsFile;
let launcherDir;

async function call(path, init = {}) {
  const { token } = await (await fetch(`${API}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** Runs a command to its end WITHOUT blocking this process: the provider stub lives in it, and a pi that waits for the stub would wait forever behind a synchronous call. */
const run = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = execFile(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
    // `pi -p` appends what is piped to it to the prompt and waits for the end of its input: a terminal's standard input is closed or a tty, ours is closed here.
    child.stdin.end();
  });

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const auth = () => readJson(join(world.agent, 'auth.json'));
const secrets = () => (existsSync(secretsFile) ? readJson(secretsFile) : {});

/** Every file below `dir` (not `skip`) whose bytes contain `needle`. */
function filesContaining(dir, needle, skip = []) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (skip.includes(path)) continue;
      if (entry.isDirectory()) walk(path);
      else if (statSync(path).size < 50_000_000 && readFileSync(path).includes(Buffer.from(needle))) found.push(path);
    }
  };
  walk(dir);
  return found;
}

before(async () => {
  world = createWorld({ fresh: true, offline: true });
  secretsFile = join(world.base, 'secrets.json');
  launcherDir = join(world.data, 'bin');
  // The same local model every e2e test uses, as a keyless provider of its own for the threads, and OpenRouter pointed at the stub for the key.
  proxy = await startKeyProxy(MODEL_URL, MODEL.id);
  writeFileSync(
    join(world.agent, 'models.json'),
    JSON.stringify({ providers: { openrouter: { baseUrl: proxy.url }, 'llama-swap': { baseUrl: MODEL_URL, api: 'openai-completions', apiKey: 'llama-swap', models: [{ id: MODEL.id, name: MODEL.id, contextWindow: 262144 }] } } }, null, 2),
  );
  writeFileSync(join(world.agent, 'settings.json'), JSON.stringify({ defaultProvider: 'llama-swap', defaultModel: MODEL.id, defaultThinkingLevel: 'off', lastChangelogVersion: '1.2.0' }, null, 2));
  world.env.PI_KIT_SECRET_STORE = `file:${secretsFile}`;
  logFd = openSync(join(world.base, 'secrets-backend.log'), 'w');
  backend = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: root,
    env: { ...process.env, ...world.env, NODE_ENV: 'development', PI_KIT_PORT: String(PORT), PI_KIT_ORIGIN: env.base, PI_KIT_VERSION: '0.0.0-e2e' },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  const deadline = Date.now() + 60_000;
  while (!(await isUp(`${API}/api/dev/token`, { Origin: env.base }))) {
    if (Date.now() > deadline) throw new Error('The secrets test backend did not start.');
    await new Promise((r) => setTimeout(r, 300));
  }
  app = await openApp({ backend: API });
});

after(async () => {
  await app?.close();
  await proxy?.close();
  try {
    process.kill(-backend.pid, 'SIGKILL');
  } catch {
    // gone already
  }
  if (logFd !== undefined) closeSync(logFd);
  world?.dispose();
});

const settings = () => app.page.getByRole('dialog', { name: 'Settings' });

describe('an API key through the workflow, with a credential store', () => {
  it('lands in the store, auth.json holds only the command, and nothing on disk or on the page holds the key', async () => {
    await app.h.openSettings('Providers');
    // The "+" opens the wizard; the key workflow's steps run inside it.
    await settings().getByTestId('add-provider').click();
    const wf = app.page.getByTestId('add-provider-wizard');
    await wf.getByTestId('choice-api_key').click();
    await wf.getByTestId('which-openrouter').click();
    await wf.getByTestId('wizard-continue').click();
    await wf.getByRole('button', { name: 'I have a key' }).click();
    await wf.getByText('Asking pi to sign in').waitFor({ state: 'detached' });
    await wf.getByLabel('Paste the key').fill(KEY);
    await wf.getByTestId('validate-save').click();
    await wf.getByTestId('key-result').waitFor();
    assert.match(await wf.getByTestId('saved-as').innerText(), /OpenRouter key, keychain/);
    assert.equal(await wf.getByTestId('plain-text-warning').count(), 0, 'no warning: the key is not in plain text');
    await wf.getByTestId('key-done').click();
    await wf.waitFor({ state: 'detached' });

    assert.deepEqual(auth().openrouter, { type: 'api_key', key: '!pi-kit-secret get openrouter' });
    assert.equal(secrets().openrouter, KEY);
    assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
    assert.deepEqual(filesContaining(world.base, KEY, [secretsFile]), [], 'the key is in no file but the credential store');
    assert.equal((await app.page.content()).includes(KEY), false);
    assert.equal(JSON.stringify((await call('/api/pi-settings')).body).includes(KEY), false);
    const credentialLine = await settings().locator('[data-provider="openrouter"] [data-testid="credential-line"]').innerText();
    assert.match(credentialLine, /keychain/);
    assert.doesNotMatch(credentialLine, /key ending/);
  });

  it('pi in a terminal still resolves it through the command, and answers with it', async () => {
    const piCli = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
    // The environment of a terminal: pi-kit-secret on PATH (the launcher pi-kit wrote), the same credential store, no pi-kit running anywhere in it.
    const terminal = { ...process.env, PI_CODING_AGENT_DIR: world.agent, PI_KIT_SECRET_STORE: `file:${secretsFile}`, PATH: `${launcherDir}:${process.env.PATH}`, PI_OFFLINE: '1', NO_COLOR: '1' };
    assert.ok(existsSync(join(launcherDir, 'pi-kit-secret')), 'the launcher exists');
    const printed = await run('node', [piCli, 'auth', 'print-api-key', '--provider', 'openrouter'], { env: terminal });
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.stdout.trim(), KEY, 'pi resolved the key through the !command');

    // A model that speaks the OpenAI chat API (the stub is one); OpenRouter also lists Claude and virtual models, which use other protocols.
    const models = (await call('/api/pi-settings')).body.models.filter((m) => m.provider === 'openrouter' && !m.virtual && !/^~|anthropic|claude/.test(m.id));
    assert.ok(models.length > 0, 'the catalog lists OpenRouter models');
    const answered = await run('node', [piCli, '-p', '--no-session', '--no-extensions', '--no-skills', '--no-mcp', '--model', `openrouter/${models[0].id}`, 'Reply with the single word ok.'], { env: terminal, cwd: world.project });
    assert.equal(answered.status, 0, `pi -p exited ${answered.status}: ${answered.stderr} (the stub saw ${JSON.stringify(proxy.seen)})`);
    assert.ok(answered.stdout.trim().length > 0, 'pi answered');
    const completions = proxy.seen.filter((s) => s.url.includes('chat/completions'));
    assert.ok(completions.length > 0, 'the request reached the provider stub');
    assert.equal(completions.at(-1).authorization, `Bearer ${KEY}`, 'the provider was sent exactly the key that was typed');
  });

  it('moves a key that auth.json holds in full into the store when asked, and never by itself', async () => {
    // A key added the old way, behind the app's back (the pi command line, an older pi-kit).
    const file = join(world.agent, 'auth.json');
    writeFileSync(file, JSON.stringify({ ...auth(), groq: { type: 'api_key', key: GROQ } }, null, 2), { mode: 0o600 });
    await app.page.reload();
    await app.page.waitForSelector('pk-root .pk-shell');
    await app.h.openSettings('Providers');
    const banner = settings().getByTestId('move-keys');
    await banner.waitFor();
    assert.match(await banner.innerText(), /1 key is in auth\.json as plain text/);
    // Looking at it moved nothing.
    assert.equal(auth().groq.key, GROQ);
    assert.equal(secrets().groq, undefined);
    await banner.getByTestId('move-keys-button').click();
    await settings().getByTestId('move-result').waitFor();
    assert.deepEqual(auth().groq, { type: 'api_key', key: '!pi-kit-secret get groq' });
    assert.equal(secrets().groq, GROQ);
    assert.deepEqual(auth().openrouter, { type: 'api_key', key: '!pi-kit-secret get openrouter' });
    assert.equal(await settings().getByTestId('move-keys').count(), 0, 'nothing is left to move');
    assert.deepEqual(filesContaining(world.agent, GROQ), [], 'the plain-text key is gone from pi’s folder');
    assert.match(await settings().locator('[data-provider="groq"] [data-testid="credential-line"]').innerText(), /key from keychain/);
    await app.page.keyboard.press('Escape');
  });

  it('signing out removes the stored key as well', async () => {
    await app.h.openSettings('Providers');
    await settings().locator('[data-provider="groq"]').getByRole('button', { name: /Remove the key for/ }).click();
    // A provider that is not signed in is not a row any more.
    await settings().locator('[data-provider="groq"]').waitFor({ state: 'detached' });
    assert.equal(auth().groq, undefined);
    assert.equal(secrets().groq, undefined);
    await app.page.keyboard.press('Escape');
  });
});

describe('the database', () => {
  it('is encrypted with a key in the store: not readable with plain sqlite3, readable with the key, and settings say so', async () => {
    const file = join(world.data, 'pi-kit.sqlite');
    assert.notEqual(readFileSync(file).subarray(0, 15).toString('latin1'), 'SQLite format 3');
    const key = secrets()['pi-kit/db'];
    assert.match(key, /^[0-9a-f]{64}$/);
    const plain = spawnSync('sqlite3', [file, 'select count(*) from sqlite_master'], { encoding: 'utf8' });
    if (!plain.error) assert.match(plain.stderr + plain.stdout, /not a database|encrypted/i, 'plain sqlite3 cannot read it');
    const db = new Database(file, { readonly: true });
    db.pragma("cipher='chacha20'");
    db.pragma(`key="x'${key}'"`);
    assert.ok(db.prepare("select count(*) as n from sqlite_master where name = 'thread_events'").get().n === 1);
    db.close();

    await app.h.openSettings('Advanced');
    await settings().getByTestId('section-advanced').getByRole('tab', { name: 'Security', exact: true }).click();
    const section = settings().getByTestId('secrets-at-rest');
    await section.getByTestId('database-chip').filter({ hasText: 'encrypted' }).waitFor();
    assert.match(await section.getByTestId('store-chip').innerText(), /scratch store/);
  });

  it('shows the recovery key once: it is the key in the store, and a second request is refused', async () => {
    const section = settings().getByTestId('secrets-at-rest');
    await section.getByTestId('export-recovery-key').click();
    const dialog = app.page.getByTestId('recovery-dialog');
    await dialog.waitFor();
    assert.equal((await dialog.getByTestId('recovery-key').innerText()).trim(), secrets()['pi-kit/db']);
    await dialog.getByTestId('recovery-done').click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal((await call('/api/secrets/recovery-key', { method: 'POST', body: '{}' })).status, 409);
    await section.getByRole('button', { name: 'Recovery key shown' }).waitFor();
    assert.equal(await app.page.getByTestId('recovery-key').count(), 0, 'the key is no longer on the page');
    await app.page.keyboard.press('Escape');
  });
});

describe('redaction', () => {
  let threadId;

  it('a key pasted into a prompt shows as [redacted ...] in the transcript and is in no file of pi-kit’s; pi’s own session file keeps what pi was sent', async () => {
    await app.h.newThread();
    await app.h.prompt(`My key is ${PASTED}. Reply with the single word ok.`);
    const user = app.page.locator('pk-transcript').getByText(/My key is/).first();
    await user.waitFor();
    const text = await user.innerText();
    assert.match(text, /My key is \[redacted openai key …zz42\]/);
    assert.equal(text.includes(PASTED), false);
    assert.equal((await app.page.locator('pk-transcript').innerText()).includes(PASTED), false);

    threadId = (await call('/api/threads')).body.filter((t) => t.cwd === world.project).sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
    // The replay log in the encrypted database holds no plaintext: opened with the key, searched for the secret.
    const db = new Database(join(world.data, 'pi-kit.sqlite'), { readonly: true });
    db.pragma("cipher='chacha20'");
    db.pragma(`key="x'${secrets()['pi-kit/db']}'"`);
    const events = db.prepare('select event_json from thread_events').all().map((r) => r.event_json);
    db.close();
    assert.ok(events.some((e) => e.includes('[redacted openai key …zz42]')), 'the log holds the masked text');
    assert.equal(events.some((e) => e.includes(PASTED)), false, 'the log holds no plaintext');
    assert.deepEqual(filesContaining(world.data, PASTED), [], 'no file in pi-kit’s data folder holds it');
    // pi's file is pi's: it holds what the model was sent, which is what makes the answer possible.
    assert.ok(filesContaining(join(world.agent, 'sessions'), PASTED).length > 0, 'pi’s own session file is untouched');
  });

  it('an export is masked, and says how many places', async () => {
    const result = await call(`/api/threads/${threadId}/export`, { method: 'POST', body: JSON.stringify({ path: 'export.jsonl' }) });
    assert.equal(result.status, 201);
    assert.equal(result.body.format, 'jsonl');
    assert.ok(result.body.redacted > 0);
    const exported = readFileSync(result.body.path, 'utf8');
    assert.equal(exported.includes(PASTED), false);
    assert.ok(exported.includes('[redacted openai key …zz42]'));
    const html = await call(`/api/threads/${threadId}/export`, { method: 'POST', body: JSON.stringify({ path: 'export.html' }) });
    const page = readFileSync(html.body.path, 'utf8');
    assert.equal(Buffer.from(/id="session-data" type="application\/json">([^<]+)</.exec(page)[1], 'base64').toString('utf8').includes(PASTED), false, 'the HTML export’s session data is masked');
  });

  it('a pattern of the person’s own masks what the built-in ones do not; a folder with the pass switched off shows the text as it is', async () => {
    await app.h.openSettings('Advanced');
    await settings().getByTestId('section-advanced').getByRole('tab', { name: 'Privacy', exact: true }).click();
    const patterns = settings().getByTestId('redaction-patterns');
    await patterns.getByLabel('Pattern name').fill('acme token');
    await patterns.getByLabel('Regular expression').fill('(');
    await patterns.getByTestId('add-pattern').click();
    await patterns.getByTestId('pattern-error').waitFor();
    await patterns.getByLabel('Regular expression').fill('acme_[a-z0-9]{12}');
    await patterns.getByTestId('add-pattern').click();
    await settings().getByTestId('redaction-pattern').getByText('acme token', { exact: true }).waitFor();
    assert.deepEqual((await call('/api/redaction')).body.config.patterns, [{ name: 'acme token', regex: 'acme_[a-z0-9]{12}' }]);
    await app.page.keyboard.press('Escape');
    await app.h.prompt(`The token is ${CUSTOM}. Reply with the single word ok.`);
    assert.match(await app.page.locator('pk-transcript').getByText(/The token is/).first().innerText(), /The token is \[redacted acme token …3456\]/);

    await app.h.openSettings('Advanced');
    await settings().getByTestId('section-advanced').getByRole('tab', { name: 'Privacy', exact: true }).click();
    await settings().getByTestId('redaction-settings').getByRole('switch', { name: /Mask keys in project/ }).uncheck();
    await app.page.getByText('Saved').first().waitFor();
    await app.page.keyboard.press('Escape');
    await app.h.prompt(`Remember ${GITHUB}. Reply with the single word ok.`);
    const shown = await app.page.locator('pk-transcript').getByText(/Remember/).first().innerText();
    assert.ok(shown.includes(GITHUB), 'with the pass off for this folder the text is shown as it is');
  });
});
