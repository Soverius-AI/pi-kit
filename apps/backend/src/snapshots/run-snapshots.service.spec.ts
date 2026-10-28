import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { AgentSpansRepository } from '../db/agent-spans.repository';
import { EventLogRepository } from '../db/event-log.repository';
import { type PathBatch, FolderChangesService } from '../folder-changes/folder-changes.service';
import { RunSnapshotsService, START_WAIT_MS } from './run-snapshots.service';

let base: string;
let folder: string;
let db: DatabaseService;
let log: EventLogRepository;
let watch: FolderChangesService;
let snapshots: RunSnapshotsService;
let published: PathBatch[];

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

function start(git: boolean): void {
  folder = join(base, git ? 'repo' : 'plain');
  mkdirSync(folder);
  writeFileSync(join(folder, 'a.ts'), 'one\n');
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: folder });
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'],
      { cwd: folder },
    );
  }
  snapshots = new RunSnapshotsService(log, { get: () => ({ cwd: folder, worktreePath: null }) } as never, watch, {
    dataDir: join(base, 'data'),
  } as never);
  snapshots.onModuleInit();
  watch.subscribe(folder, (batch) => published.push(batch));
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-run-snapshots-')));
  db = new DatabaseService({ dataDir: join(base, 'data') });
  log = new EventLogRepository(db);
  watch = new FolderChangesService();
  published = [];
});
afterEach(() => {
  snapshots.onModuleDestroy();
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
});

describe('RunSnapshotsService', () => {
  it('snapshots the folder around a run and tells the panels which files the run changed', async () => {
    start(true);
    log.beginRun('t1', 'r1');
    await snapshots.whenStarted('t1');
    expect(log.runsOf('t1')[0]).toMatchObject({ folder, startTree: expect.stringMatching(/^[0-9a-f]{40}$/) });
    writeFileSync(join(folder, 'a.ts'), 'two\n');
    writeFileSync(join(folder, 'b.ts'), 'new\n');
    log.endRun('r1', 'finished');
    await until(() => published.length > 0);
    expect(log.runsOf('t1')[0].endTree).toMatch(/^[0-9a-f]{40}$/);
    expect(published).toEqual([{ paths: ['a.ts', 'b.ts'], overflow: false, headMoved: false, at: expect.any(Number) }]);
  });

  it('counts what a background agent changed in the thread’s folder between runs as the thread’s', async () => {
    start(true);
    snapshots.onModuleDestroy();
    const spans = new AgentSpansRepository(db);
    const withAgents = new RunSnapshotsService(
      log,
      { get: () => ({ cwd: folder, worktreePath: null }) } as never,
      watch,
      { dataDir: join(base, 'data') } as never,
      undefined,
      spans,
    );
    withAgents.onModuleInit();
    try {
      log.beginRun('t1', 'r1');
      await withAgents.whenStarted('t1');
      writeFileSync(join(folder, 'by-pi.ts'), 'x\n');
      log.endRun('r1', 'finished');
      await until(() => published.length > 0);
      // The thread is idle; its agent works in the folder.
      await withAgents.agentStarted('agent-1', 't1', folder);
      writeFileSync(join(folder, 'by-agent.ts'), 'x\n');
      // While it works, what it changed so far counts.
      expect((await withAgents.runChanges('t1')).map((c) => c.path)).toEqual(['by-pi.ts', 'by-agent.ts']);
      withAgents.agentEnded('agent-1');
      await until(() => published.length > 1);
      expect(published[1].paths).toEqual(['by-agent.ts']);
      // A hand edit after the agent stopped is nobody's.
      writeFileSync(join(folder, 'by-hand.ts'), 'x\n');
      const changes = await withAgents.runChanges('t1');
      expect(changes.map((c) => ({ path: c.path, run: c.run }))).toEqual([
        { path: 'by-pi.ts', run: 1 },
        { path: 'by-agent.ts', run: undefined },
      ]);
      expect((await withAgents.threadChanges('t1', folder))?.files.map((c) => c.path)).toEqual([
        'by-pi.ts',
        'by-agent.ts',
      ]);
      // More work right after it finished, while its end snapshot is still being taken: a stretch of its own.
      await withAgents.agentStarted('agent-1', 't1', folder);
      withAgents.agentEnded('agent-1');
      await withAgents.agentStarted('agent-1', 't1', folder);
      expect(spans.ofThread('t1').map((span) => span.endTree === null)).toEqual([false, false, true]);
      writeFileSync(join(folder, 'by-agent-again.ts'), 'x\n');
      withAgents.agentEnded('agent-1');
      expect((await withAgents.runChanges('t1')).map((c) => c.path)).toContain('by-agent-again.ts');
    } finally {
      withAgents.onModuleDestroy();
    }
  });

  it('keeps no snapshots outside a git work tree, and a run there ends with a full refresh', async () => {
    start(false);
    log.beginRun('t1', 'r1');
    await snapshots.whenStarted('t1');
    expect(log.runsOf('t1')[0]).toMatchObject({ folder, startTree: null });
    log.endRun('r1', 'finished');
    await until(() => published.length > 0);
    expect(published).toEqual([{ paths: [], overflow: true, headMoved: false, at: expect.any(Number) }]);
    expect(await snapshots.threadChanges('t1', folder)).toBeUndefined();
  });

  it('reads each run in the folder it worked in: a worktree that was merged back and removed keeps what its runs changed', async () => {
    start(true);
    log.beginRun('t1', 'r1');
    await snapshots.whenStarted('t1');
    writeFileSync(join(folder, 'b.ts'), 'new\n');
    log.endRun('r1', 'finished');
    await until(() => published.length > 0);
    // The thread's folder is now another one (the project); the run's folder still has its snapshots.
    const project = join(base, 'project');
    mkdirSync(project);
    expect(await snapshots.threadChanges('t1', project)).toBeUndefined();
    expect(await snapshots.runChanges('t1')).toEqual([
      { path: 'b.ts', before: expect.stringMatching(/^[0-9a-f]{40}$/), run: 1, at: expect.any(Number), status: 'A' },
    ]);
  });

  it('keeps no "before" when the snapshot took longer than the run waited for it', async () => {
    start(true);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const slow = {
        capture: () =>
          new Promise<string>((resolve) => setTimeout(() => resolve('f'.repeat(40)), START_WAIT_MS + 5000)),
      };
      vi.spyOn(snapshots, 'shadow').mockResolvedValue(slow as never);
      log.beginRun('t1', 'r1');
      let started = false;
      void snapshots.whenStarted('t1').then(() => (started = true));
      await vi.advanceTimersByTimeAsync(START_WAIT_MS);
      expect(started).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(log.runsOf('t1')[0]).toMatchObject({ folder, startTree: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves out a run whose snapshot is gone instead of failing', async () => {
    start(true);
    log.beginRun('t1', 'r1');
    await snapshots.whenStarted('t1');
    log.setStartTree('r1', folder, '0'.repeat(40));
    log.endRun('r1', 'finished');
    await until(() => published.length > 0);
    expect((await snapshots.threadChanges('t1', folder))?.files).toEqual([]);
    expect(await snapshots.runChanges('t1')).toEqual([]);
  });

  it('reads a run whose worktree was removed, from where the run said its snapshots are', async () => {
    start(true);
    const worktree = join(base, 'wt');
    execFileSync('git', ['worktree', 'add', '-q', worktree, '-b', 'wt'], { cwd: folder });
    snapshots.onModuleDestroy();
    const wt = new RunSnapshotsService(log, { get: () => ({ cwd: worktree, worktreePath: null }) } as never, watch, {
      dataDir: join(base, 'data'),
    } as never);
    wt.onModuleInit();
    try {
      log.beginRun('w1', 'rw');
      await wt.whenStarted('w1');
      writeFileSync(join(worktree, 'made.ts'), 'x\n');
      log.endRun('rw', 'finished');
      await until(() => log.runsOf('w1')[0]?.endTree != null);
      execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: folder });
      const fresh = new RunSnapshotsService(log, { get: () => undefined } as never, watch, {
        dataDir: join(base, 'data'),
      } as never);
      expect((await fresh.runChanges('w1')).map((c) => c.path)).toEqual(['made.ts']);
    } finally {
      wt.onModuleDestroy();
    }
  });

  it('waits for the end snapshot of a run that just ended before saying what it changed', async () => {
    start(true);
    log.beginRun('t1', 'r1');
    await snapshots.whenStarted('t1');
    writeFileSync(join(folder, 'late.ts'), 'x\n');
    log.endRun('r1', 'finished');
    // Asked at once: the end snapshot is still being taken.
    expect((await snapshots.runChanges('t1')).map((c) => c.path)).toEqual(['late.ts']);
  });

  it('gives paths relative to each folder, also when a root and a subfolder share the same snapshots', async () => {
    start(true);
    mkdirSync(join(folder, 'src'));
    const sub = join(folder, 'src');
    snapshots.onModuleDestroy();
    const both = new RunSnapshotsService(
      log,
      { get: (id: string) => ({ cwd: id === 'root' ? folder : sub, worktreePath: null }) } as never,
      watch,
      { dataDir: join(base, 'data') } as never,
    );
    both.onModuleInit();
    try {
      log.beginRun('root', 'r-root');
      log.beginRun('sub', 'r-sub');
      await both.whenStarted('root');
      await both.whenStarted('sub');
      writeFileSync(join(sub, 'a.ts'), 'x\n');
      log.endRun('r-root', 'finished');
      log.endRun('r-sub', 'finished');
      expect((await both.runChanges('root')).map((c) => c.path)).toEqual(['src/a.ts']);
      expect((await both.runChanges('sub')).map((c) => c.path)).toEqual(['a.ts']);
    } finally {
      both.onModuleDestroy();
    }
  });

  it('takes the folder as the previous run left it as the "before" of a turn pi started by itself', async () => {
    start(true);
    log.beginRun('t1', 'r1');
    await snapshots.whenStarted('t1');
    log.endRun('r1', 'finished');
    await until(() => log.runsOf('t1')[0]?.endTree != null);
    const busy = new RunSnapshotsService(
      log,
      { get: () => ({ cwd: folder, worktreePath: null }) } as never,
      watch,
      { dataDir: join(base, 'data') } as never,
      { has: () => true, isStreaming: () => true } as never,
    );
    snapshots.onModuleDestroy();
    busy.onModuleInit();
    try {
      // pi already wrote this before the run could be followed.
      writeFileSync(join(folder, 'early.ts'), 'x\n');
      log.beginRun('t1', 'r2');
      await busy.whenStarted('t1');
      const [first, second] = log.runsOf('t1');
      expect(second.startTree).toBe(first.endTree);
      log.endRun('r2', 'finished');
      expect((await busy.runChanges('t1')).map((c) => c.path)).toEqual(['early.ts']);
    } finally {
      busy.onModuleDestroy();
    }
  });

  it('snapshots a thread the request itself creates, as soon as its row exists', async () => {
    start(true);
    snapshots.onModuleDestroy();
    let row: { cwd: string; worktreePath: null } | undefined;
    const created = new RunSnapshotsService(log, { get: () => row } as never, watch, {
      dataDir: join(base, 'data'),
    } as never);
    created.onModuleInit();
    try {
      log.beginRun('new', 'r1');
      // The run prepares the thread (its row appears), then waits for the snapshot before pi gets the prompt.
      setTimeout(() => (row = { cwd: folder, worktreePath: null }), 30);
      await created.whenStarted('new');
      expect(log.runsOf('new')[0]?.startTree).toMatch(/^[0-9a-f]{40}$/);
      writeFileSync(join(folder, 'first.ts'), 'x\n');
      log.endRun('r1', 'finished');
      expect((await created.runChanges('new')).map((c) => c.path)).toEqual(['first.ts']);
    } finally {
      created.onModuleDestroy();
    }
  });

  it('gives a turn pi started right after a run the end snapshot that run is still taking as its "before"', async () => {
    start(true);
    snapshots.onModuleDestroy();
    let streaming = false;
    const busy = new RunSnapshotsService(
      log,
      { get: () => ({ cwd: folder, worktreePath: null }) } as never,
      watch,
      { dataDir: join(base, 'data') } as never,
      { has: () => true, isStreaming: () => streaming } as never,
    );
    busy.onModuleInit();
    try {
      log.beginRun('t1', 'r1');
      await busy.whenStarted('t1');
      log.endRun('r1', 'finished');
      // At once: r1's end snapshot is still being taken.
      streaming = true;
      log.beginRun('t1', 'r2');
      await until(() => log.runsOf('t1')[1]?.startTree != null);
      const [first, second] = log.runsOf('t1');
      expect(second.startTree).toBe(first.endTree);
      writeFileSync(join(folder, 'turn.ts'), 'x\n');
      log.endRun('r2', 'finished');
      expect((await busy.runChanges('t1')).map((c) => c.path)).toEqual(['turn.ts']);
    } finally {
      busy.onModuleDestroy();
    }
  });

  it('lets a run start at once when nothing is being snapshotted', async () => {
    start(true);
    await expect(snapshots.whenStarted('nobody')).resolves.toBeUndefined();
  });
});
