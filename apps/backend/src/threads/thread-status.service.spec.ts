import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiDialogRequest, ThreadsEvent } from '@pi-kit/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttendantRepository } from '../db/attendant.repository';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import { MetaRepository } from '../db/meta.repository';
import { OutcomesRepository } from '../db/outcomes.repository';
import { SkillDraftsRepository } from '../db/skill-drafts.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { ThreadStatusService } from './thread-status.service';

let dir: string;
let db: DatabaseService;
let rows: ThreadsRepository;
let events: EventLogRepository;
let attendant: AttendantRepository;
let outcomeRows: OutcomesRepository;
let dialogs: { id: string; request: PiDialogRequest }[];
let onDialogs: ((threadId: string) => void) | undefined;
let service: ThreadStatusService;
let seen: ThreadsEvent[];

async function addThread(id: string, seenAt = 0): Promise<void> {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, '{}\n');
  await rows.insertDraft({ id, sessionPath: path, cwd: '/proj' });
  await rows.markSeen(id, seenAt);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pk-status-'));
  db = await DatabaseService.create({ dataDir: dir });
  rows = new ThreadsRepository(db);
  events = new EventLogRepository(db);
  attendant = new AttendantRepository(db);
  dialogs = [];
  onDialogs = undefined;
  const sessions = {
    pendingDialogs: () => dialogs,
    proseQuestion: () => undefined,
    onDialogsChanged: (listener: (threadId: string) => void) => void (onDialogs = listener),
    has: () => false,
    contextShare: () => 42,
  };
  outcomeRows = new OutcomesRepository(db);
  service = new ThreadStatusService(
    rows,
    events,
    attendant,
    sessions as never,
    outcomeRows,
    new SkillDraftsRepository(db),
  );
  service.onModuleInit();
  seen = [];
  service.subscribe((event) => seen.push(event));
  await new MetaRepository(db).touchWorkspace('/proj');
});
afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('ThreadStatusService', () => {
  it('the snapshot has every thread, and a second touch without a change says nothing', async () => {
    await addThread('t1');
    await addThread('t2');
    const states = await service.snapshot();
    expect(Object.keys(states).sort()).toEqual(['t1', 't2']);
    await service.touch('t1');
    expect(seen).toEqual([]);
  });

  it('a run starting and ending pushes running, then the outcome and unread, once the bookkeeping is done', async () => {
    await addThread('t1', 1);
    await service.snapshot();
    await events.beginRun('t1', 'r1');
    await tick();
    await service.touch('t1');
    expect(seen.at(-1)).toMatchObject({ type: 'state', id: 't1', state: { activity: 'running' } });
    await events.endRun('r1', 'finished');
    await tick();
    await service.touch('t1');
    expect(seen.at(-1)).toMatchObject({
      type: 'state',
      id: 't1',
      state: { activity: 'idle', lastRun: 'finished', unread: true, context: null },
    });
    await rows.markSeen('t1', Date.now() + 1000);
    await service.touch('t1');
    expect(seen.at(-1)).toMatchObject({ state: { unread: false } });
  });

  it('a stopped run is aborted, not unread', async () => {
    await addThread('t1', 1);
    await service.snapshot();
    await events.beginRun('t1', 'r1');
    await events.endRun('r1', 'aborted');
    await tick();
    await service.touch('t1');
    expect(seen.at(-1)).toMatchObject({ state: { activity: 'idle', lastRun: 'aborted', unread: false } });
  });

  it('a question pushes waiting with its first words and the draft that belongs to it; answering clears both', async () => {
    await addThread('t1');
    await service.snapshot();
    dialogs = [{ id: 'd1', request: { method: 'confirm', title: 'Proceed with the test?' } }];
    await attendant.addSuggestion({ threadId: 't1', kind: 'answer', target: 'd1', text: 'Allow' });
    onDialogs?.('t1');
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({ state: { activity: dialogs.length ? 'waiting' : 'idle' } }),
    );
    expect(seen.at(-1)).toMatchObject({
      state: {
        activity: 'waiting',
        question: 'Proceed with the test?',
        suggestions: [{ kind: 'answer', target: 'd1', text: 'Allow' }],
      },
    });
    dialogs = [];
    onDialogs?.('t1');
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({ state: { activity: dialogs.length ? 'waiting' : 'idle' } }),
    );
    expect(seen.at(-1)).toMatchObject({ state: { activity: 'idle', question: null, suggestions: [] } });
  });

  it("a background agent's question for the user makes the thread wait, with the question in its state", async () => {
    await addThread('t1');
    await service.snapshot();
    const question = {
      id: 'agent-question:7:q1',
      agentId: '7',
      request: { method: 'input' as const, title: 'Change greet?', agent: 'reviewer' },
    };
    let questions = [question];
    service.setAgentQuestions(() => questions);
    await service.touch('t1');
    expect(seen.at(-1)).toMatchObject({
      state: {
        activity: 'waiting',
        question: 'Change greet?',
        dialog: { id: 'agent-question:7:q1', method: 'input' },
        agentQuestions: [question],
      },
    });
    questions = [];
    await service.touch('t1');
    expect(seen.at(-1)).toMatchObject({ state: { activity: 'idle', question: null } });
    expect((seen.at(-1) as { state?: { agentQuestions?: unknown } }).state?.agentQuestions).toBeUndefined();
  });

  it('the attendant’s summary reaches the stream when the thread is touched', async () => {
    await addThread('t1');
    await service.snapshot();
    await attendant.setSummary('t1', 'Writing the summary function', null);
    await service.touch('t1');
    expect(seen.at(-1)).toMatchObject({ state: { summary: 'Writing the summary function' } });
  });

  it('touch on a deleted thread says gone, once; touchAll finds what changed', async () => {
    await addThread('t1');
    await addThread('t2');
    await service.snapshot();
    await rows.delete('t1');
    await service.touch('t1');
    await service.touch('t1');
    expect(seen.filter((e) => e.type === 'gone')).toEqual([{ type: 'gone', id: 't1' }]);
    await attendant.setSummary('t2', 'x', null);
    await service.touchAll();
    expect(seen.at(-1)).toMatchObject({ type: 'state', id: 't2' });
  });

  it('an outcome written for a thread reaches its state, in the snapshot and as a pushed line', async () => {
    await addThread('t1');
    await addThread('t2');
    expect((await service.snapshot())['t1']?.outcome).toBeNull();
    await outcomeRows.put({
      threadId: 't1',
      kind: 'merged',
      baseCommit: 'b',
      headCommit: 'h'.repeat(40),
      mergeCommit: 'h'.repeat(40),
      prUrl: null,
      at: 1234,
      files: ['a.ts'],
    });
    await service.touch('t1');
    expect(seen.at(-1)).toMatchObject({
      type: 'state',
      id: 't1',
      state: { outcome: { kind: 'merged', head: 'h'.repeat(40), at: 1234 } },
    });
    // A pass over every thread reads the outcomes once and puts each on its own thread.
    const states = await service.snapshot();
    expect(states['t1']?.outcome).toMatchObject({ kind: 'merged' });
    expect(states['t2']?.outcome).toBeNull();
    await outcomeRows.put({
      threadId: 't2',
      kind: 'pr',
      baseCommit: 'b',
      headCommit: 'p'.repeat(40),
      mergeCommit: null,
      prUrl: 'https://example.test/pr/1',
      at: 99,
      files: [],
    });
    await service.touchAll();
    expect(seen.at(-1)).toMatchObject({
      id: 't2',
      state: { outcome: { kind: 'pr', url: 'https://example.test/pr/1' } },
    });
  });

  it('a skill draft reaches the state of its thread, and a decision changes it', async () => {
    await addThread('t1');
    await addThread('t2');
    expect((await service.snapshot())['t1']?.draft).toBeNull();
    const drafts = new SkillDraftsRepository(db);
    const made = await drafts.insert({
      threadId: 't1',
      name: 'add-a-migration',
      text: '---\nname: add-a-migration\ndescription: d\n---\nB',
      scope: 'project',
      madeBy: 'attendant',
    });
    await service.touch('t1');
    expect(seen.at(-1)).toMatchObject({
      type: 'state',
      id: 't1',
      state: { draft: { id: made.id, name: 'add-a-migration', state: 'pending', madeBy: 'attendant' } },
    });
    expect((await service.snapshot())['t2']?.draft).toBeNull();
    await drafts.setState(made.id, 'discarded');
    await service.touch('t1');
    expect(seen.at(-1)).toMatchObject({ id: 't1', state: { draft: { state: 'discarded' } } });
  });

  it('listChanged is a line of its own, and a closed stream does not stop the others', () => {
    const second = vi.fn();
    service.subscribe(() => {
      throw new Error('closed');
    });
    service.subscribe(second);
    service.listChanged();
    expect(seen).toEqual([{ type: 'list' }]);
    expect(second).toHaveBeenCalledWith({ type: 'list' });
  });
});
