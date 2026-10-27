// End to end: packages in Settings › Extensions. A backend of this file's own on a scratch pi folder, a fake npm registry (`PI_KIT_NPM_REGISTRY`, e2e/support/fake-registry.mjs) and
// a package made on disk in the scratch folder: **nothing is installed from the network**; the install, the update and the removal run through pi's real package manager on that folder.
//
// Walk: separate Extensions and Skills pages -> Add a package, Browse: the registry's packages and pi-kit's own, a search, the filter by what a package contains, the second step with its README and the exact command ->
// From a folder: what it adds, Install, and the row appears with what it brings (and pi's settings.json agrees) -> the switch, off and on -> Check for updates marks it "0.1.0 → 0.2.0", Update takes it
// -> Remove… asks first.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { after, before, describe, it } from 'node:test';
import { env, openApp } from './support/app.mjs';
import { createWorld, isUp, root } from './support/env.mjs';
import { startFakeRegistry } from './support/fake-registry.mjs';

const PORT = Number(new URL(env.api).port) + 27;
const API = `http://127.0.0.1:${PORT}`;
const REGISTRY_PORT = PORT + 1;

let world;
let backend;
let app;
let logFd;
let registry;
let pkg;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const settingsFile = () => join(world.agent, 'settings.json');
const piSettings = () => (existsSync(settingsFile()) ? readJson(settingsFile()) : {});

function writePackage(version) {
  mkdirSync(join(pkg, 'extensions'), { recursive: true });
  mkdirSync(join(pkg, 'skills', 'split-task'), { recursive: true });
  mkdirSync(join(pkg, 'prompts'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'demo-pkg', version, description: 'A demo package', keywords: ['pi-package'] }, null, 2),
  );
  writeFileSync(join(pkg, 'extensions', 'hello.ts'), 'export default function () {}\n');
  writeFileSync(
    join(pkg, 'skills', 'split-task', 'SKILL.md'),
    '---\nname: split-task\ndescription: Split a task into parts\n---\n\nSplit it.\n',
  );
  writeFileSync(join(pkg, 'prompts', 'review.md'), '---\ndescription: Review the change\n---\n\nReview $@\n');
  writeFileSync(join(pkg, 'README.md'), '# Demo package\n\nIt says hello from a folder.\n');
}

before(async () => {
  registry = await startFakeRegistry({ port: REGISTRY_PORT });
  world = createWorld({
    offline: true,
    extraEnv: ({ base }) => ({
      PI_KIT_NO_BROWSER: '1',
      PI_KIT_LLAMA_SWAP_CONFIG: join(base, 'existing-llama-swap.yaml'),
      PI_KIT_HOME: join(base, 'home'),
      PI_KIT_NPM_REGISTRY: registry.url,
      // development only: the newest version a package is said to have, so "Check for updates" can mark the folder package without a registry that has it
      PI_KIT_PACKAGE_LATEST: JSON.stringify({ 'demo-pkg': '0.2.0' }),
      // no package of pi-kit's own in pi's settings: the list starts empty
      PI_KIT_LEARN_PACKAGE: 'off',
      PI_KIT_MEAT_PROXY_PACKAGE: 'off',
      PI_KIT_COMPUTER_USE_PACKAGE: 'off',
    }),
  });
  mkdirSync(join(world.base, 'home'), { recursive: true });
  writeFileSync(
    join(world.base, 'existing-llama-swap.yaml'),
    '# Existing shared engine config\nhealthCheckTimeout: 90\nmodels:\n  existing-model:\n    cmd: existing-engine --ctx-size 4096\n',
  );
  pkg = join(world.base, 'pkgs', 'demo-pkg');
  writePackage('0.1.0');
  logFd = openSync(join(world.base, 'packages-backend.log'), 'w');
  backend = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      ...world.env,
      NODE_ENV: 'development',
      PI_KIT_PORT: String(PORT),
      PI_KIT_ORIGIN: env.base,
      PI_KIT_VERSION: '0.0.0-e2e',
    },
    stdio: ['ignore', logFd, logFd],
    detached: true,
  });
  const deadline = Date.now() + 60_000;
  while (!(await isUp(`${API}/api/dev/token`, { Origin: env.base }))) {
    if (Date.now() > deadline) throw new Error('The packages test backend did not start.');
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
  await registry?.close();
  if (logFd !== undefined) closeSync(logFd);
  world?.dispose();
});

const settings = () => app.page.getByRole('dialog', { name: 'Settings' });
const wizard = () => app.page.getByTestId('add-package-wizard');
const editor = () => app.page.getByTestId('file-editor');
const row = (name) => settings().getByTestId(`package-${name}`);
async function ext() {
  const modelSettings = app.page.getByTestId('model-settings');
  if (await modelSettings.count()) {
    await modelSettings.locator('.head').getByRole('button', { name: 'Close', exact: true }).click();
    if (await modelSettings.getByRole('button', { name: 'Discard changes', exact: true }).count())
      await modelSettings.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await modelSettings.waitFor({ state: 'detached' });
  }
  if (await editor().count()) {
    await editor().getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    if (await editor().getByTestId('discard').count()) await editor().getByTestId('discard').click();
    await editor().waitFor({ state: 'detached' });
  }
  if ((await settings().count()) === 0) await app.h.openSettings();
  await settings()
    .getByRole('tab', { name: /Extensions/ })
    .click();
  await settings().getByTestId('section-extensions').waitFor();
}
const searchLogs = () =>
  registry.requests
    .filter((u) => u.startsWith('/-/v1/search'))
    .map((u) => decodeURIComponent(new URL(u, 'http://x').searchParams.get('text')));

describe('separate resource pages', () => {
  it('Extensions has packages and prompt files, while Skills has its own page', async () => {
    await ext();
    const headings = await settings().locator('.pk-group > header h4').allInnerTexts();
    assert.deepEqual(headings, ['Packages', 'Your extensions and prompts']);
    assert.equal(await settings().getByTestId('files-group').isVisible(), false);
    await settings().getByTestId('section-extensions').getByRole('tab', { name: 'Local files', exact: true }).click();
    // The tab's panel switches after the click.
    await settings().getByTestId('files-group').waitFor();
    assert.equal(await settings().getByTestId('packages-group').isVisible(), false);
    assert.equal(await settings().getByTestId('skills-group').count(), 0);
    await settings()
      .getByRole('tab', { name: /^Skills/ })
      .click();
    await settings().getByTestId('section-skills').waitFor();
    await settings().getByTestId('skills-group').waitFor();
    assert.equal(await settings().getByTestId('packages-group').count(), 0);
    assert.equal(await settings().getByTestId('files-group').count(), 0);
    await ext();
    await settings().getByTestId('packages-empty').waitFor();
    assert.match(await settings().getByTestId('packages-empty').innerText(), /No packages yet/);
    assert.deepEqual(piSettings().packages ?? [], []);
  });
});

describe('local models in Settings', () => {
  it('/llama opens working model management from both slash input and the command palette', async () => {
    if ((await settings().count()) === 0) await app.h.openSettings();
    await settings().locator('.head > .pk-close').first().click();
    await settings().waitFor({ state: 'detached' });
    const box = app.page.getByLabel('Message to pi');
    await box.fill('/llama');
    await app.page.getByRole('option').filter({ hasText: '/llama' }).waitFor();
    await box.press('Enter');
    await settings().getByTestId('local-runtime-wizard').waitFor();
    assert.equal(
      await settings().getByRole('tab', { name: 'Local models', exact: true }).getAttribute('aria-selected'),
      'true',
    );
    await settings().getByTestId('local-runtime-wizard').getByRole('tab', { name: 'Engines', exact: true }).click();
    await settings().getByRole('button', { name: 'Advanced YAML…', exact: true }).first().waitFor();
    await settings().locator('.head > .pk-close').first().click();
    await settings().waitFor({ state: 'detached' });
    assert.equal(await box.inputValue(), '');
    await app.page.keyboard.press('Control+k');
    const palette = app.page.getByRole('dialog', { name: 'Command palette' });
    await palette.getByLabel('Search commands').fill('llama');
    await palette.getByRole('option').first().waitFor();
    assert.equal(await palette.getByRole('option').first().getAttribute('aria-disabled'), null);
    await app.page.keyboard.press('Enter');
    await settings().getByTestId('local-runtime-wizard').waitFor();
    await ext();
  });

  it('reuses guided setup and exposes HF search without starting a download', async () => {
    await settings().getByRole('tab', { name: 'Local models' }).click();
    const guided = settings().getByTestId('local-runtime-wizard');
    await guided.getByRole('tab', { name: /^Your models/ }).waitFor();
    await guided.getByRole('tab', { name: 'Download models', exact: true }).click();
    await guided.getByTestId('local-search').waitFor();
    assert.match(await guided.innerText(), /Hugging Face/);
    const { token } = await (await fetch(`${API}/api/dev/token`, { headers: { Origin: env.base } })).json();
    const status = await (
      await fetch(`${API}/api/setup/local-runtime`, { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    assert.equal(status.job, undefined, 'opening Settings does not install or download anything');
    await settings().getByRole('searchbox', { name: 'Search settings' }).fill('hf');
    await settings().getByTestId('local-runtime-wizard').getByTestId('local-search').waitFor();
    await ext();
  });

  it('bounds a long model list, keeps file review outside it, and preserves choices across tabs', async () => {
    const modelRoute = '**/api/setup/local-runtime/models?*';
    const gib = 1024 ** 3;
    await app.page.route(modelRoute, async (route) => {
      const context = Number(new URL(route.request().url()).searchParams.get('contextTokens'));
      await route.fulfill({
        json: {
          models: Array.from({ length: 24 }, (_, index) => ({
            id: `fixture-${index}`,
            repository: 'test/Example-GGUF',
            revision: 'a'.repeat(40),
            file: `example-${index}-Q4_K_M.gguf`,
            bytes: 3 * gib,
            sha256: 'b'.repeat(64),
            license: 'apache-2.0',
            source: 'https://huggingface.co/test/Example-GGUF',
            downloads: 100,
            estimate: {
              contextTokens: context,
              memoryBytes: 5 * gib,
              fitsMemory: true,
              fitsDisk: true,
              explanation: 'Estimated fit for this test machine.',
            },
          })),
          notes: [],
        },
      });
    });
    const originalViewport = app.page.viewportSize();
    try {
      await settings().getByRole('tab', { name: 'Local models' }).click();
      const guided = settings().getByTestId('local-runtime-wizard');
      await guided.getByRole('tab', { name: 'Download models', exact: true }).click();
      await guided.getByTestId('local-search').click();
      const results = guided.getByTestId('local-model-results');
      await results.getByRole('radio').last().scrollIntoViewIfNeeded();
      const dimensions = await results.evaluate((element) => ({
        height: element.clientHeight,
        full: element.scrollHeight,
        top: element.scrollTop,
      }));
      assert.ok(dimensions.full > dimensions.height, 'long lists scroll inside their own region');
      assert.ok(dimensions.height <= 352, 'results do not grow beyond their height budget');
      assert.ok(dimensions.top > 0, 'the last result can be reached by scrolling');
      await results.getByRole('radio').last().click();
      const review = guided.getByTestId('local-download-review');
      assert.match(await review.innerText(), /example-23-Q4_K_M.gguf/);
      assert.equal(
        await review.evaluate((element) => element === document.activeElement),
        true,
        'file selection moves focus to its review',
      );
      assert.equal(
        await results.getByTestId('local-download-review').count(),
        0,
        'review remains outside scrolling results',
      );
      assert.equal(await guided.getByTestId('local-download').isDisabled(), true);
      await review.getByRole('checkbox').check();
      await app.page.waitForFunction(
        () => document.querySelector('[data-testid=local-download]')?.disabled === false,
        undefined,
      );
      assert.equal(await guided.getByTestId('local-download').isEnabled(), true);
      await guided.getByRole('tab', { name: 'Engines', exact: true }).click();
      await guided.getByRole('region', { name: 'llama-swap setup', exact: true }).waitFor();
      assert.equal(await guided.getByTestId('local-download').isVisible(), false);
      await guided.getByRole('tab', { name: 'Download models', exact: true }).click();
      assert.equal(await review.getByRole('checkbox').isChecked(), true);
      await guided.getByRole('button', { name: /Back to results/ }).click();
      await results.waitFor();
      assert.ok(
        await results.evaluate((element) => element.scrollTop > 0),
        'back preserves the result scroll position',
      );
      await results.getByRole('radio').last().click();
      await review.waitFor();
      assert.equal(await review.getByRole('checkbox').isChecked(), true);
      await settings()
        .locator('main')
        .evaluate((element) => {
          element.scrollTop = 0;
        });
      if (process.env.E2E_CAPTURE_SETTINGS) {
        mkdirSync(process.env.E2E_CAPTURE_SETTINGS, { recursive: true });
        const previousTheme = await app.page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        await app.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'pi-dark'));
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'local-models-desktop.png'),
        });
        await app.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'pi-light'));
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'local-models-light.png'),
        });
        await app.page.evaluate(
          (theme) => document.documentElement.setAttribute('data-theme', theme ?? 'pi-dark'),
          previousTheme,
        );
      }
      await app.page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await settings().evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        'the settings dialog fits a phone',
      );
      await guided.getByRole('tab', { name: 'Engines', exact: true }).click();
      await guided.getByRole('tab', { name: 'Download models', exact: true }).click();
      if (process.env.E2E_CAPTURE_SETTINGS)
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'local-models-phone.png'),
        });
    } finally {
      await app.page.unroute(modelRoute);
      await app.page.setViewportSize(originalViewport);
      await ext();
    }
  });

  it('lists actual model files, registers them with llama-swap, and deletes only the confirmed file', async () => {
    const folder = join(world.base, 'model-library');
    mkdirSync(folder);
    const file = join(folder, 'library-fixture.gguf');
    writeFileSync(file, Buffer.from('GGUF\x03\x00\x00\x00fixture model data'));
    await settings().getByRole('tab', { name: 'Local models' }).click();
    const guided = settings().getByTestId('local-runtime-wizard');
    await guided.getByRole('tab', { name: 'Engines', exact: true }).click();
    await guided.getByTestId('model-directory').fill(folder);
    await guided.getByRole('button', { name: 'Check folder and engines' }).click();
    await app.page.waitForFunction(
      () =>
        !document.querySelector('[data-testid=model-directory]')?.closest('form')?.querySelector('button')?.disabled,
    );
    await guided.getByRole('tab', { name: /^Your models/ }).click();
    const row = guided
      .getByTestId('installed-models-list')
      .locator('article')
      .filter({ hasText: 'library-fixture.gguf' });
    await row.waitFor();
    assert.equal(await guided.getByTestId('installed-models-list').locator('select').count(), 0);
    assert.equal(await guided.locator('input[data-testid=llama-swap-config-path]').count(), 0);
    assert.equal(await guided.getByTestId('local-context').count(), 0);
    assert.equal(await guided.getByRole('button', { name: /Start engine|Stop engine/ }).count(), 0);
    assert.equal(await guided.getByRole('button', { name: /bench|Measure speed/ }).count(), 0);
    await row.getByRole('button', { name: 'Add to llama-swap', exact: true }).click();
    await row.getByText('In llama-swap', { exact: true }).waitFor();
    assert.equal(await row.count(), 1, 'the file and its llama-swap entry share one library row');
    await row.getByRole('button', { name: 'Configure', exact: true }).waitFor();
    assert.match(await row.getAttribute('data-model-uid'), /^model-[a-f0-9]{16}$/);
    if (process.env.E2E_CAPTURE_SETTINGS) {
      mkdirSync(process.env.E2E_CAPTURE_SETTINGS, { recursive: true });
      await guided.screenshot({ path: join(process.env.E2E_CAPTURE_SETTINGS, 'merged-local-model.png') });
    }
    const config = readFileSync(join(world.base, 'existing-llama-swap.yaml'), 'utf8');
    assert.ok(
      Object.values(parseYaml(config).models).some((entry) => entry.cmd.includes(realpathSync(file))),
      `the selected file is in the owned engine config: ${config}`,
    );
    assert.match(config, /# Existing shared engine config/);
    assert.equal(parseYaml(config).models['existing-model'].cmd, 'existing-engine --ctx-size 4096');
    assert.equal(
      existsSync(join(world.data, 'local-runtime', 'llama-swap.yaml')),
      false,
      'no private config or instance is created',
    );
    assert.ok(
      !Object.values(parseYaml(config).models)
        .find((entry) => entry.cmd.includes(realpathSync(file)))
        .cmd.includes('--ctx-size'),
      'new entries do not force context settings',
    );
    if (process.env.E2E_CAPTURE_SETTINGS) {
      await app.page.screenshot({
        animations: 'disabled',
        path: join(process.env.E2E_CAPTURE_SETTINGS, 'local-library-desktop.png'),
      });
      const viewport = app.page.viewportSize();
      await app.page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await settings().evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
      await app.page.screenshot({
        animations: 'disabled',
        path: join(process.env.E2E_CAPTURE_SETTINGS, 'local-library-phone.png'),
      });
      await app.page.setViewportSize(viewport);
    }
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    assert.ok(existsSync(file), 'opening confirmation does not remove the file');
    await row.getByRole('button', { name: 'Delete file', exact: true }).click();
    await row.waitFor({ state: 'detached' });
    assert.equal(existsSync(file), false);
    assert.equal(
      readFileSync(join(world.base, 'existing-llama-swap.yaml'), 'utf8').includes('library-fixture.gguf'),
      false,
    );
    await ext();
  });

  it('shows all configured llama-swap models alongside files with shared filtering and refresh', async () => {
    const hardwareRoute = '**/api/setup/local-runtime/hardware*';
    let models = ['configured-qwen', 'configured-deepseek'];
    await app.page.route(hardwareRoute, async (route) => {
      const response = await route.fetch();
      const facts = await response.json();
      await route.fulfill({
        json: {
          ...facts,
          servers: [
            ...facts.servers,
            { kind: 'llama-swap', name: 'Existing llama-swap', baseUrl: 'http://127.0.0.1:18080/v1', models },
          ],
        },
      });
    });
    try {
      await settings().getByRole('tab', { name: 'Local models' }).click();
      const guided = settings().getByTestId('local-runtime-wizard');
      const library = guided.getByTestId('installed-models-list');
      const row = library.locator('[data-server-model="configured-qwen"]');
      await row.waitFor();
      assert.match(await row.innerText(), /Existing llama-swap/);
      assert.match(await row.innerText(), /18080/);
      assert.equal(await row.getByRole('button').count(), 0, 'server-only entries have no file deletion controls');
      await guided.getByRole('searchbox', { name: 'Filter your models' }).fill('configured-deepseek');
      await library.locator('[data-server-model="configured-deepseek"]').waitFor();
      assert.equal(await row.count(), 0);
      models = ['configured-replacement'];
      await guided.getByRole('searchbox', { name: 'Filter your models' }).fill('');
      await guided.getByRole('button', { name: 'Refresh models', exact: true }).click();
      await library.locator('[data-server-model="configured-replacement"]').waitFor();
      assert.equal(await library.locator('[data-server-model="configured-deepseek"]').count(), 0);
    } finally {
      await app.page.unroute(hardwareRoute);
      await ext();
    }
  });

  it('combines a configured model and its live service into one configurable row and keeps it when stopped', async () => {
    const hardwareRoute = '**/api/setup/local-runtime/hardware*';
    let running = true;
    await app.page.route(hardwareRoute, async (route) => {
      const response = await route.fetch(),
        facts = await response.json();
      await route.fulfill({
        json: {
          ...facts,
          configs: facts.configs.map((config) =>
            config.models.includes('existing-model')
              ? { ...config, baseUrl: running ? 'http://127.0.0.1:18080' : undefined }
              : config,
          ),
          servers: running
            ? [
                {
                  kind: 'llama-swap',
                  name: 'Existing llama-swap',
                  baseUrl: 'http://localhost:18080/v1',
                  models: ['existing-model'],
                },
              ]
            : [],
        },
      });
    });
    try {
      await ext();
      await settings().getByRole('tab', { name: 'Local models', exact: true }).click();
      const guided = settings().getByTestId('local-runtime-wizard'),
        library = guided.getByTestId('installed-models-list');
      const row = library.locator('[data-config-model="existing-model"]');
      await row.waitFor();
      await row.getByText('Running', { exact: true }).waitFor();
      assert.equal(await row.count(), 1);
      assert.equal(await library.locator('[data-server-model="existing-model"]').count(), 0);
      assert.match(await row.innerText(), /Download target/);
      assert.match(await row.innerText(), /Running/);
      assert.match(await row.innerText(), /18080/);
      await row.getByRole('button', { name: 'Configure', exact: true }).click();
      await app.page
        .getByTestId('model-settings')
        .getByRole('spinbutton', { name: 'Context size', exact: true })
        .waitFor();
      await app.page
        .getByTestId('model-settings')
        .locator('.head')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await guided.getByRole('searchbox', { name: 'Filter your models' }).fill('18080');
      assert.equal(await library.locator('[data-config-model]').count(), 1);
      await guided.getByRole('searchbox', { name: 'Filter your models' }).fill('');
      running = false;
      await guided.getByRole('button', { name: 'Refresh models', exact: true }).click();
      await row.getByText('From config', { exact: true }).waitFor();
      assert.equal(await row.getByRole('button', { name: 'Configure', exact: true }).count(), 1);
      assert.equal(await library.locator('[data-server-model="existing-model"]').count(), 0);
    } finally {
      await app.page.unroute(hardwareRoute);
      await ext();
    }
  });

  it('reads shared and selected config models while stopped and refreshes edits directly from disk', async () => {
    const sharedFile = join(world.base, 'existing-llama-swap.yaml');
    const previous = existsSync(sharedFile) ? readFileSync(sharedFile, 'utf8') : undefined;
    const externalFile = join(world.base, 'external-llama-swap.yaml');
    const content = 'models:\n  external-offline-model:\n    cmd: "never-execute-this"\n';
    writeFileSync(sharedFile, 'models:\n  shared-offline-model:\n    cmd: "never-execute-this"\n');
    writeFileSync(externalFile, content);
    const services = join(world.base, 'home', 'Library', 'LaunchAgents');
    mkdirSync(services, { recursive: true });
    const service = join(services, 'com.fixture.llama-swap.plist');
    writeFileSync(
      service,
      `<?xml version="1.0"?><plist version="1.0"><dict><key>ProgramArguments</key><array><string>/tools/llama-swap</string><string>--config</string><string>${externalFile}</string></array></dict></plist>`,
    );
    try {
      await settings().getByRole('tab', { name: 'Local models' }).click();
      const guided = settings().getByTestId('local-runtime-wizard');
      const library = guided.getByTestId('installed-models-list');
      const owned = library.locator('[data-config-model="shared-offline-model"]');
      await owned.waitFor();
      assert.match(await owned.innerText(), /From config/);
      assert.match(await owned.innerText(), /existing-llama-swap.yaml/);
      await guided.getByRole('tab', { name: 'Engines', exact: true }).click();
      await guided
        .getByRole('combobox', { name: 'Download config', exact: true })
        .selectOption(realpathSync(externalFile));
      await guided.getByRole('tab', { name: /^Your models/ }).click();
      const external = library.locator('[data-config-model="external-offline-model"]');
      await external.waitFor();
      assert.match(await external.innerText(), /From config/);
      assert.equal(await external.getByRole('button', { name: 'Configure', exact: true }).count(), 1);
      assert.equal(readFileSync(externalFile, 'utf8'), content);
      if (process.env.E2E_CAPTURE_SETTINGS) {
        mkdirSync(process.env.E2E_CAPTURE_SETTINGS, { recursive: true });
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'offline-config-models-desktop.png'),
        });
        const viewport = app.page.viewportSize();
        await app.page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await settings().evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'offline-config-models-phone.png'),
        });
        await app.page.setViewportSize(viewport);
      }
      writeFileSync(externalFile, 'models: {edited-offline-model: {cmd: never-execute-this}}');
      await guided.getByRole('button', { name: 'Refresh models', exact: true }).click();
      await library.locator('[data-config-model="edited-offline-model"]').waitFor();
      assert.equal(await external.count(), 0);
      writeFileSync(externalFile, 'models: [invalid]');
      await guided.getByRole('button', { name: 'Refresh models', exact: true }).click();
      await guided.getByRole('alert').filter({ hasText: 'models entry must be a YAML object' }).first().waitFor();
      await owned.waitFor();
      assert.match(await owned.innerText(), /From config/);
      await guided.getByRole('tab', { name: 'Engines', exact: true }).click();
      await guided.getByRole('button', { name: 'Use automatic detection', exact: true }).click();
      await app.page.waitForFunction(
        () => !document.querySelector('[aria-label="llama-swap configuration"] button')?.disabled,
      );
    } finally {
      if (previous !== undefined) writeFileSync(sharedFile, previous);
      else rmSync(sharedFile, { force: true });
      rmSync(externalFile, { force: true });
      rmSync(service, { force: true });
      await ext();
    }
  });

  it('edits automatically detected YAML with validation and conflict recovery', async () => {
    const file = join(world.base, 'existing-llama-swap.yaml');
    const original = readFileSync(file, 'utf8');
    try {
      await settings().getByRole('tab', { name: 'Local models', exact: true }).click();
      const guided = settings().getByTestId('local-runtime-wizard');
      await guided.getByRole('tab', { name: 'Engines', exact: true }).click();
      await guided.getByRole('button', { name: 'Advanced YAML…', exact: true }).first().click();
      const modal = editor(),
        field = modal.locator('textarea');
      await field.waitFor();
      await field.fill('models: [invalid]');
      await modal.getByTestId('editor-problem').waitFor();
      assert.equal(await modal.getByTestId('editor-save').isDisabled(), true);
      await field.fill(original + '\n# edited in Settings\n');
      writeFileSync(file, original + '\n# external edit\n');
      await modal.getByTestId('editor-save').click();
      await modal.getByTestId('editor-error').filter({ hasText: 'changed since' }).waitFor();
      assert.equal(readFileSync(file, 'utf8').includes('# edited in Settings'), false);
      await modal.getByRole('button', { name: 'Reload', exact: true }).click();
      await field.waitFor();
      await app.page.waitForFunction(() =>
        document.querySelector('[data-testid=file-editor] textarea')?.value.includes('# external edit'),
      );
      const reloaded = await field.inputValue();
      assert.match(reloaded, /# external edit/);
      await field.fill(reloaded + '# saved through YAML editor\n');
      if (process.env.E2E_CAPTURE_SETTINGS)
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'yaml-editor-desktop.png'),
        });
      await modal.getByTestId('editor-save').click();
      await modal.waitFor({ state: 'detached' });
      assert.match(readFileSync(file, 'utf8'), /# external edit[\s\S]*# saved through YAML editor/);
      assert.equal(
        parseYaml(readFileSync(file, 'utf8')).models['existing-model'].cmd,
        'existing-engine --ctx-size 4096',
      );
    } finally {
      writeFileSync(file, original);
      await ext();
    }
  });

  it('configures model knobs in a form, preserves the existing YAML and handles concurrent edits', async () => {
    const file = join(world.base, 'existing-llama-swap.yaml'),
      original = readFileSync(file, 'utf8'),
      viewport = app.page.viewportSize();
    writeFileSync(
      file,
      original.replace('models:\n', 'macros:\n  context: 8192\nmodels:\n') +
        `  knobs-model: # preserve model comment\n    cmd: |\n      llama-server --model '/models/a b.gguf' -c \${context} -ngl all --temp 0.7 --host 127.0.0.1 --port \${PORT} --chat-template-kwargs '{"think":true}'\n    ttl: 60 # preserve ttl comment\n    aliases: [my-alias]\n`,
    );
    try {
      await settings().getByRole('tab', { name: 'Local models', exact: true }).click();
      const guided = settings().getByTestId('local-runtime-wizard');
      await guided.getByRole('button', { name: 'Refresh models', exact: true }).click();
      await guided.getByRole('tab', { name: /^Your models/ }).click();
      await guided
        .locator('[data-config-model="knobs-model"]')
        .getByRole('button', { name: 'Configure', exact: true })
        .click();
      const modal = app.page.getByTestId('model-settings');
      await modal.getByRole('spinbutton', { name: 'Context size', exact: true }).waitFor();
      assert.equal(await modal.getByRole('spinbutton', { name: 'Context size', exact: true }).inputValue(), '8192');
      assert.match(await modal.innerText(), /config macro/);
      await modal.getByRole('spinbutton', { name: 'Context size', exact: true }).fill('32768');
      await modal.getByRole('spinbutton', { name: 'Unload after idle (seconds)', exact: true }).fill('0');
      await modal.getByRole('textbox', { name: 'GPU layers', exact: true }).fill('4');
      await modal.getByRole('combobox', { name: 'Flash Attention', exact: true }).selectOption('on');
      if (process.env.E2E_CAPTURE_SETTINGS)
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'model-settings-runtime.png'),
        });
      await modal.getByRole('tab', { name: 'Generation defaults', exact: true }).click();
      await modal.getByRole('spinbutton', { name: 'Temperature', exact: true }).fill('0.25');
      await modal.getByRole('spinbutton', { name: 'Top P', exact: true }).fill('0.9');
      await modal.getByRole('button', { name: 'Save model settings', exact: true }).click();
      await modal
        .getByText('Saved to your existing config. Engine options apply on the next model load.', { exact: true })
        .waitFor();
      const text = readFileSync(file, 'utf8'),
        parsed = parseYaml(text);
      assert.match(text, /# preserve model comment/);
      assert.match(text, /# preserve ttl comment/);
      assert.equal(parsed.models['knobs-model'].ttl, 0);
      assert.match(parsed.models['knobs-model'].cmd, /-c 32768/);
      assert.match(parsed.models['knobs-model'].cmd, /-ngl 4/);
      assert.match(parsed.models['knobs-model'].cmd, /--temp 0.25/);
      assert.match(parsed.models['knobs-model'].cmd, /--top-p 0.9/);
      assert.match(parsed.models['knobs-model'].cmd, /--flash-attn on/);
      assert.match(parsed.models['knobs-model'].cmd, /--port \$\{PORT\}/);
      assert.match(parsed.models['knobs-model'].cmd, /--chat-template-kwargs '\{"think":true\}'/);
      assert.equal(parsed.macros.context, 8192);
      assert.deepEqual(parsed.models['knobs-model'].aliases, ['my-alias']);
      assert.equal(parsed.models['existing-model'].cmd, 'existing-engine --ctx-size 4096');
      await modal.getByRole('tab', { name: 'Runtime', exact: true }).click();
      await app.page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await modal.getByRole('dialog').evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
      if (process.env.E2E_CAPTURE_SETTINGS)
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'model-settings-phone.png'),
        });
      await app.page.setViewportSize(viewport);
      writeFileSync(file, text + '# external edit\n');
      await modal.getByRole('spinbutton', { name: 'CPU threads', exact: true }).fill('8');
      await modal.getByRole('button', { name: 'Save model settings', exact: true }).click();
      await modal.getByRole('alert').filter({ hasText: 'changed since' }).waitFor();
      assert.equal(readFileSync(file, 'utf8'), text + '# external edit\n');
      await modal.getByRole('button', { name: 'Reload model settings', exact: true }).click();
      await app.page.waitForFunction(() => document.querySelector('[aria-label="CPU threads"]')?.value === '');
      await modal.getByRole('spinbutton', { name: 'CPU threads', exact: true }).fill('4');
      await modal.getByRole('button', { name: 'Advanced YAML…', exact: true }).click();
      await modal.getByRole('button', { name: 'Keep editing', exact: true }).click();
      assert.equal(await editor().count(), 0);
      await modal.getByRole('button', { name: 'Advanced YAML…', exact: true }).click();
      await modal.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await editor().locator('textarea').waitFor();
      assert.match(await editor().locator('textarea').inputValue(), /# external edit/);
    } finally {
      await app.page.setViewportSize(viewport);
      writeFileSync(file, original);
      await ext();
    }
  });

  it('edits configured MTP and draft controls in the model GUI and writes them to the existing YAML', async () => {
    const file = join(world.base, 'existing-llama-swap.yaml'),
      original = readFileSync(file, 'utf8');
    writeFileSync(
      file,
      original +
        '  mtp-model:\n    cmd: llama-server --model /models/mtp.gguf --spec-type draft-mtp --spec-draft-n-max 3 --custom keep\n',
    );
    try {
      await ext();
      await settings().getByRole('tab', { name: 'Local models', exact: true }).click();
      const guided = settings().getByTestId('local-runtime-wizard');
      await guided
        .locator('[data-config-model="mtp-model"]')
        .getByRole('button', { name: 'Configure', exact: true })
        .click();
      const modal = app.page.getByTestId('model-settings');
      await modal.getByRole('tab', { name: 'MTP', exact: true }).click();
      assert.equal(
        await modal.getByRole('combobox', { name: 'Speculative decoding', exact: true }).inputValue(),
        'draft-mtp',
      );
      await modal.getByRole('spinbutton', { name: 'Maximum draft tokens', exact: true }).fill('6');
      await modal.getByRole('spinbutton', { name: 'Minimum draft tokens', exact: true }).fill('7');
      assert.equal(await modal.getByRole('button', { name: 'Save model settings', exact: true }).isDisabled(), true);
      await modal.getByRole('spinbutton', { name: 'Minimum draft tokens', exact: true }).fill('1');
      await modal.getByRole('spinbutton', { name: 'Minimum draft probability', exact: true }).fill('0.1');
      await modal.getByRole('textbox', { name: 'Draft model path', exact: true }).fill("/models/a draft's head.gguf");
      await modal.getByRole('button', { name: 'Save model settings', exact: true }).click();
      await modal
        .getByText('Saved to your existing config. Engine options apply on the next model load.', { exact: true })
        .waitFor();
      const command = parseYaml(readFileSync(file, 'utf8')).models['mtp-model'].cmd;
      assert.match(command, /--spec-draft-n-max 6/);
      assert.match(command, /--spec-draft-n-min 1/);
      assert.match(command, /--spec-draft-p-min 0.1/);
      assert.match(command, /--custom keep/);
      assert.equal(
        await modal.getByRole('textbox', { name: 'Draft model path', exact: true }).inputValue(),
        "/models/a draft's head.gguf",
      );
      if (process.env.E2E_CAPTURE_SETTINGS)
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'model-mtp.png'),
        });
      await modal.getByRole('combobox', { name: 'Speculative decoding', exact: true }).selectOption('none');
      const disabledMtp = app.page.waitForResponse(
        (response) =>
          response.url().includes('/api/setup/local-runtime/model-options') && response.request().method() === 'POST',
      );
      await modal.getByRole('button', { name: 'Save model settings', exact: true }).click();
      assert.equal((await disabledMtp).ok(), true);
      await app.page.waitForFunction(
        () => document.querySelector('[aria-label="Speculative decoding"]')?.value === 'none',
      );
      assert.match(parseYaml(readFileSync(file, 'utf8')).models['mtp-model'].cmd, /--spec-type none/);
    } finally {
      writeFileSync(file, original);
      await ext();
    }
  });

  it('translates model settings, YAML validation and model pages into German and preserves saved knobs', async () => {
    const file = join(world.base, 'existing-llama-swap.yaml'),
      original = readFileSync(file, 'utf8');
    writeFileSync(
      file,
      original + '  translated-model:\n    cmd: llama-server --model /models/example.gguf --ctx-size 4096 --temp 0.7\n',
    );
    try {
      if ((await settings().count()) === 0) await app.h.openSettings();
      await settings().getByRole('tab', { name: 'General', exact: true }).click();
      await settings().getByTestId('language-select').selectOption('de');
      const german = app.page.getByRole('dialog', { name: 'Einstellungen', exact: true });
      await german.getByRole('tab', { name: 'Lokale Modelle', exact: true }).click();
      const guided = german.getByTestId('local-runtime-wizard');
      await guided
        .locator('[data-config-model="translated-model"]')
        .getByRole('button', { name: 'Konfigurieren', exact: true })
        .click();
      const modal = app.page.getByTestId('model-settings');
      await modal.getByRole('spinbutton', { name: 'Kontextgröße', exact: true }).fill('8192');
      await modal.getByRole('tab', { name: 'Generierungsvorgaben', exact: true }).click();
      await modal.getByRole('spinbutton', { name: 'Temperatur', exact: true }).fill('0.5');
      await modal.getByRole('button', { name: 'Modelleinstellungen speichern', exact: true }).click();
      await modal.getByText('In deiner vorhandenen Konfiguration gespeichert.', { exact: false }).waitFor();
      const saved = parseYaml(readFileSync(file, 'utf8')).models['translated-model'].cmd;
      assert.match(saved, /--ctx-size 8192/);
      assert.match(saved, /--temp 0.5/);
      if (process.env.E2E_CAPTURE_SETTINGS)
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'model-settings-german.png'),
        });
      await modal.getByRole('button', { name: 'Erweitert: YAML…', exact: true }).click();
      await editor().locator('textarea').fill('models: [invalid]');
      await editor()
        .getByTestId('editor-problem')
        .filter({ hasText: 'Der Eintrag models muss ein YAML-Objekt sein.' })
        .waitFor();
      assert.equal(await editor().getByTestId('editor-save').isDisabled(), true);
      await editor().getByRole('dialog').getByRole('button', { name: 'Schließen', exact: true }).click();
      await editor().getByTestId('discard').click();
      await editor().waitFor({ state: 'detached' });
      await german.getByRole('tab', { name: 'Chatmodelle', exact: true }).click();
      await german.getByRole('tab', { name: 'Chatvorgaben', exact: true }).waitFor();
      await german.getByRole('tab', { name: /^Katalog/ }).click();
      await german.getByRole('searchbox', { name: 'Modellkatalog filtern' }).waitFor();
    } finally {
      writeFileSync(file, original);
      const modal = app.page.getByTestId('model-settings');
      if (await modal.count()) {
        await modal.locator('.head button').click();
        if (await modal.getByRole('button', { name: 'Änderungen verwerfen', exact: true }).count())
          await modal.getByRole('button', { name: 'Änderungen verwerfen', exact: true }).click();
      }
      if (await editor().count()) {
        await editor().getByRole('dialog').getByRole('button', { name: 'Schließen', exact: true }).click();
        if (await editor().getByTestId('discard').count()) await editor().getByTestId('discard').click();
      }
      const german = app.page.getByRole('dialog', { name: 'Einstellungen', exact: true });
      if (await german.count()) {
        await german.getByRole('tab', { name: 'Allgemein', exact: true }).click();
        await german.getByTestId('language-select').selectOption('en');
      }
      await ext();
    }
  });

  it('saves before reload, keeps reload running after closing the form, and retries without resaving', async () => {
    const file = join(world.base, 'existing-llama-swap.yaml'),
      original = readFileSync(file, 'utf8');
    writeFileSync(file, original + '  reload-model:\n    cmd: llama-server -c 4096\n');
    const optionsRoute = /\/api\/setup\/local-runtime\/model-options(?:\?.*)?$/;
    const statusRoute = /\/api\/setup\/local-runtime$/;
    let job,
      requests = 0,
      saves = 0;
    await app.page.route(optionsRoute, async (route) => {
      if (route.request().method() === 'POST') saves++;
      const response = await route.fetch(),
        data = await response.json();
      await route.fulfill({ json: { ...data, reload: { available: true, baseUrl: 'http://127.0.0.1:8080' } } });
    });
    await app.page.route('**/api/setup/local-runtime/model-reload', async (route) => {
      const body = route.request().postDataJSON();
      assert.match(parseYaml(readFileSync(file, 'utf8')).models['reload-model'].cmd, /-c 32768/);
      assert.equal(body.model, 'reload-model');
      job = {
        id: `reload-fixture-${++requests}`,
        kind: 'reload',
        state: 'running',
        startedAt: 1,
        logs: [],
        detail: 'Loading reload-model with saved settings…',
        action: { kind: 'reload', ...body },
      };
      await route.fulfill({ json: job });
    });
    await app.page.route(statusRoute, (route) =>
      job ? route.fulfill({ json: { autostart: false, job } }) : route.continue(),
    );
    try {
      await settings().getByRole('tab', { name: 'Local models', exact: true }).click();
      const guided = settings().getByTestId('local-runtime-wizard');
      await guided.getByRole('tab', { name: /^Your models/ }).click();
      await guided.getByRole('button', { name: 'Refresh models', exact: true }).click();
      const configure = guided
        .locator('[data-config-model="reload-model"]')
        .getByRole('button', { name: 'Configure', exact: true });
      await configure.click();
      const modal = app.page.getByTestId('model-settings');
      await modal.getByRole('spinbutton', { name: 'Context size', exact: true }).fill('32768');
      await modal.getByRole('button', { name: 'Save and reload model', exact: true }).click();
      await modal.getByText('Loading reload-model with saved settings…', { exact: true }).waitFor();
      assert.equal(
        await modal.getByText('Model reloaded and ready. The saved settings are active.', { exact: true }).count(),
        0,
      );
      assert.equal(saves, 1);
      if (process.env.E2E_CAPTURE_SETTINGS)
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'model-reload-progress.png'),
        });
      await modal.locator('.head').getByRole('button', { name: 'Close', exact: true }).click();
      await modal.waitFor({ state: 'detached' });
      await guided.getByTestId('local-job').getByText('reload-model', { exact: true }).waitFor();
      job = { ...job, state: 'failed', error: 'Model failed to load. Saved settings are retained.' };
      await guided.getByTestId('local-job').getByRole('alert').waitFor();
      await configure.click();
      await modal.getByRole('button', { name: 'Reload model', exact: true }).click();
      await modal.getByText('Loading reload-model with saved settings…', { exact: true }).waitFor();
      assert.equal(requests, 2);
      assert.equal(saves, 1);
      job = { ...job, state: 'complete', detail: 'reload-model is ready with the saved settings.' };
      await modal.getByText('Model reloaded and ready. The saved settings are active.', { exact: true }).waitFor();
      assert.equal(saves, 1);
      if (process.env.E2E_CAPTURE_SETTINGS)
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'model-reload-ready.png'),
        });
    } finally {
      await app.page.unroute(optionsRoute);
      await app.page.unroute(statusRoute);
      await app.page.unroute('**/api/setup/local-runtime/model-reload');
      writeFileSync(file, original);
      await ext();
    }
  });

  it('organizes Chat models into defaults, pinned shortcuts and a bounded searchable catalog', async () => {
    const overviewRoute = '**/api/pi-settings*';
    const viewport = app.page.viewportSize();
    await app.page.route(overviewRoute, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch(),
        data = await response.json();
      await route.fulfill({
        json: {
          ...data,
          models: Array.from({ length: 60 }, (_, index) => ({
            provider: index % 2 ? 'second' : 'fixture',
            id: `fixture-${String(index).padStart(3, '0')}`,
            name: `Fixture ${index}`,
            available: true,
            reasoning: index % 2 === 0,
            contextWindow: 16384,
          })),
        },
      });
    });
    try {
      await settings().locator('.head > .pk-close').first().click();
      await app.h.openSettings();
      await settings().getByRole('tab', { name: 'Chat models', exact: true }).click();
      const page = settings().getByTestId('section-models');
      await page.getByRole('tab', { name: 'Chat defaults', exact: true }).click();
      await page.getByTestId('default-model').waitFor();
      assert.match(
        await page.getByRole('tabpanel', { name: 'Chat defaults' }).innerText(),
        /Applies when you create a chat/,
      );
      assert.equal(await page.locator('[data-testid^="provider-default-"]').count(), 0);
      if (process.env.E2E_CAPTURE_SETTINGS)
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'chat-defaults-desktop.png'),
        });
      await page.getByRole('tab', { name: /^Catalog/ }).click();
      const catalog = page.getByRole('region', { name: 'Model catalog', exact: true });
      await catalog.locator('tbody tr').last().scrollIntoViewIfNeeded();
      const size = await catalog.evaluate((element) => ({ height: element.clientHeight, full: element.scrollHeight }));
      assert.ok(size.full > size.height && size.height <= 352, 'the catalog scrolls inside its height budget');
      await page.getByRole('searchbox', { name: 'Filter model catalog' }).fill('fixture-059');
      assert.equal(await catalog.locator('tbody tr').count(), 1);
      assert.match(await catalog.innerText(), /second\/fixture-059/);
      assert.ok(!(await catalog.innerText()).includes('Free'), 'unknown catalog prices are not called free');
      await page.getByRole('searchbox', { name: 'Filter model catalog' }).fill('');
      await page.getByRole('combobox', { name: 'Filter by provider' }).selectOption('second');
      await app.page.waitForFunction(
        () => document.querySelectorAll('[aria-label="Model catalog"] tbody tr').length === 30,
      );
      assert.equal(await catalog.locator('tbody tr').count(), 30);
      if (process.env.E2E_CAPTURE_SETTINGS)
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'chat-catalog-desktop.png'),
        });
      await app.page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await settings().evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
      assert.ok(
        await catalog
          .locator('tbody td')
          .first()
          .evaluate((element) => element.clientWidth >= 224),
        'model names remain readable on a narrow screen',
      );
      if (process.env.E2E_CAPTURE_SETTINGS)
        await app.page.screenshot({
          animations: 'disabled',
          path: join(process.env.E2E_CAPTURE_SETTINGS, 'chat-catalog-phone.png'),
        });
    } finally {
      await app.page.unroute(overviewRoute);
      await app.page.setViewportSize(viewport);
      if (await settings().count()) {
        await settings().locator('.head > .pk-close').first().click();
        await settings().waitFor({ state: 'detached' });
      }
      await ext();
    }
  });

  it('restores retry controls and the exact filename, cancels explicitly, and reclaims orphaned bytes', async () => {
    const statusUrl = /\/api\/setup\/local-runtime$/;
    const gib = 1024 ** 3;
    const candidate = {
      id: 'retry-fixture',
      repository: 'test/Retry-GGUF',
      revision: 'a'.repeat(40),
      file: 'retry-fixture.gguf',
      bytes: 2 * gib,
      sha256: 'b'.repeat(64),
      license: 'apache-2.0',
      source: 'https://huggingface.co/test/Retry-GGUF',
      downloads: 1,
      estimate: { contextTokens: 8192, memoryBytes: 4 * gib, fitsMemory: true, fitsDisk: true, explanation: 'Fixture' },
    };
    const initial = {
      id: 'restored-job',
      kind: 'download',
      state: 'cancelled',
      detail: 'Old cancelled job',
      startedAt: 1,
      receivedBytes: gib,
      totalBytes: 2 * gib,
      logs: [],
      action: { kind: 'download', candidate },
    };
    let current = initial,
      retried = false,
      cancelled = false;
    await app.page.route(statusUrl, (route) => route.fulfill({ json: { autostart: false, job: current } }));
    await app.page.route('**/api/setup/local-runtime/retry', async (route) => {
      retried = true;
      current = { ...initial, id: 'retried-job', state: 'running', receivedBytes: 0 };
      await route.fulfill({ json: current });
    });
    await app.page.route('**/api/setup/local-runtime/cancel', async (route) => {
      cancelled = true;
      current = { ...current, state: 'cancelled' };
      await route.fulfill({ json: { autostart: false, job: current } });
    });
    const modelFolder = join(world.data, 'local-models');
    mkdirSync(modelFolder, { recursive: true });
    const partial = join(modelFolder, 'retry-fixture.gguf.12345678-1234-1234-1234-123456789abc.part');
    writeFileSync(partial, 'orphaned download bytes');
    try {
      await settings().getByRole('tab', { name: 'Local models' }).click();
      const guided = settings().getByTestId('local-runtime-wizard'),
        job = guided.getByTestId('local-job');
      await job.getByText('retry-fixture.gguf', { exact: true }).waitFor();
      assert.equal(await job.locator('progress').count(), 0, 'a cancelled transfer is history, not current progress');
      await job.getByRole('button', { name: 'Retry this download' }).click();
      await job.getByRole('button', { name: 'Cancel download and remove partial file' }).waitFor();
      assert.equal(retried, true);
      await job.getByRole('button', { name: 'Cancel download and remove partial file' }).click();
      await job.getByRole('button', { name: 'Retry this download' }).waitFor();
      assert.equal(cancelled, true);
      await guided.getByRole('button', { name: /Remove incomplete downloads/ }).click();
      await app.page.waitForFunction(() => !document.querySelector('[aria-label="Leftover model files"]'));
      assert.equal(existsSync(partial), false, 'cleanup removes real orphaned partial files');
    } finally {
      await app.page.unroute(statusUrl);
      await app.page.unroute('**/api/setup/local-runtime/retry');
      await app.page.unroute('**/api/setup/local-runtime/cancel');
      await ext();
    }
  });
});

describe('Add a package: Browse', () => {
  it('lists the registry’s packages and pi-kit’s own, with what they contain, their use and their licence', async () => {
    await settings().getByTestId('add-package').click();
    await wizard().getByTestId('result-pi-subagents').waitFor();
    const names = await wizard()
      .locator('.pk-choices button')
      .evaluateAll((b) => b.map((x) => x.getAttribute('data-testid')));
    for (const name of [
      'pi-subagents',
      'pi-swarm',
      'skills-devops',
      'pi-review-bot',
      '@pi-kit/learn',
      '@pi-kit/meat-proxy',
    ])
      assert.ok(names.includes(`result-${name}`), `${name} is listed: ${names.join(', ')}`);
    assert.match(
      await wizard().getByTestId('result-pi-subagents').innerText(),
      /2 extensions, 1 skill · 12k downloads · updated .* · MIT/,
    );
    assert.match(await wizard().getByTestId('result-skills-devops').innerText(), /3 skills/);
    assert.match(await wizard().getByTestId('result-@pi-kit/learn').innerText(), /ships with pi-kit/);
    assert.match(await wizard().getByTestId('browse-hint').innerText(), /keyword pi-package/);
    assert.deepEqual(searchLogs()[0], 'keywords:pi-package', 'the first search asks for the keyword alone');
  });

  it('a search narrows the list, the filter keeps what contains the kind, and the same search is not asked twice', async () => {
    await wizard().getByTestId('package-search').fill('subagent');
    await wizard().locator('.pk-choices button').nth(1).waitFor({ state: 'detached' });
    assert.deepEqual(
      await wizard()
        .locator('.pk-choices button')
        .evaluateAll((b) => b.map((x) => x.getAttribute('data-testid'))),
      ['result-pi-subagents'],
    );
    assert.ok(searchLogs().includes('keywords:pi-package subagent'));
    await wizard().getByTestId('package-search').fill('');
    await wizard().getByTestId('result-pi-swarm').waitFor();
    const before = registry.requests.length;
    await wizard().getByTestId('package-kind').selectOption('skills');
    await wizard().getByTestId('result-pi-swarm').waitFor({ state: 'detached' });
    const skills = await wizard()
      .locator('.pk-choices button')
      .evaluateAll((b) => b.map((x) => x.getAttribute('data-testid')));
    assert.deepEqual(skills.sort(), ['result-pi-subagents', 'result-skills-devops']);
    assert.equal(
      registry.requests.length,
      before,
      'the filter works on what the search already has: one search per five minutes',
    );
    await wizard().getByTestId('package-kind').selectOption('all');
  });

  it('a result goes to the second step: what it adds, the README as plain text, and the exact command; Back returns', async () => {
    await wizard().getByTestId('result-pi-review-bot').click();
    await wizard().getByTestId('package-command').waitFor();
    assert.match(await wizard().getByTestId('detail-title').innerText(), /pi-review-bot\s+0\.9\.3/);
    const adds = await wizard().getByTestId('package-adds').innerText();
    assert.match(adds, /Extensions\s+1/);
    assert.match(adds, /Prompts\s+1/);
    assert.equal(await wizard().getByTestId('package-command').innerText(), 'pi install npm:pi-review-bot');
    assert.match(await wizard().getByTestId('package-readme').innerText(), /A second opinion\./);
    assert.equal(
      await wizard()
        .getByTestId('package-readme')
        .evaluate((el) => getComputedStyle(el).maxHeight),
      '160px',
    );
    await wizard().getByTestId('every-project').uncheck();
    await wizard().getByTestId('package-command').filter({ hasText: 'pi install -l npm:pi-review-bot' }).waitFor();
    await wizard().getByTestId('wizard-back').click();
    await wizard().getByTestId('package-search').waitFor();
    // the network is not touched by installing: this test goes no further with an npm package
    assert.deepEqual(piSettings().packages ?? [], []);
  });
});

describe('Add a package: From a folder', () => {
  it('a folder that is not a package is refused on the second step', async () => {
    await wizard().getByTestId('tab-folder').check();
    mkdirSync(join(world.base, 'not-a-package'), { recursive: true });
    await wizard().getByTestId('package-folder').fill(join(world.base, 'not-a-package'));
    await wizard().getByTestId('package-primary').click();
    await wizard().getByTestId('detail-error').waitFor();
    assert.match(await wizard().getByTestId('detail-error').innerText(), /is not a pi package/);
    assert.equal(await wizard().getByTestId('package-primary').isDisabled(), true);
    await wizard().getByTestId('wizard-back').click();
  });

  it('says what the folder adds, and Install puts the package in pi’s settings and the row in the list', async () => {
    await wizard().getByTestId('package-folder').fill(pkg);
    await wizard().getByTestId('package-primary').click();
    await wizard().getByTestId('package-command').waitFor();
    assert.match(await wizard().getByTestId('detail-title').innerText(), /demo-pkg\s+0\.1\.0/);
    const adds = await wizard().getByTestId('package-adds').innerText();
    assert.match(adds, /Extensions\s+hello/);
    assert.match(adds, /Skills\s+split-task/);
    assert.match(adds, /Prompts\s+review/);
    // the choice made on the Browse tab is still there (one wizard, one set of choices): this package goes to every project
    assert.equal(await wizard().getByTestId('every-project').isChecked(), false);
    await wizard().getByTestId('every-project').check();
    await wizard()
      .getByTestId('package-command')
      .filter({ hasText: `pi install ${pkg}` })
      .waitFor();
    assert.equal(await wizard().getByTestId('package-command').innerText(), `pi install ${pkg}`);
    assert.match(await wizard().getByTestId('package-readme').innerText(), /It says hello from a folder\./);
    await wizard().getByTestId('package-primary').click();
    await wizard().waitFor({ state: 'detached' });
    await row('demo-pkg').waitFor();
    assert.equal(piSettings().packages.length, 1);
    assert.match(String(piSettings().packages[0].source ?? piSettings().packages[0]), /demo-pkg$/);
    const r = row('demo-pkg');
    assert.equal(await r.locator('.nm .chip.ok').innerText(), 'on');
    assert.match(
      (await r.locator('.ds').innerText()).replace(/\s+/g, ' '),
      /^1 extension, 1 skill, 1 prompt · .*demo-pkg/,
    );
    assert.equal(await r.locator('.nm .cnt').innerText(), '0.1.0');
    assert.equal(await settings().getByTestId('packages-empty').count(), 0);
    // a package's own skill is under the package, not under Your skills
    assert.equal(await settings().getByTestId('skills-group').getByTestId('resource-skills-split-task').count(), 0);
    await r.getByTestId('toggle-contents-demo-pkg').click();
    await settings().getByTestId('contents-demo-pkg').getByTestId('resource-skills-split-task').waitFor();
    assert.equal(await settings().getByTestId('contents-demo-pkg').getByTestId('resource-extensions-hello').count(), 1);
  });

  it('the same folder cannot be installed twice', async () => {
    await settings().getByTestId('add-package').click();
    await wizard().getByTestId('tab-folder').check();
    await wizard().getByTestId('package-folder').fill(pkg);
    await wizard().getByTestId('package-primary').click();
    await wizard().getByTestId('package-command').waitFor();
    assert.equal(await wizard().getByTestId('package-primary').isDisabled(), true);
    assert.match(await wizard().innerText(), /installed already/);
    await app.page.keyboard.press('Escape');
    await wizard().waitFor({ state: 'detached' });
  });
});

describe('on and off, updates, remove', () => {
  it('the switch turns the package off in pi’s settings and back on, and offers the reload', async () => {
    const toggle = row('demo-pkg').getByTestId('package-toggle-demo-pkg');
    await toggle.uncheck();
    await app.page.waitForFunction(
      () => document.querySelector('[data-testid="package-demo-pkg"]')?.getAttribute('data-state') === 'off',
    );
    const entry = piSettings().packages[0];
    assert.deepEqual(
      { extensions: entry.extensions, skills: entry.skills, prompts: entry.prompts, themes: entry.themes },
      { extensions: [], skills: [], prompts: [], themes: [] },
    );
    assert.equal(await row('demo-pkg').locator('.nm .chip.off').first().innerText(), 'off');
    await settings().getByTestId('reload-banner').waitFor();
    await toggle.check();
    await app.page.waitForFunction(
      () => document.querySelector('[data-testid="package-demo-pkg"]')?.getAttribute('data-state') === 'on',
    );
    assert.equal(typeof piSettings().packages[0], 'string', 'on again is the plain source, as pi writes it');
  });

  it('Check for updates marks it 0.1.0 → 0.2.0, and Update takes the new version', async () => {
    await settings().getByTestId('check-updates').click();
    await settings().getByTestId('outdated-demo-pkg').waitFor();
    assert.equal(await settings().getByTestId('outdated-demo-pkg').innerText(), '0.1.0 → 0.2.0');
    // the folder is the package: its new version is what an update picks up
    writePackage('0.2.0');
    await settings().getByTestId('update-demo-pkg').click();
    await settings().getByTestId('outdated-demo-pkg').waitFor({ state: 'detached' });
    assert.equal(await row('demo-pkg').locator('.nm .cnt').innerText(), '0.2.0');
    assert.equal(await settings().getByTestId('update-demo-pkg').count(), 0);
  });

  it('Remove… asks first, and then pi takes the package out of its settings', async () => {
    await row('demo-pkg').getByTestId('package-more-demo-pkg').click();
    await app.page.getByRole('menuitem', { name: 'Remove…' }).click();
    await settings().getByTestId('remove-confirm-demo-pkg').waitFor();
    assert.match(await settings().getByTestId('remove-confirm-demo-pkg').innerText(), /Remove demo-pkg\?/);
    assert.equal(piSettings().packages.length, 1, 'asking changed nothing');
    await settings().getByTestId('remove-yes-demo-pkg').click();
    await row('demo-pkg').waitFor({ state: 'detached' });
    assert.deepEqual(piSettings().packages ?? [], []);
    assert.ok(existsSync(join(pkg, 'package.json')), 'a folder package is pi’s to forget, not to delete');
    await settings().getByTestId('packages-empty').waitFor();
  });
});
