import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { EventLogRepository } from '../db/event-log.repository';
import { MetaRepository } from '../db/meta.repository';
import { OutcomesRepository } from '../db/outcomes.repository';
import { type ThreadRow, ThreadsRepository } from '../db/threads.repository';
import type { PiSessionService } from '../pi/pi-session.service';
import type { RunSnapshotsService } from '../snapshots/run-snapshots.service';
import type { FolderChangesService, PathBatch } from '../folder-changes/folder-changes.service';
import { HeadWatcher } from './head-watcher';
import { OutcomesService } from './outcomes.service';
import type { ThreadStatusService } from './thread-status.service';

let base: string;
let repo: string;
let db: DatabaseService;
let threads: ThreadsRepository;
let outcomes: OutcomesRepository;
/** What each thread's runs changed, and when: the snapshots' answer. */
let edited: Map<string, { path: string; at: number }[]>;
let published: PathBatch[];
let events: EventLogRepository;
let service: OutcomesService;
let open: Set<string>;
let touched: string[];

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    encoding: 'utf8',
  }).trim();

function write(folder: string, rel: string, text: string): void {
  mkdirSync(join(folder, rel, '..'), { recursive: true });
  writeFileSync(join(folder, rel), text);
}

/** A commit of `files` (path → text) in `folder`; returns its full hash. */
function commit(folder: string, files: Record<string, string>, message: string, date?: string): string {
  for (const [rel, text] of Object.entries(files)) write(folder, rel, text);
  sh(folder, 'add', '-A');
  execFileSync(
    'git',
    ['-C', folder, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message],
    {
      env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    },
  );
  return sh(folder, 'rev-parse', 'HEAD');
}

/** A thread in `repo`; `edited` are the files its runs changed. */
function addThread(id: string, edited: string[], over: { cwd?: string; messageCount?: number } = {}): ThreadRow {
  const path = join(base, `${id}.jsonl`);
  writeFileSync(path, '{}\n');
  threads.insertDraft({
    id,
    sessionPath: path,
    cwd: over.cwd ?? repo,
    baseCommit: sh(over.cwd ?? repo, 'rev-parse', 'HEAD'),
  });
  editedBy(id, edited);
  return threads.get(id) as ThreadRow;
}

function editedBy(id: string, paths: string[], at = Date.now()): void {
  edited.set(id, [...(edited.get(id) ?? []), ...paths.map((path) => ({ path, at }))]);
}

/** The folder is looked at again (a thread of it opened or ran): a commit made since is found. */
async function commitSeen(folder: string): Promise<void> {
  await service.track(folder);
  await service.idle();
}

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-outcomes-')));
  repo = join(base, 'proj');
  mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  commit(repo, { 'a.ts': 'one\n', 'b.ts': 'one\n', 'c.ts': 'one\n' }, 'init');
  db = new DatabaseService({ dataDir: join(base, 'data') });
  new MetaRepository(db).touchWorkspace(repo);
  threads = new ThreadsRepository(db);
  outcomes = new OutcomesRepository(db);
  edited = new Map();
  published = [];
  events = new EventLogRepository(db);
  open = new Set();
  touched = [];
  const watch = {
    publish: (_cwd: string, batch: PathBatch) => published.push(batch),
  } as unknown as FolderChangesService;
  const snapshots = {
    runChanges: async (id: string) => edited.get(id) ?? [],
  } as unknown as RunSnapshotsService;
  const sessions = { has: (id: string) => open.has(id) } as unknown as PiSessionService;
  const status = { touch: (id: string) => touched.push(id) } as unknown as ThreadStatusService;
  service = new OutcomesService(threads, outcomes, events, sessions, watch, status, snapshots);
  service.onModuleInit();
});

afterEach(() => {
  service.onModuleDestroy();
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
});

describe('the base commit', () => {
  it('is HEAD of the folder when the thread starts, in full', async () => {
    const head = sh(repo, 'rev-parse', 'HEAD');
    expect(await service.headOf(repo)).toBe(head);
    expect(head).toHaveLength(40);
    const row = addThread('t1', []);
    expect(row.baseCommit).toBe(head);
    expect(row.baseSource).toBe('start');
  });

  it('is null outside a repository and before the first commit', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    expect(await service.headOf(plain)).toBeNull();
    const fresh = join(base, 'fresh');
    mkdirSync(fresh);
    sh(fresh, 'init', '-q');
    expect(await service.headOf(fresh)).toBeNull();
    expect(await service.headOf(join(base, 'missing'))).toBeNull();
  });

  it('moves to the folder as it is when the first message is sent, for a thread that waited', async () => {
    const row = addThread('t1', []);
    const later = commit(repo, { 'a.ts': 'two\n' }, 'while the thread waited');
    await service.refreshBase(row);
    expect((threads.get('t1') as ThreadRow).baseCommit).toBe(later);
    // Once it has messages the base stays where it was.
    threads.recordRunEnd('t1', { logMtime: 1, messageCount: 2, preview: 'hi' });
    commit(repo, { 'a.ts': 'three\n' }, 'during the thread');
    await service.refreshBase(threads.get('t1') as ThreadRow);
    expect((threads.get('t1') as ThreadRow).baseCommit).toBe(later);
  });

  it('is estimated once for an old thread: the newest commit before its first message', async () => {
    const early = commit(repo, { 'a.ts': 'two\n' }, 'early', '2026-01-01T10:00:00Z');
    commit(repo, { 'a.ts': 'three\n' }, 'late', '2026-03-01T10:00:00Z');
    // A thread the pi command line made in February: the row has no base and has not been looked at.
    const path = join(base, 'old.jsonl');
    writeFileSync(path, '{}\n');
    threads.upsertFromSession({
      id: 'old',
      sessionPath: path,
      cwd: repo,
      title: undefined,
      preview: 'x',
      parentSessionPath: undefined,
      messageCount: 2,
      createdAt: Date.parse('2026-02-01T00:00:00Z'),
      updatedAt: Date.now(),
    });
    expect(threads.get('old')).toMatchObject({ baseCommit: null, baseSource: null });
    await service.estimateBases();
    expect(threads.get('old')).toMatchObject({ baseCommit: early, baseSource: 'estimated' });
    // Looked at once: a later commit does not move it, and a second pass does nothing.
    commit(repo, { 'a.ts': 'four\n' }, 'newer', '2026-02-02T10:00:00Z');
    await service.estimateBases();
    expect(threads.get('old')?.baseCommit).toBe(early);
  });

  it('is recorded as none for a thread outside a repository, or older than the first commit, and a missing folder waits', async () => {
    const plain = join(base, 'plain');
    mkdirSync(plain);
    const make = (id: string, cwd: string, createdAt: number) => {
      const path = join(base, `${id}.jsonl`);
      writeFileSync(path, '{}\n');
      threads.upsertFromSession({
        id,
        sessionPath: path,
        cwd,
        title: undefined,
        preview: 'x',
        parentSessionPath: undefined,
        messageCount: 1,
        createdAt,
        updatedAt: Date.now(),
      });
    };
    make('plain', plain, Date.now());
    make('ancient', repo, Date.parse('2000-01-01T00:00:00Z'));
    make('gone', join(base, 'unmounted'), Date.now());
    await service.estimateBases();
    expect(threads.get('plain')).toMatchObject({ baseCommit: null, baseSource: 'none' });
    expect(threads.get('ancient')).toMatchObject({ baseCommit: null, baseSource: 'none' });
    expect(threads.get('gone')).toMatchObject({ baseCommit: null, baseSource: null });
  });
});

describe('committed: a commit made in the thread folder', () => {
  it('is the outcome of the thread that changed the committed files, and the state is pushed', async () => {
    addThread('t1', ['a.ts']);
    open.add('t1');
    await service.track(repo);
    const head = commit(repo, { 'a.ts': 'two\n', 'other.ts': 'x\n' }, 'Change a');
    await commitSeen(repo);
    const outcome = outcomes.get('t1');
    expect(outcome).toMatchObject({
      kind: 'committed',
      headCommit: head,
      baseCommit: (threads.get('t1') as ThreadRow).baseCommit,
    });
    expect(outcome?.files).toEqual(['a.ts', 'other.ts']);
    expect(touched).toContain('t1');
    expect(service.get('t1')).toMatchObject({
      kind: 'committed',
      head,
      files: ['a.ts', 'other.ts'],
      baseSource: 'start',
    });
    expect(service.range('t1')).toEqual({ base: (threads.get('t1') as ThreadRow).baseCommit, head });
  });

  it('is nobody’s when the only thread that touched the file is a verification run, and is again when it is not one', async () => {
    addThread('replay', ['a.ts']);
    open.add('replay');
    service.excludeThreads((id) => id === 'replay');
    await service.track(repo);
    commit(repo, { 'a.ts': 'two\n' }, 'Change a');
    await commitSeen(repo);
    expect(outcomes.get('replay')).toBeUndefined();
    expect(service.get('replay')).toBeUndefined();
    service.excludeThreads(undefined);
    commit(repo, { 'a.ts': 'three\n' }, 'Change a again');
    await commitSeen(repo);
    expect(outcomes.get('replay')).toMatchObject({ kind: 'committed' });
  });

  it('tells a listener when an outcome is written, and whether it is the first (the learning package drafts on the first)', async () => {
    addThread('t1', ['a.ts']);
    open.add('t1');
    await service.track(repo);
    const heard: [string, string, boolean][] = [];
    const off = service.onOutcome((threadId, kind, first) => void heard.push([threadId, kind, first]));
    service.onOutcome(() => {
      throw new Error('a listener that fails does not stop the others');
    });
    commit(repo, { 'a.ts': 'two\n' }, 'one');
    await commitSeen(repo);
    commit(repo, { 'a.ts': 'three\n' }, 'two');
    await commitSeen(repo);
    expect(heard).toEqual([
      ['t1', 'committed', true],
      ['t1', 'committed', false],
    ]);
    off();
    commit(repo, { 'a.ts': 'four\n' }, 'three');
    await commitSeen(repo);
    expect(heard).toHaveLength(2);
  });

  it("is nobody's when no thread changed any committed file", async () => {
    addThread('t1', ['a.ts']);
    open.add('t1');
    await service.track(repo);
    commit(repo, { 'c.ts': 'two\n' }, 'Change c');
    await commitSeen(repo);
    expect(outcomes.get('t1')).toBeUndefined();
  });

  it('goes to the thread with the larger overlap, and extends the outcome with a later commit', async () => {
    addThread('few', ['a.ts']);
    addThread('many', ['a.ts', 'b.ts']);
    open.add('few');
    open.add('many');
    await service.track(repo);
    const first = commit(repo, { 'a.ts': 'two\n', 'b.ts': 'two\n' }, 'Change a and b');
    await commitSeen(repo);
    expect(outcomes.get('few')).toBeUndefined();
    expect(outcomes.get('many')).toMatchObject({ headCommit: first });
    const second = commit(repo, { 'b.ts': 'three\n', 'c.ts': 'two\n' }, 'Change b and c');
    await commitSeen(repo);
    const extended = outcomes.get('many');
    expect(extended).toMatchObject({
      kind: 'committed',
      headCommit: second,
      baseCommit: (threads.get('many') as ThreadRow).baseCommit,
    });
    expect(extended?.files).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('breaks a tie by the thread that ran most recently', async () => {
    addThread('older', ['a.ts']);
    addThread('newer', ['a.ts']);
    events.beginRun('older', 'r1');
    events.endRun('r1', 'finished');
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.beginRun('newer', 'r2');
    events.endRun('r2', 'finished');
    open.add('older');
    open.add('newer');
    await service.track(repo);
    commit(repo, { 'a.ts': 'two\n' }, 'Change a');
    await commitSeen(repo);
    expect(outcomes.get('older')).toBeUndefined();
    expect(outcomes.get('newer')).toBeDefined();
  });

  it('only counts a thread that is open or ran last in the folder', async () => {
    addThread('quiet', ['a.ts']);
    addThread('last', ['c.ts']);
    events.beginRun('quiet', 'r1');
    events.endRun('r1', 'finished');
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.beginRun('last', 'r2');
    events.endRun('r2', 'finished');
    await service.track(repo);
    // quiet touched a.ts but neither is it open nor did it run last.
    commit(repo, { 'a.ts': 'two\n' }, 'Change a');
    await commitSeen(repo);
    expect(outcomes.get('quiet')).toBeUndefined();
    // Opened, it counts.
    open.add('quiet');
    commit(repo, { 'a.ts': 'three\n' }, 'Change a again');
    await commitSeen(repo);
    expect(outcomes.get('quiet')).toBeDefined();
  });

  it('does not count a file the thread touched after the commit', async () => {
    addThread('t1', []);
    open.add('t1');
    await service.track(repo);
    commit(repo, { 'a.ts': 'two\n' }, 'Change a', '2026-01-01T10:00:00Z');
    // The thread's baseline of a.ts is from now, years after that commit's date.
    editedBy('t1', ['a.ts']);
    await service.track(repo);
    await service.idle();
    expect(outcomes.get('t1')).toBeUndefined();
  });

  it('is not a checkout, a reset or an uncommitted change, and merged or pr outcomes are not replaced', async () => {
    addThread('t1', ['a.ts']);
    open.add('t1');
    await service.track(repo);
    sh(repo, 'checkout', '-q', '-b', 'feature');
    await service.track(repo);
    await service.idle();
    write(repo, 'a.ts', 'dirty\n');
    await service.track(repo);
    await service.idle();
    expect(outcomes.get('t1')).toBeUndefined();
    // A merge or pull request the thread already has stays.
    outcomes.put({
      threadId: 't1',
      kind: 'pr',
      baseCommit: 'b',
      headCommit: 'h',
      mergeCommit: null,
      prUrl: 'https://example.test/pr/1',
      at: 1,
      files: [],
    });
    commit(repo, { 'a.ts': 'committed\n' }, 'Change a on the branch');
    await service.track(repo);
    await service.idle();
    expect(outcomes.get('t1')).toMatchObject({ kind: 'pr', headCommit: 'h' });
  });

  it('finds several commits that one move of HEAD brought, one by one', async () => {
    addThread('t1', ['a.ts', 'b.ts']);
    open.add('t1');
    await service.track(repo);
    commit(repo, { 'a.ts': 'two\n' }, 'first');
    const last = commit(repo, { 'b.ts': 'two\n' }, 'second');
    await commitSeen(repo);
    expect(outcomes.get('t1')).toMatchObject({ headCommit: last });
    expect(outcomes.get('t1')?.files).toEqual(['a.ts', 'b.ts']);
  });

  it('finds a commit made while nobody looked when a thread of the folder runs, and tells the panels', async () => {
    addThread('t1', ['a.ts']);
    open.add('t1');
    await service.track(join(base, 'missing'));
    events.beginRun('t1', 'r0');
    events.endRun('r0', 'finished');
    await service.idle();
    const head = commit(repo, { 'a.ts': 'two\n' }, 'Change a');
    events.beginRun('t1', 'r1');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.idle();
    expect(outcomes.get('t1')).toMatchObject({ headCommit: head });
    expect(published).toContainEqual(expect.objectContaining({ headMoved: true }));
  });

  it('sees a commit through the one watched reflog of the folder opened last', async () => {
    addThread('t1', ['a.ts']);
    open.add('t1');
    await service.track(repo);
    const head = commit(repo, { 'a.ts': 'two\n' }, 'Change a');
    for (let i = 0; i < 100 && !outcomes.get('t1'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.idle();
    }
    expect(outcomes.get('t1')).toMatchObject({ headCommit: head });
  });

  it('watches no reflog for a worktree or a folder without .git: their threads get their outcome from the merge back', async () => {
    const watch = vi.spyOn(HeadWatcher.prototype, 'watch');
    await service.track(join(base, 'missing'));
    sh(repo, 'worktree', 'add', '-q', join(base, 'wt'), '-b', 'wt-branch');
    await service.track(join(base, 'wt'));
    expect(watch).not.toHaveBeenCalled();
    await service.track(repo);
    expect(watch).toHaveBeenCalledWith(repo);
    watch.mockRestore();
  });

  it('sees the first commit of a repository that was just initialised, and attributes it', async () => {
    const fresh = join(base, 'initialised');
    mkdirSync(fresh);
    sh(fresh, 'init', '-q', '-b', 'main');
    const path = join(base, 'first.jsonl');
    writeFileSync(path, '{}\n');
    threads.insertDraft({ id: 'first', sessionPath: path, cwd: fresh });
    editedBy('first', ['a.ts']);
    open.add('first');
    // Opened before any commit exists: the folder is known without a HEAD.
    await service.track(fresh);
    const root = commit(fresh, { 'a.ts': 'one\n' }, 'first');
    await commitSeen(fresh);
    expect(outcomes.get('first')).toMatchObject({ kind: 'committed', headCommit: root });
  });

  it('watches the folder opened last, even when an earlier one takes longer to look at', async () => {
    const slow = join(base, 'slow');
    mkdirSync(slow);
    sh(slow, 'init', '-q', '-b', 'main');
    await service.track(repo);
    const watched = vi.spyOn(
      (service as unknown as { headWatcher: { watch(folder: string): void } }).headWatcher,
      'watch',
    );
    // The slow one reads its HEAD first; the repository already known is ready at once.
    const first = service.track(slow);
    await service.track(repo);
    await first;
    expect(watched.mock.calls.map(([folder]) => folder)).toEqual([repo]);
  });

  it('names the empty tree as the base of a root commit for a thread without a base', async () => {
    const fresh = join(base, 'fresh');
    mkdirSync(fresh);
    sh(fresh, 'init', '-q', '-b', 'main');
    const path = join(base, 'nb.jsonl');
    writeFileSync(path, '{}\n');
    threads.insertDraft({ id: 'nb', sessionPath: path, cwd: fresh });
    editedBy('nb', ['a.ts']);
    open.add('nb');
    const root = commit(fresh, { 'a.ts': 'one\n' }, 'first');
    await service.attributeCommit(fresh, root);
    expect(outcomes.get('nb')).toMatchObject({
      kind: 'committed',
      headCommit: root,
      baseCommit: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
    });
  });
});

describe('merged and pr', () => {
  it("the merge commit is the outcome, the base is the tip it landed on, and the files are the merge's", async () => {
    const thread = addThread('t1', []);
    const base0 = sh(repo, 'rev-parse', 'HEAD');
    sh(repo, 'checkout', '-q', '-b', 'pi-kit/work');
    commit(repo, { 'new.ts': 'n\n', 'a.ts': 'two\n' }, 'work');
    sh(repo, 'checkout', '-q', 'main');
    sh(repo, 'merge', '--no-ff', '-q', '-m', 'Merge pi-kit/work into main', 'pi-kit/work');
    const merge = sh(repo, 'rev-parse', 'HEAD');
    await service.recordMerged(thread, sh(repo, 'rev-parse', '--short', 'HEAD'));
    expect(outcomes.get('t1')).toMatchObject({
      kind: 'merged',
      baseCommit: base0,
      headCommit: merge,
      mergeCommit: merge,
    });
    expect(outcomes.get('t1')?.files).toEqual(['a.ts', 'new.ts']);
    // The diff the Outcome source shows is exactly git's.
    const range = service.range('t1');
    expect(sh(repo, 'diff', '--name-only', `${range?.base}..${range?.head}`).split('\n').sort()).toEqual([
      'a.ts',
      'new.ts',
    ]);
    // The watcher seeing the merge afterwards does not turn it into somebody's commit.
    open.add('t1');
    await service.track(repo);
    service['heads'].set(repo, base0);
    await commitSeen(repo);
    expect(outcomes.get('t1')).toMatchObject({ kind: 'merged' });
  });

  it('a pull request is the branch tip against where the branch left the base', async () => {
    const thread = { ...addThread('t1', []), baseBranch: 'main' } as ThreadRow;
    const base0 = sh(repo, 'rev-parse', 'HEAD');
    sh(repo, 'checkout', '-q', '-b', 'pi-kit/pr');
    const tip = commit(repo, { 'p.ts': 'p\n' }, 'pr work');
    await service.recordPullRequest(thread, repo, 'https://example.test/pr/7');
    expect(outcomes.get('t1')).toMatchObject({
      kind: 'pr',
      baseCommit: base0,
      headCommit: tip,
      prUrl: 'https://example.test/pr/7',
    });
    expect(outcomes.get('t1')?.files).toEqual(['p.ts']);
  });
});
