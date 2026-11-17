import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { DEFAULT_ATTENDANT_SETTINGS } from '@pi-kit/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttendantRepository } from '../db/attendant.repository';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import { MetaRepository } from '../db/meta.repository';
import { ThreadsRepository } from '../db/threads.repository';
import type { BgAgentRow } from '../bg-agents/bg-agents.repository';
import { AttendantModelPort } from './attendant-model';
import { AttendantService } from './attendant.service';
import { cleanFollowUp, followUpPrompt } from './follow-up-text';
import { FollowUpService } from './follow-up.service';

const msg = (id: string, parentId: string | null, role: string, text: string): PiSessionEntry => ({
  id,
  parentId,
  type: 'message',
  message: { role, content: [{ type: 'text', text }] },
});
const entries = [
  msg('u', null, 'user', 'Compare two approaches with independent reviewers'),
  msg('a', 'u', 'assistant', 'The reviewers have reported. '.repeat(30) + 'Both checks passed.'),
];
const reviewer = (over: Partial<BgAgentRow> = {}): BgAgentRow =>
  ({
    id: 'reviewer',
    threadId: 't',
    name: 'reviewer',
    role: 'Review',
    brief: 'Check composer changes',
    status: 'done',
    report: 'No regressions found',
    ...over,
  }) as BgAgentRow;

let dir: string;
let db: DatabaseService;
let repo: AttendantRepository;
let meta: MetaRepository;
let events: EventLogRepository;
let rows: ThreadsRepository;
let attendant: AttendantService;
let service: FollowUpService;
let settings: typeof DEFAULT_ATTENDANT_SETTINGS;
let leaf: string;
let agents: BgAgentRow[];
let pending: { id: string }[];
let queued: string[];
let treeChanged: (id: string) => void;
let agentsChanged: (id: string) => void;
let reply: string;
let gate: Promise<void> | undefined;
const ask = vi.fn();
const touch = vi.fn();

beforeEach(async () => {
  Logger.overrideLogger(false);
  dir = mkdtempSync(join(tmpdir(), 'pk-follow-up-'));
  db = await DatabaseService.create({ dataDir: dir });
  repo = new AttendantRepository(db);
  meta = new MetaRepository(db);
  events = new EventLogRepository(db);
  rows = new ThreadsRepository(db);
  await meta.touchWorkspace('/proj');
  const path = join(dir, 't.jsonl');
  writeFileSync(path, '{}\n');
  await rows.insertDraft({ id: 't', cwd: '/proj', sessionPath: path, title: 'A named thread' });
  await rows.upsertFromSession(
    {
      id: 't',
      cwd: '/proj',
      sessionPath: path,
      title: 'A named thread',
      preview: '',
      parentSessionPath: undefined,
      messageCount: 2,
      createdAt: 1,
      updatedAt: 2,
    },
    1,
  );
  settings = {
    ...DEFAULT_ATTENDANT_SETTINGS,
    enabled: true,
    followUpSuggestions: true,
    when: { onEnd: false, onInterrupt: false, everyMinutes: 0 },
  };
  await meta.setSetting('attendant', settings);
  leaf = 'a';
  agents = [reviewer()];
  pending = [];
  queued = [];
  reply = 'Compare the two reviewer reports';
  gate = undefined;
  ask.mockReset().mockImplementation(async () => {
    await gate;
    return { text: reply, model: 'test/model', inputTokens: 90, outputTokens: 8, cost: 0.01 };
  });
  const model = {
    calls: 0,
    resolve: async () => ({ provider: 'test', id: 'model', price: 1, reasoning: false }),
    ask,
  } as unknown as AttendantModelPort;
  const threads = { treeSource: async () => ({ entries, leafId: leaf }) };
  const status = { touch, touchAll: vi.fn() };
  const sessions = {
    has: () => true,
    isStreaming: () => false,
    queue: () => ({ steering: queued, followUp: [] }),
    pendingDialogs: () => pending,
    onTreeChanged: (fn: typeof treeChanged) => {
      treeChanged = fn;
      return () => undefined;
    },
    onDialogsChanged: () => () => undefined,
  };
  const background = {
    list: () => agents,
    userQuestions: () => [],
    state: () => ({ enabled: true }),
    onChange: (fn: typeof agentsChanged) => {
      agentsChanged = fn;
      return () => undefined;
    },
  };
  attendant = new AttendantService(
    meta,
    repo,
    threads as never,
    rows,
    status as never,
    events,
    sessions as never,
    model,
    {} as never,
  );
  service = new FollowUpService(
    attendant,
    repo,
    events,
    rows,
    threads as never,
    sessions as never,
    background as never,
    meta,
    status as never,
    { state: async () => ({ status: 'trusted' }) } as never,
  );
  await service.onModuleInit();
  await events.beginRun('t', 'r1');
  await events.endRun('r1', 'finished');
});

afterEach(async () => {
  service.onModuleDestroy();
  attendant.onModuleDestroy();
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
  Logger.overrideLogger(['log', 'warn', 'error']);
});

describe('contextual follow-ups', () => {
  it('uses agent reports and the full final response, records real usage, and accepts without sending', async () => {
    await service.generate('t');
    const suggestion = (await repo.openSuggestions('t'))[0];
    expect(suggestion).toMatchObject({ kind: 'prompt', text: reply });
    const prompt = ask.mock.calls[0][0];
    expect(prompt.user).toContain('Both checks passed');
    expect(prompt.user).toContain('No regressions found');
    expect(prompt.system).toContain('duplicate an active agent');
    expect(await repo.usageSince(0)).toMatchObject({ cost: 0.01, calls: 1, inputTokens: 90 });
    await attendant.accept(suggestion.id);
    expect((await repo.suggestion(suggestion.id))?.state).toBe('accepted');
    await service.generate('t');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it.each([
    'off',
    'feature-off',
    'cap',
    'project-off',
    'archived',
    'failed',
    'active-agent',
    'blocked-agent',
    'dialog',
    'queue',
  ])('makes no model call for %s', async (reason) => {
    if (reason === 'off') await attendant.patch({ enabled: false });
    if (reason === 'feature-off') await attendant.patch({ followUpSuggestions: false });
    if (reason === 'cap') await attendant.patch({ dailyCostCap: 0 });
    if (reason === 'project-off') await meta.patchWorkspace('/proj', { attendantOff: true });
    if (reason === 'archived') await rows.update('t', { archived: true });
    if (reason === 'failed') await events.endRun('r1', 'error');
    if (reason === 'active-agent') agents = [reviewer({ status: 'active' })];
    if (reason === 'blocked-agent') agents = [reviewer({ status: 'blocked' })];
    if (reason === 'dialog') pending = [{ id: 'question' }];
    if (reason === 'queue') queued = ['already requested'];
    await service.generate('t');
    expect(ask).not.toHaveBeenCalled();
    expect(await repo.openSuggestions('t')).toEqual([]);
  });

  it('treats SKIP as a normal paid result and does not retry it', async () => {
    reply = 'SKIP';
    await service.generate('t');
    await service.generate('t');
    expect(await repo.openSuggestions('t')).toEqual([]);
    expect((await repo.actions())[0]).toMatchObject({
      kind: 'prompt',
      status: 'done',
      text: 'No clear follow-up.',
      cost: 0.01,
    });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('does not offer new delegation when the project disabled agents', async () => {
    await meta.patchWorkspace('/proj', { agentsOff: true });
    await service.generate('t');
    expect(JSON.parse(ask.mock.calls[0][0].user).backgroundAgentsEnabled).toBe(false);
  });

  it('switching predictions off expires only prompt suggestions', async () => {
    await repo.addSuggestion({ threadId: 't', kind: 'label', target: 'u', text: 'Two approaches' });
    await service.generate('t');
    await attendant.patch({ followUpSuggestions: false });
    expect(await repo.openSuggestions('t')).toEqual([expect.objectContaining({ kind: 'label' })]);
  });

  it('expires predictions when a run or branch changes', async () => {
    await service.generate('t');
    treeChanged('t');
    expect(await repo.openSuggestions('t')).toEqual([]);
    agents = [reviewer({ report: 'A changed report' })];
    await service.generate('t');
    expect(await repo.openSuggestions('t')).toHaveLength(1);
    await events.beginRun('t', 'r2');
    expect(await repo.openSuggestions('t')).toEqual([]);
  });

  it('rejects acceptance if agent state changed even without a delivered event', async () => {
    await service.generate('t');
    const suggestion = (await repo.openSuggestions('t'))[0];
    agents = [reviewer({ status: 'active' })];
    await expect(attendant.accept(suggestion.id)).rejects.toThrow('no longer matches');
    expect(await repo.openSuggestions('t')).toEqual([]);
  });

  it('drops an in-flight result after a branch changes and still accounts for its cost', async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = service.generate('t');
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    leaf = 'u';
    treeChanged('t');
    release();
    await request;
    expect(await repo.openSuggestions('t')).toEqual([]);
    expect((await repo.usageSince(0)).cost).toBe(0.01);
  });

  it('invalidates a displayed prediction when an agent changes', async () => {
    await service.generate('t');
    agentsChanged('t');
    expect(await repo.openSuggestions('t')).toEqual([]);
  });
});

describe('follow-up output and bounded context', () => {
  it.each(['SKIP', 'Prompt: run tests', 'I can review it', 'one\ntwo', '!dangerous-command', 'a'.repeat(161)])(
    'rejects %s',
    (value) => expect(cleanFollowUp(value)).toBeUndefined(),
  );
  it('includes capability restrictions and bounds agent reports', () => {
    const prompt = followUpPrompt(entries, 'a', [reviewer({ report: 'x'.repeat(100_000) })], false);
    expect(JSON.parse(prompt.user).backgroundAgentsEnabled).toBe(false);
    expect(prompt.user.length).toBeLessThan(8000);
    expect(cleanFollowUp('Have an independent agent review this approach')).toBe(
      'Have an independent agent review this approach',
    );
  });
});
