import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Harness, VIEWPORTS } from '../../scripts/screenshots.mjs';
import { editProjectFile as editFile } from './app-files.mjs';
import { fakeMicrophone } from './fake-mic.mjs';
import { WAIT_MS } from './timeouts.mjs';

export const env = {
  base: process.env.E2E_BASE ?? 'http://localhost:4200',
  api: process.env.E2E_API ?? 'http://127.0.0.1:4300',
  agentDir: process.env.E2E_AGENT_DIR,
  project: process.env.E2E_PROJECT,
  dataDir: process.env.E2E_DATA_DIR,
  server: JSON.parse(process.env.E2E_ENV ?? '{}'),
};

/** app.e2e's restart test stops its backend. Later suites own a replacement only when needed. */
export async function ensureBackend() {
  const up = async () => {
    try {
      return (await fetch(`${env.api}/api/health`, { headers: { Authorization: `Bearer ${env.server.PI_KIT_TOKEN}` }, signal: AbortSignal.timeout(1000) })).ok;
    } catch { return false; }
  };
  if (await up()) return async () => undefined;
  const child = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, ...env.server, NODE_ENV: 'development', PI_KIT_PORT: new URL(env.api).port, PI_KIT_ORIGIN: env.base },
    stdio: ['ignore', 'ignore', 'pipe'], detached: true,
  });
  let stderr = '';
  let spawnError;
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  child.once('error', (error) => { spawnError = error; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const kill = (signal) => { try { process.kill(-child.pid, signal); } catch { /* already gone */ } };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 5000);
    timer.unref();
    try { await exited; } finally { clearTimeout(timer); }
  };
  try {
    const deadline = Date.now() + 60_000;
    while (!(await up())) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null || Date.now() > deadline)
        throw new Error(`The test backend did not start: ${spawnError?.message ?? stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A browser with the scene runner's harness on a page (scripts/screenshots.mjs), opened on the app. */
export async function openApp({ viewport = VIEWPORTS.desktop, clipboard = false, microphone, backend, scrollbars = false } = {}) {
  if (!env.project) throw new Error('Run the tests with `pnpm run e2e`: they need the scratch project and agent folder it creates.');
  const browser = await chromium.launch(scrollbars ? { ignoreDefaultArgs: ['--hide-scrollbars'] } : {});
  // `clipboard` lets the page read and write the system clipboard: the Copy buttons are checked by what they put there.
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...(clipboard ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });
  // Every wait of the page uses the suite's one limit (support/timeouts.mjs).
  context.setDefaultTimeout(WAIT_MS);
  context.setDefaultNavigationTimeout(WAIT_MS);
  const page = await context.newPage();
  // `microphone`: the path of a WAV the page's microphone plays in a loop (e2e/support/fake-mic.mjs).
  if (microphone) await fakeMicrophone(page, microphone);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // `backend`: another backend the page talks to (a test that needs a machine of its own, the first-run flow); the renderer is the shared one.
  const harness = new Harness(page, { base: env.base, api: backend ?? env.api, out: join(env.project, '..', 'shots') });
  await harness.open();
  return { browser, context, page, h: harness, errors, close: () => browser.close() };
}

/** The text of every assistant prose block, newest last. */
export const proseTexts = (page) => page.locator('pk-transcript pk-prose').allInnerTexts();

/** A request against the backend with the dev token, for assertions that look behind the UI. */
export async function api(path, init = {}) {
  const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${env.api}${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  return res.json();
}

/** What pi's side was given by the human-in-the-loop test extension (e2e/support/pk-hitl.ts): one parsed JSON line per answered dialog, oldest first. */
export function hitlLog() {
  try {
    return readFileSync(env.server.PK_HITL_LOG, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Waits until the extension has logged one more `kind` entry than `before` entries, and returns that entry's answer. */
export async function nextHitl(kind, before, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entries = hitlLog().filter((e) => e.kind === kind);
    if (entries.length > before) return entries[before].answer;
    if (Date.now() > deadline) throw new Error(`pi never got an answer for ${kind}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export const hitlCount = (kind) => hitlLog().filter((e) => e.kind === kind).length;

export const readPiSettings = () => JSON.parse(readFileSync(join(env.agentDir, 'settings.json'), 'utf8'));

export function git(...args) {
  return execFileSync('git', args, { cwd: env.project, encoding: 'utf8' });
}

export const editProjectFile = (relative, transform) => editFile(env.project, relative, transform);
