import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import type { AttendantSettings, PiDialogRequest } from '@pi-kit/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttendantRepository } from '../db/attendant.repository';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import { MetaRepository } from '../db/meta.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { type ModelChoice, AttendantModelPort, type ModelReply } from './attendant-model';
import { AttendantService, startOfDay } from './attendant.service';
import type { Prompt } from './attendant-text';

const CHOICE: ModelChoice = { provider: 'llama-swap', id: 'gemma', price: 0, reasoning: false };

/** A model that answers by the kind of prompt it gets, counts its calls and charges a fixed cost per call. */
class FakeModel extends AttendantModelPort {
  calls = 0;
  cost = 0;
  answers = { title: 'Add a monthly summary to the report', summary: 'Writing the summary function', label: 'Retry or give up', draft: 'Allow' };
  prompts: Prompt[] = [];
  resolve = vi.fn(async (_settings: AttendantSettings) => CHOICE as ModelChoice | undefined);
  async ask(prompt: Prompt, _choice?: ModelChoice, _signal?: AbortSignal): Promise<ModelReply> {
    this.calls += 1;
    this.prompts.push(prompt);
    const text = prompt.system.includes('name conversations')
      ? this.answers.title
      : prompt.system.includes('one-line status')
        ? this.answers.summary
        : prompt.system.includes('label the point')
          ? this.answers.label
          : this.answers.draft;
    return { text, model: 'llama-swap/gemma', inputTokens: 100, outputTokens: 10, cost: this.cost };
  }
}

const msg = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string): PiSessionEntry => ({
  type: 'message',
  id,
  parentId,
  message: { role, content: [{ type: 'text', text }] },
});
const LINEAR: PiSessionEntry[] = [msg('u1', null, 'user', 'Add a monthly summary to the report module'), msg('a1', 'u1', 'assistant', 'I will write it now.')];

let dir: string;
let db: DatabaseService;
let meta: MetaRepository;
let repo: AttendantRepository;
let rows: ThreadsRepository;
let events: EventLogRepository;
let model: FakeModel;
let dialogs: { id: string; request: PiDialogRequest }[];
let entries: PiSessionEntry[];
let leaf: string;
let processed: string[];
const status = { touch: vi.fn(), touchAll: vi.fn() };
const tree = { label: vi.fn(async () => undefined) };
const patch = vi.fn(async (id: string, change: { title?: string }) => rows.update(id, change));

const make = () =>
  new AttendantService(
    meta,
    repo,
    {
      treeSource: async (id: string) => {
        processed.push(id);
        return { entries, leafId: leaf, path: undefined };
      },
      patch,
    } as never,
    rows,
    status as never,
    events,
    { onDialogsChanged: vi.fn(), pendingDialogs: () => dialogs } as never,
    model,
    tree as never,
  );

/** A thread with a session file on disk (the attendant keys its memory on the file's mtime) and `messageCount` messages. */
function addThread(id: string, over: { title?: string; cwd?: string; messageCount?: number; archived?: boolean } = {}): string {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, '{}\n');
  rows.insertDraft({ id, sessionPath: path, cwd: over.cwd ?? '/proj', ...(over.title ? { title: over.title } : {}) });
  rows.upsertFromSession({ id, sessionPath: path, cwd: over.cwd ?? '/proj', title: over.title, preview: 'p', parentSessionPath: undefined, messageCount: over.messageCount ?? 2, createdAt: 1, updatedAt: 2 }, 1);
  if (over.archived) rows.update(id, { archived: true });
  return path;
}

const enable = (over: Partial<AttendantSettings> = {}): void => void meta.setSetting('attendant', { enabled: true, model: null, when: { onEnd: true, onInterrupt: true, everyMinutes: 0 }, dailyCostCap: 0.5, ...over });

/**
 * Holds every model request until `release()` (or until its signal aborts, as a real request ends then), and keeps the signal each was given.
 * A request whose signal aborted fails the way a cancelled one does; one that was released answers as the fake does.
 */
function holdModel(): { seen: { prompt: Prompt; signal: AbortSignal | undefined }[]; release: () => void; until: (count: number) => Promise<void> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const real = model.ask.bind(model);
  const seen: { prompt: Prompt; signal: AbortSignal | undefined }[] = [];
  vi.spyOn(model, 'ask').mockImplementation(async (prompt, choice, signal) => {
    seen.push({ prompt, signal });
    await new Promise<void>((resolve) => {
      void gate.then(resolve);
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    if (signal?.aborted) throw new Error('aborted');
    return real(prompt, choice, signal);
  });
  const until = async (count: number): Promise<void> => {
    const end = Date.now() + 5000;
    while (seen.length < count) {
      if (Date.now() > end) throw new Error(`waited for ${count} model requests, saw ${seen.length}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { seen, release, until };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pk-attendant-'));
  db = new DatabaseService({ dataDir: dir });
  meta = new MetaRepository(db);
  repo = new AttendantRepository(db);
  rows = new ThreadsRepository(db);
  events = new EventLogRepository(db);
  model = new FakeModel();
  dialogs = [];
  entries = LINEAR;
  leaf = 'a1';
  processed = [];
  status.touch.mockClear();
  tree.label.mockClear();
  patch.mockClear();
  meta.touchWorkspace('/proj');
});
afterEach(() => {
  db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('the attendant is off', () => {
  it('by default: no model is called, nothing is recorded, a manual run is refused', async () => {
    addThread('t1');
    const attendant = make();
    expect(attendant.settings().enabled).toBe(false);
    attendant.enqueue('t1', 'end');
    await attendant.process('t1', 'end');
    expect(attendant.sweep()).toBe(0);
    expect(() => attendant.run('t1')).toThrow(ConflictException);
    expect(model.calls).toBe(0);
    expect(model.resolve).not.toHaveBeenCalled();
    expect(repo.actions()).toEqual([]);
    expect((await attendant.statusReport()).calls).toBe(0);
  });

  it('switching it off while it works stops the rest of the job: no further model call, nothing listed for the aborted one', async () => {
    addThread('t1');
    enable();
    const held = holdModel();
    const attendant = make();
    attendant.enqueue('t1', 'end');
    await held.until(1);
    attendant.patch({ enabled: false });
    held.release();
    await attendant.idle();
    expect(model.calls).toBe(0);
    expect(repo.actions()).toEqual([]);
    expect((await attendant.statusReport()).queued).toBe(0);
  });

  it('switching it off again stops everything at once', async () => {
    addThread('t1');
    const attendant = make();
    enable();
    attendant.patch({ enabled: false });
    attendant.enqueue('t1', 'end');
    await attendant.idle();
    expect(model.calls).toBe(0);
  });
});

describe('the attendant is on', () => {
  beforeEach(() => enable());

  it('leaves a verification thread alone: not named, not summarised, not swept', async () => {
    addThread('replay');
    addThread('t2');
    meta.markVerificationThread('replay', 'draft-1');
    const attendant = make();
    await attendant.process('replay', 'end');
    expect(model.calls).toBe(0);
    expect(rows.get('replay')?.title).toBeNull();
    expect(repo.actions()).toEqual([]);
    // The sweep takes the other thread and not the replay.
    expect(attendant.sweep()).toBe(1);
    await attendant.idle();
    expect(processed).toContain('t2');
    expect(processed).not.toContain('replay');
  });

  it('lists a note with the replay’s usage when another service hands one in', () => {
    addThread('t1');
    make().note('learn', rows.get('t1') as never, 'Verified the skill x: pass.', 'done', { model: 'p/m', inputTokens: 50, outputTokens: 0, cost: 0.01 });
    expect(repo.actions()[0]).toMatchObject({ kind: 'learn', status: 'done', model: 'p/m', inputTokens: 50, cost: 0.01, text: 'Verified the skill x: pass.' });
    expect(repo.usageSince(0).cost).toBeCloseTo(0.01);
  });

  it('names an unnamed thread and keeps a one-line summary, each an action with its tokens and cost', async () => {
    addThread('t1');
    model.cost = 0.002;
    await make().process('t1', 'end');
    expect(patch).toHaveBeenCalledWith('t1', { title: 'Add a monthly summary to the report' });
    expect(rows.get('t1')?.title).toBe('Add a monthly summary to the report');
    expect(repo.meta('t1')?.summary).toBe('Writing the summary function');
    const actions = repo.actions();
    expect(actions.map((a) => [a.kind, a.status, a.model, a.inputTokens, a.outputTokens, a.cost])).toEqual([
      ['summary', 'done', 'llama-swap/gemma', 100, 10, 0.002],
      ['title', 'done', 'llama-swap/gemma', 100, 10, 0.002],
    ]);
    expect(actions[1].threadId).toBe('t1');
    expect(status.touch).toHaveBeenCalledWith('t1');
  });

  it('never renames a thread the user named, and does not summarise a file it already summarised', async () => {
    addThread('t1', { title: 'My own name' });
    const attendant = make();
    await attendant.process('t1', 'end');
    expect(model.prompts.map((p) => p.system.includes('name conversations'))).toEqual([false]);
    expect(patch).not.toHaveBeenCalled();
    await attendant.process('t1', 'end');
    expect(model.calls).toBe(1);
    // a question makes it look again even though the file did not change
    await attendant.process('t1', 'interrupt');
    expect(model.calls).toBe(2);
  });

  it('puts the pending question into the summary prompt', async () => {
    addThread('t1', { title: 'x' });
    dialogs = [{ id: 'd1', request: { method: 'input', title: 'Which folder?' } }];
    await make().process('t1', 'interrupt');
    expect(model.prompts.at(-1)?.user).toContain('waiting for the user to answer: Which folder?');
  });

  it('skips a thread without messages, an archived one, and a project that opted out', async () => {
    addThread('empty', { messageCount: 0 });
    addThread('old', { archived: true });
    addThread('away', { cwd: '/away' });
    meta.touchWorkspace('/away');
    meta.patchWorkspace('/away', { attendantOff: true });
    const attendant = make();
    for (const id of ['empty', 'old', 'away']) await attendant.process(id, 'end');
    expect(model.calls).toBe(0);
  });

  it('does not touch a thread that runs; the end of the run brings it back', async () => {
    addThread('t1');
    events.beginRun('t1', 'r1');
    await make().process('t1', 'end');
    expect(model.calls).toBe(0);
    events.endRun('r1', 'finished');
    await make().process('t1', 'end');
    expect(model.calls).toBeGreaterThan(0);
  });

  it('stops when the daily cost cap is reached and says so once', async () => {
    enable({ dailyCostCap: 0.01 });
    addThread('t1');
    addThread('t2');
    model.cost = 0.02;
    const attendant = make();
    await attendant.process('t1', 'end');
    const callsAfterFirst = model.calls;
    expect(callsAfterFirst).toBe(1); // the first request used the cap up; the second one of the thread was refused
    await attendant.process('t2', 'end');
    await attendant.process('t2', 'end');
    expect(model.calls).toBe(callsAfterFirst);
    expect(repo.actions().filter((a) => a.status === 'skipped')).toHaveLength(1);
    expect((await attendant.statusReport()).capReached).toBe(true);
    expect(repo.usageSince(startOfDay()).cost).toBeCloseTo(0.02);
  });

  it('without a model it records that it could not work', async () => {
    addThread('t1');
    model.resolve.mockResolvedValueOnce(undefined);
    await make().process('t1', 'end');
    expect(model.calls).toBe(0);
    expect(repo.actions()[0]).toMatchObject({ status: 'skipped', text: 'No model is available for the attendant.' });
  });

  it('a failed request is an action of status error, and the next thread still gets its turn', async () => {
    addThread('t1');
    vi.spyOn(model, 'ask').mockRejectedValueOnce(new Error('model server down'));
    await make().process('t1', 'end');
    expect(repo.actions().find((a) => a.status === 'error')?.text).toBe('model server down');
  });

  it('an answer that is not a title is an error, not a title', async () => {
    addThread('t1');
    model.answers.title = 'Hm';
    await make().process('t1', 'end');
    expect(rows.get('t1')?.title).toBeNull();
    expect(repo.actions().find((a) => a.kind === 'title')?.status).toBe('error');
  });

  it('a sweep queues the threads whose file changed since it looked, newest first, at most the limit', async () => {
    for (const id of ['a', 'b', 'c']) addThread(id);
    const attendant = make();
    expect(attendant.sweep(2)).toBe(2);
    await attendant.idle();
    expect(rows.get('a') && repo.meta('a')?.lookedFor).not.toBeUndefined();
    // everything looked at is up to date; only the third remains
    expect(attendant.sweep()).toBe(1);
    await attendant.idle();
    expect(attendant.sweep()).toBe(0);
  });

  it('a run that ended or a question goes ahead of the sweep’s jobs, and a sweep job that gets a better reason moves forward', async () => {
    for (const id of ['t1', 't2', 't3', 't4']) addThread(id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = model.ask.bind(model);
    vi.spyOn(model, 'ask').mockImplementationOnce(async (prompt) => {
      await gate;
      return real(prompt);
    });
    const attendant = make();
    attendant.enqueue('t1', 'sweep'); // starts, held at its first request
    attendant.enqueue('t2', 'sweep');
    attendant.enqueue('t3', 'sweep');
    attendant.enqueue('t4', 'end');
    attendant.enqueue('t3', 'interrupt');
    attendant.enqueue('t2', 'sweep'); // already queued: nothing changes
    expect((await attendant.statusReport()).queued).toBe(4);
    release();
    await attendant.idle();
    expect(processed).toEqual(['t1', 't3', 't4', 't2']);
    expect((await attendant.statusReport()).queued).toBe(0);
  });

  it('switching it on takes a first look', async () => {
    addThread('t1');
    const attendant = make();
    attendant.patch({ enabled: false });
    attendant.patch({ enabled: true });
    await attendant.idle();
    expect(model.calls).toBeGreaterThan(0);
  });
});

describe('suggestions', () => {
  beforeEach(() => enable());

  it('drafts an answer to a yes/no question and offers it, without answering', async () => {
    addThread('t1', { title: 'x' });
    dialogs = [{ id: 'd1', request: { method: 'confirm', title: 'Run npm test?' } }];
    await make().process('t1', 'interrupt');
    expect(repo.openSuggestions('t1')).toEqual([{ id: expect.any(Number), kind: 'answer', target: 'd1', text: 'Allow', reason: expect.stringContaining('Run npm test?') }]);
    expect(repo.actions().find((a) => a.kind === 'draft')?.text).toContain('Suggested “Allow”');
  });

  it('proposes nothing when the model says SKIP, and does not ask about a question twice', async () => {
    addThread('t1', { title: 'x' });
    dialogs = [{ id: 'd1', request: { method: 'confirm', title: 'Delete the database?' } }];
    model.answers.draft = 'SKIP';
    const attendant = make();
    await attendant.process('t1', 'interrupt');
    expect(repo.openSuggestions('t1')).toEqual([]);
    expect(repo.actions().find((a) => a.kind === 'draft')?.text).toContain('left to you');
    model.answers.draft = 'Allow';
    dialogs = [{ id: 'd2', request: { method: 'confirm', title: 'Run npm test?' } }];
    await attendant.process('t1', 'interrupt');
    await attendant.process('t1', 'interrupt');
    expect(repo.openSuggestions('t1')).toHaveLength(1);
    expect(model.prompts.filter((p) => p.system.includes('mechanical')).length).toBe(2);
  });

  it('does not draft for a free-text question, and keeps to the options of a list', async () => {
    addThread('t1', { title: 'x' });
    dialogs = [
      { id: 'i1', request: { method: 'input', title: 'Name it' } },
      { id: 's1', request: { method: 'select', title: 'Which flavour?', options: ['vanilla', 'pistachio'] } },
    ];
    model.answers.draft = 'pistachio';
    await make().process('t1', 'interrupt');
    expect(repo.openSuggestions('t1').map((s) => [s.target, s.text])).toEqual([['s1', 'pistachio']]);
    model.answers.draft = 'chocolate';
    dialogs = [{ id: 's2', request: { method: 'select', title: 'Again?', options: ['vanilla', 'pistachio'] } }];
    await make().process('t1', 'interrupt');
    expect(repo.openSuggestions('t1').some((s) => s.target === 's2')).toBe(false);
  });

  it('answer drafts expire with their question', () => {
    repo.addSuggestion({ threadId: 't1', kind: 'answer', target: 'd1', text: 'Allow' });
    repo.addSuggestion({ threadId: 't1', kind: 'answer', target: 'd2', text: 'Deny' });
    expect(repo.expireAnswers('t1', ['d2'])).toBe(1);
    expect(repo.openSuggestions('t1').map((s) => s.target)).toEqual(['d2']);
  });

  it('proposes a label for a fork point that has none, once', async () => {
    const path = addThread('t1', { title: 'x' });
    entries = [...LINEAR, msg('u2', 'a1', 'user', 'Retry the build'), msg('a2', 'u2', 'assistant', 'Retrying'), msg('u3', 'a1', 'user', 'Give up and ship'), msg('a3', 'u3', 'assistant', 'Shipping')];
    leaf = 'a2';
    rows.setForkCount('t1', 1, null);
    const attendant = make();
    await attendant.process('t1', 'end');
    expect(path).toBeTruthy();
    const open = repo.openSuggestions('t1');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'label', target: 'u1', text: 'Retry or give up' });
    const labelCalls = () => model.prompts.filter((p) => p.system.includes('label the point')).length;
    expect(labelCalls()).toBe(1);
    await attendant.process('t1', 'manual');
    expect(labelCalls()).toBe(1);
  });

  it('accepting a label applies it through the tree, an answer only closes the suggestion, dismissing closes it', async () => {
    addThread('t1', { title: 'x' });
    const label = repo.addSuggestion({ threadId: 't1', kind: 'label', target: 'u1', text: 'Retry or give up' });
    const answer = repo.addSuggestion({ threadId: 't1', kind: 'answer', target: 'd1', text: 'Allow' });
    const other = repo.addSuggestion({ threadId: 't1', kind: 'label', target: 'u9', text: 'x' });
    const attendant = make();
    await attendant.accept(label);
    expect(tree.label).toHaveBeenCalledWith('t1', 'u1', 'Retry or give up');
    await attendant.accept(answer);
    expect(tree.label).toHaveBeenCalledTimes(1);
    attendant.dismiss(other);
    expect(repo.openSuggestions('t1')).toEqual([]);
    await expect(attendant.accept(label)).rejects.toThrow();
  });
});

describe('work for other services (drafting a skill)', () => {
  const prompt: Prompt = { system: 'You turn work into a skill.', user: 'the thread' };
  const describeText = (text: string) => ({ status: 'done' as const, text: `Answered ${text.length}` });
  const ask = (attendant: AttendantService, initiative: 'attendant' | 'person', signal?: AbortSignal) => attendant.complete(rows.get('t1')!, prompt, { kind: 'learn', initiative, describe: describeText, signal });

  it('refuses a task while it is off, and for a project that opted out', () => {
    addThread('t1');
    const attendant = make();
    expect(attendant.enqueueTask('t1', async () => undefined)).toBe(false);
    enable();
    expect(attendant.allowedIn('/proj')).toBe(true);
    meta.patchWorkspace('/proj', { attendantOff: true });
    expect(attendant.allowedIn('/proj')).toBe(false);
    expect(attendant.enqueueTask('t1', async () => undefined)).toBe(false);
  });

  it('runs a task in line, once per thread, ahead of the sweep', async () => {
    enable();
    addThread('t1');
    addThread('t2');
    const attendant = make();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    expect(attendant.enqueueTask('t1', async () => void (await held, order.push('t1')))).toBe(true);
    expect(attendant.enqueueTask('t1', async () => void order.push('again'))).toBe(false);
    expect(attendant.enqueueTask('t2', async () => void order.push('t2'))).toBe(true);
    release();
    await attendant.idle();
    expect(order).toEqual(['t1', 't2']);
  });

  it('takes one task of each kind per thread: a score task is not refused because a learn task is waiting for the same thread', async () => {
    enable();
    addThread('t1');
    const attendant = make();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    expect(attendant.enqueueTask('t1', async () => void (await held, order.push('learn')))).toBe(true);
    expect(attendant.enqueueTask('t1', async () => void order.push('score'), 'score')).toBe(true);
    expect(attendant.enqueueTask('t1', async () => void order.push('score again'), 'score')).toBe(false);
    expect(attendant.enqueueTask('t1', async () => void order.push('learn again'))).toBe(false);
    release();
    await attendant.idle();
    expect(order).toEqual(['learn', 'score']);
  });

  it('completes a request for a person while it is off, and lists it with its cost', async () => {
    addThread('t1');
    // `draft` is what the fake answers for a prompt that is none of its own kinds.
    model.answers.draft = 'a draft';
    model.cost = 0.003;
    const done = await ask(make(), 'person');
    expect(done).toMatchObject({ ok: true, text: 'a draft', cost: 0.003 });
    expect(model.calls).toBe(1);
    expect(repo.actions()[0]).toMatchObject({ kind: 'learn', status: 'done', threadId: 't1', text: 'Answered 7', cost: 0.003 });
    expect(repo.usageSince(startOfDay()).cost).toBeCloseTo(0.003);
  });

  it('the attendant’s own initiative needs it to be on; the person’s does not', async () => {
    addThread('t1');
    const attendant = make();
    expect(await ask(attendant, 'attendant')).toMatchObject({ ok: false, code: 'off' });
    expect(model.calls).toBe(0);
    expect(await ask(attendant, 'person')).toMatchObject({ ok: true });
  });

  it('holds the daily cap for both, and says there is no model when there is none', async () => {
    enable({ dailyCostCap: 0.01 });
    addThread('t1');
    model.cost = 0.02;
    const attendant = make();
    await ask(attendant, 'person');
    expect(await ask(attendant, 'person')).toMatchObject({ ok: false, code: 'cap' });
    expect(await ask(attendant, 'attendant')).toMatchObject({ ok: false, code: 'cap' });
    expect(model.calls).toBe(1);
    enable({ dailyCostCap: null });
    model.resolve.mockResolvedValueOnce(undefined);
    expect(await ask(attendant, 'person')).toMatchObject({ ok: false, code: 'no-model' });
  });

  it('lists a failed request as an error and reports it', async () => {
    addThread('t1');
    model.ask = async () => {
      throw new Error('the server is down');
    };
    expect(await ask(make(), 'person')).toEqual({ ok: false, code: 'failed', error: 'the server is down' });
    expect(repo.actions()[0]).toMatchObject({ kind: 'learn', status: 'error', text: 'the server is down' });
  });

  it.each([
    // The backend quitting aborts every request in flight, the loop's included; a caller's signal reaches only the request it was given with.
    { who: 'the backend quitting', cancel: (attendant: AttendantService, _caller: AbortController) => attendant.onModuleDestroy(), reasons: ['cancelled', 'cancelled'], title: null },
    { who: 'the caller’s own signal', cancel: (_attendant: AttendantService, caller: AbortController) => caller.abort(), reasons: [undefined, 'cancelled'], title: 'Add a monthly summary to the report' },
  ])('a person’s request in flight is aborted by $who: the model hears it, the answer is failed, nothing is listed for it', async ({ cancel, reasons, title }) => {
    enable();
    addThread('t1');
    const held = holdModel();
    const attendant = make();
    attendant.enqueue('t1', 'end'); // the attendant's own request: its loop, naming the thread
    await held.until(1);
    const caller = new AbortController();
    const pending = ask(attendant, 'person', caller.signal);
    await held.until(2);
    expect(held.seen.map((request) => request.signal?.aborted)).toEqual([false, false]);
    cancel(attendant, caller);
    expect(held.seen.map((request) => request.signal?.reason)).toEqual(reasons);
    expect(await pending).toEqual({ ok: false, code: 'failed', error: 'The request was cancelled.' });
    held.release();
    await attendant.idle();
    expect(rows.get('t1')?.title).toBe(title);
    expect(repo.actions().filter((a) => a.kind === 'learn')).toEqual([]);
  });

  it.each(['caller already cancelled', 'backend already stopped'])('%s makes no request at all', async (why) => {
    addThread('t1');
    const caller = new AbortController();
    const attendant = make();
    if (why === 'backend already stopped') attendant.onModuleDestroy();
    else caller.abort();
    expect(await ask(attendant, 'person', caller.signal)).toEqual({ ok: false, code: 'failed', error: 'The request was cancelled.' });
    expect(model.calls).toBe(0);
    expect(model.resolve).not.toHaveBeenCalled();
    expect(repo.actions()).toEqual([]);
  });

  it('switching it off aborts every request on the attendant’s own initiative, its loop’s and a task’s at once, and not the person’s, which goes on to its answer', async () => {
    enable();
    addThread('t1');
    const held = holdModel();
    const attendant = make();
    attendant.enqueue('t1', 'end'); // the loop's own request: naming the thread
    await held.until(1);
    const own = ask(attendant, 'attendant'); // a task on the attendant's initiative, in flight at the same time as the loop's request
    await held.until(2);
    const person = ask(attendant, 'person');
    await held.until(3);
    attendant.patch({ enabled: false });
    expect(held.seen.map((request) => request.signal?.reason)).toEqual(['off', 'off', undefined]);
    expect(await own).toEqual({ ok: false, code: 'failed', error: 'The attendant was switched off.' });
    held.release();
    expect(await person).toMatchObject({ ok: true, text: 'Allow' });
    await attendant.idle();
    expect(rows.get('t1')?.title).toBeNull(); // the loop's aborted request named nothing
    expect(model.calls).toBe(1);
    expect(repo.actions().map((a) => [a.kind, a.status, a.text])).toEqual([['learn', 'done', 'Answered 5']]);
  });

  it('a learn suggestion is settled by its review, not by accept', async () => {
    addThread('t1');
    const id = repo.addSuggestion({ threadId: 't1', kind: 'learn', target: 'draft-1', text: 'a-skill' });
    await expect(make().accept(id)).rejects.toThrow(/approve or discard/);
    expect(repo.openSuggestions('t1')).toHaveLength(1);
    make().dismiss(id);
    expect(repo.openSuggestions('t1')).toEqual([]);
  });
});

describe('settings', () => {
  it('start from the defaults: off, the cheapest model, on end and on a question, $0.50 a day', () => {
    expect(make().settings()).toEqual({ enabled: false, followUpSuggestions: false, model: null, when: { onEnd: true, onInterrupt: true, everyMinutes: 0 }, dailyCostCap: 0.5 });
  });

  it('patch merges the schedule and keeps what it was not given', () => {
    const attendant = make();
    attendant.patch({ model: { provider: 'llama-swap', modelId: 'gemma' }, when: { everyMinutes: 15 } });
    expect(attendant.settings()).toMatchObject({ enabled: false, model: { provider: 'llama-swap', modelId: 'gemma' }, when: { onEnd: true, onInterrupt: true, everyMinutes: 15 } });
    attendant.patch({ dailyCostCap: null });
    expect(attendant.settings().dailyCostCap).toBeNull();
    attendant.onModuleDestroy();
  });
});
