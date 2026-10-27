import 'reflect-metadata';
import { PiPluginService } from '../pi/pi-plugin.service';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConflictException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type HunkLabelEntry, PLUGIN_CHANNELS } from '@pi-kit/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Completion } from '../attendant/attendant.service';
import { ChangesRepository } from '../db/changes.repository';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { OutcomesRepository } from '../db/outcomes.repository';
import { SignalsRepository } from '../db/signals.repository';
import { ThreadsRepository } from '../db/threads.repository';
import type { MeatProxyPackage, ScoringModule } from './meat-proxy-package';
import { ScoreController } from './score.controller';
import { ScoreService, scoreConsentSentence } from './score.service';

// The backend loads pi through a native `import()` that a test runner's sandbox does not offer.
vi.mock('../pi/load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

const git = (cwd: string, ...args: string[]): string => {
  const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  return out.stdout.trim();
};

let scoring: ScoringModule;
beforeAll(async () => {
  // The scoring the package does, loaded the way the backend loads it from an installed package.
  const url = pathToFileURL(resolve(__dirname, '..', '..', '..', '..', 'packages', 'pi-kit-meat-proxy', 'lib', 'pipeline.mjs')).href;
  scoring = (await import(/* @vite-ignore */ url)) as ScoringModule;
});
afterAll(() => undefined);

let base: string;
let project: string;
let db: DatabaseService;
let rows: ThreadsRepository;
let outcomeRows: OutcomesRepository;
let signals: SignalsRepository;
let changes: ChangesRepository;
let meta: MetaRepository;
let service: ScoreService;
let installed: boolean;
let attendantOn: boolean;
let completions: { prompt: { system: string; user: string }; initiative: string; signal: AbortSignal | undefined; listed: string | undefined }[];
let answer: (prompt: { system: string; user: string }) => Completion;
/** Every model call of the fake attendant waits for this before it answers (resolved unless a test holds it). */
let hold: Promise<void>;
const holdAnswers = (): (() => void) => {
  let release!: () => void;
  hold = new Promise<void>((resolve) => (release = resolve));
  return release;
};
const until = async (ready: () => boolean): Promise<void> => {
  const end = Date.now() + 5000;
  while (!ready()) {
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
let touched: string[];
let notes: { kind: string; text: string; status: string | undefined }[];
let delegated: { channel: string; payload: unknown }[];
let baseCommit: string;
let headCommit: string;
let head2: string;
const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];

const entries = [
  { type: 'message', id: 'm0', parentId: null, message: { role: 'user', content: 'Add notes/a.md and notes/b.md' } },
  { type: 'message', id: 'm1', parentId: 'm0', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'write', arguments: { path: 'notes/a.md', content: 'x' } }] } },
  { type: 'message', id: 'm2', parentId: 'm1', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } },
];

const transcript = {
  threadId: 't1',
  title: 'Add notes',
  cwd: '',
  prompts: ['Add notes/a.md and notes/b.md'],
  toolCalls: 1,
  steps: [],
  errors: [],
  checks: [],
  diff: null,
  changedLines: 0,
  commitMessage: null,
  base: null,
  head: null,
  truncated: false,
  redactions: 0,
  turns: [{ n: 1, at: 1, text: 'Add notes/a.md and notes/b.md', queued: false, gapMs: null, toolCalls: 1, files: ['notes/a.md'], chips: [], review: null, answers: [], previous: null }],
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-score-')));
  project = join(base, 'project');
  mkdirSync(join(project, 'notes'), { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), '# project\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'init');
  baseCommit = git(project, 'rev-parse', 'HEAD');
  writeFileSync(join(project, 'notes', 'a.md'), '# A\nline two\n');
  writeFileSync(join(project, 'notes', 'b.md'), '# B\n');
  writeFileSync(join(project, 'notes', 'hand.md'), 'by hand\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'Add notes');
  headCommit = git(project, 'rev-parse', 'HEAD');
  writeFileSync(join(project, 'notes', 'c.md'), 'three\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'More');
  head2 = git(project, 'rev-parse', 'HEAD');

  process.env['PI_CODING_AGENT_DIR'] = join(base, 'agent');
  db = new DatabaseService({ dataDir: join(base, 'data') });
  meta = new MetaRepository(db);
  meta.touchWorkspace(project);
  rows = new ThreadsRepository(db);
  outcomeRows = new OutcomesRepository(db);
  signals = new SignalsRepository(db);
  changes = new ChangesRepository(db);
  installed = true;
  attendantOn = true;
  completions = [];
  touched = [];
  notes = [];
  delegated = [];
  hold = Promise.resolve();
  answer = () => ({ ok: true, text: 'h1 | specified | prompt 1 | named\nh2 | autonomous | none | extra', model: 'fake/canned', inputTokens: 1, outputTokens: 1, cost: 0 });

  rows.insertDraft({ id: 't1', sessionPath: join(base, 't1.jsonl'), cwd: project, baseCommit });
  outcomeRows.put({ threadId: 't1', kind: 'committed', baseCommit, headCommit, mergeCommit: null, prUrl: null, at: 5, files: ['notes/a.md', 'notes/b.md', 'notes/hand.md'] });
  changes.putBaseline('t1', 'notes/a.md', { existed: false, content: null });
  signals.noteOutsideEdit('t1', 'notes/hand.md', 10);

  const attendant = {
    settings: () => ({ enabled: attendantOn }),
    modelLabel: async () => 'fake/canned',
    allowedIn: () => true,
    enqueueTask: vi.fn((_id: string, task: () => Promise<void>) => void task()),
    note: (kind: string, _row: unknown, text: string, status?: string) => void notes.push({ kind, text, status }),
    complete: async (_row: unknown, prompt: { system: string; user: string }, options: { initiative: string; signal?: AbortSignal; describe: (text: string) => { text: string } }) => {
      const call: (typeof completions)[number] = { prompt, initiative: options.initiative, signal: options.signal, listed: undefined };
      completions.push(call);
      await hold;
      // The attendant's own contract (attendant.service.spec.ts): a call whose signal aborted answers `failed` without asking the model.
      const done: Completion = options.signal?.aborted ? { ok: false, code: 'failed', error: 'The request was cancelled.' } : answer(prompt);
      // What the attendant's activity would list for this call.
      if (done.ok) call.listed = options.describe(done.text).text;
      return done;
    },
  };
  const pkg = {
    scoring: async () => (installed ? scoring : undefined),
    installedNow: () => installed,
    refresh: async () => installed,
    onInstalledChange: () => () => undefined,
    ensureInstalled: async () => 'present',
  } as unknown as MeatProxyPackage;
  const outcomeOf = (id: string) => {
    const row = outcomeRows.get(id);
    return row && { kind: row.kind, base: row.baseCommit, head: row.headCommit, merge: null, prUrl: null, at: row.at, files: row.files, baseBranch: 'main', baseSource: 'start' };
  };
  service = new ScoreService(
    outcomeRows,
    { get: outcomeOf, onOutcome: () => () => undefined } as never,
    rows,
    { assertExists: (id: string) => void (rows.get(id) ?? (() => { throw new Error('missing'); })()), treeSource: async () => ({ entries, leafId: 'm2', path: undefined }) } as never,
    {
      transcriptOf: async () => ({ ...transcript, cwd: project }),
      plugin: async (_t: string, channel: string, payload: unknown) => {
        delegated.push({ channel, payload });
        return { requestId: (payload as { requestId: string }).requestId, ok: true, learn: true };
      },
    } as never,
    signals,
    changes,
    attendant as never,
    new PiPluginService(),
    { touch: (id: string) => void touched.push(id), setScoreBadge: () => undefined, touchAll: () => undefined } as never,
    meta,
    pkg,
  );
});

afterEach(() => {
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
  else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
});

const ask = (channel: string, payload: Record<string, unknown> = {}, session = 't1') => service.plugin(session, channel, { requestId: 'r1', ...payload });

/** An outcome with enough changed text for more than one of the package's prompts; the fake model labels whatever each prompt offers. */
function longOutcome(): void {
  for (let index = 0; index < 30; index++) writeFileSync(join(project, 'notes', `long-${index}.txt`), Array.from({ length: 24 }, (_, line) => `file ${index} line ${line} ${'words '.repeat(28)}`).join('\n') + '\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'Long outcome');
  const head = git(project, 'rev-parse', 'HEAD');
  outcomeRows.put({ threadId: 't1', kind: 'committed', baseCommit, headCommit: head, mergeCommit: null, prUrl: null, at: 11, files: [] });
  answer = (prompt) => ({ ok: true, text: [...prompt.user.matchAll(/^(h\d+) \| notes\/\S+ \|/gm)].map((match) => `${match[1]} | specified | prompt 1 | named`).join('\n'), model: 'fake/canned', inputTokens: 1, outputTokens: 1, cost: 0 });
}

/** An outcome whose only changed file was changed by hand and never by pi: every hunk is decided by rule, and no model is asked. */
function handOnlyOutcome(): void {
  writeFileSync(join(project, 'notes', 'hand2.md'), 'by hand too\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'By hand');
  const head = git(project, 'rev-parse', 'HEAD');
  outcomeRows.put({ threadId: 't1', kind: 'committed', baseCommit: head2, headCommit: head, mergeCommit: null, prUrl: null, at: 12, files: ['notes/hand2.md'] });
  signals.noteOutsideEdit('t1', 'notes/hand2.md', 10);
}

describe('scoring a thread through the package’s pipeline', () => {
  it('labels the hunks, the hand-edited file by rule without the model, and stores labels and scores', async () => {
    const result = await service.request('t1');
    expect(result.status).toBe('scored');
    expect(completions).toHaveLength(1);
    expect(completions[0].initiative).toBe('person');
    // The model saw the ledger and the hunks of the files pi touched or nobody explained; the hand-edited file is decided by the ledger.
    expect(completions[0].prompt.user).toContain('- notes/hand.md: pi never edited it; changed by hand 1 time outside pi');
    expect(completions[0].prompt.user).toMatch(/h1 \| notes\/a\.md \| @@ -0,0 \+1,2 @@/);
    expect(completions[0].prompt.user).not.toMatch(/h\d \| notes\/hand\.md/);

    const view = result.score!;
    expect(view.hunks.map((h) => [h.file, h.label, h.by])).toEqual([
      ['notes/a.md', 'specified', 'model'],
      ['notes/b.md', 'autonomous', 'model'],
      ['notes/hand.md', 'manual', 'ledger'],
    ]);
    // 2 + 1 + 1 changed lines: a.md (2) and hand.md (1) are the person's, b.md (1) is pi's.
    expect(view.scores).toMatchObject({ meat: 75, vibe: 25, hunks: 3, steered: 2, lines: 4, steeredLines: 3 });
    expect(view.scores.line).toBe('75 % steered: 2 of 3 hunks, 1 by the first prompt, 1 by hand');
    expect(view).toMatchObject({ stale: false, model: 'fake/canned', base: baseCommit, head: headCommit, corrected: 0 });
    expect(completions[0].listed).toBe('Attributed the outcome’s hunks to what you did');
    expect(touched).toContain('t1');
  });

  it('a long diff is labelled in several calls, each listed with its place, and every hunk ends up labelled', async () => {
    longOutcome();
    const result = await service.request('t1');
    expect(result.status).toBe('scored');
    expect(completions.length).toBeGreaterThan(1);
    expect(completions.map((c) => c.listed)).toEqual(completions.map((_, index) => `Attributed the outcome’s hunks to what you did (batch ${index + 1} of ${completions.length})`));
    // The fixture already committed c.md after the first outcome, so the extended outcome includes it too.
    const files = ['a.md', 'b.md', 'c.md', 'hand.md', ...Array.from({ length: 30 }, (_, index) => `long-${index}.txt`)].map((file) => `notes/${file}`).sort();
    expect(result.score!.hunks.map((h) => h.file).sort()).toEqual(files);
    expect(result.score!.hunks.filter((h) => h.by === 'model').map((h) => h.file).sort()).toEqual(files.filter((file) => file !== 'notes/hand.md'));
  });

  it('the request’s signal cancels a scoring of several batches: the call in flight hears it, no further batch is sent, nothing is stored, the request is refused', async () => {
    longOutcome();
    const release = holdAnswers();
    const caller = new AbortController();
    const pending = service.request('t1', {}, caller.signal);
    await until(() => completions.length === 1);
    caller.abort();
    // The very signal the request was given is the one the attendant's call carries.
    expect(completions[0].signal?.aborted).toBe(true);
    release();
    await expect(pending).rejects.toThrow(ConflictException);
    await expect(pending).rejects.toThrow(/cancelled/);
    expect(completions).toHaveLength(1);
    expect(outcomeRows.get('t1')).toMatchObject({ scores: null, hunkLabels: null });
  });

  it.each([
    {
      when: 'after the last model reply',
      calls: 1,
      arrange: (caller: AbortController) => {
        const reply = answer;
        // The client goes away in the moment the model answers: no call is left to hear it, only the write.
        answer = (prompt) => {
          caller.abort();
          return reply(prompt);
        };
      },
    },
    {
      when: 'before a scoring whose every hunk is decided by rule',
      calls: 0,
      arrange: (caller: AbortController) => {
        handOnlyOutcome();
        caller.abort();
      },
    },
  ])('a cancellation that lands $when stores nothing and the request is refused', async ({ calls, arrange }) => {
    const caller = new AbortController();
    arrange(caller);
    await expect(service.request('t1', {}, caller.signal)).rejects.toThrow(/cancelled/);
    expect(completions).toHaveLength(calls);
    expect(outcomeRows.get('t1')).toMatchObject({ scores: null, hunkLabels: null });
  });

  it('a thread without an outcome has nothing to score', async () => {
    rows.insertDraft({ id: 't2', sessionPath: join(base, 't2.jsonl'), cwd: project });
    await expect(service.request('t2')).rejects.toThrow(/no outcome/);
    expect(completions).toHaveLength(0);
  });

  it('with the package gone it refuses, and the route that reads answers 404', async () => {
    await service.request('t1');
    installed = false;
    await expect(service.request('t1')).rejects.toThrow(/not installed/);
    expect(() => service.view('t1')).toThrow(/not installed/);
    expect(service.overview()).toEqual({ installed: false, projects: [] });
  });

  it('the model’s failure comes back as a refusal, and nothing is stored', async () => {
    answer = () => ({ ok: false, code: 'cap', error: 'The attendant’s daily cost cap is reached.' });
    await expect(service.request('t1')).rejects.toThrow(/daily cost cap/);
    expect(outcomeRows.get('t1')?.scores).toBeNull();
  });

  it('with the attendant off it asks first: the sentence names the model, nothing is sent, and the agreement is kept for the thread', async () => {
    attendantOn = false;
    const asked = await service.request('t1');
    expect(asked).toEqual({ status: 'consent', model: 'fake/canned', message: scoreConsentSentence('fake/canned') });
    expect(completions).toHaveLength(0);
    const agreed = await service.request('t1', { consent: true });
    expect(agreed.status).toBe('scored');
    expect(completions).toHaveLength(1);
    // Asked once, answered once: the thread is not asked again.
    expect((await service.request('t1')).status).toBe('scored');
  });
});

describe('POST /threads/:id/score over HTTP', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** The real route in front of the service built above, listening on a local port. */
  async function start(): Promise<string> {
    const module = await Test.createTestingModule({ controllers: [ScoreController], providers: [{ provide: ScoreService, useValue: service }] }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    return (await app.getUrl()).replace('[::1]', '127.0.0.1');
  }
  const post = (url: string, signal?: AbortSignal) => fetch(`${url}/threads/t1/score`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal });

  it('a client that closes the connection mid-scoring cancels it: the attendant’s call hears it, no batch follows, nothing is stored', async () => {
    longOutcome();
    const release = holdAnswers();
    const url = await start();
    const requested = vi.spyOn(service, 'request');
    const client = new AbortController();
    const response = post(url, client.signal);
    await until(() => completions.length === 1);
    expect(completions[0].signal?.aborted).toBe(false);
    client.abort();
    await expect(response).rejects.toThrow();
    // The closed connection reaches the scoring.
    await until(() => completions[0].signal?.aborted === true);
    release();
    await expect(requested.mock.results[0].value).rejects.toThrow(ConflictException);
    expect(completions).toHaveLength(1);
    expect(outcomeRows.get('t1')).toMatchObject({ scores: null, hunkLabels: null });
  });

  it('a client that waits is never cancelled: the signal stays quiet through every batch and the score comes back', async () => {
    longOutcome();
    const url = await start();
    const response = await post(url);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe('scored');
    expect(completions.length).toBeGreaterThan(1);
    expect(completions.map((c) => c.signal?.aborted)).toEqual(completions.map(() => false));
    expect(outcomeRows.get('t1')?.scores).not.toBeNull();
  });
});

describe('the attendant’s own scoring after an outcome', () => {
  it('scores, lists the result in the activity, and uses the attendant’s initiative', async () => {
    expect(await service.autoScore('t1')).toBe('scored');
    expect(completions[0].initiative).toBe('attendant');
    expect(notes).toEqual([{ kind: 'score', text: '75 % steered: 2 of 3 hunks, 1 by the first prompt, 1 by hand', status: 'done' }]);
  });

  it('does nothing while the attendant is off or the package is gone', async () => {
    attendantOn = false;
    expect(await service.autoScore('t1')).toBe('skipped');
    attendantOn = true;
    installed = false;
    expect(await service.autoScore('t1')).toBe('skipped');
    expect(completions).toHaveLength(0);
  });

  it('says why in the activity when the outcome changed no text', async () => {
    git(project, 'checkout', '-q', baseCommit);
    outcomeRows.put({ threadId: 't1', kind: 'committed', baseCommit, headCommit: baseCommit, mergeCommit: null, prUrl: null, at: 6, files: [] });
    expect(await service.autoScore('t1')).toBe('skipped');
    expect(notes[0]).toMatchObject({ kind: 'score', status: 'skipped' });
    expect(notes[0].text).toMatch(/no text file/);
  });
});

describe('the person relabels a hunk', () => {
  it('moves the score from the labels as they stand and keeps the correction', async () => {
    await service.request('t1');
    const id = 'notes/b.md@0:1';
    const view = await service.relabel('t1', id, 'specified');
    expect(view.scores).toMatchObject({ meat: 100, steered: 3 });
    expect(view.corrected).toBe(1);
    expect(view.hunks.find((h) => h.id === id)).toMatchObject({ label: 'specified', was: 'autonomous', by: 'person' });
    // Scoring again: the model’s new labels replace its old ones, the person’s correction stays and is shown to the model.
    completions.length = 0;
    await service.request('t1');
    expect(completions[0].prompt.user).toContain('the model said autonomous, the person says specified');
    expect(service.view('t1').hunks.find((h) => h.id === id)).toMatchObject({ label: 'specified', by: 'person' });
    expect(service.view('t1').scores.meat).toBe(100);
    // Taking it back.
    const back = await service.relabel('t1', id, null);
    expect(back.scores.meat).toBe(75);
    expect(back.corrected).toBe(0);
  });

  it('refuses a hunk the outcome does not have, a thread nobody scored, and a missing package', async () => {
    await expect(service.relabel('t1', 'x@1:1', 'manual')).rejects.toThrow(/not been scored/);
    await service.request('t1');
    await expect(service.relabel('t1', 'x@1:1', 'manual')).rejects.toThrow(/no such hunk/);
    installed = false;
    await expect(service.relabel('t1', 'notes/b.md@0:1', 'manual')).rejects.toThrow(/not installed/);
  });
});

describe('what is drawn, and when', () => {
  it('says the labels are out of date when the outcome moved on', async () => {
    await service.request('t1');
    outcomeRows.put({ threadId: 't1', kind: 'committed', baseCommit, headCommit: head2, mergeCommit: null, prUrl: null, at: 9, files: [] });
    expect(service.view('t1').stale).toBe(true);
    expect(service.view('t1').head).toBe(headCommit);
  });

  it('the distribution counts the scored threads of each project', async () => {
    expect(service.overview().projects).toEqual([]);
    await service.request('t1');
    const overview = service.overview();
    expect(overview.installed).toBe(true);
    expect(overview.projects).toHaveLength(1);
    expect(overview.projects[0]).toMatchObject({ cwd: project, scored: 1, mean: 75 });
    expect(overview.projects[0].bins[7]).toBe(1);
  });
});

describe('the plugin events', () => {
  it('baselines: the files pi edited, with when and in which message, and never their content', async () => {
    const reply = await ask(PLUGIN_CHANNELS.baselines);
    expect(reply).toMatchObject({ requestId: 'r1', ok: true });
    const files = reply?.['files'] as { path: string; existed: boolean; turn: number | null; edits: number }[];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'notes/a.md', existed: false, turn: 1, edits: 1 });
    expect(JSON.stringify(files)).not.toContain('content');
  });

  it('outside-edits: the files the watcher saw change by hand', async () => {
    const reply = await ask(PLUGIN_CHANNELS.outsideEdits);
    expect(reply?.['edits']).toEqual([{ path: 'notes/hand.md', firstAt: 10, lastAt: 10, count: 1 }]);
  });

  it('a thread id is enough as its start, and an unknown one is not found', async () => {
    expect((await ask(PLUGIN_CHANNELS.outsideEdits, { thread: 't' }, 'other'))?.ok).toBe(true);
    expect(await ask(PLUGIN_CHANNELS.outsideEdits, { thread: 'nope' })).toMatchObject({ ok: false, code: 'not-found' });
  });

  it.each([1, 2001])('annotate: stores all %s labels and scores, and the thread’s state is told', async (count) => {
    const labels: HunkLabelEntry[] = Array.from({ length: count }, (_, index) => ({ id: `notes/file-${index}.md@0:1`, file: `notes/file-${index}.md`, header: '@@ -0,0 +1,2 @@', label: 'specified', input: 'first-prompt', trace: 'named', lines: 2, by: 'model' }));
    const scores = scoring.computeScores(labels)!;
    const reply = await ask(PLUGIN_CHANNELS.annotate, { base: baseCommit, head: headCommit, model: 'm', labels, scores });
    expect(reply).toEqual({ requestId: 'r1', ok: true });
    expect(outcomeRows.get('t1')).toMatchObject({ scores: { meat: 100 }, hunkLabels: { base: baseCommit, head: headCommit, model: 'm', labels, corrections: {} } });
    expect(touched).toContain('t1');
    expect(service.view('t1').hunks).toHaveLength(count);
  });

  it('annotate: a thread without an outcome, a bad payload, and a label outside the four', async () => {
    rows.insertDraft({ id: 't2', sessionPath: join(base, 't2.jsonl'), cwd: project });
    expect(await ask(PLUGIN_CHANNELS.annotate, { thread: 't2', base: 'a', head: 'b', labels: [] })).toMatchObject({ ok: false, code: 'not-found' });
    expect(await ask(PLUGIN_CHANNELS.annotate, { base: 'a' })).toMatchObject({ ok: false, code: 'invalid' });
    const bad = { id: 'x', file: 'x', header: '@@', label: 'great', input: 'none', trace: '', lines: 1, by: 'model' };
    expect(await ask(PLUGIN_CHANNELS.annotate, { base: 'a', head: 'b', labels: [bad] })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('annotate: null clears; the person’s corrections survive new labels and the score is computed over them', async () => {
    await service.request('t1');
    await service.relabel('t1', 'notes/b.md@0:1', 'specified');
    const fresh = (await service.request('t1')).score!;
    expect(fresh.scores.meat).toBe(100);
    await ask(PLUGIN_CHANNELS.annotate, { base: baseCommit, head: headCommit, labels: null, scores: null });
    expect(outcomeRows.get('t1')).toMatchObject({ scores: null, hunkLabels: null });
  });

  it('returns the complete outcome diff beyond the former two-million-character cutoff', async () => {
    writeFileSync(join(project, 'notes', '000-large.txt'), 'large'.repeat(430_000) + '\n');
    writeFileSync(join(project, 'zz-complete.txt'), 'COMPLETE-OUTCOME-END\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'Large outcome with a final file');
    const head = git(project, 'rev-parse', 'HEAD');
    outcomeRows.put({ threadId: 't1', kind: 'committed', baseCommit, headCommit: head, mergeCommit: null, prUrl: null, at: 10, files: [] });
    const reply = await ask(PLUGIN_CHANNELS.outcome, { diff: true, annotations: true });
    expect(reply).toMatchObject({ ok: true });
    const diff = String(reply?.['diff']);
    expect(diff.length).toBeGreaterThan(2_000_000);
    expect(diff).toContain('+COMPLETE-OUTCOME-END\n');
  });

  it('outcome with annotations is answered here; without them it is learn’s', async () => {
    const plain = await ask(PLUGIN_CHANNELS.outcome, { diff: true });
    expect(plain).toMatchObject({ learn: true });
    const full = await ask(PLUGIN_CHANNELS.outcome, { diff: true, annotations: true });
    expect(full).toMatchObject({ ok: true, outcome: { base: baseCommit, head: headCommit }, annotations: { hunkLabels: null, scores: null } });
    expect(String(full?.['diff'])).toContain('diff --git a/notes/a.md b/notes/a.md');
    await service.request('t1');
    const after = await ask(PLUGIN_CHANNELS.outcome, { annotations: true });
    expect((after?.['annotations'] as { scores: { meat: number } }).scores.meat).toBe(75);
    expect(after).not.toHaveProperty('diff');
  });

  it('attendant:run with the task score is answered here (its consent, its activity kind); any other task is learn’s', async () => {
    expect(await ask(PLUGIN_CHANNELS.attendant, { task: 'learn', system: 's', user: 'u' })).toMatchObject({ learn: true });
    const ok = await ask(PLUGIN_CHANNELS.attendant, { task: 'score', system: 's', user: 'u' });
    expect(ok).toMatchObject({ ok: true, model: 'fake/canned' });
    attendantOn = false;
    const consent = await ask(PLUGIN_CHANNELS.attendant, { task: 'score', system: 's', user: 'u' });
    expect(consent).toMatchObject({ ok: false, code: 'consent', model: 'fake/canned', error: scoreConsentSentence('fake/canned') });
    expect(await ask(PLUGIN_CHANNELS.attendant, { task: 'score', system: 's', user: 'u', consent: true })).toMatchObject({ ok: true });
  });

  it('attendant:run forwards its caller’s cancellation signal to the model owner', async () => {
    const release = holdAnswers();
    const session = new AbortController();
    const pending = service.plugin('t1', PLUGIN_CHANNELS.attendant, { requestId: 'r1', task: 'score', system: 's', user: 'u' }, session.signal);
    try {
      await until(() => completions.length === 1);
      expect(completions[0].signal?.aborted).toBe(false);
      session.abort();
      expect(completions[0].signal?.aborted).toBe(true);
    } finally {
      release();
      await pending;
    }
  });

  it('a request with no requestId is not answered, and an unknown event is invalid', async () => {
    expect(await service.plugin('t1', PLUGIN_CHANNELS.baselines, {})).toBeUndefined();
    expect(await ask('pi-kit:nope')).toMatchObject({ ok: false, code: 'invalid' });
  });
});
