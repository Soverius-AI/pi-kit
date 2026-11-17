import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEASE_TTL_MS } from '../coordination/leases';
import { DatabaseService } from './database.service';
import { LeasesRepository } from './leases.repository';
import { MetaRepository } from './meta.repository';
import { ThreadsRepository } from './threads.repository';

let dir: string;
let db: DatabaseService;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pk-wtrepo-'));
  db = await DatabaseService.create({ dataDir: dir });
});
afterEach(async () => {
  await db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('file leases', () => {
  it('are taken per thread, folder and file, and renewed by a later edit', async () => {
    const leases = new LeasesRepository(db);
    const first = await leases.take('t1', '/p', 'a.ts', 1_000);
    expect(first).toMatchObject({ since: 1_000, at: 1_000 });
    const again = await leases.take('t1', '/p', 'a.ts', 5_000);
    expect(again).toMatchObject({ since: 1_000, at: 5_000 });
    await leases.take('t2', '/p', 'a.ts', 6_000);
    await leases.take('t1', '/other', 'a.ts', 6_000);
    expect((await leases.activeIn('/p', 7_000)).map((l) => l.threadId).sort()).toEqual(['t1', 't2']);
    expect((await leases.activeOf('t1', 7_000)).map((l) => l.cwd).sort()).toEqual(['/other', '/p']);
  });

  it('expire 30 minutes after the last edit, and a lapsed one starts over', async () => {
    const leases = new LeasesRepository(db);
    await leases.take('t1', '/p', 'a.ts', 1_000);
    expect(await leases.activeIn('/p', 1_000 + LEASE_TTL_MS - 1)).toHaveLength(1);
    expect(await leases.activeIn('/p', 1_000 + LEASE_TTL_MS)).toHaveLength(0);
    const renewed = await leases.take('t1', '/p', 'a.ts', 1_000 + LEASE_TTL_MS + 10);
    expect(renewed.since).toBe(1_000 + LEASE_TTL_MS + 10);
  });

  it('are released with the thread and pruned when expired', async () => {
    const leases = new LeasesRepository(db);
    await leases.take('t1', '/p', 'a.ts', 1_000);
    await leases.take('t2', '/p', 'b.ts', 1_000 + LEASE_TTL_MS);
    expect(await leases.prune(1_000 + LEASE_TTL_MS + 1)).toBe(1);
    await leases.release('t2');
    expect(await leases.activeIn('/p', 1_000 + LEASE_TTL_MS + 1)).toEqual([]);
  });
});

describe('threads in worktrees', () => {
  const facts = { path: '/wt/proj/fix', branch: 'pi-kit/fix', projectCwd: '/proj', base: 'main' };

  it('are listed under their project while their session says the worktree folder', async () => {
    const threads = new ThreadsRepository(db);
    await threads.insertDraft({ id: 'a', sessionPath: '/s/a.jsonl', cwd: '/proj' });
    await threads.insertDraft({ id: 'w', sessionPath: '/s/w.jsonl', cwd: facts.path, worktree: facts });
    const row = await threads.get('w');
    expect(row).toMatchObject({
      cwd: '/proj',
      sessionCwd: facts.path,
      worktreePath: facts.path,
      branch: 'pi-kit/fix',
      baseBranch: 'main',
    });
    expect((await threads.list({ cwd: '/proj' })).map((t) => t.id).sort()).toEqual(['a', 'w']);
    expect(await threads.list({ cwd: facts.path })).toEqual([]);
  });

  it('keep the project when a reconcile pass writes the session file folder', async () => {
    const threads = new ThreadsRepository(db);
    await threads.insertDraft({ id: 'w', sessionPath: '/s/w.jsonl', cwd: facts.path, worktree: facts });
    await threads.upsertFromSession({
      id: 'w',
      sessionPath: '/s/w.jsonl',
      cwd: facts.path,
      title: 'T',
      preview: 'p',
      parentSessionPath: undefined,
      messageCount: 2,
      createdAt: 1,
      updatedAt: 2,
    });
    expect((await threads.get('w'))?.cwd).toBe('/proj');
  });

  it('adopt a session the command line starts in a worktree folder', async () => {
    const threads = new ThreadsRepository(db);
    await threads.insertDraft({ id: 'w', sessionPath: '/s/w.jsonl', cwd: facts.path, worktree: facts });
    await threads.upsertFromSession({
      id: 'cli',
      sessionPath: '/s/cli.jsonl',
      cwd: facts.path,
      title: undefined,
      preview: 'hi',
      parentSessionPath: undefined,
      messageCount: 1,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(await threads.get('cli')).toMatchObject({
      origin: 'cli',
      cwd: '/proj',
      worktreePath: facts.path,
      branch: 'pi-kit/fix',
    });
  });

  it('carry on in the project once the worktree is cleared', async () => {
    const threads = new ThreadsRepository(db);
    await threads.insertDraft({ id: 'w', sessionPath: '/s/w.jsonl', cwd: facts.path, worktree: facts });
    await threads.clearWorktree('w');
    expect(await threads.get('w')).toMatchObject({ cwd: '/proj', worktreePath: null, branch: 'pi-kit/fix' });
    expect(await threads.worktreePaths()).toEqual([]);
  });

  it('make their folder a workspace folder for the panels, and keep per-project settings', async () => {
    const threads = new ThreadsRepository(db);
    const meta = new MetaRepository(db);
    await meta.touchWorkspace('/proj');
    await threads.insertDraft({ id: 'w', sessionPath: '/s/w.jsonl', cwd: facts.path, worktree: facts });
    expect(await meta.isWorktree(facts.path)).toBe(true);
    expect(await meta.isWorktree('/proj')).toBe(false);
    expect(await meta.setWorktreeSettings('/proj', { root: ' /srv/wt ', base: 'develop', setup: '' })).toBe(true);
    expect((await meta.listWorkspaces())[0]).toMatchObject({ worktreeRoot: '/srv/wt', worktreeBase: 'develop' });
    expect(await meta.setWorktreeSettings('/missing', { root: '/x' })).toBe(false);
  });
});
