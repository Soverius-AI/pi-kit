// End to end: skills and prompt templates as chips of the composer. Run with `pnpm run e2e -- --file a-skills`. The file name starts
// with `a-` because app.e2e.mjs stops the shared backend. The scratch project has two skills (pk-alpha, pk-beta) and the template pk-review.
// What each test proves:
//   - two skill chips and a sentence go to pi as ONE message holding both <skill> blocks (in chip order) and then the sentence; the session records a
//     pi-kit.skills entry; the Entries inspector shows the expanded prompt; the bubble shows two chips over the sentence, and still does after a reload;
//   - a chip picked from a `/` typed after other words, and the template chip (expanded as pi expands /pk-review);
//   - a pinned chip is on the next message, dimmer, and survives a reload, until it is unpinned; Backspace in an empty composer takes the last chip back;
//   - a `/skill:name` typed first (no chip) still goes to pi as text and pi expands it;
//   - Settings › Skills puts a chip in the composer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { api, openApp } from './support/app.mjs';

let app;
before(async () => {
  app = await openApp();
});
after(async () => {
  await app?.close();
});

const box = () => app.page.getByLabel('Message to pi');
const chips = () => app.page.getByTestId('chip-strip').getByTestId('skill-chip');
const pinned = () => app.page.locator('[data-testid="chip-strip"] [data-testid="skill-chip"][data-pinned="true"]');
const bubbleChips = () => app.page.locator('pk-transcript [data-testid="message-chips"]');
const newestThread = async () => (await api('/api/threads')).toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
const sessionEntries = async () => {
  const thread = await newestThread();
  const { sessionFile } = await api(`/api/threads/${thread.id}/stats`);
  return readFileSync(sessionFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
};
/** The user messages pi stored, as the text it was given. */
const promptsOf = (entries) => entries.filter((e) => e.type === 'message' && e.message.role === 'user').map((e) => (typeof e.message.content === 'string' ? e.message.content : e.message.content.map((p) => p.text ?? '').join('')));
const skillBlock = (name) => new RegExp(`<skill name="${name}" location="[^"]*/\\.pi/skills/${name}/SKILL\\.md">\\nReferences are relative to [^\\n]*/\\.pi/skills/${name}\\.\\n\\n# ${name}\\n\\n[^\\n]+\\n</skill>`);

/** Types `/skill:name` and picks it from the menu with Enter: it becomes a chip, not text. */
async function pick(typed, option, name = option.replace(/^skill:/, '')) {
  await box().fill(typed);
  await app.page.locator('[role="option"][id^="pk-composer-opt-"]', { hasText: option }).first().waitFor();
  await box().press('Enter');
  await chips().filter({ has: app.page.locator(`.name:text-is("${name}")`) }).first().waitFor();
}

async function send(text) {
  await box().fill(text);
  await box().press('Enter');
  // The composer's own stop button (a running tool row has a Stop button of its own).
  await app.page.getByTestId('stop').waitFor({ timeout: 30_000 }).catch(() => undefined);
  await app.page.getByTestId('stop').waitFor({ state: 'detached' });
  await app.h.settle(800);
}

describe('skills and prompt templates are chips', () => {
  it('two skills and a sentence reach pi as one message; the bubble shows two chips over the sentence', async () => {
    const { page, h } = app;
    await h.newThread();
    await pick('/skill:pk-alpha', 'skill:pk-alpha');
    assert.equal(await box().inputValue(), '', 'the chip is not text');
    // A `/` after other words offers the skills too (not the built-ins); the words stay.
    await box().fill('then also /skill:pk-be');
    await page.locator('[role="option"][id^="pk-composer-opt-"]', { hasText: 'skill:pk-beta' }).first().waitFor();
    assert.equal(await page.locator('[role="option"][id^="pk-composer-opt-"]', { hasText: 'compact' }).count(), 0, 'a built-in is only offered at the start');
    await box().press('Enter');
    await chips().nth(1).waitFor();
    assert.equal(await box().inputValue(), 'then also ');
    assert.deepEqual(await chips().locator('.name').allInnerTexts(), ['pk-alpha', 'pk-beta']);
    assert.deepEqual(await chips().locator('.scope').allInnerTexts(), ['project', 'project']);

    await send('Say hello in one short sentence.');
    const thread = await newestThread();
    const entries = await sessionEntries();
    const [prompt] = promptsOf(entries);
    const alpha = skillBlock('pk-alpha').exec(prompt);
    const beta = skillBlock('pk-beta').exec(prompt);
    assert.ok(alpha && beta, `both skill blocks are in the prompt pi got:\n${prompt}`);
    assert.ok(alpha.index < beta.index, 'in chip order');
    assert.ok(prompt.endsWith('</skill>\n\nthen also Say hello in one short sentence.') || prompt.endsWith('</skill>\n\nSay hello in one short sentence.'), 'the sentence follows after a blank line');
    const recorded = entries.find((e) => e.type === 'custom' && e.customType === 'pi-kit.skills');
    assert.deepEqual(
      recorded.data.chips.map((c) => [c.kind, c.name, c.pinned]),
      [['skill', 'pk-alpha', false], ['skill', 'pk-beta', false]],
    );
    assert.match(recorded.data.text, /Say hello in one short sentence\.$/);

    // The chips left the composer; the bubble has them over the sentence, and no instructions.
    assert.equal(await chips().count(), 0);
    const user = page.locator('pk-transcript .pk-user').first();
    assert.deepEqual(await user.locator('[data-testid="skill-chip"] .name').allInnerTexts(), ['pk-alpha', 'pk-beta']);
    assert.match(await user.innerText(), /Say hello in one short sentence\./);
    assert.ok(!(await page.locator('pk-transcript').innerText()).includes('<skill'), 'the transcript does not show the instructions');
    assert.equal(await bubbleChips().count(), 1);
    assert.equal(await user.locator('[data-testid="skill-chip-remove"]').count(), 0, 'the chips in the bubble are read-only');

    // After a reload the same bubble is drawn from the session entry.
    await page.reload();
    await box().waitFor();
    await bubbleChips().first().waitFor();
    assert.deepEqual(await page.locator('pk-transcript .pk-user').first().locator('[data-testid="skill-chip"] .name').allInnerTexts(), ['pk-alpha', 'pk-beta']);
    assert.ok(!(await page.locator('pk-transcript').innerText()).includes('<skill'));

    // The Entries inspector shows the prompt as pi got it, both blocks.
    await h.openPanel('Tree');
    await page.getByRole('button', { name: 'Entries', exact: true }).click();
    const lines = page.getByTestId('entry-line');
    const line = lines.filter({ hasText: '<skill name="pk-alpha"' }).first();
    await line.waitFor();
    const title = await line.getAttribute('title');
    assert.match(title, /<skill name="pk-alpha"/);
    assert.match(title, /<skill name="pk-beta"/);
    assert.ok(title.indexOf('pk-alpha') < title.indexOf('pk-beta'));
    await lines.filter({ hasText: 'pi-kit.skills' }).first().waitFor();
    await h.closePanel();
    assert.equal((await api(`/api/threads/${thread.id}/tree`)).rows.filter((r) => r.kind === 'turn').length, 1);
  });

  it('a template chip is expanded as pi expands /pk-review; a skill and a template go together', async () => {
    const { h } = app;
    await h.newThread();
    await pick('/pk-rev', 'pk-review');
    await pick('/skill:pk-al', 'skill:pk-alpha');
    assert.deepEqual(await chips().locator('.name').allInnerTexts(), ['pk-review', 'pk-alpha']);
    await send('Answer yes.');
    const [prompt] = promptsOf(await sessionEntries());
    const template = 'Review the staged changes and list anything that looks risky.';
    assert.ok(prompt.startsWith(`${template}\n\n<skill name="pk-alpha"`), prompt);
    assert.ok(prompt.endsWith('</skill>\n\nAnswer yes.'));
  });

  it('a pinned chip is on the next messages, dimmer, until it is unpinned', async () => {
    const { page, h } = app;
    await h.newThread();
    await pick('/skill:pk-alpha', 'skill:pk-alpha');
    const chip = chips().first();
    await chip.hover();
    await chip.getByTestId('skill-chip-pin').click();
    await pinned().waitFor();
    await send('First message, say one.');
    // The pinned chip stays in the composer; the unpinned ones would have gone.
    assert.equal(await chips().count(), 1);
    await pinned().waitFor();
    assert.equal((await page.getByRole('button', { name: 'Send' }).isDisabled()), true, 'a pinned chip alone is not a message');
    // A pin is remembered (localStorage): the chip is still on the thread after the page is loaded again.
    await page.reload();
    await box().waitFor();
    await pinned().waitFor();
    assert.equal(await chips().count(), 1);
    await send('Second message, say two.');
    let prompts = promptsOf(await sessionEntries());
    assert.equal(prompts.length, 2);
    assert.ok(skillBlock('pk-alpha').test(prompts[0]) && skillBlock('pk-alpha').test(prompts[1]), 'both messages carry the skill');
    assert.equal(await bubbleChips().count(), 2, 'both bubbles show the chip');
    // Unpin: it goes with the next message and is gone after it.
    await chips().first().hover();
    await chips().first().getByTestId('skill-chip-pin').click();
    await pinned().waitFor({ state: 'detached' });
    await send('Third message, say three.');
    assert.equal(await chips().count(), 0);
    await send('Fourth message, say four.');
    prompts = promptsOf(await sessionEntries());
    assert.equal(prompts.length, 4);
    assert.ok(skillBlock('pk-alpha').test(prompts[2]), 'the unpinned chip rode along once more');
    assert.ok(!prompts[3].includes('<skill'), 'and then it was gone');
    // Backspace in an empty composer takes the last chip back.
    await pick('/skill:pk-be', 'skill:pk-beta');
    await box().focus();
    await box().press('Backspace');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="chip-strip"] [data-testid="skill-chip"]').length === 0);
  });

  it('a /skill:name typed first, without a chip, still goes to pi as text and pi expands it', async () => {
    const { page, h } = app;
    await h.newThread();
    await send('/skill:pk-beta say hi');
    const entries = await sessionEntries();
    const [prompt] = promptsOf(entries);
    assert.ok(skillBlock('pk-beta').test(prompt));
    assert.ok(prompt.endsWith('</skill>\n\nsay hi'), 'pi’s own expansion: the block, a blank line, the arguments');
    assert.equal(entries.filter((e) => e.type === 'custom' && e.customType === 'pi-kit.skills').length, 0);
    assert.equal(await bubbleChips().count(), 0);
    assert.match(await page.locator('pk-transcript .pk-user').first().innerText(), /^\/skill:pk-beta say hi/);
  });

  it('Settings › Skills adds a skill to the composer', async () => {
    const { page, h } = app;
    await h.newThread();
    const dialog = await h.openSettings('Skills');
    const row = dialog.getByTestId('resource-skills-pk-alpha');
    await row.waitFor();
    await row.getByTestId('add-to-composer').click();
    await dialog.waitFor({ state: 'detached' });
    await chips().first().waitFor();
    assert.deepEqual(await chips().locator('.name').allInnerTexts(), ['pk-alpha']);
    assert.equal(await box().evaluate((el) => document.activeElement === el), true, 'the composer has the focus');
    await chips().first().getByTestId('skill-chip-remove').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="chip-strip"] [data-testid="skill-chip"]').length === 0);
  });
});
