// End to end: generated UI on CopilotKit's own renderer. Run with `pnpm run e2e`. The example extension
// (examples/a2ui-failing-specs, installed into every scratch project by e2e/support/env.mjs) answers a call with an A2UI surface; these
// tests look at what the page does with it: CopilotKit's `copilot-a2ui-activity-renderer` draws it, the surface is visible within 500 ms (no
// 8-second loader), the catalog's root `Card` is the frame, and a click goes back to pi through CopilotKit's bridge and runs a turn.
// The file's name sorts it before app.e2e.mjs, which ends by killing the backend it restarted. The tests share
// one thread: the first one asks the model for the surface, the others reload it and click it, and stop pi once its answer has begun (what is
// under test is that a click starts a turn, not how long the local model takes to finish it).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { openApp } from './support/app.mjs';

let app;
before(async () => {
  app = await openApp();
});
after(async () => {
  await app?.close();
});

const HOST = '[data-testid="a2ui-activity-surface-host"]';
const FRAME = 'copilot-a2ui-activity-renderer pk-a2ui-card pk-turn pk-genui-frame';

/** Waits until pi has finished the run: the composer's stop button is gone (a running tool row has a Stop button of its own, which makes the harness's role query ambiguous). */
const idle = async (page, h, timeout = 240_000) => {
  await page.getByTestId('stop').waitFor({ state: 'detached', timeout });
  await h.settle(600);
};

/** Records, inside the page, when the surface's host appears and when it stops being hidden by CopilotKit's loader (`surface-pending`). */
const observeSurface = (page) =>
  page.evaluate((selector) => {
    window.__surface = {};
    const look = () => {
      const host = document.querySelector(selector);
      const marks = window.__surface;
      if (host && marks.host === undefined) marks.host = performance.now();
      if (host && marks.host !== undefined && marks.visible === undefined && !host.classList.contains('surface-pending') && host.querySelector('table tbody tr')) marks.visible = performance.now();
      requestAnimationFrame(look);
    };
    look();
  }, HOST);

/** Presses a button of the surface and returns the actions the page sent to the runtime (`forwardedProps.a2uiAction`) while pi's answer began, then stops pi. */
async function clickAndStop(app, locator) {
  const { page, h } = app;
  const bodies = [];
  const onRequest = (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/copilotkit')) bodies.push(request.postData() ?? '');
  };
  page.on('request', onRequest);
  const turnsBefore = await page.locator('pk-turn[role="user"]').count();
  await locator.click();
  // The middleware turns the action into a prompt: a user turn that says what the user did, and pi starts on it.
  await page.waitForFunction((n) => document.querySelectorAll('pk-turn[role="user"]').length > n, turnsBefore);
  // A fast answer can already have replaced the streamed user id with its persisted session id. Follow the current turn.
  await page.waitForFunction(() => {
    const users = document.querySelectorAll('pk-turn[role="user"]');
    const prompt = users[users.length - 1]?.getAttribute('data-block');
    return !!prompt && [...document.querySelectorAll('pk-turn[role="pi"]')].some((turn) => turn.getAttribute('data-after') === prompt);
  }, undefined);
  page.off('request', onRequest);
  const stop = page.getByTestId('stop');
  if (await stop.count()) {
    await stop.click({ timeout: 1000 }).catch(async (error) => {
      // Completion between the check and the click also satisfies the helper's cleanup.
      if (await stop.count()) throw error;
    });
  }
  await idle(page, h, 60_000);
  assert.equal(await page.locator('pk-turn[role="user"]').count(), turnsBefore + 1, 'one new user turn');
  return { actions: bodies.map((body) => JSON.parse(body).forwardedProps?.a2uiAction).filter(Boolean), user: await page.locator('pk-turn[role="user"]').last().innerText() };
}

describe('an A2UI surface is drawn by CopilotKit', () => {
  it('is visible within 500 ms of arriving, in the generated-UI frame, with no pi-kit renderer of its own', async () => {
    const { page, h } = app;
    await h.newThread();
    await observeSurface(page);
    await h.startPrompt('Which e2e specs fail right now? Use the show_failing_specs tool.');
    await page.locator('pk-genui-frame').first().waitFor({ timeout: 120_000 }).catch(async () => {
      await idle(page, h);
      await h.startPrompt('Call the show_failing_specs tool now.');
      await page.locator('pk-genui-frame').first().waitFor();
    });
    await idle(page, h);
    const marks = await page.evaluate(() => window.__surface);
    assert.ok(marks.host !== undefined && marks.visible !== undefined, `the surface was never revealed: ${JSON.stringify(marks)}`);
    assert.ok(marks.visible - marks.host < 500, `the surface stayed hidden for ${Math.round(marks.visible - marks.host)} ms`);

    // CopilotKit's renderer, the catalog's Card as the frame, the table with its three rows, and nothing of pi-kit's own around it.
    assert.equal(await page.locator('copilot-a2ui-activity-renderer').count(), 1);
    assert.equal(await page.locator('pk-a2ui-surface, pk-genui-piece').count(), 0, 'no wrapper component of pi-kit');
    const frame = page.locator(FRAME);
    assert.equal(await frame.count(), 1);
    assert.match(await frame.locator('.bar').innerText(), /Failing specs\s*3\s*Rendered from A2UI/);
    assert.equal(await page.locator(`${HOST}.surface-pending`).count(), 0);
    assert.equal(await frame.locator('table tbody tr').count(), 3);
    assert.equal(await frame.getByRole('button', { name: 'Rerun all 3' }).count(), 1);
    // The turn attributes the transcript and the graph rely on are on the frame's turn, like on every other piece of the answer.
    const turn = page.locator('copilot-a2ui-activity-renderer pk-turn');
    assert.ok(await turn.getAttribute('data-turn'), 'data-turn');
    assert.ok(await turn.getAttribute('data-after'), 'data-after');
    assert.deepEqual(app.errors, []);
  });

  it('draws the surface rebuilt from the thread the same way after a reload', async () => {
    const { page } = app;
    await page.reload();
    await observeSurface(page);
    await page.getByLabel('Message to pi').waitFor();
    await page.locator('pk-genui-frame').first().waitFor();
    await page.waitForFunction(() => window.__surface?.visible !== undefined, undefined);
    const marks = await page.evaluate(() => window.__surface);
    assert.ok(marks.visible - marks.host < 500, `the stored surface stayed hidden for ${Math.round(marks.visible - marks.host)} ms`);
    assert.equal(await page.locator(`${FRAME} table tbody tr`).count(), 3);
  });

  it('sends a click back to pi through CopilotKit, and pi starts on it', async () => {
    const { page } = app;
    const { actions, user } = await clickAndStop(app, page.locator(FRAME).getByRole('button', { name: 'Rerun all 3' }));
    // The request is CopilotKit's `bridgeA2UIAction`: the run carries the action in `forwardedProps.a2uiAction`.
    assert.equal(actions.length, 1, 'one run carried the action');
    assert.equal(actions[0].userAction.name, 'rerun_all');
    assert.equal(actions[0].userAction.surfaceId, 'failing-specs');
    assert.deepEqual(actions[0].userAction.context, { count: 3 });
    assert.match(user, /rerun_all/);
  });

  it('runs one row from the table', async () => {
    const { page } = app;
    const { actions, user } = await clickAndStop(app, page.getByRole('row', { name: /export\.spec\.ts:58/ }).getByRole('button', { name: 'Run' }));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].userAction.name, 'rerun_spec');
    assert.equal(actions[0].userAction.context.spec, 'export.spec.ts:58');
    assert.match(user, /rerun_spec/);
    assert.match(user, /export\.spec\.ts:58/);
  });
});
