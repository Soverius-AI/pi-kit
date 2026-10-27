// Real session discovery and graph rendering with a long history, compactions and abandoned branches. No inference.
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { after, before, it } from 'node:test';
import { api, ensureBackend, env, openApp } from './support/app.mjs';
import { writeGraphSession } from './support/graph-session.mjs';

const count = 1000;
const title = 'Long session graph regression';
let app;
let fixture;
let stopBackend;
const graph = () => app.page.getByRole('listbox', { name: 'Session graph' });
const scroller = () => app.page.locator('pk-session-graph');

before(async () => {
  stopBackend = await ensureBackend();
  fixture = writeGraphSession({ agentDir: env.agentDir, cwd: env.project, name: title });
  const entries = readFileSync(fixture.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const info = entries.pop();
  let parentId = info.parentId;
  const timestamp = new Date().toISOString();
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % 50 === 0) {
      entries.push({ type: 'compaction', id: `compact-${i}`, parentId, timestamp,
        summary: `Earlier graph turns through ${i - 1}.`, firstKeptEntryId: parentId, tokensBefore: 200000 });
      parentId = `compact-${i}`;
    }
    entries.push({ type: 'message', id: `graph-u-${i}`, parentId, timestamp,
      message: { role: 'user', content: [{ type: 'text', text: `Graph viewport turn ${i}` }], timestamp: Date.now() } });
    entries.push({ type: 'message', id: `graph-a-${i}`, parentId: `graph-u-${i}`, timestamp,
      message: { role: 'assistant', content: [{ type: 'text', text: `Graph answer ${i}` }], api: 'openai-completions', provider: 'llama-swap', model: 'gemma-4-26b',
        stopReason: 'stop', timestamp: Date.now(), usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { total: 0 } } } });
    parentId = `graph-a-${i}`;
  }
  entries.push({ ...info, parentId });
  writeFileSync(fixture.file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  let thread;
  const deadline = Date.now() + 20000;
  while (!thread && Date.now() < deadline) {
    thread = (await api('/api/threads')).find((item) => item.title === title);
    if (!thread) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(thread, 'the scanner discovers the complete session fixture');
  const saved = await fetch(`${env.api}/api/settings/thread`, { method: 'PUT', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${env.server.PI_KIT_TOKEN}`,
  }, body: JSON.stringify({ value: thread.id }) });
  assert.ok(saved.ok);
  app = await openApp({ scrollbars: true });
  await app.h.openPanel('Tree');
  await graph().getByText(`Graph viewport turn ${count - 1}`, { exact: true }).waitFor();
});
after(async () => {
  await app?.close();
  if (fixture) rmSync(fixture.file, { force: true });
  await stopBackend?.();
});

async function coverage() {
  await app.page.waitForFunction(() => {
    const host = document.querySelector('pk-session-graph');
    const box = host.getBoundingClientRect();
    const rows = [...host.querySelectorAll('pk-graph-row')].map((row) => row.getBoundingClientRect());
    return rows.length > 0 && rows[0].top <= box.top + 4 && rows.at(-1).bottom >= box.bottom - 8;
  });
  const mounted = await graph().getByRole('option').count();
  assert.ok(mounted > 0 && mounted < 100, `bounded mounted graph rows: ${mounted}`);
}

it('covers beginning, middle, end and large jumps with mixed turn and compaction heights', async () => {
  for (const fraction of [0, 0.5, 0.98, 1, 0.2, 0.75, 0]) {
    await scroller().evaluate((host, part) => { host.scrollTop = part * (host.scrollHeight - host.clientHeight); }, fraction);
    await coverage();
  }
  const bands = graph().locator('pk-graph-row.band');
  assert.ok(await bands.count() > 0, 'a real compaction band is in the first window');
  assert.equal(await bands.first().evaluate((row) => row.getBoundingClientRect().height), 28);
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});

it('reveals keyboard selection and Jump to current outside the mounted window', async () => {
  await graph().focus();
  await app.page.keyboard.press('End');
  await graph().getByText(`Graph viewport turn ${count - 1}`, { exact: true }).waitFor();
  await coverage();
  await app.page.keyboard.press('Home');
  await graph().getByText('Start', { exact: true }).waitFor();
  await coverage();
  await app.page.getByRole('button', { name: 'Jump to current', exact: true }).click();
  await graph().getByText(`Graph viewport turn ${count - 1}`, { exact: true }).waitFor();
  await coverage();
});

it('filters offscreen turns, expands side branches and covers a resized viewport', async () => {
  const find = app.page.getByRole('searchbox', { name: 'Find a turn' });
  await find.fill('Graph viewport turn 450');
  await graph().getByText('Graph viewport turn 450', { exact: true }).waitFor();
  assert.equal(await graph().getByRole('option').count(), 1);
  await find.fill('');
  await scroller().evaluate((host) => { host.scrollTop = 0; });
  const branch = graph().locator('pk-graph-row[aria-expanded="false"]').first();
  await branch.click();
  await graph().getByText('Fix the generator typing', { exact: true }).waitFor();
  await coverage();
  await app.page.setViewportSize({ width: 1280, height: 600 });
  await coverage();
  await scroller().evaluate((host) => { host.scrollTop = host.scrollHeight / 2; });
  await coverage();
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});
