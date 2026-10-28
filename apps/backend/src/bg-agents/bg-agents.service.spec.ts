import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BaseEvent, verifyEvents } from '@ag-ui/client';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { firstValueFrom, from, toArray } from 'rxjs';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySecretStore } from '@pi-kit/secret-store';
import { DB_KEY_ACCOUNT } from '@pi-kit/protocol';
import { isPlainDatabase } from '../db/encryption';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import { BgAgentRunner } from './bg-agent-runner';
import { type BgAgentRow, BgAgentsRepository } from './bg-agents.repository';
import { BgAgentsService } from './bg-agents.service';
import { LOCK_FILE } from './durable-storage';

const key = 'cd'.repeat(32);
let dir: string;
let project: string;
let database: DatabaseService;
let agents: BgAgentsRepository;
let service: BgAgentsService;

/** A faux pi-ai `Models` with scripted answers, and the model it serves as `provider/modelId`. */
function faux(responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0]) {
  const models = createModels();
  const provider = fauxProvider();
  models.setProvider(provider.provider);
  provider.setResponses(responses);
  return { models, model: `${provider.getModel().provider}/${provider.getModel().id}`, provider };
}
const until = async (check: () => boolean, label: string, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const delivered: { threadId: string; content: string; details: unknown }[] = [];
let runner: BgAgentRunner;
const make = (): BgAgentsService => {
  runner = new BgAgentRunner(new EventLogRepository(database));
  return new BgAgentsService(
    { dataDir: dir },
    database,
    agents,
    { cwdOf: () => project, deliver: async (threadId, message) => void delivered.push({ threadId, content: message.content, details: message.details }), allowed: async () => undefined, isolate: async () => { throw new Error('no worktrees here'); }, discard: async () => undefined },
    runner,
  );
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pk-bg-service-'));
  project = join(dir, 'project');
  rmSync(project, { recursive: true, force: true });
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  project = dir;
  database = new DatabaseService({ dataDir: dir }, { key });
  agents = new BgAgentsRepository(database);
  delivered.length = 0;
  service = make();
});
afterEach(async () => {
  await service.close();
  database.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('BgAgentsService', () => {
  it('keeps background agents available without a credential store', async () => {
    await service.close();
    database.onApplicationShutdown();
    dir = mkdtempSync(join(tmpdir(), 'pk-bg-plain-')); // a data folder with a plaintext pi-kit.sqlite: no key
    database = new DatabaseService({ dataDir: dir });
    agents = new BgAgentsRepository(database);
    service = make();
    const { models, model } = faux([fauxAssistantMessage('Completed without Keychain.')]);
    await service.open(models);
    expect(service.state().enabled).toBe(true);
    const row = await service.spawn({ threadId: 't1', name: 'worker', role: 'worker', brief: 'Do the task.', model });
    await until(() => service.get(row.id)?.status === 'done', 'the plaintext agent to finish');
    expect(service.list('t1').map((agent) => agent.id)).toContain(row.id);
    await service.close();
    expect(readFileSync(join(dir, 'bg-agents.sqlite')).subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
    await service.open(faux([]).models);
    expect(service.state().enabled).toBe(true);
    expect(service.get(row.id)?.status).toBe('done');
    expect(await service.conversationOf(row.id)).toBeDefined();
  });

  it('encrypts plaintext durable conversations on the next enabled restart and retains encryption after opt-out', async () => {
    await service.close();
    database.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
    database = new DatabaseService({ dataDir: dir });
    agents = new BgAgentsRepository(database);
    service = make();
    const store = new MemorySecretStore();
    store.set(DB_KEY_ACCOUNT, key);
    const { models, model } = faux([fauxAssistantMessage('Retain this conversation across protection changes.')]);
    await service.open(models);
    const row = await service.spawn({ threadId: 't1', name: 'worker', role: 'worker', brief: 'Work.', model });
    await until(() => service.get(row.id)?.status === 'done', 'the agent to finish');
    await service.close();
    expect(isPlainDatabase(join(dir, 'bg-agents.sqlite'))).toBe(true);
    database.onApplicationShutdown();

    for (const enabled of [true, false]) {
      database = await DatabaseService.create({ dataDir: dir }, store, enabled);
      expect(database.recoveryKey()).toBe(key);
      agents = new BgAgentsRepository(database);
      service = make();
      await service.open(faux([]).models);
      expect(service.state().enabled).toBe(true);
      expect(service.get(row.id)?.status).toBe('done');
      const view = await (await service.conversationOf(row.id))!.context(BACKGROUND_CONTEXT);
      expect(JSON.stringify(view.entries)).toContain('Retain this conversation across protection changes.');
      await service.close();
      expect(isPlainDatabase(join(dir, 'bg-agents.sqlite'))).toBe(false);
      expect(store.get(DB_KEY_ACCOUNT)).toBe(key);
      if (enabled) database.onApplicationShutdown();
    }
  });

  it('runs a read-only agent: its prompt names it, a write is blocked, a reading bash runs, the run ends done', async () => {
    const { models, model } = faux([
      fauxAssistantMessage([fauxToolCall('write', { path: 'notes.md', content: 'x' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('bash', { command: 'cat README.md' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Reviewed.'),
    ]);
    await service.open(models);
    expect(service.state()).toEqual({ enabled: true });
    const row = await service.spawn({ threadId: 't1', name: 'reviewer', role: 'reviewer', brief: 'Review the notes.', model });
    expect(row).toMatchObject({ name: 'reviewer', permission: 'read-only', status: 'active', threadId: 't1' });
    expect(service.list('t1').map((a) => a.id)).toEqual([row.id]);
    // The write is the user's call: denied here.
    await until(() => service.userQuestions('t1').length === 1, 'the block question');
    await service.answerInterrupt(service.userQuestions('t1')[0].id, { value: 'Deny' });
    await until(() => service.get(row.id)?.status === 'done', 'the agent to finish');
    expect(existsSync(join(dir, 'notes.md'))).toBe(false);
    const view = await (await service.conversationOf(row.id))!.context(BACKGROUND_CONTEXT);
    const system = view.entries.find((entry) => entry.kind === 'pi.system');
    expect(JSON.stringify(system?.model ?? system?.data ?? '')).toContain('pikit-agent: reviewer');
    const results = view.entries.filter((entry) => entry.kind === 'pi.tool-result').map((entry) => entry.model?.[0] as { isError?: boolean; content?: { text?: string }[] });
    expect(results).toHaveLength(2);
    expect(results[0].isError).toBe(true);
    expect(results[0].content?.[0]?.text).toContain('read-only');
    expect(results[1].isError).toBeFalsy();
    expect(results[1].content?.[0]?.text).toContain('hello');
    expect(service.get(row.id)).toMatchObject({ status: 'done', cleanup: null });
    expect(service.get(row.id)?.finishedAt).toBeGreaterThan(0);
  });

  it('delivers a report to the thread once, answers agent_send and agent_wait, and a deleted thread takes its agents along', async () => {
    const { models, model } = faux([
      fauxAssistantMessage([fauxToolCall('report', { text: 'Tests pass.' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Still here?'),
      fauxAssistantMessage('Bye.'),
    ]);
    await service.open(models);
    delivered.length = 0;
    const row = await service.spawn({ threadId: 't1', name: 'tester', role: 'tester', brief: 'Test.', model });
    expect(await service.wait(row.id)).toBe('done');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ threadId: 't1', content: 'Report from agent "tester": Tests pass.', details: { agentId: row.id, name: 'tester' } });
    expect((delivered[0].details as { reportId: string }).reportId).toBeTruthy();
    expect(service.toAgent(service.get(row.id) as BgAgentRow)).toMatchObject({ id: row.id, name: 'tester', status: 'done', report: 'Tests pass.', blocked: null });
    expect(Object.keys(service.toAgent(service.get(row.id) as BgAgentRow))).not.toContain('cleanup');
    // A follow-up that ends without a report is told to the main agent all the same: the old report answered the old task.
    await service.send(row.id, 'One more thing.', 'followUp', 'send:c9');
    await until(() => delivered.length === 2 && service.get(row.id)?.status === 'done', 'the follow-up to finish');
    expect(delivered[1]).toMatchObject({ threadId: 't1', content: 'Agent "tester" ended without a report.', details: { agentId: row.id, name: 'tester', ref: expect.stringMatching(/^end:/) } });
    const log = new EventLogRepository(database);
    expect(log.count(row.id)).toBeGreaterThan(0);
    await service.deleteThread('t1');
    expect(service.list('t1')).toEqual([]);
    expect(log.count(row.id)).toBe(0); // the transcript goes with the agent
  });

  it('tells the main agent when a run fails, once, and not when the agent was stopped', async () => {
    const { models, model } = faux([fauxAssistantMessage([], { stopReason: 'error', errorMessage: '401 Unauthorized' })]);
    await service.open(models);
    delivered.length = 0;
    const row = await service.spawn({ threadId: 't1', name: 'broken', role: 'tester', brief: 'Test.', model });
    expect(await service.wait(row.id)).toBe('failed');
    await until(() => delivered.length === 1, 'the failure to reach the thread');
    expect(delivered[0]).toMatchObject({ threadId: 't1', content: expect.stringMatching(/^Agent "broken" failed: /), details: { agentId: row.id, name: 'broken', ref: expect.stringMatching(/^end:/) } });
    // A restart follows only unfinished agents: the failure is not said again.
    await service.close();
    await service.open(models);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(delivered).toHaveLength(1);
  });

  it('runs a model whose id has slashes of its own (provider/org/model)', async () => {
    const models = createModels();
    const provider = fauxProvider({ provider: 'router', models: [{ id: 'org/model-x' }] });
    models.setProvider(provider.provider);
    provider.setResponses([fauxAssistantMessage([fauxToolCall('report', { text: 'Ran on org/model-x.' })], { stopReason: 'toolUse' })]);
    await service.open(models);
    const row = await service.spawn({ threadId: 't1', name: 'routed', role: 'tester', brief: 'Test.', model: 'router/org/model-x' });
    expect(await service.wait(row.id)).toBe('done');
    expect(service.get(row.id)).toMatchObject({ model: 'router/org/model-x', report: 'Ran on org/model-x.' });
  });

  it('tells the work watcher before an agent gets work in the thread’s folder, and when it stops, each time it works', async () => {
    const { models, model } = faux([
      fauxAssistantMessage([fauxToolCall('write', { path: 'made.md', content: 'x' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
      fauxAssistantMessage('Again.'),
    ]);
    await service.open(models);
    const told: string[] = [];
    service.watchWork({
      started: async (_id, threadId, folder) =>
        void told.push(`started ${threadId}, made.md ${existsSync(join(folder, 'made.md')) ? 'there' : 'not there'}`),
      ended: () => void told.push('ended'),
    });
    const row = await service.spawn({ threadId: 't1', name: 'writer', role: 'writer', brief: 'Write.', permission: 'edit', model });
    await until(() => service.get(row.id)?.status === 'done', 'the agent to finish');
    await service.send(row.id, 'More.', 'followUp', 'more-1');
    await until(() => told.length === 4, 'the second stretch of work to end');
    expect(told).toEqual(['started t1, made.md not there', 'ended', 'started t1, made.md there', 'ended']);
  });

  it('gives no more work to an agent deleted while the folder was snapshotted for it', async () => {
    const { models, model } = faux([fauxAssistantMessage('Done.'), fauxAssistantMessage('Never.')]);
    await service.open(models);
    let starts = 0;
    service.watchWork({
      started: async (id) => {
        if (++starts === 2) await service.deleteAgent(id);
      },
      ended: () => undefined,
    });
    const row = await service.spawn({ threadId: 't1', name: 'gone', role: 'r', brief: 'Work.', permission: 'edit', model });
    await until(() => service.get(row.id)?.status === 'done', 'the agent to finish');
    await expect(service.send(row.id, 'More.', 'followUp', 'more-1')).rejects.toThrow('stopped or deleted');
  });

  it('stop aborts a running command and leaves the agent in History as stopped', async () => {
    const { models, model } = faux([fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 30' })], { stopReason: 'toolUse' }), fauxAssistantMessage('Never.')]);
    await service.open(models);
    const row = await service.spawn({ threadId: 't1', name: 'sleeper', role: 'tester', brief: 'Sleep.', permission: 'edit', model });
    await until(() => !!service.get(row.id)?.cleanup, 'the command to start');
    const started = Date.now();
    await service.stop(row.id);
    await (await service.conversationOf(row.id))!.waitForIdle(BACKGROUND_CONTEXT);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(service.get(row.id)).toMatchObject({ status: 'stopped' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(delivered.filter((message) => (message.details as { agentId: string }).agentId === row.id)).toEqual([]); // stopped on purpose: nothing to tell
  });

  it('routes a main question to the thread once, settles it with agent_reply, and shows "answered by main agent"', async () => {
    const { models, model } = faux([
      fauxAssistantMessage([fauxToolCall('ask', { question: 'Must mul accept bigint?', kind: 'main', choices: ['yes', 'no'] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Numbers only, then.'),
    ]);
    await service.open(models);
    delivered.length = 0;
    const row = await service.spawn({ threadId: 't1', name: 'tester', role: 'tester', brief: 'Test.', model });
    // A transcript opened now follows the agent live, through the same observable the runtime streams to a client.
    const live: { type: string; content?: string }[] = [];
    const following = runner.connect({ threadId: row.id, agentId: 'pi-bg' } as never).subscribe((event) => live.push(event as { type: string; content?: string }));
    await until(() => delivered.length > 0, 'the question to reach the thread');
    expect(delivered[0]).toMatchObject({ threadId: 't1', content: expect.stringContaining('Question from agent "tester"') });
    expect(delivered[0].content).toContain('Choices: yes | no');
    const { questionId } = delivered[0].details as { questionId: string; ref: string };
    expect((delivered[0].details as { ref: string }).ref).toBe(questionId);
    await until(() => service.toAgent(service.get(row.id) as BgAgentRow).question?.id === questionId, 'the panel to show the question');
    expect(service.toAgent(service.get(row.id) as BgAgentRow).question).toMatchObject({ kind: 'main', choices: ['yes', 'no'], forwarded: false, expiresAt: null });
    expect(service.userQuestions('t1')).toEqual([]);
    await expect(service.answerInterrupt('agent-question:nope:x', { value: 'y' })).rejects.toThrow('no question');
    expect(await service.answerInterrupt('not-an-agent-question', { value: 'y' })).toBe(false);
    await service.reply(row.id, questionId, 'No, numbers only.');
    await expect(service.reply(row.id, questionId, 'Again?')).rejects.toThrow('already answered');
    await until(() => service.get(row.id)?.status === 'done' && delivered.length === 2, 'the agent to finish');
    expect(delivered[1].content).toBe('Agent "tester" ended without a report.'); // no receipt for the main agent's own answer
    expect(service.toAgent(service.get(row.id) as BgAgentRow)).toMatchObject({ question: null, answered: { question: 'Must mul accept bigint?', text: 'No, numbers only.', by: 'main' } });
    const view = await (await service.conversationOf(row.id))!.context(BACKGROUND_CONTEXT);
    const result = view.entries.find((entry) => entry.kind === 'pi.tool-result')?.model?.[0] as { content?: { text?: string }[] };
    expect(result.content?.[0]?.text).toBe('Answered by main agent: No, numbers only.');
    // The agent's transcript (the `pi-bg` log the runner follows) carries the call and its result as they happened.
    const logged = new EventLogRepository(database).read(row.id).map((stored) => stored.event as { type: string; toolCallName?: string; content?: string });
    expect(logged.some((event) => event.type === 'TOOL_CALL_START' && event.toolCallName === 'ask')).toBe(true);
    expect(logged.find((event) => event.type === 'TOOL_CALL_RESULT')?.content).toContain('Answered by main agent');
    // What a client replays passes the AG-UI verifier, so the transcript does not break on it.
    await firstValueFrom(from(logged.filter((event) => event.type !== 'CUSTOM') as unknown as BaseEvent[]).pipe(verifyEvents(false), toArray()));
    await until(() => live.some((event) => event.type === 'TOOL_CALL_RESULT' && !!event.content?.includes('Answered by main agent')), 'the live follower to get the answer');
    following.unsubscribe();
  });

  it('settles a main question the main agent answers within the very turn that delivers it (the delivery waits for the turn)', async () => {
    const { models, model } = faux([
      fauxAssistantMessage([fauxToolCall('ask', { question: 'Which runner?', kind: 'main' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('node:test it is.'),
    ]);
    await service.open(models);
    await service.close();
    // A thread host whose delivery is the main agent's whole turn, reply included, as pi's `sendCustomMessage` with a turn behaves.
    service = new BgAgentsService(
      { dataDir: dir },
      database,
      agents,
      { cwdOf: () => project, deliver: async (_threadId, message) => void (message.customType === 'pikit.agent-question' && (await service.reply(message.details.agentId, message.details.questionId as string, 'node:test'))), allowed: async () => undefined, isolate: async () => { throw new Error('no worktrees here'); }, discard: async () => undefined },
      new BgAgentRunner(new EventLogRepository(database)),
    );
    await service.open(models);
    const row = await service.spawn({ threadId: 't1', name: 'tester', role: 'tester', brief: 'Test.', model });
    await until(() => service.get(row.id)?.status === 'done', 'the agent to finish', 20_000);
    expect(service.toAgent(service.get(row.id) as BgAgentRow)).toMatchObject({ question: null, answered: { text: 'node:test', by: 'main' } });
  });

  it('a user question (and a forwarded one) is the thread\'s to answer: a dialog in the thread state, the answer verbatim to the agent, a receipt to the main agent', async () => {
    const { models, model } = faux([
      fauxAssistantMessage([fauxToolCall('ask', { question: 'Cover negative numbers too?', kind: 'main' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('ask', { question: 'Change greet?', kind: 'user', choices: ['Keep as is', 'Change it'] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ]);
    await service.open(models);
    delivered.length = 0;
    const row = await service.spawn({ threadId: 't1', name: 'reviewer', role: 'reviewer', brief: 'Review.', model });
    await until(() => delivered.length > 0, 'the main question');
    const first = (delivered[0].details as { questionId: string }).questionId;
    await service.forward(row.id, first, 'Your call.');
    await expect(service.reply(row.id, first, 'Yes')).rejects.toThrow('forwarded');
    expect(service.userQuestions('t1')).toEqual([{ id: `agent-question:${row.id}:${first}`, agentId: row.id, request: { method: 'input', title: 'Cover negative numbers too?', message: 'Your call.', agent: 'reviewer', toolCallId: expect.any(String) } }]);
    expect(service.toAgent(service.get(row.id) as BgAgentRow).question).toMatchObject({ kind: 'user', forwarded: true, note: 'Your call.' });
    expect(await service.answerInterrupt(`agent-question:${row.id}:${first}`, { value: 'Yes' })).toBe(true);
    await until(() => delivered.length === 2, 'the receipt');
    expect(delivered[1]).toMatchObject({ content: 'The user answered agent "reviewer"\'s question "Cover negative numbers too?": Yes', details: { agentId: row.id, name: 'reviewer', ref: `${first}/answer` } });
    // The second question goes to the user directly: no message to the main agent, a select dialog in the thread.
    await until(() => service.userQuestions('t1').length === 1, 'the user question');
    expect(delivered).toHaveLength(2);
    const [dialog] = service.userQuestions('t1');
    expect(dialog.request).toMatchObject({ method: 'select', options: ['Keep as is', 'Change it'], agent: 'reviewer' });
    await expect(service.reply(row.id, dialog.id.split(':')[2], 'Keep as is')).rejects.toThrow('for the user');
    await service.answer(row.id, dialog.id.split(':')[2], 'cancelled', null);
    await until(() => service.get(row.id)?.status === 'done', 'the agent to finish');
    expect(service.userQuestions('t1')).toEqual([]);
    expect(delivered[2].content).toContain('dismissed');
    const view = await (await service.conversationOf(row.id))!.context(BACKGROUND_CONTEXT);
    const results = view.entries.filter((entry) => entry.kind === 'pi.tool-result').map((entry) => (entry.model?.[0] as { content?: { text?: string }[] }).content?.[0]?.text);
    expect(results).toEqual(['Answered by the user: Yes', 'The question was dismissed without an answer. Decide yourself and go on.']);
  });

  it('keeps a question open until answered beyond a legacy deadline and across restart', async () => {
    const { models, model } = faux([
      fauxAssistantMessage([fauxToolCall('ask', { question: 'Which style?', kind: 'user', default: 'fallback', timeoutMs: 1000 })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Accepted.'),
    ]);
    await service.open(models);
    const row = await service.spawn({ threadId: 't1', name: 'docs', role: 'docs', brief: 'Ask.', model });
    await until(() => service.userQuestions('t1').length === 1, 'the question');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(service.userQuestions('t1')).toHaveLength(1);
    expect(service.userQuestions('t1')[0].request.expiresAt).toBeUndefined();
    expect(service.toAgent(service.get(row.id)!).question?.expiresAt).toBeNull();
    await service.close();
    await service.open(models);
    await until(() => service.userQuestions('t1').length === 1, 'the recovered question');
    await service.answerInterrupt(service.userQuestions('t1')[0].id, { value: 'My choice' });
    expect(await service.wait(row.id)).toBe('done');
    expect(service.toAgent(service.get(row.id)!).answered).toMatchObject({ by: 'user', text: 'My choice' });
  });

  it('waits for completion without an expiry while the agent is still working', async () => {
    let release!: () => void;
    let generating = false;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { models, model } = faux([async () => { generating = true; await pending; return fauxAssistantMessage('Finished.'); }]);
    await service.open(models);
    const row = await service.spawn({ threadId: 't1', name: 'worker', role: 'work', brief: 'Work.', model });
    await until(() => generating, 'the held provider request');
    let returned = false;
    const waiting = service.wait(row.id).then((status) => { returned = true; return status; });
    try {
      // Let the SDK register the wait before simulating elapsed time.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(returned).toBe(false);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      expect(returned).toBe(false);
      vi.useRealTimers();
      release();
      expect(await waiting).toBe('done');
    } finally {
      vi.useRealTimers();
      release();
      await waiting;
    }
  });

  it('cancels a caller status wait without stopping the agent', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { models, model } = faux([async () => { await pending; return fauxAssistantMessage('Finished.'); }]);
    await service.open(models);
    const row = await service.spawn({ threadId: 't1', name: 'worker', role: 'work', brief: 'Work.', model });
    const aborter = new AbortController();
    const waiting = service.wait(row.id, aborter.signal).then((status) => ({ status }), (error: unknown) => ({ error }));
    try {
      aborter.abort(new Error('Caller stopped waiting.'));
      const outcome = await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 100))]);
      expect(outcome).toMatchObject({ error: expect.objectContaining({ message: 'Caller stopped waiting.' }) });
      expect(service.get(row.id)?.status).toBe('active');
    } finally {
      release();
      await waiting;
    }
    expect(await service.wait(row.id)).toBe('done');
  });

  it('accepts one concurrent answer and delivers only that answer to the agent and main thread', async () => {
    const { models, model } = faux([
      fauxAssistantMessage([fauxToolCall('ask', { question: 'Which implementation?', kind: 'user' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Accepted.'),
    ]);
    await service.open(models);
    delivered.length = 0;
    const row = await service.spawn({ threadId: 't1', name: 'worker', role: 'implement', brief: 'Ask first.', model });
    await until(() => service.userQuestions('t1').length === 1, 'the user question');
    const [dialog] = service.userQuestions('t1');
    const choices = ['First implementation', 'Second implementation'];
    const replies = await Promise.allSettled(choices.map((value) => service.answerInterrupt(dialog.id, { value })));
    expect(replies.filter((reply) => reply.status === 'fulfilled')).toHaveLength(1);
    const rejected = replies.find((reply) => reply.status === 'rejected');
    expect(rejected?.status === 'rejected' && String(rejected.reason)).toContain('already answered');
    const accepted = choices[replies.findIndex((reply) => reply.status === 'fulfilled')];
    await until(() => service.get(row.id)?.status === 'done', 'the answered agent to finish');
    expect(service.toAgent(service.get(row.id) as BgAgentRow).answered).toMatchObject({ by: 'user', text: accepted });
    await until(() => delivered.length === 2, 'the end of the run to reach the thread');
    expect(delivered[0].content).toContain(`: ${accepted}`);
    expect(delivered[1].content).toBe('Agent "worker" ended without a report.');
    const log = new EventLogRepository(database);
    await until(() => log.read(row.id).some((stored) => stored.event.type === 'TOOL_CALL_RESULT'), 'the durable tool result');
    const result = log.read(row.id).find((stored) => stored.event.type === 'TOOL_CALL_RESULT')?.event;
    expect(result && 'content' in result ? result.content : undefined).toBe(`Answered by the user: ${accepted}`);
  });

  it('refuses to spawn while the project has switched agents off, with the reason', async () => {
    const { models, model } = faux([fauxAssistantMessage('Never.')]);
    await service.open(models);
    await service.close();
    service = new BgAgentsService({ dataDir: dir }, database, agents, { cwdOf: () => project, deliver: async () => undefined, allowed: async () => 'Background agents are off for this project: switch them on in Settings › Projects.', isolate: async () => { throw new Error('no'); }, discard: async () => undefined }, new BgAgentRunner(new EventLogRepository(database)));
    await service.open(models);
    await expect(service.spawn({ threadId: 't1', name: 'a', role: 'r', brief: 'b', model })).rejects.toThrow('switch them on');
    expect(service.list('t1')).toEqual([]);
  });

  it('lets more than four agents generate concurrently and records every request', async () => {
    let generating = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { models, model } = faux(Array.from({ length: 5 }, () => async () => {
      generating++;
      await pending;
      return fauxAssistantMessage('Done.');
    }));
    await service.open(models);
    const rows: BgAgentRow[] = [];
    try {
      for (let i = 0; i < 5; i++) rows.push(await service.spawn({ threadId: 't1', name: `agent-${i}`, role: 'test', brief: 'Work concurrently.', model }));
      await until(() => generating === 5, 'all five model requests to start before any finishes', 5000);
      expect(rows.map((row) => service.toAgent(service.get(row.id) as BgAgentRow).turns)).toEqual([1, 1, 1, 1, 1]);
    } finally {
      release();
    }
    await Promise.all(rows.map(async (row) => expect(await service.wait(row.id)).toBe('done')));
  }, 15_000);

  it('lets an agent run as many turns as it needs without a budget or cap question', async () => {
    const { models, model } = faux([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'cat README.md' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('bash', { command: 'cat README.md' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('bash', { command: 'cat README.md' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Read it three times.'),
    ]);
    await service.open(models);
    const row = await service.spawn({ threadId: 't1', name: 'docs', role: 'docs', brief: 'Docs.', model });
    await until(() => service.get(row.id)?.status === 'done', 'the agent to finish');
    expect(service.userQuestions('t1')).toEqual([]);
    expect(service.toAgent(service.get(row.id) as BgAgentRow)).toMatchObject({ turns: 4 });
  });

  it('turns a blocked action into a question: Deny keeps the file as it is, Allow once lets the call through, Allow all stops the asking', async () => {
    const { models, model } = faux([
      fauxAssistantMessage([fauxToolCall('write', { path: 'notes.md', content: 'first' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('write', { path: 'notes.md', content: 'second' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('write', { path: 'notes.md', content: 'third' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('write', { path: 'notes.md', content: 'fourth' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Done.'),
    ]);
    await service.open(models);
    const starts: string[] = [];
    service.onToolStart((start) => starts.push(`${start.toolName} ${start.args['path']} in ${start.cwd}`));
    const row = await service.spawn({ threadId: 't1', name: 'reviewer', role: 'reviewer', brief: 'Review.', model });
    await until(() => service.userQuestions('t1').length === 1, 'the block question');
    const first = service.userQuestions('t1')[0];
    expect(first.request).toMatchObject({ method: 'select', options: ['Allow once', 'Allow all', 'Deny'], agent: 'reviewer' });
    expect(first.request.title).toContain('wants to run write on notes.md');
    await service.answerInterrupt(first.id, { value: 'Deny' });
    await until(() => service.userQuestions('t1').length === 1 && service.userQuestions('t1')[0].id !== first.id, 'the second block question');
    expect(existsSync(join(dir, 'notes.md'))).toBe(false);
    await service.answerInterrupt(service.userQuestions('t1')[0].id, { value: 'Allow once' });
    await until(() => service.userQuestions('t1').length === 1 && readFileSync(join(dir, 'notes.md'), 'utf8') === 'second', 'the third block question');
    // "Allow all": the third write goes through, the fourth is not asked about, and the agent is `edit` from here on.
    await service.answerInterrupt(service.userQuestions('t1')[0].id, { value: 'Allow all' });
    await until(() => service.get(row.id)?.status === 'done', 'the agent to finish');
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('fourth');
    expect(service.get(row.id)?.permission).toBe('edit');
    expect(starts).toEqual([`write notes.md in ${dir}`, `write notes.md in ${dir}`, `write notes.md in ${dir}`]);
    const view = await (await service.conversationOf(row.id))!.context(BACKGROUND_CONTEXT);
    const results = view.entries.filter((entry) => entry.kind === 'pi.tool-result').map((entry) => entry.model?.[0] as { isError?: boolean; content?: { text?: string }[] });
    expect(results[0].isError).toBe(true);
    expect(results[0].content?.[0]?.text).toContain('did not allow');
    expect(results[1].isError).toBeFalsy();
    expect(results[2].isError).toBeFalsy();
    expect(results[3].isError).toBeFalsy();
  });

  it('lets agents of one thread message each other: a message from the sender in the recipient\'s transcript', async () => {
    const { models, model } = faux([fauxAssistantMessage('Waiting.')]);
    await service.open(models);
    const recipient = await service.spawn({ threadId: 't1', name: 'tester', role: 'tests', brief: 'Wait.', model });
    expect(await service.wait(recipient.id)).toBe('done');
    const { provider } = faux([]);
    provider.setResponses([fauxAssistantMessage([fauxToolCall('agent_send', { agent: recipient.id, text: 'Cover greet too.', mode: 'followUp' })], { stopReason: 'toolUse' }), fauxAssistantMessage('Sent.'), fauxAssistantMessage('Got it.')]);
    models.setProvider(provider.provider);
    const sender = await service.spawn({ threadId: 't1', name: 'reviewer', role: 'review', brief: 'Tell tester.', model });
    await until(() => service.get(sender.id)?.status === 'done' && service.get(recipient.id)?.status === 'done', 'both to finish');
    const view = await (await service.conversationOf(recipient.id))!.context(BACKGROUND_CONTEXT);
    const inputs = view.entries.filter((entry) => entry.kind === 'pi.user').map((entry) => (entry.model?.[0] as { content?: unknown }).content);
    expect(inputs).toContain(`Message from agent "reviewer" (agent ${sender.id}): Cover greet too.`);
    const logged = new EventLogRepository(database).read(recipient.id).map((stored) => stored.event as { type: string; name?: string });
    expect(logged.find((event) => event.type === 'SUBAGENT_STARTED')).toMatchObject({ name: 'reviewer' });
    expect(service.toAgent(service.get(sender.id) as BgAgentRow)).toMatchObject({ turns: 2 });
    // Another thread's agent is refused.
    const stranger = await service.spawn({ threadId: 't2', name: 'x', role: 'r', brief: 'b', model });
    await expect((service as unknown as { sendFrom: (a: string, b: string, t: string, m: 'steer', r: string) => Promise<void> }).sendFrom(sender.id, stranger.id, 'hi', 'steer', 'send:1')).rejects.toThrow('no agent');
  });

  it('survives a backend kill: the next backend takes the store over, holds the agent for its running command, and goes on when the user discards it', async () => {
    const worker = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'killed-backend.mjs'), dir, key, 'sleep 5'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    worker.stdout.on('data', (data) => (out += data));
    worker.stderr.on('data', (data) => (err += data));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The worker never got ready:\n${out}\n${err}`)), 30_000);
      worker.stdout.on('data', () => {
        if (out.includes('READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      worker.once('exit', () => reject(new Error(`The worker exited by itself:\n${out}\n${err}`)));
    });
    const id = /READY (\S+)/.exec(out)![1];
    const gone = new Promise((resolve) => worker.once('exit', resolve));
    worker.kill('SIGKILL');
    await gone;

    const { models } = faux([fauxAssistantMessage('Done after the restart.')]);
    await service.open(models);
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8'))).toMatchObject({ pid: process.pid, epoch: 2 });
    expect(service.get(id)).toMatchObject({ status: 'blocked', cleanup: { command: 'sleep 5' } });
    expect(service.holds.reasonOf(id)).toBe('cleanup');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(service.get(id)?.status).toBe('blocked'); // held: no request went out
    service.discardCleanup(id);
    await until(() => service.get(id)?.status === 'done', 'the agent to finish after the restart');
    const view = await (await service.conversationOf(id))!.context(BACKGROUND_CONTEXT);
    const result = view.entries.find((entry) => entry.kind === 'pi.tool-result');
    expect(JSON.stringify(result?.data)).toContain('interrupted');
    expect(JSON.stringify(view.entries.at(-1)?.model)).toContain('Done after the restart.');
    expect(service.get(id)).toMatchObject({ status: 'done', cleanup: null, ownerEpoch: 2 });
  }, 60_000);
});
