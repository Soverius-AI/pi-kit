// The crash checkpoints of the background agents' reference use case (UC-7 and UC-8 across a restart) and the crash matrix: this file
// starts and kills its own backend (SIGKILL) the way e2e/backend-lifecycle.e2e.mjs does, against the scripted model of
// e2e/support/bg-agents-script.mjs, and drives everything through the API (no renderer). Each row's observed outcome is written into
// the decision record's "Spike results". It is slow and runs with the other e2e lanes, not in the default `check`.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createWorld, root } from './support/env.mjs';
import { createScript } from './support/bg-agents-script.mjs';
import { FAKE_MODEL, FAKE_PROVIDER, registerFakeModel, startFakeModel } from './support/fake-model.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A world of its own with the scripted model as pi's default; `options` go to the script (a slow bash, a gated report answer). */
async function makeWorld(options) {
  const world = createWorld({ offline: true });
  const script = createScript(options);
  const fake = await startFakeModel({ answer: script.answer });
  registerFakeModel(world.agent, fake.url);
  const settings = join(world.agent, 'settings.json');
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }));
  return { world, script, fake, dispose: async () => { await fake.stop(); world.dispose(); } };
}

/** A backend of our own on a free port, against the world's folders; `kill` sends SIGKILL, the way a crash ends it. */
async function startBackend(world) {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['dist/apps/backend/main.js'], {
    cwd: root,
    env: { ...process.env, ...world.env, NODE_ENV: 'development', PI_KIT_PORT: String(port), PI_KIT_ORIGIN: `http://localhost:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { log = (log + data).slice(-30_000); });
  const exited = once(child, 'exit');
  const url = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${world.env.PI_KIT_TOKEN}`, 'Content-Type': 'application/json' };
  const api = async (path, init = {}) => {
    const res = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: init.signal ?? AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : undefined;
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The backend exited before it answered.\n${log}`);
    try {
      const health = await api('/api/health');
      if (health.backgroundAgents?.enabled) break;
    } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`The backend did not start.\n${log}`);
    await sleep(200);
  }
  return {
    child,
    url,
    token: world.env.PI_KIT_TOKEN,
    api,
    log: () => log,
    pid: child.pid,
    async kill() {
      child.kill('SIGKILL');
      await exited;
    },
    async stop() {
      if (child.exitCode === null && !child.signalCode) {
        child.kill('SIGTERM');
        await Promise.race([exited, sleep(8000).then(() => child.kill('SIGKILL'))]);
      }
    },
  };
}

/** One AG-UI run over SSE; resolves once it finished (the main agent's turn is over). */
const runPrompt = (backend, threadId, content) =>
  readRun(backend, { threadId, runId: crypto.randomUUID(), state: {}, tools: [], context: [], messages: [{ id: crypto.randomUUID(), role: 'user', content }], forwardedProps: {} }, 'run');

async function readRun(backend, input, kind) {
  const res = await fetch(`${backend.url}/api/copilotkit/agent/pi/${kind}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${backend.token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${kind} answered ${res.status}: ${await res.text()}`);
  const events = [];
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += new TextDecoder().decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (data) try { events.push(JSON.parse(data)); } catch { /* keep-alive */ }
    }
  }
  return events;
}

/** The thread's stored AG-UI log, as a connecting client gets it (the stream ends when nothing runs). */
const connectLog = (backend, threadId) => readRun(backend, { threadId, runId: '', state: {}, tools: [], context: [], messages: [], forwardedProps: {} }, 'connect');

async function until(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(250);
  }
}

/** A thread in the world's project with background agents switched on, and the main agent's first turn (the spawns, the edit) done. */
async function startStory(backend, world) {
  const thread = await backend.api('/api/threads', { method: 'POST', body: JSON.stringify({ cwd: world.project, title: 'crash' }) });
  await backend.api('/api/workspaces', { method: 'PATCH', body: JSON.stringify({ cwd: world.project, agents: true }) });
  const events = await runPrompt(backend, thread.id, 'Add mul to src/math.ts and, in the background, have the tests written and the code reviewed.');
  assert.ok(events.some((event) => event.type === 'RUN_FINISHED'), 'the first turn finished');
  const agents = await backend.api(`/api/threads/${thread.id}/agents`);
  assert.deepEqual(agents.map((a) => a.name), ['tester', 'reviewer']);
  return { thread, agents: Object.fromEntries(agents.map((a) => [a.name, a])) };
}

const agentsOf = (backend, threadId) => backend.api(`/api/threads/${threadId}/agents`);
const byName = async (backend, threadId, name) => (await agentsOf(backend, threadId)).find((a) => a.name === name);
const questionOf = (backend, threadId, name) => until(async () => (await byName(backend, threadId, name))?.question, `${name}'s question`);
const answer = (backend, threadId, agent, question, text) => backend.api(`/api/threads/${threadId}/agents/${agent}/answer`, { method: 'POST', body: JSON.stringify({ question, text }) });
const alive = (pid) => spawnSync('kill', ['-0', String(pid)]).status === 0;
/** The pid of the `sleep 8` tester's bash runs, if any (the matrix row "mid-bash with a child still running"). */
const sleepPid = () => {
  const out = spawnSync('pgrep', ['-f', '^sleep 8$'], { encoding: 'utf8' }).stdout.trim();
  return out ? Number(out.split('\n')[0]) : undefined;
};

/** The outcomes of the matrix, printed at the end for the decision record's "Spike results". */
const outcomes = [];
after(() => console.log(`\nMATRIX\n${outcomes.map((row) => `- ${row}`).join('\n')}\n`));

/** Every text of a thread's log: the streamed deltas of live runs and the messages of the snapshots a restart rebuilds the log from. */
function textsOf(events) {
  const parts = [];
  for (const event of events) {
    if (event.type === 'TEXT_MESSAGE_CONTENT') parts.push(event.delta ?? '');
    if (event.type === 'MESSAGES_SNAPSHOT') for (const message of event.messages ?? []) if (typeof message.content === 'string') parts.push(`\n${message.content}\n`);
  }
  return parts.join('');
}
const countOf = (events, pattern) => (textsOf(events).match(pattern) ?? []).length;

describe('UC-7 and UC-8 across a restart', () => {
  let w;
  before(async () => {
    w = await makeWorld({ slowBash: true });
  });
  after(async () => {
    w.script.releaseAll();
    await w?.dispose();
  });

  it('killed mid-bash with a child still running and while a question waits: the next backend holds tester for its command, keeps reviewer’s question, duplicates nothing; resumed, tester runs the command again and reports; the answer after the restart reaches reviewer (UC-7, UC-8)', async () => {
    let backend = await startBackend(w.world);
    try {
      const { thread, agents } = await startStory(backend, w.world);
      // tester's questions: the main agent answers the first, the user the forwarded second.
      w.script.release('tester:ask');
      const forwarded = await until(async () => { const q = (await byName(backend, thread.id, 'tester'))?.question; return q?.kind === 'user' ? q : undefined; }, "tester's forwarded question");
      await answer(backend, thread.id, agents.tester.id, forwarded.id, 'Yes');
      // reviewer asks the user (UC-5) and waits; tester runs its slow command.
      w.script.release('reviewer:ask');
      const reviewerQuestion = await questionOf(backend, thread.id, 'reviewer');
      assert.equal(reviewerQuestion.kind, 'user');
      w.script.release('tester:bash');
      await until(async () => (await byName(backend, thread.id, 'tester'))?.tool === 'bash', "tester's bash");
      await sleep(1500);
      const child = sleepPid();
      const before = await connectLog(backend, thread.id);
      const questionsBefore = countOf(before, /Question from agent "tester"/g);
      assert.equal(questionsBefore, 2);
      // The crash.
      await backend.kill();
      await sleep(500);
      const childSurvived = child !== undefined && alive(child);
      outcomes.push(`mid-bash with a child still running: the backend was killed while tester's \`sleep 8 && node --test test/*.test.ts\` ran; the sleep child ${child === undefined ? 'was not found' : childSurvived ? 'survived the crash (its own process group)' : 'died with the backend'}.`);
      // The next backend.
      backend = await startBackend(w.world);
        const held = await until(async () => { const t = await byName(backend, thread.id, 'tester'); return t?.status === 'blocked' ? t : undefined; }, 'tester held');
      assert.equal(held.blocked, 'cleanup');
      const reviewerAfter = await byName(backend, thread.id, 'reviewer');
      assert.equal(reviewerAfter.question?.id, reviewerQuestion.id, "reviewer's question is still open");
      const state = (await backend.api('/api/threads')).find((t) => t.id === thread.id)?.state;
      assert.equal(state.activity, 'waiting');
      assert.ok(state.agentQuestions.some((q) => q.agentId === agents.reviewer.id));
      assert.equal((await agentsOf(backend, thread.id)).length, 2, 'no duplicate spawn');
      const after = await connectLog(backend, thread.id);
      assert.equal(countOf(after, /Question from agent "tester"/g), questionsBefore, 'no duplicate question');
      outcomes.push(`while a question waits: reviewer's question to the user was open across the kill; the next backend lists it (the thread waits, "Needs you"), nothing was asked twice.`);
      // Resumed, tester gets its interrupted command reported and runs it again (the script reruns on "interrupted"), then reports.
      await backend.api(`/api/threads/${thread.id}/agents/${agents.tester.id}/resume`, { method: 'POST' });
      if (childSurvived) spawnSync('kill', ['-9', String(child)]);
      await until(async () => (await byName(backend, thread.id, 'tester'))?.status === 'done', 'tester done', 120_000);
      const testerLog = await connectLogOf(backend, agents.tester.id);
      const bashCalls = testerLog.filter((e) => e.type === 'TOOL_CALL_START' && e.toolCallName === 'bash').length;
      const interrupted = testerLog.filter((e) => e.type === 'TOOL_CALL_RESULT' && /interrupted/i.test(e.content ?? '')).length;
      outcomes.push(`mid-bash, resumed: tester's transcript shows ${bashCalls} bash call(s) and ${interrupted} result(s) reporting the interruption; it reported "Tests for add, sub, mul and greet pass." after the second run.`);
      assert.equal(bashCalls, 2, 'the interrupted command ran again');
      assert.equal(interrupted, 1, 'the first run is reported as interrupted');
      // UC-8: the user's answer after the restart reaches reviewer; its report arrives in the thread.
      await answer(backend, thread.id, agents.reviewer.id, reviewerQuestion.id, 'Keep as is');
      const block = await until(async () => { const q = (await byName(backend, thread.id, 'reviewer'))?.question; return q?.text.includes('wants to run write') ? q : undefined; }, "reviewer's blocked write");
      await answer(backend, thread.id, agents.reviewer.id, block.id, 'Deny');
      w.script.release('reviewer:report');
      await until(async () => (await byName(backend, thread.id, 'reviewer'))?.status === 'done', 'reviewer done', 120_000);
      const log = await connectLog(backend, thread.id);
      const texts = textsOf(log);
      assert.match(texts, /Report from agent "reviewer": Reviewed src\//);
      assert.match(texts, /Report from agent "tester": Tests for add, sub, mul and greet pass\./);
      assert.match(texts, /Both agents are done\./);
      outcomes.push(`UC-8 across the restart: the answer given to the next backend reached reviewer verbatim; both reports arrived in the thread and the main agent said "Both agents are done."`);
    } finally {
      await backend.stop();
    }
  });
});

/** An agent's transcript log, as the panel gets it. */
const connectLogOf = (backend, agentId) => readRun(backend, { threadId: agentId, runId: '', state: {}, tools: [], context: [], messages: [], forwardedProps: {} }, 'connect').catch(() => []);

describe('the crash matrix', () => {
  it('killed mid-generation: the pending request is made again by the next backend, once, and the agent goes on', async () => {
    const w = await makeWorld({});
    let backend = await startBackend(w.world);
    try {
      const { thread, agents } = await startStory(backend, w.world);
      // tester's second request waits at the gate tester:ask: the model has not answered when the backend dies.
      await until(async () => (await byName(backend, thread.id, 'tester'))?.activity === 'running' && w.fake.requests.some((r) => /pikit-agent: tester/.test(JSON.stringify(r))), "tester's pending request");
      const requestsBefore = w.fake.requests.length;
      await backend.kill();
      backend = await startBackend(w.world);
        w.script.release('tester:ask');
      const question = await questionOf(backend, thread.id, 'tester');
      assert.equal(question.kind, 'main');
      await until(async () => (await byName(backend, thread.id, 'tester'))?.turns >= 2, "tester's turns");
      const testerRequests = w.fake.requests.filter((r) => /pikit-agent: tester/.test(JSON.stringify(r))).length;
      outcomes.push(`mid-generation: killed while tester's model request was pending; the next backend made the request again (${w.fake.requests.length - requestsBefore} more request(s) to the model, ${testerRequests} of tester's in all), tester's question was asked once (${(await agentsOf(backend, thread.id)).length} agents, no duplicate).`);
      assert.equal((await agentsOf(backend, thread.id)).length, 2);
    } finally {
      w.script.releaseAll();
      await backend.stop();
      await w.dispose();
    }
  });

  it('killed during a report: the report is in the thread once, the agent is done, the main agent’s answer to it is the aborted run', async () => {
    const w = await makeWorld({ gateReports: true });
    let backend = await startBackend(w.world);
    try {
      const { thread, agents } = await startStory(backend, w.world);
      w.script.release('tester:ask');
      const forwarded = await until(async () => { const q = (await byName(backend, thread.id, 'tester'))?.question; return q?.kind === 'user' ? q : undefined; }, "tester's forwarded question");
      await answer(backend, thread.id, agents.tester.id, forwarded.id, 'Yes');
      w.script.release('tester:bash');
      // tester reports; the main agent's answer to the report waits at the gate main:report when the backend dies.
      await until(async () => (await byName(backend, thread.id, 'tester'))?.report, "tester's report");
      await until(async () => (await backend.api('/api/threads')).find((t) => t.id === thread.id)?.state?.activity === 'running', 'the main agent answering the report');
      await backend.kill();
      backend = await startBackend(w.world);
        const tester = await byName(backend, thread.id, 'tester');
      const log = await connectLog(backend, thread.id);
      const reports = countOf(log, /Report from agent "tester"/g);
      const aborted = log.filter((e) => e.type === 'RUN_FINISHED' && e.result?.aborted === true).length + log.filter((e) => e.type === 'RUN_ERROR').length;
      outcomes.push(`during a report: killed while the main agent answered tester's report; after the restart tester is ${tester.status} with its report kept, the report is in the thread ${reports} time(s), and the main agent's turn ended as aborted (${aborted} aborted run(s) in the log).`);
      assert.equal(tester.status, 'done');
      assert.match(tester.report, /pass/);
      assert.equal(reports, 1);
      assert.ok(aborted >= 1);
    } finally {
      w.script.releaseAll();
      await backend.stop();
      await w.dispose();
    }
  });
});
