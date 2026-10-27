// Screenshots: the reference use case "Add `mul` and get it release-ready" photographed at UC-3 (the Agents panel while both
// agents work and tester's transcript streams), UC-5 (a question of an agent to the user) and UC-10 (History). Run with
//   PI_KIT_DEV_RENDERER_PORT=4370 PI_KIT_DEV_BACKEND_PORT=4470 node scripts/screenshots.mjs --set bg-agents --serve --out <dir>
// The set starts the scripted model of e2e/support/bg-agents-script.mjs first; the main agent and the agents are driven by it, so the flow is the e2e's.
import { FAKE_MODEL, FAKE_PROVIDER, registerFakeModel, startFakeModel } from '../../e2e/support/fake-model.mjs';
import { createScript } from '../../e2e/support/bg-agents-script.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let fake;
let script;

export const world = {
  trusted: true,
  start: async () => {
    script = createScript();
    fake = await startFakeModel({ answer: script.answer });
    return () => fake.stop();
  },
  setup: ({ agent }) => {
    registerFakeModel(agent, fake.url);
    const path = join(agent, 'settings.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }));
  },
};

const scene = (id, viewport, theme, file, run) => ({ id, viewport, theme, file, run });

/** Background agents are opt-in per project: the switch of Settings › Projects, here through the same API, for the new thread's folder. */
async function enableAgents(h) {
  const { token } = await (await fetch(`${h.api}/api/dev/token`, { headers: { Origin: h.base } })).json();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: h.base };
  const threads = await (await fetch(`${h.api}/api/threads`, { headers })).json();
  const cwd = threads.toSorted((a, b) => b.updatedAt - a.updatedAt)[0].cwd;
  await fetch(`${h.api}/api/workspaces`, { method: 'PATCH', headers, body: JSON.stringify({ cwd, agents: true }) });
}
const box = (h) => h.page.getByLabel('Message to pi');
const agentsButton = (h) => h.page.getByRole('button', { name: /^Agents/ });

/** The first scene brings the thread to UC-3: both agents spawned and at work, tester's transcript open. */
async function start(h) {
  await h.open();
  await h.newThread();
  await enableAgents(h);
  await box(h).fill('Add mul to src/math.ts and, in the background, have the tests written and the code reviewed.');
  await box(h).press('Enter');
  await h.page.locator('pk-transcript').getByText('Started tester and reviewer.', { exact: true }).waitFor({ timeout: 60_000 });
  await h.waitIdle();
  await agentsButton(h).click();
  await h.page.locator('[data-testid="agents-active"] li').nth(1).waitFor({ timeout: 10_000 });
  await h.settle(500);
}

export const scenes = [
  scene('agents-active-1440', 'desktop', 'pi-dark', '14-agents-active-1440.png', async (h) => {
    await start(h);
  }),
  scene('agent-transcript-1440', 'desktop', 'pi-dark', '14-agent-transcript-1440.png', async (h) => {
    await h.page.locator('[data-testid="agents-active"] li').first().getByTestId('agent-open').click();
    await h.page.locator('[data-testid="agent-transcript"]').getByText(/test\/math\.test\.ts/).first().waitFor({ timeout: 30_000 });
    await h.settle(500);
  }),
  scene('agents-history-1440', 'desktop', 'pi-dark', '14-agents-history-1440.png', async (h) => {
    script.release('tester:bash');
    script.release('reviewer:report');
    await h.page.locator('pk-transcript').getByText('Both agents are done.', { exact: true }).waitFor({ timeout: 90_000 });
    await h.page.getByRole('button', { name: /Back to the agents/ }).click();
    await h.page.locator('[data-testid="agents-history"] li').nth(1).waitFor({ timeout: 30_000 });
    await h.settle(500);
  }),
  scene('agents-history-375', 'phone', 'pi-dark', '14-agents-history-375.png', async (h) => {
    await h.settle(300);
  }),
];
