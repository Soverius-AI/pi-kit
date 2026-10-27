// End to end: the chat surface on CopilotKit's components. Run with `pnpm run e2e`; app.e2e.mjs covers the composer, the
// transcript and the model chips on the same DOM, so these tests only add branch navigation, regenerate, thumbs, and the
// registrations a pi extension makes without touching the renderer.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, openApp } from './support/app.mjs';

let app;
before(async () => {
  app = await openApp();
});
after(async () => {
  await app?.close();
});

const newestThread = async () => (await api('/api/threads')).toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
const branchLabels = (page) => page.evaluate(() => [...document.querySelectorAll('copilot-chat-user-message-branch-navigation')].map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
const turnPieces = (page) => page.locator('pk-transcript pk-turn');
/** The composer's text, once the store has put it there (a click answers before Angular has drawn the new value). */
const composerIs = async (page, value) => {
  await page.waitForFunction((v) => document.querySelector('[aria-label="Message to pi"]')?.value === v, value);
};

describe('the chat view is CopilotKit with pi-kit slots', () => {
  it('draws the page, the message list and the input with CopilotKit components', async () => {
    const { page, h } = app;
    await h.newThread();
    for (const tag of ['copilot-chat-view', 'copilot-chat-input', 'copilot-chat-attachment-queue']) {
      assert.equal(await page.locator(tag).count(), 1, tag);
    }
    // The transcript is virtual: one `copilot-chat-message-view` per row on screen, so a thread without a message has none.
    assert.equal(await page.locator('pk-transcript copilot-chat-message-view').count(), 0, 'copilot-chat-message-view in an empty thread');
    // The slots are pi-kit's: the textarea and toolbar components, the transcript wrapper, the input container with the hint row.
    for (const tag of ['pk-composer-field', 'pk-composer-toolbar', 'pk-transcript', 'copilot-chat-view-input-container .pk-hint']) {
      assert.equal(await page.locator(tag).count(), 1, tag);
    }
  });
});

describe('regenerate, branch navigation and thumbs', () => {
  it('rates an answer and keeps the rating across a reload', async () => {
    const { page, h } = app;
    // The previous thread's composer stays on screen while a slow create is pending. The helper must wait for the new selection.
    const delayCreate = async (route) => {
      if (route.request().method() === 'POST') await page.waitForTimeout(800);
      await route.continue();
    };
    await page.route('**/api/threads', delayCreate);
    try { await h.newThread(); } finally { await page.unroute('**/api/threads', delayCreate); }
    await h.prompt('Say the word alpha and nothing else.');
    const answer = page.locator('pk-turn', { has: page.locator('copilot-chat-assistant-message') }).last();
    await answer.hover();
    await answer.locator('copilot-chat-assistant-message-thumbs-up-button button').click();
    await page.locator('.pk-rate.on').waitFor();
    const thread = await newestThread();
    const stored = await api(`/api/threads/${thread.id}/feedback`);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].rating, 'up');
    await page.reload();
    await page.getByLabel('Message to pi').waitFor();
    await page.locator('.pk-rate.on').waitFor();
    // Rating the same answer again clears it.
    await page.locator('pk-turn', { has: page.locator('copilot-chat-assistant-message') }).last().hover();
    await page.locator('copilot-chat-assistant-message-thumbs-up-button button').click();
    await page.locator('.pk-rate.on').waitFor({ state: 'detached' });
    assert.deepEqual(await api(`/api/threads/${thread.id}/feedback`), []);
  });

  it('regenerates an answer from the parent turn, and the user message walks its siblings', async () => {
    const { page, h } = app;
    await h.newThread();
    await h.prompt('Say the word beta and nothing else.');
    const thread = await newestThread();
    assert.deepEqual(await branchLabels(page), [], 'one turn has no branches');
    const answer = page.locator('pk-turn', { has: page.locator('copilot-chat-assistant-message') }).last();
    await answer.hover();
    await answer.locator('copilot-chat-assistant-message-regenerate-button button').click();
    await h.waitIdle();
    // The same text was prompted again as a sibling: two turns that continue from the same place, and the message shows "2/2".
    await page.waitForFunction(() => document.querySelectorAll('copilot-chat-user-message-branch-navigation').length > 0, undefined);
    assert.deepEqual(await branchLabels(page), ['2/2']);
    const tree = await api(`/api/threads/${thread.id}/tree`);
    const turns = tree.rows.filter((r) => r.kind === 'turn');
    assert.equal(turns.length, 2, 'the graph shows both siblings');
    assert.equal(turns[0].parentId, turns[1].parentId);
    assert.equal(await page.locator('pk-turn[role="user"]').count(), 1, 'the transcript shows the active branch only');
    // Previous: the first sibling's branch comes back.
    const user = page.locator('pk-turn[role="user"]').first();
    await user.hover();
    await page.getByLabel('Previous message branch').click();
    await page.waitForFunction(() => document.querySelector('copilot-chat-user-message-branch-navigation')?.innerText.includes('1/2'), undefined);
    const activeLeaf = (await api(`/api/threads/${thread.id}/tree`)).rows.find((r) => r.isLeaf);
    assert.equal(activeLeaf.id, turns.toSorted((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))[0].id, 'the leaf moved to the first sibling');
    // Next goes forward again.
    await page.locator('pk-turn[role="user"]').first().hover();
    await page.getByLabel('Next message branch').click();
    await page.waitForFunction(() => document.querySelector('copilot-chat-user-message-branch-navigation')?.innerText.includes('2/2'), undefined);
    assert.ok((await turnPieces(page).count()) >= 2);
  });

  it('Edit on a user message puts its text in the composer and sending it branches', async () => {
    const { page, h } = app;
    await h.newThread();
    await h.prompt('Say the word gamma and nothing else.');
    const user = page.locator('pk-turn[role="user"]').first();
    await user.hover();
    await user.locator('copilot-chat-user-message-edit-button button').click();
    const box = page.getByLabel('Message to pi');
    await page.waitForFunction(() => /gamma/.test(document.querySelector('[aria-label="Message to pi"]')?.value ?? ''), undefined);
    assert.match(await page.locator('copilot-chat-view-input-container').innerText(), /Branching from turn 1/);
    await box.fill('Say the word delta and nothing else.');
    await box.press('Enter');
    await h.waitIdle();
    await page.waitForFunction(() => document.querySelector('copilot-chat-user-message-branch-navigation')?.innerText.includes('2/2'), undefined);
  });
});

describe('what a pi extension adds to the composer, without touching the renderer', () => {
  it('adds a toolbar button, a suggestion and an argument completer', async () => {
    const { page, h } = app;
    await h.newThread();
    // The test extension (e2e/fixtures/project/.pi/extensions/pk-test.ts) registers these over pi's event bus when its session starts.
    const button = page.locator('pk-composer-toolbar [data-action="pi:pk-hello"]');
    await button.waitFor();
    assert.equal(await button.getAttribute('data-source'), 'pi');
    const pill = page.getByTestId('copilot-suggestion').filter({ hasText: 'Ask for a fruit' });
    await pill.waitFor();
    // A prompt template that asks to be a suggestion is a pill as well.
    await page.getByTestId('copilot-suggestion').filter({ hasText: 'Review my changes' }).waitFor();
    const box = page.getByLabel('Message to pi');
    await button.click();
    await composerIs(page, '/pk-fruit ');
    // The extension's completer answers for the argument.
    await box.pressSequentially('ap');
    const menu = page.getByRole('listbox').filter({ hasText: 'apricot' });
    await menu.waitFor();
    assert.match(await menu.innerText(), /apple/);
    assert.doesNotMatch(await menu.innerText(), /banana/);
    await menu.getByRole('option', { name: /apricot/ }).click();
    await composerIs(page, '/pk-fruit apricot');
    // The suggestion puts its text in the composer.
    await box.fill('');
    await pill.click();
    await composerIs(page, '/pk-fruit apple');
    await box.fill('');
    await h.settle(200);
  });

  it('interprets extension status colors live and after event replay', async () => {
    const { page, h } = app;
    await h.newThread();
    const box = page.getByLabel('Message to pi');
    await box.fill('/pk-colour-status test');
    await box.press('Enter');
    const assertStatus = async () => {
      for (const selector of ['[data-status="speed"]', '.pk-status [title="speed"]']) {
        const status = page.locator(selector);
        await status.waitFor();
        assert.equal(await status.innerText(), '87.2 tok/s');
        assert.equal(await status.locator('pk-ansi-text span').evaluate((e) => getComputedStyle(e).color), 'rgb(135, 135, 135)');
      }
    };
    await assertStatus();
    await page.reload();
    await page.getByLabel('Message to pi').waitFor();
    await assertStatus();
  });

  it('@ completion and the file chip: a referenced path shows as a chip and removing it takes it out of the text', async () => {
    const { page } = app;
    const box = page.getByLabel('Message to pi');
    await box.fill('look at @src/gre');
    const menu = page.getByRole('listbox').filter({ hasText: 'src/greet.ts' });
    await menu.waitFor();
    await menu.getByRole('option', { name: /src\/greet\.ts/ }).click();
    await composerIs(page, 'look at @src/greet.ts ');
    const chip = page.locator('.copilotKitAttachmentQueueItem--document', { hasText: 'src/greet.ts' });
    await chip.waitFor();
    await chip.getByRole('button', { name: 'Remove attachment' }).click();
    await composerIs(page, 'look at ');
    await box.fill('');
  });
});
