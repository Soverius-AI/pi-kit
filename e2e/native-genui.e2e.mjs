// Real pi tools and CopilotKit renderers, with a deterministic model. Data comes from bash/git in the scratch project.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { api, ensureBackend, env, git, openApp } from './support/app.mjs';
import { FAKE_MODEL, FAKE_PROVIDER, registerFakeModel, startFakeModel, userTextOf } from './support/fake-model.mjs';

let app;
let fake;
let settingsBefore;
let stopBackend;
const counts = (text) => {
  const grouped = new Map();
  for (const date of text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []) grouped.set(date, (grouped.get(date) ?? 0) + 1);
  const dates = [...grouped.keys()].sort();
  const rows = [];
  if (!dates.length) return rows;
  for (let day = new Date(`${dates[0]}T00:00:00Z`); day.toISOString().slice(0, 10) <= dates.at(-1); day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    rows.push({ date, commits: grouped.get(date) ?? 0 });
  }
  return rows;
};
const tool = (name, args) => ({ toolCalls: [{ name, arguments: args }] });

before(async () => {
  fake = await startFakeModel({ answer: (body) => {
    const messages = body.messages ?? [];
    const lastUser = messages.findLastIndex((message) => message.role === 'user');
    const prompt = userTextOf(body);
    const turn = messages.slice(lastUser + 1);
    if (/User performed action/.test(prompt)) return 'Refreshed the commit summary.';
    if (/Warmup/.test(prompt)) return 'Ready for the next request.';
    if (/Ask location/.test(prompt)) {
      if (!turn.some((message) => message.role === 'tool')) return tool('ask_user', { question: 'Where are you seeing the name?' });
      return 'Location received.';
    }
    if (/Ask range/.test(prompt)) {
      if (!turn.some((message) => message.role === 'tool')) return tool('ask_user', { question: 'Which commit range?', options: ['Last week', 'All history'] });
      return 'Selected range received.';
    }
    const results = turn.filter((message) => message.role === 'tool');
    if (!results.length) return tool('bash', { command: 'git log --format=%cs' });
    if (results.length > 1) return 'Displayed commits per day from Git.';
    const rows = counts(String(results[0].content));
    if (/A2UI table/.test(prompt)) return tool('render_a2ui', {
      surfaceId: 'commits-table', title: 'Commits per day', body: 'body', data: { rows }, components: [
        { id: 'body', component: 'Column', properties: { children: ['table', 'button'], inset: true } },
        { id: 'table', component: 'Table', properties: { columns: [{ key: 'date', label: 'Date' }, { key: 'commits', label: 'Commits' }], rows: { path: '/rows' } } },
        { id: 'button', component: 'Button', properties: { child: 'label', variant: 'primary', action: { event: { name: 'refresh_commits', context: {} } } } },
        { id: 'label', component: 'Text', properties: { text: 'Refresh commits' } },
      ],
    });
    const max = Math.max(1, ...rows.map((row) => row.commits));
    return tool('generateSandboxedUi', {
      initialHeight: 460, css: 'body{font:14px system-ui;margin:16px;color:#18283c;background:#f7fafc}svg{width:100%;height:260px}button{padding:8px}td{padding:4px 12px}',
      html: `<html><head></head><body><h2>Commits per day</h2><p>Current branch, all history; committer dates. Total: ${rows.reduce((sum, row) => sum + row.commits, 0)}</p><svg role="img" aria-label="Commits per day" viewBox="0 0 800 260">${rows.map((row, index) => `<rect data-date="${row.date}" data-commits="${row.commits}" x="${index * 800 / rows.length}" y="${240 - row.commits / max * 220}" width="${Math.max(1, 760 / rows.length)}" height="${row.commits / max * 220}" fill="#2563eb"><title>${row.date}: ${row.commits} commits</title></rect>`).join('')}</svg><button id="toggle">Show data</button><table id="data" hidden><tbody>${rows.map((row) => `<tr><td>${row.date}</td><td>${row.commits}</td></tr>`).join('')}</tbody></table></body></html>`,
      jsExpressions: ['document.getElementById("toggle").onclick = () => { document.getElementById("data").hidden = !document.getElementById("data").hidden; }'],
    });
  } });
  registerFakeModel(env.agentDir, fake.url);
  const path = join(env.agentDir, 'settings.json'); settingsBefore = readFileSync(path, 'utf8');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(settingsBefore), defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }));
  stopBackend = await ensureBackend();
  app = await openApp();
});
after(async () => {
  try {
    await app?.close(); await fake?.stop();
    if (settingsBefore) writeFileSync(join(env.agentDir, 'settings.json'), settingsBefore);
  } finally { await stopBackend?.(); }
});
const idle = () => app.page.getByTestId('stop').waitFor({ state: 'detached' });

describe('built-in generated UI and standard pi interrupts', () => {
  it('renders an interactive commits chart in WebSandbox and restores it after reload', async () => {
    const { page, h } = app;
    const mathFonts = [];
    const fontRequest = (request) => { if (request.url().includes('/KaTeX_')) mathFonts.push(request.url()); };
    page.on('request', fontRequest);
    await h.newThread(); await h.startPrompt('Commit chart: show how many commits per day we had in this project.');
    const selector = '[data-testid="open-generative-ui-final-sandbox"]';
    const chart = page.frameLocator(selector);
    await chart.getByRole('img', { name: 'Commits per day' }).waitFor(); await idle();
    const expected = counts(git('log', '--format=%cs'));
    const actual = async () => chart.locator('rect').evaluateAll((bars) => bars.map((bar) => ({ date: bar.dataset.date, commits: Number(bar.dataset.commits) })));
    assert.deepEqual(await actual(), expected);
    await chart.getByRole('button', { name: 'Show data' }).click();
    await chart.locator('table').waitFor({ state: 'visible' });
    const iframe = page.locator(selector);
    assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
    assert.ok((await iframe.getAttribute('src')).endsWith('/api/genui-sandbox/frame.html'));
    const frame = page.frames().find((frame) => frame.url().includes('/api/genui-sandbox/frame.html'));
    assert.equal(await frame.evaluate(() => { try { return !!parent.document; } catch { return false; } }), false);
    assert.equal(await frame.evaluate(() => { try { return !!localStorage; } catch { return false; } }), false);
    await page.screenshot({ path: join(env.project, '..', 'commits-per-day-chart.png'), fullPage: true });
    await page.reload(); await chart.getByRole('img', { name: 'Commits per day' }).waitFor();
    assert.deepEqual(await actual(), expected);
    // The built renderer under the desktop CSP: srcdoc would inherit script-src 'self' and fail here.
    const built = fileURLToPath(new URL('../dist/apps/renderer/browser/', import.meta.url));
    // A document fulfilled by Playwright has no loopback address classification; allow its loopback API calls.
    await app.context.grantPermissions(['local-network-access'], { origin: env.base });
    const csp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ${env.api}; frame-src ${env.api}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;
    await page.route(`${env.base}/**`, async (route) => {
      const file = join(built, decodeURIComponent(new URL(route.request().url()).pathname));
      await route.fulfill({ path: existsSync(file) && !route.request().isNavigationRequest() ? file : join(built, 'index.html'), headers: { 'Content-Security-Policy': csp } });
    });
    try {
      mathFonts.length = 0;
      await page.reload();
      await chart.getByRole('img', { name: 'Commits per day' }).waitFor({ timeout: 10_000 }).catch(async (error) => {
        console.error('Production page:', (await page.locator('body').innerText()).slice(-2000), page.frames().map((frame) => frame.url()), app.errors);
        throw error;
      });
      assert.deepEqual(await actual(), expected);
      await chart.getByRole('button', { name: 'Show data' }).click(); await chart.locator('table').waitFor({ state: 'visible' });
      assert.deepEqual(mathFonts, [], 'ordinary chat does not download mathematical fonts');
      const loadedFont = page.waitForResponse((response) => response.url().includes('/assets/katex/fonts/KaTeX_Main-Regular.woff2'));
      await page.evaluate(() => document.fonts.load('16px KaTeX_Main'));
      assert.equal((await loadedFont).status(), 200, 'math fonts load from local assets when requested');
    } finally { page.off('request', fontRequest); await page.unroute(`${env.base}/**`); await page.reload(); }
    assert.ok(fake.requests.some((request) => JSON.stringify(request.messages).includes('pi-ui')));
    assert.deepEqual(app.errors, []);
  });

  it('renders a native A2UI table from the same Git data, persists it, and forwards a button action', async () => {
    const { page, h } = app;
    await h.newThread(); await h.startPrompt('A2UI table: show commits per day with a refresh button.');
    const table = page.locator('copilot-a2ui-activity-renderer table');
    await table.waitFor(); await idle();
    const expected = counts(git('log', '--format=%cs'));
    await table.locator('tbody tr').nth(expected.length - 1).waitFor({ timeout: 10_000 }).catch(async (error) => {
      console.error('A2UI table:', await page.locator('pk-a2ui-table').evaluate((el) => window.ng?.getComponent(el)?.props()), app.errors);
      throw error;
    });
    assert.deepEqual(await table.locator('tbody tr').evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim()))), expected.map((row) => [row.date, String(row.commits)]));
    await page.reload(); await table.waitFor();
    const action = page.waitForRequest((request) => request.method() === 'POST' && request.postData()?.includes('refresh_commits'));
    await page.getByRole('button', { name: 'Refresh commits' }).click();
    const request = await action;
    assert.equal(request.postDataJSON().forwardedProps.a2uiAction.userAction.name, 'refresh_commits');
    await idle(); assert.deepEqual(app.errors, []);
  });

  it('exposes interrupt capabilities, waits on ask_user, and resumes with a standard answer', async () => {
    const info = await api('/api/copilotkit/info');
    assert.equal(info.agents.pi.capabilities.humanInTheLoop.interrupts, true);
    assert.equal(info.openGenerativeUIEnabled, true);
    const { page, h } = app;
    await h.newThread(); await h.startPrompt('Ask range: ask which commit range I want before proceeding.');
    const choice = page.getByRole('button', { name: 'All history', exact: true });
    await choice.waitFor();
    const resumed = page.waitForRequest((request) => request.method() === 'POST' && !!request.postDataJSON()?.resume?.length);
    await choice.click();
    assert.deepEqual((await resumed).postDataJSON().resume[0].payload, { value: 'All history' });
    await page.getByText('Selected range received.').waitFor();
    await idle(); assert.deepEqual(app.errors, []);
  });

  for (const resolution of ['answer', 'cancel', 'stop']) {
    it(`preserves a later-turn input question through switching and reload, then allows branching after ${resolution}`, async () => {
      const { page, h } = app;
      const created = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/threads');
      await h.newThread();
      const { id } = await (await created).json();
      // A prior completed turn means the log already has a snapshot and a file checkpoint.
      await h.startPrompt('Warmup: get ready for a question.');
      await page.locator('pk-transcript').getByText('Ready for the next request.', { exact: true }).waitFor(); await idle();
      await h.startPrompt('Ask location: clarify where the name appears.');
      const question = page.getByRole('group', { name: 'Where are you seeing the name?', exact: true });
      await question.getByRole('textbox').waitFor();
      await h.newThread();
      // A second active conversation changes the coordination prompt on the edited branch.
      await h.startPrompt('Warmup: another chat keeps the context fresh.');
      await page.locator('pk-transcript').getByText('Ready for the next request.', { exact: true }).waitFor(); await idle();
      await page.locator(`.pk-thread[data-thread="${id}"]`).click();
      await question.getByRole('textbox').waitFor();
      await page.reload();
      await question.getByRole('textbox').waitFor();
      assert.doesNotMatch(await page.locator('pk-transcript').innerText(), /No result, the run was interrupted/);

      const tree = await api(`/api/threads/${id}/tree?raw=1`);
      const refused = await api(`/api/threads/${id}/navigate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: tree.leafId }) });
      assert.equal(refused.statusCode, 409, 'a live question still owns the session until answered or stopped');
      if (resolution === 'stop') {
        await page.getByTestId('stop').click();
      } else {
        const resumed = page.waitForRequest((request) => request.method() === 'POST' && !!request.postDataJSON()?.resume?.length);
        if (resolution === 'answer') {
          await question.getByRole('textbox').fill('The project README');
          await question.getByRole('button', { name: 'Submit', exact: true }).click();
        } else {
          await question.getByRole('button', { name: 'Cancel', exact: true }).click();
        }
        const entry = (await resumed).postDataJSON().resume[0];
        if (resolution === 'answer') assert.deepEqual(entry.payload, { value: 'The project README' });
        else assert.equal(entry.status, 'cancelled');
        await page.locator('pk-transcript').getByText('Location received.', { exact: true }).waitFor();
      }
      await question.waitFor({ state: 'detached' }); await idle(); await h.settle();

      // Branch through the same user-facing Edit and Send path that was blocked in the report.
      const user = page.locator('pk-turn[role="user"]').first();
      await user.hover();
      await user.locator('copilot-chat-user-message-edit-button button').click();
      await page.getByText('Branching from turn 1', { exact: true }).waitFor({ timeout: 5_000 }).catch(async (error) => {
        console.error('Branch state:', (await page.locator('body').innerText()).slice(-4500));
        throw error;
      });
      await h.startPrompt(`Warmup: branch after ${resolution}.`);
      await page.waitForFunction(() => document.querySelector('copilot-chat-user-message-branch-navigation')?.innerText.includes('2/2'), undefined);
      await page.locator('pk-transcript').getByText('Ready for the next request.', { exact: true }).waitFor(); await idle();
      assert.deepEqual(app.errors, []);
    });
  }
});
