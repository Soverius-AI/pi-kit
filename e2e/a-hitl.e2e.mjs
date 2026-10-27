// End to end: human-in-the-loop blocks, the toolbars on a message, and the queue bar. Run with `pnpm run e2e`.
// The test extension e2e/support/pk-hitl.ts asks through every dialog of pi's ExtensionUIContext and writes what pi was given to a log
// (`hitlLog()`): the assertions on "pi's side" read that log, and pi's queue is read from `GET /api/threads/:id/queue`, which is the session's own.
// The file's name sorts it before app.e2e.mjs, which ends by killing the backend it restarted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { VIEWPORTS } from '../scripts/screenshots.mjs';
import { api, env, hitlCount, nextHitl, openApp } from './support/app.mjs';

let app;
before(async () => {
  app = await openApp({ clipboard: true });
});
after(async () => {
  await app?.close();
});

const newestThread = async () => (await api('/api/threads')).toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
const send = async (page, text) => {
  const box = page.getByLabel('Message to pi');
  await box.fill(text);
  await box.press('Enter');
};
const block = (page, name) => page.getByRole('group', { name });
/** A block ignores Enter for a moment after it appears (a key typed for the composer must not answer it). */
const armed = (page) => page.waitForTimeout(550);
const text = (locator) => locator.innerText();
/** pi is idle: the composer's Stop is gone (a running tool row has a Stop of its own, so the harness's `waitIdle` can see three). */
const composerStop = (page) => page.locator('pk-composer-toolbar').getByRole('button', { name: 'Stop' });
const idle = async (page, timeout = 240_000) => {
  await composerStop(page).waitFor({ state: 'detached', timeout });
  await page.waitForTimeout(600);
};

describe('extension dialogs are interactive blocks', () => {
  it('confirm: shows the question, who asked and the timeout; Enter allows', async () => {
    const { page, h } = app;
    await h.newThread();
    const before = hitlCount('confirm');
    await send(page, '/hitl-confirm Tag v2.0.0 now?');
    const q = block(page, 'Publish the release?');
    await q.waitFor();
    const shown = await text(q);
    assert.match(shown, /Tag v2\.0\.0 now\?/);
    assert.match(shown, /Asked by an extension · pk-hitl/);
    assert.match(shown, /pi continues without an answer in \d:\d\d/, 'pi carried a timeout, the block counts it down');
    assert.match(shown, /Enter allows, Esc denies/);
    assert.equal(await page.evaluate(() => document.activeElement?.closest('pk-approval') !== null), true, 'the block has the focus');
    await armed(page);
    await page.keyboard.press('Enter');
    assert.equal(await nextHitl('confirm', before), true);
    await q.waitFor({ state: 'detached' });
    await idle(page);
  });

  it('confirm: Esc denies, and so does the Deny button', async () => {
    const { page, h } = app;
    let before = hitlCount('confirm');
    await send(page, '/hitl-confirm now');
    const q = block(page, 'Publish the release?');
    await q.waitFor();
    await armed(page);
    await page.keyboard.press('Escape');
    assert.equal(await nextHitl('confirm', before), false);
    await idle(page);
    before = hitlCount('confirm');
    await send(page, '/hitl-confirm again');
    await q.waitFor();
    await q.getByRole('button', { name: 'Deny' }).click();
    assert.equal(await nextHitl('confirm', before), false);
    await idle(page);
  });

  it('confirm: Enter right after the block appears does not answer it', async () => {
    const { page, h } = app;
    const before = hitlCount('confirm');
    await send(page, '/hitl-confirm now');
    const q = block(page, 'Publish the release?');
    await q.waitFor();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    assert.equal(await q.count(), 1, 'a key pressed in the first moments is ignored');
    assert.equal(hitlCount('confirm'), before);
    await armed(page);
    await q.getByRole('button', { name: 'Deny' }).click();
    await nextHitl('confirm', before);
    await idle(page);
  });

  it('confirm: a timeout that runs out answers "cancelled" for the user', async () => {
    const { page, h } = app;
    const before = hitlCount('confirm-short');
    // Text after the command name closes the slash menu, so Enter sends instead of completing the name.
    await send(page, '/hitl-confirm-short now');
    const q = block(page, 'Still there?');
    await q.waitFor();
    assert.match(await text(q), /pi continues without an answer in 0:0\d/);
    await q.waitFor({ state: 'detached' });
    assert.equal(await nextHitl('confirm-short', before), false, 'pi got the answer its own timeout would have given');
    await page.getByText(/timed out; pi went on without an answer/).first().waitFor();
    await idle(page);
  });

  it('select: an option list with the first option highlighted; arrows move, Enter picks', async () => {
    const { page, h } = app;
    const before = hitlCount('select');
    // The pointer rests where the last test clicked; pointing at an option would highlight it instead of the default.
    await page.mouse.move(2, 2);
    await send(page, '/hitl-select now');
    const q = block(page, 'Pick a deploy target');
    await q.waitFor();
    const options = q.locator('[data-option]');
    assert.deepEqual(await options.allInnerTexts().then((t) => t.map((s) => s.replace(/^\d\s*/, '').trim())), ['staging', 'production', 'canary']);
    assert.match((await options.nth(0).getAttribute('class')) ?? '', /btn-warning/, 'the first option is the highlighted default');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.querySelectorAll('[data-option]')[1]?.classList.contains('btn-warning'));
    assert.doesNotMatch((await options.nth(0).getAttribute('class')) ?? '', /btn-warning/, 'the highlight moved');
    await page.keyboard.press('Enter');
    assert.equal(await nextHitl('select', before), 'production');
    await idle(page);
  });

  it('select: Esc cancels (pi gets undefined), a number picks, a click picks', async () => {
    const { page, h } = app;
    let before = hitlCount('select');
    await send(page, '/hitl-select now');
    const q = block(page, 'Pick a deploy target');
    await q.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await nextHitl('select', before), null);
    await idle(page);
    before = hitlCount('select');
    await send(page, '/hitl-select now');
    await q.waitFor();
    await page.keyboard.press('3');
    assert.equal(await nextHitl('select', before), 'canary');
    await idle(page);
    before = hitlCount('select');
    await send(page, '/hitl-select now');
    await q.waitFor();
    await q.getByRole('button', { name: 'staging' }).click();
    assert.equal(await nextHitl('select', before), 'staging');
    await idle(page);
  });

  it('input: a field with the placeholder; an empty answer gets a message, a typed one is sent', async () => {
    const { page, h } = app;
    let before = hitlCount('input');
    await send(page, '/hitl-input now');
    const q = block(page, 'Release name?');
    await q.waitFor();
    const field = q.getByRole('textbox', { name: 'Release name?' });
    assert.equal(await field.getAttribute('placeholder'), 'e.g. v2.1.0');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'INPUT', 'the field has the focus');
    await page.keyboard.press('Enter');
    await q.getByRole('alert').waitFor();
    assert.match(await text(q), /Type an answer, or cancel\./);
    assert.equal(await field.getAttribute('aria-invalid'), 'true');
    assert.equal(hitlCount('input'), before, 'nothing reached pi');
    await page.keyboard.type('v3.1.4');
    await q.getByRole('alert').waitFor({ state: 'detached' });
    await page.keyboard.press('Enter');
    assert.equal(await nextHitl('input', before), 'v3.1.4');
    await idle(page);
    // Cancel resolves with pi's "no answer".
    before = hitlCount('input');
    await send(page, '/hitl-input now');
    await q.waitFor();
    await q.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await nextHitl('input', before), null);
    await idle(page);
  });

  it('editor: a multiline editor with the text pre-filled; Enter is a newline, ⌘⏎ submits, Esc cancels', async () => {
    const { page, h } = app;
    let before = hitlCount('editor');
    await send(page, '/hitl-editor now');
    const q = block(page, 'Edit the release notes');
    await q.waitFor();
    const area = q.getByRole('textbox', { name: 'Edit the release notes' });
    assert.equal(await area.inputValue(), '# Release notes\n\n- first change\n');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
    assert.match(await text(q), /(?:⌘|Ctrl\+)Enter submits, Esc cancels/);
    await page.keyboard.press('Control+End');
    await page.keyboard.type('- second change');
    await page.keyboard.press('Enter');
    await page.keyboard.type('- third');
    assert.equal(await q.count(), 1, 'a plain Enter does not submit');
    await page.keyboard.press('Meta+Enter');
    assert.equal(await nextHitl('editor', before), '# Release notes\n\n- first change\n- second change\n- third');
    await idle(page);
    before = hitlCount('editor');
    await send(page, '/hitl-editor now');
    await q.waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await nextHitl('editor', before), null);
    await idle(page);
  });

  it('a dialog opened by a tool_call hook says which tool was running', async () => {
    const { page, h } = app;
    const before = hitlCount('guard');
    await send(page, 'Use the bash tool to run exactly this command: touch hitl-guarded');
    const q = block(page, /touch hitl-guarded/);
    await q.waitFor();
    assert.match(await text(q), /Asked by an extension · pk-hitl · while running bash/);
    await q.getByRole('button', { name: 'Deny' }).click();
    assert.equal(await nextHitl('guard', before), false);
    await idle(page);
  });
});

describe('a question in prose', () => {
  it('the thread is waiting, the composer offers Reply and a pill per option, a pill answers', async () => {
    const { page, h } = app;
    await h.newThread();
    // pi answers with a sentence that ends in a question and lists three options (the prompt makes the local model say exactly that).
    await h.prompt('Reply with exactly this sentence and nothing else: Should I use Vitest, Jest or Mocha?');
    const pills = page.getByTestId('copilot-suggestion');
    await pills.filter({ hasText: 'Jest' }).waitFor();
    assert.deepEqual(await pills.allInnerTexts().then((t) => t.map((s) => s.trim()).slice(0, 4)), ['Reply', 'Vitest', 'Jest', 'Mocha'], 'Reply first, then a pill per listed option');
    assert.match((await page.getByLabel('Message to pi').getAttribute('placeholder')) ?? '', /Reply to pi/);
    const thread = await newestThread();
    assert.equal(thread.waiting, true, 'the thread list says pi is waiting for the user');
    // The sidebar's waiting badge carries the question itself.
    await page.getByTestId('waiting-badge').filter({ hasText: /Mocha/ }).first().waitFor();
    // One click answers.
    await pills.filter({ hasText: 'Jest' }).click();
    await page.locator('pk-turn[role="user"] .pk-user', { hasText: /^Jest$/ }).first().waitFor();
    // The reply started a turn (what pi does with "Jest" is up to the model): end it, then the pills must be gone.
    const stop = composerStop(page);
    if (await stop.count()) await stop.click();
    await stop.waitFor({ state: 'detached' });
    await h.settle(500);
    assert.equal(await page.getByTestId('copilot-suggestion').filter({ hasText: 'Vitest' }).count(), 0, 'the pills are gone once answered');
  });
});

describe('the toolbars on a message', () => {
  const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
  /** The text parts of pi's newest assistant message in the thread's session file: the markdown source. */
  const piAssistantSource = async () => {
    const thread = await newestThread();
    const detail = await api(`/api/threads/${thread.id}`);
    const lines = readFileSync(detail.sessionPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const last = lines.filter((e) => e.type === 'message' && e.message?.role === 'assistant').at(-1);
    return last.message.content.filter((p) => p.type === 'text').map((p) => p.text).join('');
  };
  const assistantTurn = (page) => page.locator('pk-turn', { has: page.locator('copilot-chat-assistant-message') }).last();

  it('Copy on an answer puts its markdown source in the clipboard', async () => {
    const { page, h } = app;
    await h.newThread();
    await h.prompt('Reply with exactly this markdown and nothing else:\n\n**bold** and `code`\n\n- one\n- two');
    const turn = assistantTurn(page);
    await turn.hover();
    await turn.locator('copilot-chat-assistant-message-copy-button button').click();
    await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.length > 0));
    const copied = await clipboard(page);
    const source = await piAssistantSource();
    assert.equal(copied.trim(), source.trim(), 'the clipboard holds the message as pi stored it');
    assert.match(copied, /\*\*bold\*\*/, 'markdown markers, not rendered text');
    assert.match(copied, /^- one$/m);
    assert.doesNotMatch(copied, /<\w+/, 'no HTML');
  });

  it('shows no read-aloud button, and thumbs show and keep their state', async () => {
    const { page } = app;
    const turn = assistantTurn(page);
    await turn.hover();
    assert.equal(await page.locator('copilot-chat-assistant-message-read-aloud-button').count(), 0);
    await turn.locator('copilot-chat-assistant-message-thumbs-up-button button').click();
    await page.locator('.pk-rate.on').waitFor();
    // Down replaces up.
    await turn.hover();
    await turn.locator('copilot-chat-assistant-message-thumbs-down-button button').click();
    await page.waitForFunction(() => document.querySelectorAll('.pk-rate.on').length === 1 && !document.querySelector('.pk-rate[data-rating="up"].on'));
    const thread = await newestThread();
    // The rating is sent after the thumb changes on screen: wait for the table to say so.
    for (let i = 0; i < 50 && (await api(`/api/threads/${thread.id}/feedback`)).map((f) => f.rating).join() !== 'down'; i++) await page.waitForTimeout(100);
    assert.deepEqual((await api(`/api/threads/${thread.id}/feedback`)).map((f) => f.rating), ['down']);
    await page.reload();
    await page.getByLabel('Message to pi').waitFor();
    await page.locator('.pk-rate.on').waitFor();
    assert.equal(await page.locator('.pk-rate.on copilot-chat-assistant-message-thumbs-down-button').count(), 1, 'the down thumb is the one shown pressed');
  });

  it('Copy on a user message puts what was typed in the clipboard; Edit is there beside it', async () => {
    const { page, h } = app;
    await h.newThread();
    await h.prompt('Say the word omega and nothing else.');
    const user = page.locator('pk-turn[role="user"]').first();
    await user.hover();
    assert.equal(await user.locator('copilot-chat-user-message-edit-button button').count(), 1);
    await user.locator('copilot-chat-user-message-copy-button button').click();
    await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.length > 0));
    assert.equal(await clipboard(page), 'Say the word omega and nothing else.');
  });
});

describe('the queue bar', () => {
  const queueOf = async (id) => api(`/api/threads/${id}/queue`);
  /** Waits until pi's queue satisfies `check`, then returns it. */
  const piQueue = async (id, check, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const queue = await queueOf(id);
      if (check(queue)) return queue;
      if (Date.now() > deadline) throw new Error(`pi's queue never matched: ${JSON.stringify(queue)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  /** A follow-up queued by another request, the way a second window would (the composer's own switch is the Deliver chip). */
  const queueFollowUp = async (id, content) => {
    const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
    const res = await fetch(`${env.api}/api/copilotkit/agent/pi/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ threadId: id, runId: crypto.randomUUID(), state: {}, tools: [], context: [], messages: [{ id: crypto.randomUUID(), role: 'user', content }], forwardedProps: { streamingBehavior: 'followUp' } }),
    });
    assert.ok(res.ok);
    await res.text();
  };
  const rows = (page) => page.getByTestId('queue-row');
    const waitRows = (page, expected) => page.waitForFunction((want) => JSON.stringify([...document.querySelectorAll('[data-testid=queue-row]')].map((e) => `${e.getAttribute('data-kind')}: ${e.querySelector('.txt')?.textContent?.replace(/\s+/g, ' ').trim()}`)) === JSON.stringify(want), expected);

  it('lists what pi holds; Steer now, Remove, Merge, Edit and Clear all change pi’s own queue; a reload shows it again', async () => {
    const { page, h } = app;
    await h.newThread();
    await send(page, 'Use the bash tool to run exactly this command: sleep 60');
    await composerStop(page).waitFor();
    await page.getByText('Agent is running').first().waitFor();
    const id = (await newestThread()).id;
    assert.equal(await rows(page).count(), 0, 'nothing is queued, so there is no bar');

    await send(page, 'alpha steer');
    await send(page, 'bravo steer');
    await queueFollowUp(id, 'charlie follow-up');
    assert.deepEqual(await piQueue(id, (q) => q.steering.length === 2 && q.followUp.length === 1), { steering: ['alpha steer', 'bravo steer'], followUp: ['charlie follow-up'] });
    await waitRows(page, ['steer: alpha steer', 'steer: bravo steer', 'followUp: charlie follow-up']);
    assert.equal(await page.getByTestId('queue-count').innerText(), '3');
    assert.match(await text(page.locator('pk-queue-bar .head')), /steer goes after this turn, follow-up after the run/);
    assert.equal(Math.round((await rows(page).first().locator('.row').boundingBox()).height), 36, 'rows are 36px');
    // The bar is one unit with the well: its bottom edge touches the well's top edge.
    const bar = await page.locator('pk-queue-bar .pk-queue').boundingBox();
    const well = await page.locator('pk-composer-well').boundingBox();
    assert.ok(Math.abs(bar.y + bar.height - well.y) <= 1, 'the bar is docked onto the well');

    // Steer now: only a follow-up has it; it becomes the last steering message.
    const charlie = rows(page).nth(2);
    await charlie.hover();
    assert.equal(await rows(page).nth(0).getByRole('button', { name: 'Steer now' }).count(), 0, 'a steer has nothing to steer now');
    await charlie.getByRole('button', { name: 'Steer now' }).click();
    assert.deepEqual(await piQueue(id, (q) => q.followUp.length === 0), { steering: ['alpha steer', 'bravo steer', 'charlie follow-up'], followUp: [] });
    await waitRows(page, ['steer: alpha steer', 'steer: bravo steer', 'steer: charlie follow-up']);

    // Remove: pi's queue loses that message and keeps the others in order.
    await rows(page).nth(1).hover();
    await rows(page).nth(1).getByRole('button', { name: 'Remove' }).click();
    assert.deepEqual(await piQueue(id, (q) => q.steering.length === 2), { steering: ['alpha steer', 'charlie follow-up'], followUp: [] });
    await waitRows(page, ['steer: alpha steer', 'steer: charlie follow-up']);

    // Merge: one steer, the texts joined by blank lines in queue order.
    await page.getByRole('button', { name: 'Merge' }).click();
    assert.deepEqual(await piQueue(id, (q) => q.steering.length === 1), { steering: ['alpha steer\n\ncharlie follow-up'], followUp: [] });
    await waitRows(page, ['steer: alpha steer charlie follow-up']);
    assert.equal(await page.getByRole('button', { name: 'Merge' }).isDisabled(), true, 'one message has nothing to merge');

    // Edit: out of the queue, back in the composer.
    await send(page, 'delta steer');
    await piQueue(id, (q) => q.steering.length === 2);
    await rows(page).nth(1).hover();
    await rows(page).nth(1).getByRole('button', { name: 'Edit' }).click();
    assert.deepEqual(await piQueue(id, (q) => q.steering.length === 1), { steering: ['alpha steer\n\ncharlie follow-up'], followUp: [] });
    await page.waitForFunction(() => document.querySelector('[aria-label="Message to pi"]')?.value === 'delta steer');
    await page.getByLabel('Message to pi').fill('');

    // A reload shows pi's queue again, not an empty bar.
    await queueFollowUp(id, 'echo follow-up');
    await piQueue(id, (q) => q.followUp.length === 1);
    await page.reload();
    await page.getByLabel('Message to pi').waitFor();
    await waitRows(page, ['steer: alpha steer charlie follow-up', 'followUp: echo follow-up']);

    // The phone variant: the kind, the text and Remove on a row; Steer now and Edit open with a tap on the row.
    await page.setViewportSize(VIEWPORTS.phone);
    await h.settle(300);
    const row = rows(page).nth(1);
    assert.equal(await row.getByRole('button', { name: 'Steer now' }).first().isVisible(), false, 'Steer now is not on the row on a phone');
    assert.equal(await row.getByRole('button', { name: 'Remove' }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the bar does not overflow the phone');
    await row.locator('.txt').click();
    await row.locator('.more').getByRole('button', { name: 'Steer now' }).waitFor();
    await page.setViewportSize(VIEWPORTS.desktop);
    await h.settle(300);

    // Clear all.
    await page.getByRole('button', { name: 'Clear all' }).click();
    assert.deepEqual(await piQueue(id, (q) => q.steering.length === 0 && q.followUp.length === 0), { steering: [], followUp: [] });
    await rows(page).first().waitFor({ state: 'detached' });
    await composerStop(page).click();
    await idle(page);
  });
});
