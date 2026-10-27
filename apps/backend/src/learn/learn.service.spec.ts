import { PiPluginService } from '../pi/pi-plugin.service';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  PLUGIN_CHANNELS,
  type PiDialogRequest,
  type SkillDraft,
  type SkillVerification,
  parseSkillText,
  provenanceOf,
  verifiedResultOfText,
} from '@pi-kit/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Completion } from '../attendant/attendant.service';
import { AttendantRepository } from '../db/attendant.repository';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { SkillDraftsRepository } from '../db/skill-drafts.repository';
import { ThreadsRepository } from '../db/threads.repository';
import type { LearnPackage } from './learn-package';
import { LearnService, consentSentence } from './learn.service';
import { skillHash } from './verify-rules';

// The backend loads pi through a native `import()` that a test runner's sandbox does not offer; the test loads the same package its own way.
vi.mock('../pi/load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

const CANNED =
  '---\nname: add-a-migration\ndescription: Use when adding a table with its migration\n---\n\n# Add a migration\n\n## Steps\n1. Write the SQL\n2. Run the tests\n';
const HEAD = 'b'.repeat(40);
const BASE = 'a'.repeat(40);
void ({} as PiDialogRequest);

let base: string;
let project: string;
let agent: string;
let db: DatabaseService;
let meta: MetaRepository;
let rows: ThreadsRepository;
let drafts: SkillDraftsRepository;
let attendantRows: AttendantRepository;
let service: LearnService;
let settings: { enabled: boolean };
let completions: string[];
/** The signal each model call was given: the plugin API hands the session's on. */
let signals: (AbortSignal | undefined)[];
let reply: () => Promise<Completion> | Completion;
let reloaded: string[];
let touched: string[];
let outcomeListener: ((threadId: string, kind: string, firstTime: boolean) => void) | undefined;
let listed: { type: string; name: string; label: string; description?: string }[];
let transcriptFacts: { toolCalls: number; changedLines: number };
const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];

const analysis = {
  buildAnalysisPrompt: () => ({ system: 'S', user: 'U' }),
  parseDraftReply: (text: string) =>
    text.startsWith('---')
      ? { ok: true as const, name: 'add-a-migration', description: 'Use when adding a table with its migration', text }
      : { ok: false as const, skip: text.startsWith('SKIP'), reason: text },
};

function addThread(id: string): void {
  const path = join(base, `${id}.jsonl`);
  writeFileSync(path, '{}\n');
  rows.insertDraft({ id, sessionPath: path, cwd: project, baseCommit: BASE });
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-learn-')));
  project = join(base, 'project');
  agent = join(base, 'agent');
  mkdirSync(project);
  mkdirSync(agent);
  process.env['PI_CODING_AGENT_DIR'] = agent;
  db = new DatabaseService({ dataDir: join(base, 'data') });
  meta = new MetaRepository(db);
  meta.touchWorkspace(project);
  rows = new ThreadsRepository(db);
  drafts = new SkillDraftsRepository(db);
  attendantRows = new AttendantRepository(db);
  settings = { enabled: true };
  completions = [];
  signals = [];
  reloaded = [];
  touched = [];
  outcomeListener = undefined;
  listed = [];
  transcriptFacts = { toolCalls: 8, changedLines: 30 };
  reply = () => ({ ok: true, text: CANNED, model: 'fake/canned', inputTokens: 10, outputTokens: 5, cost: 0.001 });
  const attendant = {
    settings: () => settings,
    modelLabel: async () => 'fake/canned',
    allowedIn: () => true,
    enqueueTask: (_id: string, task: () => Promise<void>) => void task(),
    note: vi.fn(),
    complete: async (
      _row: unknown,
      _prompt: unknown,
      options: { describe: (text: string) => unknown; signal?: AbortSignal },
    ) => {
      const done = await reply();
      completions.push(done.ok ? done.text : done.code);
      signals.push(options.signal);
      if (done.ok) options.describe(done.text);
      return done;
    },
  };
  const outcomeFor = (id: string) =>
    id === 'thread-1' || id === 'thread-2'
      ? {
          kind: 'merged',
          base: BASE,
          head: HEAD,
          merge: HEAD,
          prUrl: null,
          at: 1,
          files: ['a'],
          baseBranch: 'main',
          baseSource: 'start',
        }
      : undefined;
  service = new LearnService(
    drafts,
    attendantRows,
    attendant as never,
    rows,
    {
      assertExists: (id: string) => {
        if (!rows.get(id)) throw new Error('missing');
      },
      treeSource: async () => ({ entries: [], leafId: null, path: undefined }),
    } as never,
    {
      get: outcomeFor,
      folderOf: () => project,
      onOutcome: (listener: typeof outcomeListener) => {
        outcomeListener = listener;
        return () => undefined;
      },
    } as never,
    {
      has: () => true,
      stats: () => ({ streaming: false }),
      reload: async (id: string) => void reloaded.push(id),
    } as never,
    { touch: (id: string) => void touched.push(id) } as never,
    { overview: async () => ({ items: listed }) } as never,
    { extraPatterns: () => [] } as never,
    meta,
    { analysis: async () => analysis, ensureInstalled: async () => 'present' } as unknown as LearnPackage,
    new PiPluginService(),
  );
  // The facts the worth rule reads come from the transcript; the unit under test is the rule's use, not git.
  vi.spyOn(service, 'transcriptOf').mockImplementation(async (id: string) => ({
    threadId: id,
    title: null,
    cwd: project,
    prompts:
      id === 'empty'
        ? []
        : ['Add a database migration for the invoices table and write a test for the migration runner'],
    toolCalls: transcriptFacts.toolCalls,
    steps: [],
    errors: [],
    checks: [],
    diff: null,
    changedLines: transcriptFacts.changedLines,
    commitMessage: null,
    base: BASE,
    head: HEAD,
    truncated: false,
    redactions: 0,
  }));
  addThread('thread-1');
  addThread('thread-2');
});

afterEach(() => {
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
  else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
});

const skillsIn = (folder: string): string[] => (existsSync(folder) ? readdirSync(folder) : []);

describe('asking for a draft', () => {
  it('refuses to learn recursively from a learning workspace', async () => {
    meta.markLearningThread('thread-2', 'thread-1');
    await expect(service.request('thread-2')).rejects.toThrow('Choose the original chat');
    expect(completions).toEqual([]);
  });

  it('makes a pending draft with the thread recorded as its origin, and writes no skills folder', async () => {
    const result = await service.request('thread-1');
    expect(result.status).toBe('drafted');
    const draft = result.draft!;
    expect(draft).toMatchObject({
      threadId: 'thread-1',
      name: 'add-a-migration',
      state: 'pending',
      scope: 'project',
      madeBy: 'person',
      model: 'fake/canned',
      decidedAt: null,
      path: null,
    });
    expect(provenanceOf(draft.text)).toEqual({ learnedFrom: 'thread-1', base: BASE, head: HEAD });
    expect(draft.text).toContain('verified: null');
    expect(existsSync(join(project, '.pi'))).toBe(false);
    expect(skillsIn(join(agent, 'skills'))).toEqual([]);
    expect(touched).toContain('thread-1');
  });

  it('opens a learn suggestion for the sidebar chip, with the skill’s name', async () => {
    const { draft } = await service.request('thread-1');
    expect(attendantRows.openSuggestions('thread-1')).toEqual([
      expect.objectContaining({ kind: 'learn', target: draft!.id, text: 'add-a-migration' }),
    ]);
  });

  it('has one draft per thread: asking again returns it and asks the model nothing', async () => {
    const first = await service.request('thread-1');
    const again = await service.request('thread-1');
    expect(again.draft!.id).toBe(first.draft!.id);
    expect(completions).toHaveLength(1);
  });

  it.each([false, true])(
    'shares overlapping automatic and manual draft requests (attendant first: %s)',
    async (attendantFirst) => {
      let finish!: () => void;
      let started!: () => void;
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      let calls = 0;
      reply = () =>
        new Promise<Completion>((resolve) => {
          calls++;
          started();
          finish = () =>
            resolve({ ok: true, text: CANNED, model: 'fake/canned', inputTokens: 10, outputTokens: 5, cost: 0.001 });
        });
      const first = attendantFirst ? service.autoDraft('thread-1') : service.request('thread-1');
      await waiting;
      const second = attendantFirst ? service.request('thread-1') : service.autoDraft('thread-1');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(calls).toBe(1);
      finish();
      const results = await Promise.all([first, second]);
      const manual = results[attendantFirst ? 1 : 0] as Awaited<ReturnType<LearnService['request']>>;
      expect(manual.status).toBe('drafted');
      expect(manual.draft?.id).toBe(drafts.forThread('thread-1')?.id);
      expect(results[attendantFirst ? 0 : 1]).toBe('drafted');
      expect(drafts.pending()).toHaveLength(1);
      expect(completions).toHaveLength(1);
      expect(attendantRows.openSuggestions('thread-1')).toHaveLength(1);
    },
  );

  it('allows another draft attempt after the shared model call rejects', async () => {
    reply = () => Promise.reject(new Error('model disconnected'));
    await expect(service.request('thread-1')).rejects.toThrow('model disconnected');
    reply = () => ({ ok: true, text: CANNED, model: 'fake/canned', inputTokens: 10, outputTokens: 5, cost: 0.001 });
    expect((await service.request('thread-1')).status).toBe('drafted');
  });

  it('asks for consent first while the attendant is off, once, naming the model', async () => {
    settings.enabled = false;
    const asked = await service.request('thread-1');
    expect(asked).toEqual({ status: 'consent', model: 'fake/canned', message: consentSentence('fake/canned') });
    expect(asked.message).toContain('sends the thread’s transcript');
    expect(completions).toHaveLength(0);
    expect(drafts.forThread('thread-1')).toBeUndefined();

    const agreed = await service.request('thread-1', { consent: true });
    expect(agreed.status).toBe('drafted');
    expect(completions).toHaveLength(1);
    // Agreed for the thread: the next draft of it (after it was deleted) is not asked about again.
    db.db.prepare("DELETE FROM skill_drafts WHERE thread_id = 'thread-1'").run();
    expect((await service.request('thread-1')).status).toBe('drafted');
    // Another thread is another decision.
    expect((await service.request('thread-2')).status).toBe('consent');
  });

  it('refuses a thread that has no messages', async () => {
    addThread('empty');
    await expect(service.request('empty')).rejects.toThrow(/no messages yet/);
    expect(completions).toHaveLength(0);
  });

  it('fails with the reason when the model’s answer is not a skill, and keeps nothing', async () => {
    reply = () => ({ ok: true, text: 'I do not know', model: 'fake/canned', inputTokens: 1, outputTokens: 1, cost: 0 });
    await expect(service.request('thread-1')).rejects.toThrow(/not a skill/);
    expect(drafts.forThread('thread-1')).toBeUndefined();
    reply = () => ({
      ok: true,
      text: 'SKIP: too specific',
      model: 'fake/canned',
      inputTokens: 1,
      outputTokens: 1,
      cost: 0,
    });
    await expect(service.request('thread-1')).rejects.toThrow(/Nothing in this thread generalises: SKIP: too specific/);
  });

  it('fails when the cap is reached', async () => {
    reply = () => ({ ok: false, code: 'cap', error: 'The attendant’s daily cost cap is reached.' });
    await expect(service.request('thread-1')).rejects.toThrow(/cap/);
  });
});

describe('the attendant drafting by itself after an outcome', () => {
  it('drafts a thread that looks worth it', async () => {
    expect(await service.autoDraft('thread-1')).toBe('drafted');
    expect(drafts.forThread('thread-1')).toMatchObject({ madeBy: 'attendant', state: 'pending' });
  });

  it('leaves a thread that is too small alone, without a model call, and says so once', async () => {
    transcriptFacts = { toolCalls: 3, changedLines: 30 };
    expect(await service.autoDraft('thread-1')).toBe('not-worth');
    expect(await service.autoDraft('thread-1')).toBe('not-worth');
    expect(completions).toHaveLength(0);
    expect(drafts.forThread('thread-1')).toBeUndefined();
    const note = (service as unknown as { attendant: { note: ReturnType<typeof vi.fn> } }).attendant.note;
    expect(note).toHaveBeenCalledTimes(1);
    expect(note.mock.calls[0][2]).toMatch(/Only 3 tool calls/);
  });

  it('leaves a thread alone when a skill pi has already covers its prompt', async () => {
    listed = [
      {
        type: 'skills',
        name: 'db-migrations',
        label: 'Project',
        description: 'Use when adding a database migration or changing a table schema',
      },
    ];
    expect(await service.autoDraft('thread-1')).toBe('not-worth');
    expect(completions).toHaveLength(0);
  });

  it('does nothing while the attendant is off', async () => {
    settings.enabled = false;
    expect(await service.autoDraft('thread-1')).toBe('skipped');
    expect(completions).toHaveLength(0);
  });

  it('does not draft a thread again after a discard', async () => {
    const { draft } = await service.request('thread-1');
    service.discard(draft!.id);
    expect(await service.autoDraft('thread-1')).toBe('skipped');
    expect(completions).toHaveLength(1);
  });
});

describe('the draft’s state machine: pending, then approved or discarded; a discard can be reopened', () => {
  it('discard writes nothing, records the decision and closes the suggestion', async () => {
    const { draft } = await service.request('thread-1');
    const discarded = service.discard(draft!.id);
    expect(discarded).toMatchObject({ state: 'discarded', path: null });
    expect(discarded.decidedAt).toBeGreaterThan(0);
    expect(existsSync(join(project, '.pi'))).toBe(false);
    expect(skillsIn(join(agent, 'skills'))).toEqual([]);
    expect(attendantRows.openSuggestions('thread-1')).toEqual([]);
    // The thread is not drafted again: asking returns the discarded draft and the model is not asked.
    expect((await service.request('thread-1')).draft).toMatchObject({ id: draft!.id, state: 'discarded' });
    expect(completions).toHaveLength(1);
  });

  it('reopen makes it pending again with a suggestion; approving then works', async () => {
    const { draft } = await service.request('thread-1');
    service.discard(draft!.id);
    const reopened = service.reopen(draft!.id);
    expect(reopened).toMatchObject({ state: 'pending', decidedAt: null });
    expect(attendantRows.openSuggestions('thread-1')).toHaveLength(1);
    const approved = await service.approve(draft!.id, { name: 'add-a-migration', scope: 'project', text: draft!.text });
    expect(approved.draft.state).toBe('approved');
  });

  it('refuses transitions that do not exist', async () => {
    const { draft } = await service.request('thread-1');
    expect(() => service.reopen(draft!.id)).toThrow(/open already/);
    service.discard(draft!.id);
    expect(() => service.discard(draft!.id)).toThrow(/discarded already/);
    await expect(
      service.approve(draft!.id, { name: 'add-a-migration', scope: 'project', text: draft!.text }),
    ).rejects.toThrow(/discarded/);
    service.reopen(draft!.id);
    await service.approve(draft!.id, { name: 'add-a-migration', scope: 'project', text: draft!.text });
    expect(() => service.reopen(draft!.id)).toThrow(/approved/);
    expect(() => service.discard(draft!.id)).toThrow(/approved/);
    await expect(service.approve(draft!.id, { name: 'other', scope: 'project', text: draft!.text })).rejects.toThrow(
      /approved already/,
    );
    expect(() => service.discard('nope')).toThrow(/no such draft/);
  });
});

describe('approve is the only writer of a skills folder', () => {
  it('writes .pi/skills/<name>/SKILL.md for the project scope, with the person’s edits and the provenance', async () => {
    const { draft } = await service.request('thread-1');
    const edited = draft!.text.replace('2. Run the tests', '2. Run the tests twice');
    const approved = await service.approve(draft!.id, {
      name: 'add-a-migration',
      scope: 'project',
      text: edited,
      verify: true,
    });
    const file = join(project, '.pi', 'skills', 'add-a-migration', 'SKILL.md');
    expect(approved.path).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe(approved.draft.text);
    expect(readFileSync(file, 'utf8')).toContain('Run the tests twice');
    expect(provenanceOf(readFileSync(file, 'utf8'))).toEqual({ learnedFrom: 'thread-1', base: BASE, head: HEAD });
    expect(approved.draft).toMatchObject({
      state: 'approved',
      path: file,
      scope: 'project',
      verification: { requested: true, state: 'not-run' },
    });
    expect(attendantRows.openSuggestions('thread-1')).toEqual([]);
    expect(reloaded).toContain('thread-1');
    expect(touched.at(-1)).toBe('thread-1');
  });

  it('writes into the user’s pi folder for the user scope', async () => {
    const { draft } = await service.request('thread-1');
    const approved = await service.approve(draft!.id, { name: 'add-a-migration', scope: 'user', text: draft!.text });
    expect(approved.path).toBe(join(agent, 'skills', 'add-a-migration', 'SKILL.md'));
    expect(existsSync(join(project, '.pi'))).toBe(false);
    expect(approved.draft.scope).toBe('user');
  });

  it('renames the skill when the person changes the name (the frontmatter follows)', async () => {
    const { draft } = await service.request('thread-1');
    const approved = await service.approve(draft!.id, {
      name: 'migrations-with-tests',
      scope: 'project',
      text: draft!.text,
    });
    expect(approved.path).toBe(join(project, '.pi', 'skills', 'migrations-with-tests', 'SKILL.md'));
    expect(parseSkillText(approved.draft.text).name).toBe('migrations-with-tests');
  });

  it('refuses a name that would leave the skills folder, and writes nothing', async () => {
    const { draft } = await service.request('thread-1');
    for (const name of ['../escape', '..', 'a/b', '/etc/passwd', 'a\\b', 'x/../../y', '.hidden', 'UPPER', '']) {
      await expect(
        service.approve(draft!.id, { name: name || ' ', scope: 'project', text: draft!.text }),
        name,
      ).rejects.toThrow();
    }
    expect(existsSync(join(project, '.pi'))).toBe(false);
    expect(existsSync(join(base, 'escape'))).toBe(false);
    expect(skillsIn(join(agent, 'skills'))).toEqual([]);
    expect(drafts.get(draft!.id)?.state).toBe('pending');
  });

  it('asks for another name when the folder is taken, and does not overwrite it', async () => {
    mkdirSync(join(project, '.pi', 'skills', 'add-a-migration'), { recursive: true });
    writeFileSync(join(project, '.pi', 'skills', 'add-a-migration', 'SKILL.md'), 'mine');
    const { draft } = await service.request('thread-1');
    await expect(
      service.approve(draft!.id, { name: 'add-a-migration', scope: 'project', text: draft!.text }),
    ).rejects.toThrow(/already exists.*Choose another name/);
    expect(readFileSync(join(project, '.pi', 'skills', 'add-a-migration', 'SKILL.md'), 'utf8')).toBe('mine');
    expect(drafts.get(draft!.id)?.state).toBe('pending');
    const ok = await service.approve(draft!.id, { name: 'add-a-migration-2', scope: 'project', text: draft!.text });
    expect(ok.draft.state).toBe('approved');
  });

  it('asks for another name when pi already lists a skill of that name from anywhere', async () => {
    listed = [{ type: 'skills', name: 'add-a-migration', label: 'Package @acme/skills' }];
    const { draft } = await service.request('thread-1');
    await expect(
      service.approve(draft!.id, { name: 'add-a-migration', scope: 'project', text: draft!.text }),
    ).rejects.toThrow(/pi already has a skill named add-a-migration \(Package @acme\/skills\)/);
    expect(existsSync(join(project, '.pi'))).toBe(false);
  });

  it('refuses a text pi would not load', async () => {
    const { draft } = await service.request('thread-1');
    await expect(
      service.approve(draft!.id, { name: 'add-a-migration', scope: 'project', text: 'just some text' }),
    ).rejects.toThrow(/frontmatter/);
    await expect(
      service.approve(draft!.id, {
        name: 'add-a-migration',
        scope: 'project',
        text: '---\nname: add-a-migration\n---\nBody',
      }),
    ).rejects.toThrow(/description/);
    await expect(
      service.approve(draft!.id, {
        name: 'add-a-migration',
        scope: 'project',
        text: '---\nname: add-a-migration\ndescription: d\n---\n',
      }),
    ).rejects.toThrow(/instructions/);
    expect(existsSync(join(project, '.pi'))).toBe(false);
  });

  it('re-stamps the provenance if the person deleted or forged it', async () => {
    const { draft } = await service.request('thread-1');
    const forged = draft!.text.replace('learnedFrom: thread-1', 'learnedFrom: somewhere-else');
    const approved = await service.approve(draft!.id, { name: 'add-a-migration', scope: 'project', text: forged });
    expect(provenanceOf(approved.draft.text).learnedFrom).toBe('thread-1');
  });

  it('is the only code in the backend that writes a SKILL.md', () => {
    const root = join(__dirname, '..');
    const writers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.ts$/.test(name) &&
          !/\.spec\.ts$/.test(name) &&
          /writeFileSync|writeFile\(|appendFile/.test(readFileSync(path, 'utf8')) &&
          /SKILL\.md/.test(readFileSync(path, 'utf8'))
        )
          writers.push(path.slice(root.length + 1));
      }
    };
    walk(root);
    // Approval, guarded verification updates, and user-requested installation own skill writes.
    expect(writers.sort()).toEqual(['learn/learn.service.ts', 'learn/skill-files.ts', 'skills/skill-installer.ts']);
  });

  it('every writer is reached only from a user action: no background path imports a writer module or calls approve / save', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/.test(name) && !/\.spec\.ts$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const rel = (path: string) => path.slice(root.length + 1);
    const importersOf = (module: string) =>
      files
        .filter((f) => new RegExp(`from '(\\.|\\.\\.)/(?:[a-z-]+/)?${module}'`).test(readFileSync(f, 'utf8')))
        .map(rel)
        .sort();
    // Restrict writers and the managed deletion module to user-facing entry points.
    expect(importersOf('skill-files')).toEqual([
      'learn/learn.service.ts',
      'learn/learned-skills.service.ts',
      'learn/verify.service.ts',
      'skills/managed-skills.ts',
    ]);
    expect(importersOf('managed-skills')).toEqual(['skills/skills.controller.ts']);
    expect(importersOf('skill-installer')).toEqual(['skills/skills.controller.ts']);
    // The attendant, the plugin host, the outcome watcher and the pi session layer are the background paths: none of them may import a writer or call the two writing methods.
    const background = /^(attendant|plugins|outcomes|pi|agui|watch)\//;
    const touchesAWriter = (text: string) =>
      /skill-files'|managed-skills'|skill-installer'|\.approve\(|\.saveApproved\(/.test(text);
    const offenders = files.filter((f) => background.test(rel(f)) && touchesAWriter(readFileSync(f, 'utf8'))).map(rel);
    expect(offenders, 'a background path reaches a SKILL.md writer').toEqual([]);
    // approve and saveApproved are called from the two user-facing entry points only.
    const callers = files
      .filter(
        (f) => /\.approve\(|\.saveApproved\(/.test(readFileSync(f, 'utf8')) && !/learn\/learn\.service\.ts$/.test(f),
      )
      .map(rel)
      .sort();
    expect(callers).toEqual(['learn/learn.controller.ts', 'learn/learned-skills.service.ts']);
  });
});

describe('the learn suggestion after an outcome', () => {
  beforeEach(() => {
    service.onModuleInit();
  });

  it('proposes learning from a merged thread: a pending draft and the learn suggestion for the sidebar chip', async () => {
    outcomeListener?.('thread-1', 'merged', true);
    await vi.waitFor(() =>
      expect(drafts.forThread('thread-1')).toMatchObject({
        state: 'pending',
        madeBy: 'attendant',
        name: 'add-a-migration',
      }),
    );
    expect(attendantRows.openSuggestions('thread-1')).toEqual([
      expect.objectContaining({ kind: 'learn', text: 'add-a-migration' }),
    ]);
    expect(attendantRows.openSuggestions('thread-2')).toEqual([]);
  });

  it('does not draft a thread again after the person discarded its draft, however often an outcome lands', async () => {
    const { draft } = await service.request('thread-1');
    service.discard(draft!.id);
    outcomeListener?.('thread-1', 'merged', false);
    outcomeListener?.('thread-1', 'pr', false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completions).toHaveLength(1);
    expect(drafts.forThread('thread-1')).toMatchObject({ id: draft!.id, state: 'discarded' });
    expect(attendantRows.openSuggestions('thread-1')).toEqual([]);
  });

  it('does not draft while a draft is pending, approved, or the attendant is off, or for a replay thread', async () => {
    const { draft } = await service.request('thread-1');
    outcomeListener?.('thread-1', 'merged', false);
    await service.approve(draft!.id, { name: 'add-a-migration', scope: 'project', text: draft!.text });
    outcomeListener?.('thread-1', 'committed', false);
    settings.enabled = false;
    outcomeListener?.('thread-2', 'merged', true);
    settings.enabled = true;
    meta.markVerificationThread('thread-2', 'some-draft');
    outcomeListener?.('thread-2', 'merged', true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completions).toHaveLength(1);
    expect(drafts.forThread('thread-2')).toBeUndefined();
  });
});

describe('an approved skill after the fact: edit, retire, restore', () => {
  const skillFile = (name = 'add-a-migration') => join(project, '.pi', 'skills', name, 'SKILL.md');
  const retiredFile = (name = 'add-a-migration') => join(project, '.pi', 'skills', '.retired', name, 'SKILL.md');
  let id: string;
  beforeEach(async () => {
    const { draft } = await service.request('thread-1');
    await service.approve(draft!.id, { name: 'add-a-migration', scope: 'project', text: draft!.text });
    id = draft!.id;
    reloaded.length = 0;
  });

  it('saves the edited text over the file, re-stamps the provenance and reloads the idle sessions', async () => {
    const text = readFileSync(skillFile(), 'utf8');
    const forged = text
      .replace('learnedFrom: thread-1', 'learnedFrom: elsewhere')
      .replace('2. Run the tests', '2. Run the tests twice');
    const saved = await service.saveApproved(id, { text: forged });
    const written = readFileSync(skillFile(), 'utf8');
    expect(written).toBe(saved.text);
    expect(written).toContain('Run the tests twice');
    expect(provenanceOf(written)).toEqual({ learnedFrom: 'thread-1', base: BASE, head: HEAD });
    expect(saved.state).toBe('approved');
    expect(reloaded).toContain('thread-1');
    expect(touched.at(-1)).toBe('thread-1');
  });

  it('keeps the name of the folder whatever the text says, and refuses a text pi would not load', async () => {
    const text = readFileSync(skillFile(), 'utf8');
    const saved = await service.saveApproved(id, {
      text: text.replace('name: add-a-migration', 'name: something-else'),
    });
    expect(parseSkillText(saved.text).name).toBe('add-a-migration');
    expect(existsSync(skillFile('something-else'))).toBe(false);
    await expect(service.saveApproved(id, { text: 'just words' })).rejects.toThrow(BadRequestException);
    await expect(service.saveApproved(id, { text: '---\nname: add-a-migration\n---\nBody' })).rejects.toThrow(
      /description/,
    );
    expect(readFileSync(skillFile(), 'utf8')).toBe(saved.text);
  });

  it('states a verification only for a replay of exactly the saved text', async () => {
    const text = readFileSync(skillFile(), 'utf8');
    const verification: SkillVerification = {
      state: 'done',
      result: 'pass',
      finishedAt: Date.UTC(2026, 9, 17, 10),
      base: BASE,
      skillHash: skillHash(text),
      score: 1,
      files: { reproduced: 2, expected: 2, extra: 0 },
      hunks: { matched: 2, expected: 2, actual: 2 },
    };
    drafts.setVerification(id, verification);
    expect(verifiedResultOfText((await service.saveApproved(id, { text })).text)).toBe('pass');
    const edited = await service.saveApproved(id, { text: text.replace('2. Run the tests', '2. Run the tests twice') });
    expect(verifiedResultOfText(edited.text)).toBeUndefined();
    expect(edited.text).toContain('verified: null');
  });

  it('refuses to save while a replay runs, when the file is gone, and for a skill that is not approved', async () => {
    const text = readFileSync(skillFile(), 'utf8');
    drafts.setVerification(id, { state: 'running' });
    await expect(service.saveApproved(id, { text })).rejects.toThrow(/being verified/);
    drafts.setVerification(id, null);
    const second = await service.request('thread-2');
    await expect(service.saveApproved(second.draft!.id, { text })).rejects.toThrow(/not an approved skill/);
    rmSync(join(project, '.pi', 'skills', 'add-a-migration'), { recursive: true });
    await expect(service.saveApproved(id, { text })).rejects.toThrow(/gone/);
  });

  it('retire moves the folder to .retired, records when, reloads the sessions, and deletes nothing', async () => {
    const before = readFileSync(skillFile(), 'utf8');
    const retired = await service.retire(id);
    expect(retired.state).toBe('approved');
    expect(drafts.retiredAt(id)).toBeGreaterThan(0);
    expect(existsSync(skillFile())).toBe(false);
    expect(readFileSync(retiredFile(), 'utf8')).toBe(before);
    expect(reloaded).toContain('thread-1');
    await expect(service.retire(id)).rejects.toThrow(/retired already/);
    await expect(service.saveApproved(id, { text: before })).rejects.toThrow(/retired/);
  });

  it('retires a user-scope skill into <agent dir>/skills/.retired/', async () => {
    const second = await service.request('thread-2');
    const approved = await service.approve(second.draft!.id, {
      name: 'user-skill',
      scope: 'user',
      text: second.draft!.text.replace('name: add-a-migration', 'name: user-skill'),
    });
    await service.retire(second.draft!.id);
    expect(existsSync(approved.path)).toBe(false);
    expect(existsSync(join(agent, 'skills', '.retired', 'user-skill', 'SKILL.md'))).toBe(true);
  });

  it('restore moves it back; a taken place, a name pi lists now and a skill that is not retired are refused', async () => {
    await expect(service.unretire(id)).rejects.toThrow(/not retired/);
    await service.retire(id);
    mkdirSync(join(project, '.pi', 'skills', 'add-a-migration'), { recursive: true });
    await expect(service.unretire(id)).rejects.toThrow(/exists in the skills folder/);
    rmSync(join(project, '.pi', 'skills', 'add-a-migration'), { recursive: true });
    listed = [{ type: 'skills', name: 'add-a-migration', label: 'Package @acme/skills' }];
    await expect(service.unretire(id)).rejects.toThrow(/collide/);
    listed = [];
    reloaded.length = 0;
    await service.unretire(id);
    expect(drafts.retiredAt(id)).toBeNull();
    expect(existsSync(skillFile())).toBe(true);
    expect(existsSync(retiredFile())).toBe(false);
    expect(reloaded).toContain('thread-1');
  });

  it('does not move a folder that is not the skill pi-kit wrote (a replaced file with another origin)', async () => {
    writeFileSync(
      skillFile(),
      readFileSync(skillFile(), 'utf8').replace('learnedFrom: thread-1', 'learnedFrom: thread-9'),
    );
    await expect(service.retire(id)).rejects.toThrow(/not where pi-kit wrote it/);
    expect(existsSync(skillFile())).toBe(true);
    expect(drafts.retiredAt(id)).toBeNull();
  });

  it('syncApprovedText brings a hand edit of the file into the draft, for a replay', async () => {
    const edited = readFileSync(skillFile(), 'utf8').replace('2. Run the tests', '2. Run the tests by hand');
    writeFileSync(skillFile(), edited);
    expect(service.syncApprovedText(id).text).toBe(edited);
    expect(drafts.get(id)?.text).toBe(edited);
  });
});

describe('verification and the approval', () => {
  const finished = (text: string, over: Partial<SkillVerification> = {}): SkillVerification => ({
    state: 'done',
    result: 'pass',
    finishedAt: Date.UTC(2026, 9, 17, 10, 0, 0),
    base: BASE,
    skillHash: skillHash(text),
    score: 1,
    files: { reproduced: 2, expected: 2, extra: 0 },
    hunks: { matched: 2, expected: 2, actual: 2 },
    ...over,
  });

  it('states the replay in the written file, but only a replay of exactly this text', async () => {
    const { draft } = await service.request('thread-1');
    drafts.setVerification(draft!.id, finished(draft!.text));
    const approved = await service.approve(draft!.id, {
      name: 'add-a-migration',
      scope: 'project',
      text: draft!.text,
      verify: true,
    });
    expect(verifiedResultOfText(readFileSync(approved.path, 'utf8'))).toBe('pass');
    expect(readFileSync(approved.path, 'utf8')).toContain('    files: 2/2\n');
    expect(approved.draft.verification).toMatchObject({ state: 'done', result: 'pass', requested: true });
  });

  it('writes verified: null for a text that was edited after the replay', async () => {
    const { draft } = await service.request('thread-1');
    drafts.setVerification(draft!.id, finished(draft!.text));
    const approved = await service.approve(draft!.id, {
      name: 'add-a-migration',
      scope: 'project',
      text: draft!.text.replace('2. Run the tests', '2. Run the tests twice'),
    });
    expect(readFileSync(approved.path, 'utf8')).toContain('  verified: null');
    expect(verifiedResultOfText(readFileSync(approved.path, 'utf8'))).toBeUndefined();
  });

  it('replaces a verified block the person typed, and one for a replay that never finished', async () => {
    const { draft } = await service.request('thread-1');
    const forged = draft!.text.replace('verified: null', 'verified:\n    result: pass\n    files: 9/9');
    const approved = await service.approve(draft!.id, { name: 'add-a-migration', scope: 'project', text: forged });
    expect(readFileSync(approved.path, 'utf8')).toContain('  verified: null');
    expect(readFileSync(approved.path, 'utf8')).not.toContain('9/9');

    const second = await service.request('thread-2');
    drafts.setVerification(second.draft!.id, finished(second.draft!.text, { state: 'running', result: undefined }));
    const other = await service.approve(second.draft!.id, {
      name: 'second-skill',
      scope: 'user',
      text: second.draft!.text,
    });
    expect(readFileSync(other.path, 'utf8')).toContain('  verified: null');
  });

  it('the Verify first wish is added to a record that exists, and not in its place', async () => {
    const { draft } = await service.request('thread-1');
    drafts.setVerification(draft!.id, finished(draft!.text, { result: 'partial' }));
    const approved = await service.approve(draft!.id, {
      name: 'add-a-migration',
      scope: 'project',
      text: draft!.text,
      verify: true,
    });
    expect(approved.draft.verification).toMatchObject({ requested: true, state: 'done', result: 'partial' });
    const second = await service.request('thread-2');
    const withoutReplay = await service.approve(second.draft!.id, {
      name: 'another',
      scope: 'user',
      text: second.draft!.text,
      verify: true,
    });
    expect(withoutReplay.draft.verification).toEqual({ requested: true, state: 'not-run' });
  });

  it('draws nothing from a replay thread, which has nothing to teach', async () => {
    meta.markVerificationThread('thread-1', 'some-draft');
    await expect(service.request('thread-1')).rejects.toThrow(/replayed a skill/);
    expect(completions).toHaveLength(0);
  });
});

describe('the plugin API (doc/docs/plugins.md)', () => {
  it('answers a transcript request for the session’s own thread, with the draft it already has', async () => {
    const answer = await service.plugin('thread-1', PLUGIN_CHANNELS.transcript, { requestId: 'r1' });
    expect(answer).toMatchObject({
      requestId: 'r1',
      ok: true,
      transcript: { threadId: 'thread-1', toolCalls: 8 },
      draft: null,
    });
    const { draft } = await service.request('thread-1');
    expect(await service.plugin('thread-1', PLUGIN_CHANNELS.transcript, { requestId: 'r2' })).toMatchObject({
      draft: { id: draft!.id, state: 'pending' },
    });
  });

  it('finds another thread by the start of its id', async () => {
    expect(
      await service.plugin('thread-1', PLUGIN_CHANNELS.transcript, { requestId: 'r', thread: 'thread-2' }),
    ).toMatchObject({ ok: true, transcript: { threadId: 'thread-2' } });
    expect(
      await service.plugin('thread-1', PLUGIN_CHANNELS.transcript, { requestId: 'r', thread: 'thread-' }),
    ).toMatchObject({ ok: false, code: 'not-found' });
    expect(
      await service.plugin('thread-1', PLUGIN_CHANNELS.transcript, { requestId: 'r', thread: 'nope' }),
    ).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('returns the outcome of a thread, or null', async () => {
    expect(await service.plugin('thread-1', PLUGIN_CHANNELS.outcome, { requestId: 'r' })).toMatchObject({
      ok: true,
      outcome: { kind: 'merged', base: BASE, head: HEAD },
    });
    addThread('thread-3');
    expect(await service.plugin('thread-3', PLUGIN_CHANNELS.outcome, { requestId: 'r' })).toMatchObject({
      ok: true,
      outcome: null,
    });
  });

  it('runs one model call through the attendant with the session’s signal, and asks for consent first while it is off', async () => {
    const request = { requestId: 'r', task: 'learn', system: 'S', user: 'U' };
    const session = new AbortController();
    const ok = await service.plugin('thread-1', PLUGIN_CHANNELS.attendant, request, session.signal);
    expect(ok).toMatchObject({ ok: true, text: CANNED, model: 'fake/canned', cost: 0.001 });
    // The session's binding itself reaches the model call, so closing the session ends it (the attendant's own contract, proven in its spec).
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBe(session.signal);

    settings.enabled = false;
    const asked = await service.plugin('thread-2', PLUGIN_CHANNELS.attendant, request);
    expect(asked).toEqual({
      requestId: 'r',
      ok: false,
      code: 'consent',
      error: consentSentence('fake/canned'),
      model: 'fake/canned',
    });
    expect(completions).toHaveLength(1);
    expect(await service.plugin('thread-2', PLUGIN_CHANNELS.attendant, { ...request, consent: true })).toMatchObject({
      ok: true,
    });
    expect(completions).toHaveLength(2);
  });

  it('passes on why a call was refused', async () => {
    reply = () => ({ ok: false, code: 'cap', error: 'rests until tomorrow' });
    expect(
      await service.plugin('thread-1', PLUGIN_CHANNELS.attendant, {
        requestId: 'r',
        task: 'learn',
        system: 'S',
        user: 'U',
      }),
    ).toEqual({ requestId: 'r', ok: false, code: 'cap', error: 'rests until tomorrow' });
  });

  it('stores a draft a package hands back as pending, once per thread', async () => {
    const stored = await service.plugin('thread-1', PLUGIN_CHANNELS.draft, {
      requestId: 'r',
      text: CANNED,
      model: 'fake/canned',
    });
    expect(stored).toMatchObject({ ok: true, draft: { name: 'add-a-migration', state: 'pending', madeBy: 'person' } });
    expect(await service.plugin('thread-1', PLUGIN_CHANNELS.draft, { requestId: 'r', text: CANNED })).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    expect(existsSync(join(project, '.pi'))).toBe(false);
  });

  it('refuses a draft that is not a skill', async () => {
    expect(
      await service.plugin('thread-1', PLUGIN_CHANNELS.draft, { requestId: 'r', text: 'no frontmatter here' }),
    ).toMatchObject({ ok: false, code: 'invalid' });
  });

  describe('pi-kit:learn:verified', () => {
    const done: SkillVerification = {
      state: 'done',
      result: 'pass',
      files: { reproduced: 1, expected: 1, extra: 0 },
      hunks: { matched: 1, expected: 1, actual: 1 },
    };
    let started: { id: string; prompt?: string }[];
    beforeEach(() => {
      started = [];
      service.useVerifier({
        start: async (id, body) => {
          started.push({ id, ...(body?.prompt ? { prompt: body.prompt } : {}) });
          return drafts.get(id) as SkillDraft;
        },
        whenDone: async (id) => {
          drafts.setVerification(id, done);
          return done;
        },
      });
    });

    it('starts the replay, waits for it, and answers with the report', async () => {
      const { draft } = await service.request('thread-1');
      const answer = await service.plugin('thread-1', PLUGIN_CHANNELS.verified, {
        requestId: 'r',
        prompt: 'Do it again',
      });
      expect(answer).toMatchObject({
        requestId: 'r',
        ok: true,
        draft: { id: draft!.id, name: 'add-a-migration', state: 'pending' },
        verification: { state: 'done', result: 'pass' },
      });
      expect(started).toEqual([{ id: draft!.id, prompt: 'Do it again' }]);
    });

    it('only reads the last report with start: false', async () => {
      const { draft } = await service.request('thread-1');
      expect(
        await service.plugin('thread-1', PLUGIN_CHANNELS.verified, { requestId: 'r', start: false }),
      ).toMatchObject({ ok: true, verification: null });
      drafts.setVerification(draft!.id, done);
      expect(
        await service.plugin('thread-1', PLUGIN_CHANNELS.verified, { requestId: 'r', start: false }),
      ).toMatchObject({ ok: true, verification: { result: 'pass' } });
      expect(started).toEqual([]);
    });

    it('says so when the thread has no draft, when verification is not there, and why a replay was refused', async () => {
      expect(await service.plugin('thread-1', PLUGIN_CHANNELS.verified, { requestId: 'r' })).toMatchObject({
        ok: false,
        code: 'not-found',
        error: expect.stringContaining('/learn'),
      });
      await service.request('thread-1');
      service.useVerifier(undefined);
      expect(await service.plugin('thread-1', PLUGIN_CHANNELS.verified, { requestId: 'r' })).toMatchObject({
        ok: false,
        code: 'off',
      });
      service.useVerifier({
        start: async () => Promise.reject(new ConflictException('Another skill is being verified.')),
        whenDone: async () => null,
      });
      expect(await service.plugin('thread-1', PLUGIN_CHANNELS.verified, { requestId: 'r' })).toEqual({
        requestId: 'r',
        ok: false,
        code: 'conflict',
        error: 'Another skill is being verified.',
      });
      service.useVerifier({
        start: async () => Promise.reject(new BadRequestException('not a skill')),
        whenDone: async () => null,
      });
      expect(await service.plugin('thread-1', PLUGIN_CHANNELS.verified, { requestId: 'r' })).toMatchObject({
        code: 'invalid',
      });
    });

    it('rejects an unknown field', async () => {
      expect(await service.plugin('thread-1', PLUGIN_CHANNELS.verified, { requestId: 'r', nope: 1 })).toMatchObject({
        ok: false,
        code: 'invalid',
      });
    });
  });

  it('rejects a malformed request with a reason, and answers nothing without a requestId', async () => {
    expect(
      await service.plugin('thread-1', PLUGIN_CHANNELS.attendant, {
        requestId: 'r',
        task: 'other',
        system: 'S',
        user: 'U',
      }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(
      await service.plugin('thread-1', PLUGIN_CHANNELS.draft, { requestId: 'r', text: CANNED, extra: 1 }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    expect(await service.plugin('thread-1', PLUGIN_CHANNELS.transcript, {})).toBeUndefined();
    expect(await service.plugin('thread-1', 'pi-kit:unknown', { requestId: 'r' })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });
});
