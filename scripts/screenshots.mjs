// Screenshots of the running dev:web app, one named scene at a time (reuses it for e2e and adds the full set).
//
//   pnpm run dev:web                        # in another terminal, in the folder you want to look at
//   node scripts/screenshots.mjs --set bg-agents --serve --out <dir>
//   node scripts/screenshots.mjs --list   (ports: PI_KIT_DEV_RENDERER_PORT / PI_KIT_DEV_BACKEND_PORT)
//   node scripts/screenshots.mjs --scene review-mode-1440,review-mode-375 --out <dir>
//
// Options: --base <renderer url> (default http://localhost:4200), --api <backend url> (default http://127.0.0.1:4300),
// --out <dir> (default ./tmp/screenshots/<set>), --set <name>, --scene <id,id>, --keep-going, --serve (start dev:web against a scratch pi agent
// folder and project with the demo resources of e2e/support/env.mjs, stop it afterwards; needs the local model).
//
// A scene is { id, set, viewport, theme, file, run(h) }. `run` brings the page into the state to photograph (it may click,
// type, wait); `h` has the page and small helpers. Scenes of a set run in order on one page and may rely on what the
// earlier ones did (trusting the folder, a thread with pi's edits); `--scene` runs just the named ones, so state
// that a scene needs must already exist. The backend token comes from the dev endpoint, as for the app itself.
//
// What is needed: the backend started with a folder that has project resources (so the trust dialog shows), a pi
// agent folder with a model that can use tools (PI_CODING_AGENT_DIR), and `pnpm exec playwright install chromium`.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { scenes as bgAgents, world as worldBgAgents } from './scenes/bg-agents.mjs';
import { createWorld, startDevWeb } from '../e2e/support/env.mjs';
import { WAIT_MS } from '../e2e/support/timeouts.mjs';

export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1024, height: 768 },
  tablet: { width: 768, height: 1024 },
  phone: { width: 375, height: 812 },
};

// ---- helpers

export class Harness {
  constructor(page, options) {
    this.page = page;
    this.base = options.base;
    this.api = options.api;
    this.out = options.out;
  }

  /** Opens the app fresh. */
  async open() {
    // The renderer talks to 127.0.0.1:4300 unless localStorage says otherwise (BackendService); a moved backend port is announced that way.
    if (!this.initScripted) {
      this.initScripted = true;
      await this.page.addInitScript((url) => {
        try {
          localStorage.setItem('pi-kit.backendUrl', url);
        } catch {
          // blocked storage: the default port applies
        }
      }, this.api);
    }
    await this.page.goto(this.base);
    await this.page.waitForSelector('pk-root .pk-shell');
    await this.settle();
  }

  async settle(ms = 400) {
    await this.page.waitForTimeout(ms);
  }

  async viewport(name) {
    await this.page.setViewportSize(typeof name === 'string' ? VIEWPORTS[name] : name);
    await this.settle(250);
  }

  async theme(name) {
    await this.page.emulateMedia({ colorScheme: name === 'pi-dark' ? 'dark' : 'light' });
    await this.page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), name);
    await this.settle(150);
  }

  async shot(file) {
    mkdirSync(this.out, { recursive: true });
    const path = join(this.out, file);
    await this.page.screenshot({ path });
    console.log(`  saved ${path}`);
    return path;
  }

  /** The header's segmented control (Tree, Files, Changes, Terminal). */
  panelButton(name) {
    return this.page.getByRole('group', { name: 'Side panel' }).getByRole('button', { name, exact: true });
  }

  async openPanel(name) {
    const button = this.panelButton(name);
    if (await button.isVisible()) {
      if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
    } else {
      await this.page.getByRole('button', { name: 'Side panels', exact: true }).click();
      const item = this.page.getByRole('menuitemcheckbox', { name, exact: true });
      if ((await item.getAttribute('aria-checked')) !== 'true') await item.click();
      else await this.page.keyboard.press('Escape');
    }
    await this.settle();
  }

  async closePanel() {
    // The panel's own ✕ works everywhere; on a phone the panel covers the header's control.
    const close = this.page.getByRole('button', { name: /^Close the .* panel$/ });
    if (await close.count()) {
      await close.first().click();
      await this.settle(150);
      return;
    }
    for (const name of ['Tree', 'Files', 'Changes', 'Terminal']) {
      const button = this.panelButton(name);
      if ((await button.count()) && (await button.getAttribute('aria-pressed')) === 'true') await button.click();
    }
    await this.settle(150);
  }

  /** Makes sure a thread is open (the app restores the last one; otherwise the newest is picked). */
  async ensureThread() {
    if (await this.page.getByLabel('Message to pi').count()) return;
    await this.page.locator('.pk-thread').first().click();
    await this.page.getByLabel('Message to pi').waitFor();
    await this.settle();
  }

  async answerTrust(label) {
    const dialog = this.page.getByRole('dialog', { name: 'Trust this folder?' });
    await dialog.getByRole('button', { name: label }).click();
    await dialog.waitFor({ state: 'detached' });
    await this.settle();
  }

  async newThread() {
    // The old composer remains visible while creation and the sidebar refresh are pending. Wait for this thread's selection.
    const created = this.page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/threads');
    const selected = this.page.waitForRequest(async (request) => {
      if (request.method() !== 'PUT' || new URL(request.url()).pathname !== '/api/settings/thread') return false;
      const thread = await (await created).json();
      return request.postDataJSON()?.value === thread.id;
    });
    await this.page.getByTestId('new-thread').click();
    await selected;
    await this.page.getByLabel('Message to pi').waitFor();
    await this.settle();
  }

  async selectThread(text) {
    await this.page.locator('.pk-thread', { hasText: text }).first().click();
    await this.page.getByLabel('Message to pi').waitFor();
    await this.settle();
  }

  /** The main composer's Stop control; individual tools and background agents have their own. */
  get stopButton() {
    return this.page.locator('pk-composer-toolbar').first().getByRole('button', { name: 'Stop', exact: true });
  }

  /** Types into the composer and sends, then waits until pi has finished (the Stop button is gone). */
  async prompt(text, { timeout = WAIT_MS } = {}) {
    const box = this.page.getByLabel('Message to pi');
    await box.fill(text);
    await box.press('Enter');
    await this.stopButton.waitFor({ timeout: 30_000 }).catch(() => undefined);
    await this.stopButton.waitFor({ state: 'detached', timeout });
    await this.settle(800);
  }

  /** Hovers the diff row that contains `text` and clicks its `+`, types a comment and adds it to the batch. */
  async comment(text, comment) {
    const row = this.page.locator('pk-review-view .pk-diff :is(.ln, .split-pane .h)', { hasText: text }).first();
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await row.getByRole('button', { name: /Comment on/ }).first().click();
    const field = this.page.getByLabel('Comment', { exact: true });
    await field.fill(comment);
    await this.page.getByRole('button', { name: 'Add to batch' }).click();
    await this.settle(250);
  }

  /** Empties the pending batch (it survives a reload on purpose, so a rerun starts by clearing it). */
  async discardComments() {
    const discard = this.page.getByRole('button', { name: 'Discard all' });
    if (await discard.isEnabled().catch(() => false)) await discard.click();
    await this.settle(250);
  }

  /** Waits until pi has finished the current run (the Stop button is gone). */
  async waitIdle(timeout = WAIT_MS) {
    await this.stopButton.waitFor({ state: 'detached', timeout });
    await this.settle(600);
  }

  /** Sends a prompt and returns once pi is streaming it, without waiting for the end. */
  async startPrompt(text) {
    const box = this.page.getByLabel('Message to pi');
    await box.fill(text);
    await box.press('Enter');
    await this.stopButton.waitFor();
  }

  async openSettings(tab) {
    // The sidebar's quick actions have a "Project settings" button too: the footer's gear is the one that opens the dialog on its first tab.
    await this.page.getByTestId('settings-button').click();
    const dialog = this.page.getByRole('dialog', { name: 'Settings' });
    await dialog.waitFor();
    if (tab) await dialog.getByRole('tab', { name: tab }).click();
    await this.settle(400);
    return dialog;
  }
}

// ---- scenes

export const SCENES = bgAgents.map((scene) => ({ set: 'bg-agents', ...scene }));

/** The scratch world a set needs when it is run with `--serve` (a set that says nothing gets the demo world with an untrusted folder). */
const WORLDS = { 'bg-agents': worldBgAgents };

// ---- runner

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: `http://localhost:${process.env.PI_KIT_DEV_RENDERER_PORT ?? '4200'}` },
      api: { type: 'string', default: `http://127.0.0.1:${process.env.PI_KIT_DEV_BACKEND_PORT ?? '4300'}` },
      out: { type: 'string' },
      set: { type: 'string', default: 'bg-agents' },
      scene: { type: 'string' },
      list: { type: 'boolean', default: false },
      'keep-going': { type: 'boolean', default: false },
      serve: { type: 'boolean', default: false },
    },
  });
  if (values.list) {
    for (const scene of SCENES) console.log(`${scene.set}\t${scene.id}\t${scene.viewport}\t${scene.file}`);
    return;
  }
  const wanted = values.scene ? new Set(values.scene.split(',')) : undefined;
  const scenes = SCENES.filter((s) => (wanted ? wanted.has(s.id) : s.set === values.set));
  if (scenes.length === 0) throw new Error('No scene matches. Try --list.');
  const out = resolve(values.out ?? join('tmp', 'screenshots', values.set));

  // --serve: a scratch world and a dev:web of our own, so the set does not depend on what the author has lying around.
  let world;
  let server;
  let stopMocks;
  if (values.serve) {
    const options = WORLDS[scenes[0].set] ?? { demo: true, trusted: false, versionCheck: true };
    // A set may need servers of its own (a mock OAuth MCP server) running before the backend that is pointed at them.
    stopMocks = await options.start?.();
    world = createWorld(options);
    server = await startDevWeb(world);
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORTS.desktop, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(`  [page error] ${error.message}`));
  const harness = new Harness(page, { base: values.base, api: values.api, out });
  harness.world = world;
  let failed = 0;
  try {
    for (const scene of scenes) {
      console.log(`${scene.id}`);
      try {
        await harness.viewport(scene.viewport);
        // A scene run on its own starts on a blank page: open the app first.
        if (page.url() === 'about:blank') await harness.open();
        if (scene.theme) await harness.theme(scene.theme);
        await scene.run(harness);
        // The theme is set again after the run: opening the app resets it to what the backend remembers.
        if (scene.theme) await harness.theme(scene.theme);
        await harness.viewport(scene.viewport);
        await harness.shot(scene.file);
      } catch (error) {
        failed += 1;
        console.error(`  FAILED: ${error.message.split('\n')[0]}`);
        await harness.shot(`failed-${scene.id}.png`).catch(() => undefined);
        if (!values['keep-going']) break;
      }
    }
  } finally {
    await browser.close();
    server?.stop();
    await stopMocks?.();
    world?.dispose();
  }
  if (failed > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
