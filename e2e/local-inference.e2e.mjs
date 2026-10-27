// Actual selected llama-swap model: validate app contracts through Pi, without matching generated prose.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, it } from 'node:test';
import { api, ensureBackend, env, openApp, proseTexts } from './support/app.mjs';
import { MODEL } from './support/env.mjs';

let app;
let thread;
/** app.e2e.mjs's restart test leaves no backend behind: this file starts one when none answers. */
let stopBackend;
const file = () => join(env.project, 'llm-contract.txt');
before(async () => {
  stopBackend = await ensureBackend();
  app = await openApp();
});
after(async () => {
  try {
    await app?.close();
    rmSync(file(), { force: true });
  } finally {
    await stopBackend?.();
  }
});

it('executes an offered tool, records actual model usage and preserves the session after reload', async () => {
  const { page, h } = app;
  await h.newThread();
  thread = (await api('/api/threads')).toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
  await h.prompt('Use the write tool to create llm-contract.txt in the current working directory, containing exactly contract-ok followed by a newline. Then reply with a short confirmation.');
  assert.equal(readFileSync(file(), 'utf8').trim(), 'contract-ok');
  const stats = await api(`/api/threads/${thread.id}/stats`);
  assert.equal(stats.model?.id, MODEL.id);
  assert.ok(stats.toolCalls > 0 && stats.toolResults > 0, 'the tool call ran through Pi');
  assert.ok(stats.tokens.total > 0, 'provider usage is recorded');
  assert.ok((await proseTexts(page)).some((text) => text.trim()), 'an assistant response is rendered');
  await page.reload();
  await page.getByLabel('Message to pi').waitFor();
  await page.locator('pk-transcript pk-prose').first().waitFor();
  const restored = await api(`/api/threads/${thread.id}/stats`);
  assert.equal(restored.model?.id, MODEL.id);
  assert.deepEqual(restored.tokens, stats.tokens);
  assert.equal(restored.toolResults, stats.toolResults);
});

it('edits queued input during an actual response, stops it and can start another turn afterward', async () => {
  const { page, h } = app;
  const previous = (await proseTexts(page)).at(-1) ?? '';
  await h.startPrompt('Count from 1 to 10000, writing each integer on its own line. Keep going until you reach 10000. Do not use any tools.');
  await page.waitForFunction((old) => {
    const text = [...document.querySelectorAll('pk-transcript pk-prose')].at(-1)?.textContent ?? '';
    return text.trim() && text !== old;
  }, previous);
  const queued = 'Check this queued instruction after counting.';
  await page.getByLabel('Message to pi').fill(queued);
  await page.getByLabel('Message to pi').press('Enter');
  const row = page.getByTestId('queue-row').filter({ hasText: queued });
  await row.waitFor();
  assert.deepEqual(await api(`/api/threads/${thread.id}/queue`), { steering: [queued], followUp: [] });
  await row.getByRole('button', { name: 'Remove', exact: true }).click();
  await row.waitFor({ state: 'detached' });
  assert.deepEqual(await api(`/api/threads/${thread.id}/queue`), { steering: [], followUp: [] });
  await h.stopButton.click();
  await h.waitIdle();
  assert.equal((await api(`/api/threads/${thread.id}/stats`)).streaming, false);
  const count = (await api(`/api/threads/${thread.id}/stats`)).userMessages;
  await h.prompt('Reply with a single short sentence confirming that this new turn works.');
  const resumed = await api(`/api/threads/${thread.id}/stats`);
  assert.equal(resumed.userMessages, count + 1);
  assert.equal(resumed.streaming, false);
  assert.equal(resumed.model?.id, MODEL.id);
  assert.equal(app.errors.length, 0, app.errors.join('\n'));
});
