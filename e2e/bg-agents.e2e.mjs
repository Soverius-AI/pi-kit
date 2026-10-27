// The reference use case, "Add `mul` and get it release-ready": every checkpoint UC-0 to UC-13 except the crash
// (UC-7, e2e/bg-agents-crash.e2e.mjs), against dev:web with the scripted model of e2e/support/bg-agents-script.mjs. Each checkpoint asserts
// what the user would see (the DOM), what the API returns and the files on disk; never only an internal log.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { verifyEvents } from '@ag-ui/client';
import { firstValueFrom, from, toArray } from 'rxjs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { api, ensureBackend, env, openApp } from './support/app.mjs';
import { createScript, TURN_REPLIES } from './support/bg-agents-script.mjs';
import { FAKE_MODEL, FAKE_PROVIDER, registerFakeModel, startFakeModel } from './support/fake-model.mjs';

let app;
let fake;
let script;
let settingsBefore;
let stopBackend;

before(async () => {
  script = createScript();
  fake = await startFakeModel({ answer: script.answer });
  registerFakeModel(env.agentDir, fake.url);
  const path = join(env.agentDir, 'settings.json');
  settingsBefore = readFileSync(path, 'utf8');
  writeFileSync(path, JSON.stringify({ ...JSON.parse(settingsBefore), defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }));
  stopBackend = await ensureBackend();
  app = await openApp();
});
after(async () => {
  script?.releaseAll();
  try {
    await app?.close();
    await fake?.stop();
    if (settingsBefore) writeFileSync(join(env.agentDir, 'settings.json'), settingsBefore);
  } finally {
    await stopBackend?.();
  }
});

const send = async (page, text) => {
  const box = page.getByLabel('Message to pi');
  await box.fill(text);
  await box.press('Enter');
};
// The thread's transcript: the first one, since an open agent transcript in the panel draws the same component.
const transcript = (page) => page.locator('pk-transcript').first();
const idle = (page) => page.locator('pk-composer-toolbar').getByRole('button', { name: 'Stop' }).waitFor({ state: 'detached' });
const newestThread = async () => (await api('/api/threads')).toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
/** Tool answers live inside the transcript's independently collapsible work rows. */
async function visibleAnswer(transcript, text) {
  const answer = transcript.getByText(text);
  await answer.waitFor({ state: 'attached' });
  const row = answer.locator('xpath=ancestor::details[1]');
  if (!(await row.evaluate((node) => node.open))) await row.locator('summary').click();
  await answer.waitFor();
}
/** Read the complete attributed message, beyond the folded one-line preview. */
async function visibleNote(transcript, text) {
  const note = transcript.getByTestId('agent-note').filter({ hasText: text });
  await note.waitFor();
  if (!(await note.evaluate((node) => node.open))) await note.locator('summary').click();
  const body = note.locator('.body');
  await body.waitFor();
  if (typeof text === 'string') assert.equal((await body.innerText()).trim(), text);
  else assert.match(await body.innerText(), text);
}
/** Visit virtualized history rather than counting only the currently mounted notes. */
async function noteNames(transcripts) {
  const names = [];
  for (const transcript of await transcripts.all()) {
    names.push(...await transcript.evaluate(async (element) => {
      const scroller = element.closest('[cdkscrollable]');
      const found = new Map();
      const painted = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      scroller.scrollTop = 0;
      for (;;) {
        await painted();
        for (const note of element.querySelectorAll('[data-testid="agent-note"]')) found.set(note.querySelector('.body').textContent, note.querySelector('summary .lbl').textContent.trim());
        const before = scroller.scrollTop;
        scroller.scrollTop += scroller.clientHeight / 2;
        if (scroller.scrollTop === before) break;
      }
      return [...found.values()];
    }));
  }
  return names.sort();
}
/** The thread's stored AG-UI log, as a connecting client without a cache gets it (the raw replay, not the hydration snapshot). */
async function storedRuns(threadId) {
  const { token } = await (await fetch(`${env.api}/api/dev/token`, { headers: { Origin: env.base } })).json();
  const res = await fetch(`${env.api}/api/copilotkit/agent/pi/connect`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ threadId, runId: '', state: {}, messages: [], tools: [], context: [], forwardedProps: {} }),
  });
  assert.ok(res.ok, `connect answered ${res.status}`);
  const events = (await res.text()).split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)));
  return { events, runs: events.filter((event) => event.type === 'RUN_STARTED').map((event) => event.runId) };
}

describe('UC-0: an extension-started turn in an idle open thread shows live', () => {
  it('shows a custom message with triggerTurn and its answer without a reload, then a user message the extension placed, and replays both from one run each', async () => {
    const { page, h } = app;
    await h.newThread();
    const thread = await newestThread();
    // The command answers at once; the turn starts once the thread is idle. A reload would wipe the marker.
    await page.evaluate(() => { window.__pkNoReload = true; });
    await send(page, '/pk-turn message Hello from the extension');
    await transcript(page).getByText(TURN_REPLIES.message, { exact: true }).waitFor();
    await transcript(page).getByText('Hello from the extension', { exact: true }).waitFor();
    await idle(page);
    await send(page, '/pk-turn user Hello as a user message');
    await transcript(page).getByText(TURN_REPLIES.user, { exact: true }).waitFor();
    await transcript(page).getByText('Hello as a user message', { exact: true }).waitFor();
    await idle(page);
    assert.equal(await page.evaluate(() => window.__pkNoReload), true, 'the turns appeared in the open transcript, not after a reload');
    const texts = await transcript(page).innerText();
    assert.ok(texts.indexOf('Hello from the extension') < texts.indexOf(TURN_REPLIES.message), 'the placed message comes before its answer');
    assert.ok(texts.indexOf(TURN_REPLIES.message) < texts.indexOf('Hello as a user message'), 'the turns are in order');
    assert.ok(texts.indexOf('Hello as a user message') < texts.indexOf(TURN_REPLIES.user));

    // One run per turn in the log, none failed; the thread is idle.
    const { events, runs } = await storedRuns(thread.id);
    assert.deepEqual(runs.filter((id) => id.startsWith('turn-')).length, 2, `runs: ${runs.join(', ')}`);
    assert.equal(events.filter((event) => event.type === 'RUN_ERROR').length, 0);
    const state = (await api(`/api/threads/${thread.id}`)).state ?? (await api('/api/threads')).find((t) => t.id === thread.id)?.state;
    if (state) assert.equal(state.activity, 'idle');

    // The same after a reload.
    await page.reload();
    await transcript(page).getByText(TURN_REPLIES.user, { exact: true }).waitFor();
    const replayed = await transcript(page).innerText();
    for (const text of ['Hello from the extension', TURN_REPLIES.message, 'Hello as a user message', TURN_REPLIES.user]) {
      assert.ok(replayed.includes(text), `after a reload the transcript still shows "${text}"`);
    }
    assert.ok(replayed.indexOf('Hello from the extension') < replayed.indexOf(TURN_REPLIES.message));
    assert.ok(replayed.indexOf(TURN_REPLIES.message) < replayed.indexOf('Hello as a user message'));
    assert.deepEqual(app.errors, []);
  });
});

describe('the reference use case "Add `mul` and get it release-ready"', () => {
  it('UC-1 to UC-6 and UC-8 to UC-12: spawn cards, the agents at work with tester’s transcript live, questions to the main agent and the user, a blocked write denied, a message between agents, reports live, the test file in Changes, History after a reload', async () => {
    const { page, h } = app;
    await h.newThread();
    const thread = await newestThread();
    // Background agents are on by default; set explicitly here so a scratch profile behaves the same whatever its database says.
    await api('/api/workspaces', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: env.project, agents: true }) });
    await send(page, 'Add mul to src/math.ts and, in the background, have the tests written and the code reviewed.');
    // UC-1: the spawn cards, named after the agents, under the tool calls.
    const cards = page.locator('[data-testid="agent-spawn-card"]');
    // The scripted turn ends at once and a finished turn folds its tool calls into "Ran N tool calls": open it. A card's host is
    // `display: contents`, which Playwright never calls visible, so the cards are checked as present.
    await transcript(page).getByText('Started tester and reviewer.', { exact: true }).waitFor();
    const work = transcript(page).getByTestId('work-head').last();
    if ((await work.getAttribute('aria-expanded')) !== 'true') await work.click();
    await cards.nth(1).waitFor({ state: 'attached' });
    await cards.filter({ hasText: 'reviewer' }).waitFor({ state: 'attached' }); // the card's name arrives with the streamed arguments
    const names = await cards.allTextContents();
    assert.match(names[0], /tester/);
    assert.match(names[1], /reviewer/);
    await transcript(page).getByText('Started tester and reviewer.', { exact: true }).waitFor();
    await idle(page);
    const agents = await api(`/api/threads/${thread.id}/agents`);
    assert.deepEqual(agents.map((a) => [a.name, a.status, a.permission]), [['tester', 'active', 'edit'], ['reviewer', 'active', 'read-only']]);
    const { events, runs } = await storedRuns(thread.id);
    const stream = events.slice(events.findIndex((event) => event.type === 'RUN_STARTED'));
    const started = stream.filter((event) => event.type === 'SUBAGENT_STARTED');
    assert.deepEqual(started.map((event) => event.name), ['tester', 'reviewer'], `envelopes in runs ${runs.join(', ')}`);
    assert.ok(started.every((event) => event.parentToolCallId));
    await firstValueFrom(from(stream).pipe(verifyEvents(false), toArray()));
    // UC-2: the main agent's own work is done and the thread is idle while the agents still work.
    assert.match(readFileSync(join(env.project, 'src', 'math.ts'), 'utf8'), /export function mul/);
    assert.notEqual((await api('/api/threads')).find((t) => t.id === thread.id)?.state?.activity, 'running');
    assert.deepEqual((await api(`/api/threads/${thread.id}/agents`)).map((a) => a.status), ['active', 'active']);
    const activeRows = page.locator('[data-testid="agents-active"] li');
    // UC-3: the Agents panel lists both agents at work; tester's transcript shows its tool calls as they stream.
    await page.getByRole('button', { name: /^Agents/ }).click();
    await activeRows.nth(1).waitFor();
    assert.deepEqual(await activeRows.locator('.name').allInnerTexts(), ['tester', 'reviewer']);
    await activeRows.first().getByTestId('agent-open').click();
    const agentTranscript = page.locator('[data-testid="agent-transcript"]');
    await agentTranscript.waitFor();
    // The brief is its first message; the write of the test file already streamed (tester waits at its question gate).
    await agentTranscript.getByText(/Write test\/math\.test\.ts/).waitFor();
    await agentTranscript.locator('pk-edit-tool-row, pk-activity-row').first().waitFor();
    assert.match(await agentTranscript.innerText(), /test\/math\.test\.ts/);
    // UC-4: tester asks the main agent (kind "main"): a turn of the main agent appears live in the idle thread and answers with agent_reply;
    // tester's open transcript shows the answer marked "answered by main agent".
    script.release('tester:ask');
    await transcript(page).getByText('Answered tester.', { exact: true }).waitFor();
    assert.match(await transcript(page).innerText(), /Question from agent "tester"/);
    await visibleAnswer(agentTranscript, /Answered by main agent: No, numbers only\./);
    // Its second question the main agent forwards (agent_forward, with a note): a card in the thread marked as tester's, "Needs you" on the
    // thread, and the composer stays usable. The panel shows the main agent's answer with Override, and the forwarded question to answer.
    await transcript(page).getByText('Forwarded to you.', { exact: true }).waitFor();
    const questionCards = page.locator('[data-testid="agent-question-card"]');
    const forwardedCard = questionCards.filter({ hasText: 'negative numbers' });
    await forwardedCard.waitFor();
    assert.match(await forwardedCard.innerText(), /Question from agent tester/);
    assert.match(await forwardedCard.innerText(), /Your call\./);
    const needsYou = page.locator('[data-testid=needs-you]');
    await needsYou.waitFor();
    assert.match(await needsYou.innerText(), /negative numbers/);
    assert.equal((await api('/api/threads')).find((t) => t.id === thread.id)?.state?.activity, 'waiting');
    const composer = page.getByLabel('Message to pi').first();
    assert.equal(await composer.isEditable(), true);
    assert.doesNotMatch(await page.locator('pk-composer-toolbar').first().innerText(), /waiting for your answer/i);
    await page.getByRole('button', { name: /Back to the agents/ }).click();
    const testerRow = activeRows.first();
    await testerRow.locator('[data-testid="agent-answered"]').waitFor();
    assert.match(await testerRow.locator('[data-testid="agent-answered"]').innerText(), /answered by main agent: No, numbers only\./);
    await testerRow.locator('[data-testid="agent-override"]').waitFor();
    assert.equal((await testerRow.locator('[data-testid="agent-state"]').innerText()).trim(), 'waiting for you');
    await testerRow.locator('[data-testid="agent-question"] input').fill('Yes');
    await testerRow.locator('[data-testid="agent-question"] input').press('Enter');
    await forwardedCard.waitFor({ state: 'detached' });
    await visibleNote(transcript(page), /The user answered agent "tester"/);
    // UC-5: reviewer asks the user (kind "user"): a card marked as reviewer's in the thread and the question in the panel, with its choices.
    script.release('reviewer:ask');
    const reviewerCard = questionCards.filter({ hasText: 'greet has no punctuation' });
    await reviewerCard.waitFor();
    assert.match(await reviewerCard.innerText(), /Question from agent reviewer/);
    const reviewerRow = activeRows.nth(1);
    await reviewerRow.locator('[data-testid="agent-question"]').waitFor();
    assert.deepEqual(await reviewerRow.locator('[data-testid="agent-question"] button').allInnerTexts().then((t) => t.map((x) => x.trim())), ['Keep as is', 'Change it', 'Dismiss']);
    assert.match(await needsYou.innerText(), /greet has no punctuation/);
    assert.equal(await composer.isEditable(), true);
    // UC-8 (without the restart): the user's answer reaches reviewer verbatim, and its report arrives live as reviewer's message.
    await reviewerCard.getByRole('button', { name: /Keep as is/ }).click();
    await reviewerCard.waitFor({ state: 'detached' });
    await visibleNote(transcript(page), /The user answered agent "reviewer".*: Keep as is/);
    // UC-11: read-only is enforced: reviewer's write of src/greet.ts becomes a question; denied, the file is unchanged.
    const greetBefore = readFileSync(join(env.project, 'src', 'greet.ts'), 'utf8');
    const blockCard = questionCards.filter({ hasText: 'wants to run write on src/greet.ts' });
    await blockCard.waitFor();
    assert.match(await blockCard.innerText(), /Question from agent reviewer/);
    await blockCard.getByRole('button', { name: /Deny/ }).click();
    await blockCard.waitFor({ state: 'detached' });
    assert.equal(readFileSync(join(env.project, 'src', 'greet.ts'), 'utf8'), greetBefore);
    await needsYou.waitFor({ state: 'detached' });
    await testerRow.getByTestId('agent-open').click();
    await visibleAnswer(agentTranscript, /Answered by the user: Yes/);
    // UC-9 (the reports): released, the agents finish and report into the idle thread, live, as messages attributed to them.
    script.release('tester:bash');
    script.release('reviewer:report');
    await visibleNote(transcript(page), 'Report from agent "tester": Tests for add, sub, mul and greet pass.');
    await visibleNote(transcript(page), 'Report from agent "reviewer": Reviewed src/. greet has no punctuation; otherwise fine.');
    const mainNotes = await noteNames(transcript(page));
    const agentNotes = await noteNames(agentTranscript.locator('pk-transcript'));
    const notes = [...mainNotes, ...agentNotes].sort();
    // Two reports, two questions and two receipts, each attributed to its agent.
    // In the thread: tester's two questions and two receipts, reviewer's two receipts (its answer, the denied write) and report;
    // and in tester's open transcript, reviewer's message (UC-6).
    assert.deepEqual(notes.map((note) => note.trim()).sort(), ['From agent reviewer', 'From agent reviewer', 'From agent reviewer', 'From agent reviewer', 'From agent tester', 'From agent tester', 'From agent tester', 'From agent tester']);
    await transcript(page).getByText('Both agents are done.', { exact: true }).waitFor();
    await idle(page);
    assert.equal(existsSync(join(env.project, 'test', 'math.test.ts')), true);
    const finished = await api(`/api/threads/${thread.id}/agents`);
    assert.deepEqual(finished.map((a) => [a.name, a.status]), [['tester', 'done'], ['reviewer', 'done']]);
    assert.match(finished[0].report, /pass/);
    // UC-9: the tests pass in the project, and the Changes view lists tester's test file with a baseline.
    await new Promise((resolve, reject) => { const child = spawn('node', ['--test', 'test/*.test.ts'], { cwd: env.project, stdio: 'ignore' }); child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`node --test exited ${code}`)))); });
    const changes = await api(`/api/threads/${thread.id}/changes`);
    const testFile = (changes.files ?? changes).find((f) => f.path === 'test/math.test.ts');
    assert.ok(testFile, `changes: ${JSON.stringify(changes).slice(0, 300)}`);
    assert.equal(testFile.baseline ?? testFile.status, testFile.baseline ?? 'A');
    // The opened transcript streamed the bash run and the report call as they happened.
    for (const group of await agentTranscript.locator('[data-testid="work-head"][aria-expanded="false"]').all()) await group.click();
    const bashRow = agentTranscript.getByTestId('work-row').filter({ hasText: 'node --test test/*.test.ts' });
    await bashRow.locator('summary').click();
    await agentTranscript.getByRole('button', { name: /bash node --test test\/\*\.test\.ts/ }).waitFor();
    // UC-6: reviewer told tester to cover greet too (a steer, delivered with tester's next request): tester's transcript shows it as a
    // message from reviewer, not as the user's.
    await visibleNote(agentTranscript, /Message from agent "reviewer"/);
    assert.ok((await agentTranscript.locator('[data-testid="agent-note"] summary .lbl').allInnerTexts()).map((t) => t.trim()).includes('From agent reviewer'));
    // UC-10: History lists both with outcome done, a duration and a cost above zero; the transcripts open after a reload.
    await page.getByRole('button', { name: /Back to the agents/ }).click();
    const historyRows = page.locator('[data-testid="agents-history"] li');
    await historyRows.nth(1).waitFor();
    assert.deepEqual(await historyRows.getByRole('img', { name: 'done', exact: true }).count(), 2);
    for (const row of await historyRows.all()) {
      const fold = row.locator('button.fold');
      if (await fold.getAttribute('aria-expanded') === 'false') await fold.click();
      await row.getByTestId('agent-cost').waitFor();
    }
    assert.equal(await historyRows.getByTestId('agent-cost').count(), 2);
    assert.equal(await historyRows.getByTestId('agent-took').count(), 2);
    for (const cost of await historyRows.locator('[data-testid="agent-cost"]').allInnerTexts()) assert.match(cost, /[1-9]/, `a cost above zero: ${cost}`);
    for (const took of await historyRows.locator('[data-testid="agent-took"]').allInnerTexts()) assert.match(took, /\d/, `a duration: ${took}`);
    assert.equal(await historyRows.locator('[data-testid="agent-report"]').count(), 2);
    assert.ok(finished.every((a) => a.cost > 0 && a.finishedAt > a.createdAt), JSON.stringify(finished.map((a) => [a.name, a.cost, a.finishedAt - a.createdAt])));
    await h.openPanel('Changes');
    await page.locator('pk-changes-panel').getByText('math.test.ts', { exact: false }).first().waitFor();
    await h.openPanel('Agents');
    // After a reload the reports keep their attribution, and an agent's transcript opens from History.
    await page.reload();
    await transcript(page).getByText('Both agents are done.', { exact: true }).waitFor();
    assert.deepEqual(await noteNames(transcript(page)), mainNotes);
    await page.getByRole('button', { name: /^Agents/ }).click();
    await historyRows.nth(1).waitFor();
    await historyRows.filter({ hasText: 'tester' }).getByTestId('agent-open').click();
    await agentTranscript.waitFor();
    await agentTranscript.getByText(/Write test\/math\.test\.ts/).waitFor();
    assert.deepEqual(await noteNames(agentTranscript.locator('pk-transcript')), agentNotes);
    for (const group of await agentTranscript.locator('[data-testid="work-head"][aria-expanded="false"]').all()) await group.click();
    await agentTranscript.getByText(/node --test test\/\*\.test\.ts|Review src\//).first().waitFor();
    assert.deepEqual(app.errors, []);
  });
});

describe('UC-13: one owner of the agents store', () => {
  it('a second backend on the same data folder starts, reports background agents disabled, and the store is unchanged', async () => {
    const first = await api('/api/health');
    assert.deepEqual(first.backgroundAgents, { enabled: true }, `the dev backend owns the store: ${JSON.stringify(first.backgroundAgents)}`);
    const store = join(env.dataDir, 'bg-agents.sqlite');
    const lock = JSON.parse(readFileSync(join(env.dataDir, 'bg-agents.lock'), 'utf8'));
    assert.equal(lock.pid, first.pid, 'the lock names the running backend');
    const before = statSync(store);
    // A free port for the second backend; its own token, the same data folder and credential store.
    const reservation = createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const second = spawn('node', ['dist/apps/backend/main.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, ...env.server, NODE_ENV: 'development', PI_KIT_PORT: String(port), PI_KIT_ORIGIN: env.base },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    for (const stream of [second.stdout, second.stderr]) stream.on('data', (data) => { log = (log + data).slice(-12_000); });
    const exited = new Promise((resolve) => second.once('exit', resolve));
    try {
      const headers = { Authorization: `Bearer ${env.server.PI_KIT_TOKEN}` };
      const deadline = Date.now() + 60_000;
      let health;
      for (;;) {
        if (second.exitCode !== null) throw new Error(`The second backend exited before it answered.\n${log}`);
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers, signal: AbortSignal.timeout(1000) });
          if (res.ok) { health = await res.json(); break; }
        } catch { /* starting */ }
        if (Date.now() > deadline) throw new Error(`The second backend did not start.\n${log}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(health.backgroundAgents.enabled, false);
      assert.match(health.backgroundAgents.reason, new RegExp(`Another backend \\(pid ${first.pid}\\) owns`));
      assert.match(log, /Background agents are off: Another backend/);
      assert.deepEqual((await api('/api/health')).backgroundAgents, { enabled: true }, 'the first backend still owns the store');
      const after = statSync(store);
      assert.equal(after.size, before.size);
      assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(JSON.parse(readFileSync(join(env.dataDir, 'bg-agents.lock'), 'utf8')).pid, first.pid, 'the lock still names the first backend');
    } finally {
      second.kill('SIGTERM');
      const timer = setTimeout(() => second.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
  });
});
