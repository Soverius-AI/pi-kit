// End to end: pi updates from inside the app. Runs after app.e2e.mjs against the same dev:web server and scratch agent folder.
// The real update (pi's own updater installing a release, `pi update --all`, the pi command) is exercised by hand against a scratch copy of the
// install layout and described; here the release "arrives" as pi would leave it, the app notices, the backend restarts through the
// supervisor's job (the test is the supervisor in dev:web) and the thread comes back.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { api, env, openApp } from './support/app.mjs';
import { root } from './support/env.mjs';
import { addFakeRelease } from './support/fake-release.mjs';

let app;
const spawned = [];
/** The backend that `app.e2e.mjs` last started (its restart test) ended with that file; this file brings one up when none answers, the way the restart test does. */
async function ensureBackend() {
  const up = async () => {
    try {
      return (await fetch(`${env.api}/api/health`, { headers: { Authorization: `Bearer ${env.server.PI_KIT_TOKEN}` } })).ok;
    } catch {
      return false;
    }
  };
  if (await up()) return;
  startBackend();
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
}

function startBackend() {
  const child = spawn('node', ['dist/apps/backend/main.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, ...env.server, NODE_ENV: 'development', PI_KIT_PORT: new URL(env.api).port, PI_KIT_ORIGIN: env.base },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  spawned.push(child.pid);
}

before(async () => {
  await ensureBackend();
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

// A release newer than the bundled pi (the backend uses a managed release only when it is not older): the bundled version with its patch raised.
const BUNDLED = JSON.parse(readFileSync(join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), 'utf8')).version;
const FAKE = BUNDLED.replace(/^(\d+)\.(\d+)\.(\d+).*$/, (_, major, minor, patch) => `${major}.${minor}.${Number(patch) + 5}`);

describe('pi updates from inside the app', () => {
  it('runs one background job, streams its output to the Versions block and writes the log', async () => {
    const { page, h } = app;
    await h.newThread();
    const dialog = await h.openSettings('General');
    await dialog.getByTestId('section-general').getByRole('tab', { name: 'Versions', exact: true }).click();
    const versions = dialog.getByRole('region', { name: 'Versions' });
    await versions.getByTestId('row-packages').waitFor();
    // `pi update --extensions` with nothing installed is quick and needs no network: pi's own updater, run from the bundled copy (no managed install yet).
    const started = await api('/api/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targets: ['packages'] }) });
    assert.equal(started.job.state, 'running');
    assert.deepEqual(started.job.targets, ['packages']);
    let status;
    for (let i = 0; i < 60; i++) {
      status = await api('/api/update/status');
      if (status.job?.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(status.job.state, 'done', JSON.stringify(status.job));
    assert.equal(status.rows.find((r) => r.target === 'packages').state, 'done');
    // the output reached the open page through the event stream, and the log file has it too
    await versions.getByTestId('update-log').getByText(/Updated packages/).waitFor();
    assert.ok(existsSync(status.job.logPath), 'update.log exists');
    assert.match(readFileSync(status.job.logPath, 'utf8'), /\[packages\] \$ pi update --extensions \(bundled copy\)/);
    await page.keyboard.press('Escape');
  });

  it('notices a release that appeared (an update from the terminal), restarts through the supervisor and brings the thread back', async () => {
    const { page, h } = app;
    await page.reload();
    await page.waitForSelector('pk-root .pk-shell');
    await h.newThread();
    await h.prompt('Say the word before.');
    const before = await api('/api/about');
    assert.equal(before.pi.source, 'bundled');

    // pi leaves a new managed release and moves `current-version`; pi-kit's backend keeps the pi it loaded and says a restart would change it.
    addFakeRelease(env.agentDir, FAKE);
    const status = await (async () => {
      for (let i = 0; i < 20; i++) {
        const s = await api('/api/update/status');
        if (s.restart.some((r) => r.kind === 'pi')) return s;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('no restart announced');
    })();
    assert.deepEqual(status.restart, [{ kind: 'pi', version: FAKE }]);
    assert.equal(status.resolution.source, 'bundled', 'the running backend still has the pi it loaded');

    // Settings and the sidebar say so.
    await page.getByTestId('settings-button').and(page.locator('[data-update="outdated"]')).waitFor();
    const dialog = await h.openSettings('General');
    await dialog.getByTestId('section-general').getByRole('tab', { name: 'Versions', exact: true }).click();
    const restartButton = dialog.getByRole('button', { name: `Restart to use ${FAKE}` });
    await restartButton.waitFor();
    await restartButton.click();
    await page.keyboard.press('Escape');

    // The backend ends itself; dev:web has no watchdog, so the test plays it and starts the backend again on the same port and token.
    await page.getByText(/Backend unreachable/).first().waitFor();
    startBackend();
    await page.locator('.toast', { hasText: /restarted|Reconnected/ }).first().waitFor();
    await page.getByText('Backend connected').first().waitFor();
    await page.getByText('Say the word before.').first().waitFor();

    // The new backend resolved the managed release: /api/about and Settings › General show the source and version.
    const after = await api('/api/about');
    assert.equal(after.pi.source, 'managed');
    assert.equal(after.pi.version, FAKE);
    assert.ok(after.pi.packageDir.includes(join('releases', FAKE)), after.pi.packageDir);
    const again = await h.openSettings('General');
    await again.getByTestId('section-general').getByRole('tab', { name: 'Versions', exact: true }).click();
    const versions = again.getByRole('region', { name: 'Versions' });
    await versions.getByTestId('pi-source').getByText(/Managed install/).waitFor();
    assert.match(await versions.getByTestId('row-pi').innerText(), new RegExp(`pi\\s+${FAKE.replace(/\./g, '\\.')}`));
    await page.keyboard.press('Escape');
    // and a prompt still runs on the pi that was loaded from the release folder
    await h.prompt('Say the word after.');
  });

  it('"Use previous release" pins the bundled copy and the next start runs it; following the newest undoes it', async () => {
    const { page, h } = app;
    const dialog = await h.openSettings('Advanced');
    await dialog.getByTestId('section-advanced').getByRole('tab', { name: 'Runtime', exact: true }).click();
    const advanced = dialog.getByTestId('advanced');
    await advanced.getByRole('combobox', { name: 'Release to use' }).selectOption('bundled');
    await advanced.getByTestId('use-previous').click();
    await advanced.getByText(/Pinned to the bundled copy/).waitFor();
    const status = await api('/api/update/status');
    assert.equal(status.pinned, 'bundled');
    assert.ok(status.restart.some((r) => r.kind === 'pi'), 'a restart would change the pi that runs');
    await advanced.getByRole('button', { name: 'Follow the newest' }).click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="advanced"]')?.textContent?.includes('Pinned to'), undefined);
    assert.equal((await api('/api/update/status')).pinned, undefined);
    await page.keyboard.press('Escape');
  });
});
