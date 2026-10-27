import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { type SkillDraft, type SkillVerification, stampProvenance } from '@pi-kit/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { SkillDraftsRepository } from '../db/skill-drafts.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { VerifyService } from './verify.service';

// The backend loads pi through a native `import()` that a test runner's sandbox does not offer; nothing here needs it, but the modules the service imports might.
vi.mock('../pi/load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
const SKILL = stampProvenance('---\nname: add-notes\ndescription: Use when adding notes\n---\n\n# Steps\n1. Write the notes\n', { learnedFrom: 'origin', base: null, head: null });
const note = (n: number): string => `# Note ${n}\nA short note.\nNote ${n} of 2.\n`;

interface Run {
  threadId: string;
  text: string;
  cwd: string;
  chips: readonly { kind: string; name: string }[];
  /** The pinned skill file as the replay saw it. */
  pinned: string | undefined;
}

let base: string;
let project: string;
let root: string;
let db: DatabaseService;
let drafts: SkillDraftsRepository;
let rows: ThreadsRepository;
let meta: MetaRepository;
let service: VerifyService;
let draft: SkillDraft;
let baseCommit: string;
let headCommit: string;
let runs: Run[];
let simulate: (run: Run) => Promise<{ status: 'finished' | 'aborted' | 'error' | 'interrupted'; error?: string }>;
let trustAnswer: string | undefined;
let cap: boolean;
let setup: string | null;
let used: { provider: string; id: string; name: string } | null;
let checks: { step: number; command: string; passed: boolean }[];
let outcome: { kind: 'merged'; base: string; head: string; merge: string; prUrl: null; at: number; files: string[]; baseBranch: string; baseSource: 'start' | 'estimated' } | undefined;
let archived: string[];
let listed: { type: string; name: string }[];
let sessionCalls: string[];
let entries: PiSessionEntry[];
const treeSource = vi.fn(async () => ({ entries, leafId: null, path: undefined }));
const attendantNote = vi.fn();
const previousAgentDir = process.env['PI_CODING_AGENT_DIR'];

const message = (i: number, body: unknown): PiSessionEntry => ({ type: 'message', id: `m${i}`, parentId: i === 0 ? null : `m${i - 1}`, timestamp: '2026-10-17T10:00:00.000Z', message: body });

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-verify-')));
  project = join(base, 'project');
  root = join(base, 'worktrees');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(base, 'agent'));
  process.env['PI_CODING_AGENT_DIR'] = join(base, 'agent');
  writeFileSync(join(project, 'README.md'), '# p\n');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'init');
  baseCommit = git(project, 'rev-parse', 'HEAD').trim();
  mkdirSync(join(project, 'notes'));
  writeFileSync(join(project, 'notes', 'one.md'), note(1));
  writeFileSync(join(project, 'notes', 'two.md'), note(2));
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'Add two notes');
  headCommit = git(project, 'rev-parse', 'HEAD').trim();
  outcome = { kind: 'merged', base: baseCommit, head: headCommit, merge: headCommit, prUrl: null, at: 1, files: ['notes/one.md', 'notes/two.md'], baseBranch: 'main', baseSource: 'start' };

  db = new DatabaseService({ dataDir: join(base, 'data') });
  meta = new MetaRepository(db);
  meta.touchWorkspace(project);
  rows = new ThreadsRepository(db);
  drafts = new SkillDraftsRepository(db);
  const sessionPath = join(base, 'origin.jsonl');
  writeFileSync(sessionPath, '{}\n');
  rows.insertDraft({ id: 'origin', sessionPath, cwd: project, title: 'Add two notes', baseCommit });
  draft = drafts.insert({ threadId: 'origin', name: 'add-notes', text: SKILL, scope: 'project', madeBy: 'person' });

  runs = [];
  archived = [];
  sessionCalls = [];
  trustAnswer = undefined;
  cap = false;
  setup = null;
  used = { provider: 'p', id: 'm', name: 'M' };
  listed = [];
  checks = [{ step: 3, command: 'test -f notes/one.md', passed: true }];
  entries = [message(0, { role: 'user', content: 'Create notes/one.md and notes/two.md' }), message(1, { role: 'assistant', provider: 'p', model: 'm', content: [] })];
  treeSource.mockReset().mockImplementation(async () => ({ entries, leafId: null, path: undefined }));
  simulate = async (run) => {
    writeFileSync(join(run.cwd, 'x.tmp'), '');
    rmSync(join(run.cwd, 'x.tmp'));
    mkdirSync(join(run.cwd, 'notes'), { recursive: true });
    writeFileSync(join(run.cwd, 'notes', 'one.md'), note(1));
    writeFileSync(join(run.cwd, 'notes', 'two.md'), note(2));
    return { status: 'finished' };
  };

  let n = 0;
  const threads = {
    treeSource,
    create: async (cwd: string, title: string, worktree: { base: string }, _local: unknown, options: { onId?: (id: string) => void }) => {
      const id = `verify-${++n}`;
      options.onId?.(id);
      const path = join(root, 'project', `verify-${n}`);
      mkdirSync(join(root, 'project'), { recursive: true });
      git(cwd, 'worktree', 'add', '-q', path, '-b', `pi-kit/verify-${n}`, worktree.base);
      const sessionFile = join(base, `${id}.jsonl`);
      writeFileSync(sessionFile, '{}\n');
      rows.insertDraft({ id, sessionPath: sessionFile, cwd: path, title, baseCommit: worktree.base, worktree: { path, branch: `pi-kit/verify-${n}`, projectCwd: cwd, base: worktree.base } });
      return { id, worktree: { path, branch: `pi-kit/verify-${n}`, base: worktree.base, exists: true } };
    },
    openSession: async (id: string) => void sessionCalls.push(`open ${id}`),
    patch: async (id: string, patch: { archived?: boolean }) => void (patch.archived && archived.push(id)),
  };
  const worktrees = {
    settingsOf: () => ({ setup }),
    rootOf: () => root,
    remove: async (row: { id: string; worktreePath: string | null; cwd: string }, _request: unknown, branch?: string) => {
      if (row.worktreePath && existsSync(row.worktreePath)) {
        git(row.cwd, 'worktree', 'remove', '--force', row.worktreePath);
        if (branch) git(row.cwd, 'branch', '-D', branch);
      }
      rows.clearWorktree(row.id);
      return { removed: true };
    },
  };
  const sessions = {
    has: () => true,
    isStreaming: () => false,
    stats: () => ({ model: used, tokens: { total: 420 }, cost: 0.0042 }),
    setModel: vi.fn(async (id: string, change: { provider: string; modelId: string }) => void sessionCalls.push(`model ${id} ${change.provider}/${change.modelId}`)),
    abort: vi.fn(async (id: string) => void sessionCalls.push(`abort ${id}`)),
    dispose: vi.fn((id: string) => void sessionCalls.push(`dispose ${id}`)),
    pendingDialogs: () => [{ request: { title: 'Overwrite the file?' } }],
  };
  const agui = {
    runHeadless: async (threadId: string, text: string, options: { cwd: string; chips?: readonly { kind: string; name: string }[] }) => {
      const run: Run = { threadId, text, cwd: options.cwd, chips: options.chips ?? [], pinned: undefined };
      const name = run.chips[0]?.name;
      const file = name ? join(options.cwd, '.pi', 'skills', name, 'SKILL.md') : undefined;
      run.pinned = file && existsSync(file) ? readFileSync(file, 'utf8') : undefined;
      runs.push(run);
      return simulate(run);
    },
  };
  service = new VerifyService(
    drafts,
    rows,
    threads as never,
    worktrees as never,
    { get: () => outcome, excludeThreads: () => undefined } as never,
    sessions as never,
    { trustScratch: async () => trustAnswer, forgetScratch: vi.fn() } as never,
    agui as never,
    { modelLabel: async () => 'p/m', capReached: () => cap, note: attendantNote } as never,
    { overview: async () => ({ items: listed }) } as never,
    meta,
    { touch: vi.fn() } as never,
    { useVerifier: vi.fn(), transcriptOf: async () => ({ checks }) } as never,
  );
  attendantNote.mockClear();
});

afterEach(() => {
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
  else process.env['PI_CODING_AGENT_DIR'] = previousAgentDir;
});

const verify = async (body: Parameters<VerifyService['start']>[1] = {}): Promise<SkillVerification> => {
  await service.start(draft.id, body);
  return (await service.whenDone(draft.id)) as SkillVerification;
};
const scratchFolders = (): string[] => (existsSync(join(root, 'project')) ? execFileSync('ls', [join(root, 'project')], { encoding: 'utf8' }).split('\n').filter(Boolean) : []);

describe('the plan', () => {
  it('says what a replay would do', async () => {
    const plan = await service.plan(draft.id);
    expect(plan).toEqual({
      canVerify: true,
      prompt: 'Create notes/one.md and notes/two.md',
      base: baseCommit,
      head: headCommit,
      files: 2,
      checks: [{ command: 'test -f notes/one.md', originalPassed: true }],
      model: 'p/m',
      busy: false,
    });
  });

  it('says why it cannot start: no outcome, a discarded draft, commits that are gone or no prompt', async () => {
    outcome = undefined;
    expect(await service.plan(draft.id)).toMatchObject({ canVerify: false, reason: expect.stringContaining('no outcome yet') });
    outcome = { kind: 'merged', base: 'f'.repeat(40), head: 'e'.repeat(40), merge: 'e'.repeat(40), prUrl: null, at: 1, files: [], baseBranch: 'main', baseSource: 'start' };
    expect(await service.plan(draft.id)).toMatchObject({ canVerify: false, reason: expect.stringContaining('not in the repository any more') });
    outcome = { ...outcome, base: baseCommit, head: headCommit };
    entries = [message(0, { role: 'assistant', content: [] })];
    expect(await service.plan(draft.id)).toMatchObject({ canVerify: false, reason: expect.stringContaining('no first prompt') });
    entries = [message(0, { role: 'user', content: 'Do it' })];
    expect((await service.plan(draft.id)).model).toBeNull();
    drafts.setState(draft.id, 'discarded');
    expect(await service.plan(draft.id)).toMatchObject({ canVerify: false, reason: expect.stringContaining('Reopen') });
    drafts.setState(draft.id, 'pending');
    await expect(service.plan('nope')).rejects.toThrow(/no such draft/);
  });
});

describe('starting a replay', () => {
  it('reserves a draft before planning awaits so an overlapping start cannot replace its text or launch another replay', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    treeSource.mockImplementation(async () => {
      enter();
      await pending;
      return { entries, leafId: null, path: undefined };
    });
    const first = service.start(draft.id, { text: SKILL.replace('Write the notes', 'Write the first notes') });
    await entered;
    const second = service.start(draft.id, { text: SKILL.replace('Write the notes', 'Write the second notes') });
    const settled = Promise.allSettled([first, second]);
    release();
    const results = await settled;
    try {
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    } finally {
      await service.whenDone(draft.id);
      const started = results.filter((result) => result.status === 'fulfilled').length;
      await vi.waitFor(() => expect(archived).toHaveLength(started));
    }
    expect(runs).toHaveLength(1);
    expect(runs[0].pinned).toContain('Write the first notes');
    expect(drafts.get(draft.id)?.text).toContain('Write the first notes');
  });
});

describe('a replay that reproduces the thread', () => {
  it('is a pass: the files, the hunks, the check, the pinned skill, the model, and the clean-up', async () => {
    const started = await service.start(draft.id, {});
    expect(started.verification).toMatchObject({ state: 'running', phase: 'worktree', base: baseCommit, head: headCommit, prompt: 'Create notes/one.md and notes/two.md', model: 'p/m' });
    const done = (await service.whenDone(draft.id)) as SkillVerification;
    expect(done).toMatchObject({ state: 'done', result: 'pass', score: 1, files: { reproduced: 2, expected: 2, extra: 0 }, hunks: { matched: 2, expected: 2, actual: 2 }, tokens: 420, cost: 0.0042, model: 'p/m', threadId: 'verify-1' });
    expect(done.phase).toBeUndefined();
    expect(done.checks).toEqual([expect.objectContaining({ command: 'test -f notes/one.md', originalPassed: true, state: 'passed', exitCode: 0 })]);
    expect(done.summary).toBe('Reproduced 2 of 2 files and 2 of 2 hunks; 1 of 1 check passes again.');

    // The replay got the thread's prompt and the draft pinned, in the scratch worktree.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ text: 'Create notes/one.md and notes/two.md', chips: [{ kind: 'skill', name: 'add-notes', pinned: true }] });
    expect(runs[0].cwd).toBe(join(root, 'project', 'verify-1'));
    expect(runs[0].pinned).toBe(SKILL);
    expect(sessionCalls.slice(0, 2)).toEqual(['open verify-1', 'model verify-1 p/m']);

    // The record, the text, the thread's mark.
    const stored = drafts.get(draft.id) as SkillDraft;
    expect(stored.verification).toEqual(done);
    expect(stored.text).toContain('verified:\n    result: pass');
    expect(stored.text).toContain('files: 2/2');
    expect(meta.isVerificationThread('verify-1')).toBe(true);
    expect(meta.isVerificationThread('origin')).toBe(false);

    // Afterwards: no worktree, no branch, the thread archived, the main checkout as it was.
    expect(scratchFolders()).toEqual([]);
    expect(git(project, 'branch', '--list', 'pi-kit/verify-*')).toBe('');
    expect(git(project, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(archived).toEqual(['verify-1']);
    expect(rows.get('verify-1')?.worktreePath).toBeNull();
    expect(git(project, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(project, '.pi'))).toBe(false);
    expect(sessionCalls).toContain('dispose verify-1');
  });

  it('counts under the attendant’s cap, with the tokens, when it ran on the attendant’s own model; plainly when it did not', async () => {
    await verify();
    expect(attendantNote).toHaveBeenCalledWith('learn', expect.objectContaining({ id: 'origin' }), expect.stringContaining('Verified the skill add-notes: pass.'), 'done', { model: 'p/m', inputTokens: 420, outputTokens: 0, cost: 0.0042 });
    attendantNote.mockClear();
    used = { provider: 'other', id: 'model', name: 'Other' };
    await verify();
    expect(attendantNote).toHaveBeenCalledWith('learn', expect.anything(), expect.stringContaining('Verified the skill'), 'done');
  });

  it('uses the prompt the person edited, and the text they edited in the dialog (a pending draft)', async () => {
    const edited = SKILL.replace('1. Write the notes', '1. Write the notes carefully');
    const done = await verify({ prompt: 'Write the two notes.', text: edited, name: 'add-notes' });
    expect(runs[0].text).toBe('Write the two notes.');
    expect(runs[0].pinned).toContain('carefully');
    expect(done.prompt).toBe('Write the two notes.');
    expect(drafts.get(draft.id)?.text).toContain('Write the notes carefully');
  });

  it('refuses edits that are not a skill, and edits to a skill that is approved already', async () => {
    await expect(service.start(draft.id, { text: 'no frontmatter' })).rejects.toThrow(/frontmatter/);
    expect(drafts.get(draft.id)?.verification).toBeNull();
    drafts.setState(draft.id, 'approved', { path: join(base, 'skills', 'add-notes', 'SKILL.md') });
    await expect(service.start(draft.id, { text: SKILL })).rejects.toThrow(/approved/);
  });

  it('pins the draft under another name when pi has a skill of that name already', async () => {
    listed = [{ type: 'skills', name: 'add-notes' }];
    await verify();
    expect(runs[0].chips[0].name).toBe('add-notes-replay');
    expect(runs[0].pinned).toContain('name: add-notes-replay');
  });

  it('runs the project’s setup command in the scratch worktree and waits for it', async () => {
    setup = 'echo ready > setup.txt';
    checks = [{ step: 1, command: 'test "$(cat setup.txt)" = ready', passed: true }];
    const done = await verify();
    expect(done.result).toBe('pass');
    expect(done.checks?.[0].state).toBe('passed');
  });

  it('warns when the setup command failed, and when the base commit was only an estimate', async () => {
    setup = 'exit 3';
    outcome = { ...(outcome as NonNullable<typeof outcome>), baseSource: 'estimated' };
    const done = await verify();
    expect(done.warnings).toEqual([expect.stringContaining('estimated'), expect.stringContaining('setup command failed (exit 3)')]);
  });

  it('writes the result into the skill file Approve wrote, only its verified lines', async () => {
    const file = join(base, 'agent', 'skills', 'add-notes', 'SKILL.md');
    mkdirSync(join(base, 'agent', 'skills', 'add-notes'), { recursive: true });
    writeFileSync(file, SKILL);
    drafts.edit(draft.id, {});
    drafts.setState(draft.id, 'approved', { path: file });
    await verify();
    expect(readFileSync(file, 'utf8')).toContain('verified:\n    result: pass');
    expect(readFileSync(file, 'utf8').replace(/verified:[\s\S]*?\n---/, 'verified: null\n---')).toBe(SKILL);
  });
});

describe('a replay that does not', () => {
  it('is partial when one of two files is missing', async () => {
    simulate = async (run) => {
      mkdirSync(join(run.cwd, 'notes'), { recursive: true });
      writeFileSync(join(run.cwd, 'notes', 'one.md'), note(1));
      return { status: 'finished' };
    };
    const done = await verify();
    expect(done).toMatchObject({ state: 'done', result: 'partial', files: { reproduced: 1, expected: 2, extra: 0 }, hunks: { matched: 1, expected: 2, actual: 1 } });
    expect(done.fileList?.map((f) => [f.path, f.status])).toEqual([
      ['notes/one.md', 'same'],
      ['notes/two.md', 'missing'],
    ]);
    expect(drafts.get(draft.id)?.text).toContain('result: partial');
  });

  it('is partial when an earlier check regresses even after more than five later checks pass', async () => {
    checks = [
      { step: 1, command: 'test -f notes/three.md', passed: true },
      ...Array.from({ length: 6 }, (_, i) => ({ step: i + 2, command: `test ${i} -eq ${i}`, passed: true })),
    ];
    const done = await verify();
    expect(done.result).toBe('partial');
    expect(done.checks).toHaveLength(7);
    expect(done.checks?.[0]).toMatchObject({ state: 'failed', exitCode: 1, originalPassed: true });
    expect(done.summary).toContain('6 of 7 checks pass again');
  });

  it('is still a pass when a check failed in the thread and fails again, and says when a check was not run', async () => {
    checks = [
      { step: 1, command: 'test -f notes/three.md', passed: false },
      { step: 2, command: `cd ${project} && npm test`, passed: true },
    ];
    const done = await verify();
    expect(done.result).toBe('pass');
    expect(done.checks).toEqual([
      expect.objectContaining({ command: 'test -f notes/three.md', state: 'failed', originalPassed: false }),
      expect.objectContaining({ command: `cd ${project} && npm test`, state: 'skipped', note: expect.stringContaining('absolute path') }),
    ]);
  });

  it('has failed when it produced something else, and notes the files it should not have touched', async () => {
    simulate = async (run) => {
      writeFileSync(join(run.cwd, 'unrelated.txt'), 'something else\n');
      return { status: 'finished' };
    };
    const done = await verify();
    expect(done).toMatchObject({ result: 'failed', files: { reproduced: 0, expected: 2, extra: 1 }, score: 0 });
    expect(done.summary).toContain('touched 1 file it should not have');
  });

  it('does not count the pinned skill as the replay’s work', async () => {
    const done = await verify();
    expect(runs[0].pinned).toBe(SKILL);
    expect(done.files).toMatchObject({ reproduced: 2, expected: 2, extra: 0 });
    expect(done.fileList?.some((f) => f.path.startsWith('.pi/'))).toBe(false);
  });
});

describe('complete verification evidence', () => {
  it('persists every compared file, including files beyond the former detail limit', async () => {
    const paths = Array.from({ length: 65 }, (_, index) => `notes/evidence-${index}.md`);
    for (const path of paths) writeFileSync(join(project, path), `Evidence ${path}\n`);
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'Keep all comparison evidence');
    headCommit = git(project, 'rev-parse', 'HEAD').trim();
    outcome = { ...outcome!, head: headCommit, merge: headCommit, files: ['notes/one.md', 'notes/two.md', ...paths] };
    const inner = simulate;
    simulate = async (run) => {
      const result = await inner(run);
      for (const path of paths) writeFileSync(join(run.cwd, path), `Evidence ${path}\n`);
      return result;
    };
    const done = await verify();
    expect(done).toMatchObject({ state: 'done', result: 'pass', files: { reproduced: 67, expected: 67, extra: 0 } });
    expect(done.fileList?.map((file) => file.path).sort()).toEqual(['notes/one.md', 'notes/two.md', ...paths].sort());
    expect(drafts.get(draft.id)?.verification?.fileList).toEqual(done.fileList);
  });
});

describe('a replay that cannot be carried out, or is stopped', () => {
  it('keeps a progressing replay running past the former thirty-minute deadline until it completes', async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const inner = simulate;
    simulate = async (run) => {
      enter();
      await pending;
      return inner(run);
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await service.start(draft.id);
      await entered;
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(sessionCalls).not.toContain('abort verify-1');
      expect(drafts.get(draft.id)?.verification).toMatchObject({ state: 'running', phase: 'run' });
    } finally {
      release();
      vi.useRealTimers();
      await service.whenDone(draft.id);
    }
    expect(drafts.get(draft.id)?.verification).toMatchObject({ state: 'done', result: 'pass' });
  });

  it('drains verbose checks without killing them at the former output buffer limit', async () => {
    checks = [{ step: 1, command: `node -e "process.stdout.write('x'.repeat(9*1024*1024)+'\\nCHECK-FINISHED\\n')"`, passed: true }];
    const done = await verify();
    expect(done).toMatchObject({ state: 'done', result: 'pass' });
    expect(done.checks?.[0]).toMatchObject({ state: 'passed', exitCode: 0, output: expect.stringContaining('CHECK-FINISHED') });
  });

  it.skipIf(process.platform === 'win32').each(['Stop', 'app shutdown'])('%s ends a check and its descendant before removing the scratch worktree', async (action) => {
    const child = "require('node:fs').writeFileSync('owned-child.pid',String(process.pid));setInterval(()=>{},1000);";
    const parent = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
    checks = [{ step: 1, command: `node -e '${parent.replaceAll("'", "'\\''")}'`, passed: true }];
    let pid: number | undefined;
    try {
      await service.start(draft.id);
      await vi.waitFor(() => {
        const path = rows.get('verify-1')?.worktreePath;
        expect(path && existsSync(join(path, 'owned-child.pid'))).toBe(true);
        pid = Number(readFileSync(join(path!, 'owned-child.pid'), 'utf8'));
      });
      if (action === 'Stop') service.stop(draft.id);
      else await service.onModuleDestroy();
      expect(await service.whenDone(draft.id)).toMatchObject({ state: 'stopped' });
      let status = '';
      try { status = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { /* no process remains */ }
      expect(!status || status.startsWith('Z'), `check descendant ${pid} remains alive: ${status}`).toBe(true);
      expect(scratchFolders()).toEqual([]);
    } finally {
      if (drafts.get(draft.id)?.verification?.state === 'running') service.stop(draft.id);
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      await service.whenDone(draft.id);
    }
  });

  it('stops short when the project is not trusted, runs nothing and cleans up', async () => {
    trustAnswer = 'The project has pi resources that are not trusted yet.';
    const done = await verify();
    expect(done).toMatchObject({ state: 'error', error: 'The project has pi resources that are not trusted yet.' });
    expect(runs).toHaveLength(0);
    expect(scratchFolders()).toEqual([]);
    expect(archived).toEqual(['verify-1']);
    expect(drafts.get(draft.id)?.text).not.toContain('result:');
  });

  it('says the model failed, with its message, and cleans up', async () => {
    simulate = async () => ({ status: 'error', error: 'connection refused' });
    const done = await verify();
    expect(done).toMatchObject({ state: 'error', error: 'The replay failed: connection refused' });
    expect(scratchFolders()).toEqual([]);
  });

  it('says pi stopped to ask a question nobody can answer', async () => {
    simulate = async () => ({ status: 'interrupted' });
    const done = await verify();
    expect(done.state).toBe('error');
    expect(done.error).toContain('pi stopped to ask a question (“Overwrite the file?”)');
    expect(sessionCalls).toContain('abort verify-1');
  });

  it('refuses to start on the attendant’s model when its daily cap is reached', async () => {
    cap = true;
    const done = await verify();
    expect(done).toMatchObject({ state: 'error', error: expect.stringContaining('daily cost cap') });
    expect(runs).toHaveLength(0);
    expect(scratchFolders()).toEqual([]);
    cap = false;
    used = { provider: 'other', id: 'model', name: 'Other' };
    cap = true;
    expect((await verify()).state).toBe('done');
  });

  it('a run that was aborted is stopped, with nothing compared', async () => {
    simulate = async () => ({ status: 'aborted' });
    const done = await verify();
    expect(done).toMatchObject({ state: 'stopped' });
    expect(done.result).toBeUndefined();
    expect(scratchFolders()).toEqual([]);
    expect(drafts.get(draft.id)?.text).toContain('verified: null');
  });

  it('stop() aborts the run that is going and ends the verification as stopped', async () => {
    let finish: (r: { status: 'aborted' }) => void = () => undefined;
    simulate = () => new Promise((resolve) => (finish = resolve));
    const started = await service.start(draft.id, {});
    expect(started.verification?.state).toBe('running');
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(drafts.get(draft.id)?.verification?.phase).toBe('run');
    await expect(service.start(draft.id, {})).rejects.toThrow(/being verified already/);
    service.stop(draft.id);
    expect(sessionCalls).toContain('abort verify-1');
    finish({ status: 'aborted' });
    expect(await service.whenDone(draft.id)).toMatchObject({ state: 'stopped' });
    expect(() => service.stop(draft.id)).toThrow(/not being verified/);
    expect(scratchFolders()).toEqual([]);
  });

  it('runs valid drafts independently and stopping one leaves the other running', async () => {
    const finish = new Map<string, (status: 'finished' | 'aborted') => void>();
    let released = false;
    const inner = simulate;
    simulate = async (run) => {
      const status = released ? 'finished' : await new Promise<'finished' | 'aborted'>((resolve) => finish.set(run.threadId, resolve));
      return status === 'aborted' ? { status } : inner(run);
    };
    const sessionPath = join(base, 'origin-2.jsonl');
    writeFileSync(sessionPath, '{}\n');
    rows.insertDraft({ id: 'origin-2', sessionPath, cwd: project, title: 'Another notes thread', baseCommit });
    const other = drafts.insert({
      threadId: 'origin-2', name: 'other-skill',
      text: stampProvenance(SKILL.replace('name: add-notes', 'name: other-skill'), { learnedFrom: 'origin-2', base: null, head: null }),
      scope: 'user', madeBy: 'person',
    });
    try {
      await service.start(draft.id);
      expect(await service.plan(other.id)).toMatchObject({ canVerify: true, busy: false });
      await service.start(other.id);
      await vi.waitFor(() => expect(runs).toHaveLength(2));
      expect(runs[0].cwd).not.toBe(runs[1].cwd);
      service.stop(draft.id);
      const first = drafts.get(draft.id)?.verification?.threadId as string;
      const second = drafts.get(other.id)?.verification?.threadId as string;
      expect(sessionCalls).toContain(`abort ${first}`);
      expect(sessionCalls).not.toContain(`abort ${second}`);
      finish.get(first)?.('aborted');
      expect(await service.whenDone(draft.id)).toMatchObject({ state: 'stopped' });
      expect(drafts.get(other.id)?.verification?.state).toBe('running');
      finish.get(second)?.('finished');
      expect(await service.whenDone(other.id)).toMatchObject({ state: 'done', result: 'pass' });
      expect(scratchFolders()).toEqual([]);
    } finally {
      released = true;
      for (const resolve of finish.values()) resolve('finished');
      await Promise.all([service.whenDone(draft.id), service.whenDone(other.id)]);
    }
  });

  it('refuses a draft that was discarded, one without an outcome, and one that does not exist', async () => {
    drafts.setState(draft.id, 'discarded');
    await expect(service.start(draft.id, {})).rejects.toThrow(/Reopen/);
    drafts.setState(draft.id, 'pending');
    outcome = undefined;
    await expect(service.start(draft.id, {})).rejects.toThrow(/no outcome yet/);
    await expect(service.start('nope', {})).rejects.toThrow(/no such draft/);
    expect(drafts.get(draft.id)?.verification).toBeNull();
  });

  it('warns when something changed in the project folder while the replay ran', async () => {
    const inner = simulate;
    simulate = async (run) => {
      writeFileSync(join(project, 'stray.txt'), 'written outside the scratch worktree\n');
      return inner(run);
    };
    const done = await verify();
    expect(done.warnings).toEqual([expect.stringContaining('changed while the replay ran')]);
    // The stray file is the project's, not the replay's: it is not in the comparison.
    expect(done.files).toMatchObject({ reproduced: 2, extra: 0 });
  });
});

describe('after a restart', () => {
  it('a verification that was running ends as an error, and its scratch worktree goes', async () => {
    const path = join(root, 'project', 'verify-left');
    mkdirSync(join(root, 'project'), { recursive: true });
    git(project, 'worktree', 'add', '-q', path, '-b', 'pi-kit/verify-left', baseCommit);
    rows.insertDraft({ id: 'left', sessionPath: join(base, 'left.jsonl'), cwd: path, title: 'Verify: add-notes', baseCommit, worktree: { path, branch: 'pi-kit/verify-left', projectCwd: project, base: baseCommit } });
    drafts.setVerification(draft.id, { state: 'running', phase: 'run', threadId: 'left', startedAt: 1 });
    service.onModuleInit();
    await vi.waitFor(() => expect(drafts.get(draft.id)?.verification?.state).toBe('error'));
    expect(drafts.get(draft.id)?.verification?.error).toContain('closed while the skill was being verified');
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    expect(git(project, 'branch', '--list', 'pi-kit/verify-*')).toBe('');
  });
});
