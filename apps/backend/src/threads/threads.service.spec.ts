import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { ThreadsService } from './threads.service';
import { ThreadProtectionTesting } from '../pi/thread-protection.testing';

let base: string;
let project: string;
let scratch: string;
let db: DatabaseService;
let rows: ThreadsRepository;
let meta: MetaRepository;
let service: ThreadsService;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-threads-')));
  project = join(base, 'project');
  scratch = join(base, 'scratch');
  mkdirSync(project);
  mkdirSync(scratch);
  db = new DatabaseService({ dataDir: join(base, 'data') });
  rows = new ThreadsRepository(db);
  meta = new MetaRepository(db);
  const sessionPath = (name: string): string => {
    const path = join(base, `${name}.jsonl`);
    writeFileSync(path, '{}\n');
    return path;
  };
  rows.insertDraft({ id: 'plain', sessionPath: sessionPath('plain'), cwd: project, baseCommit: null });
  rows.insertDraft({
    id: 'replay',
    sessionPath: sessionPath('replay'),
    cwd: scratch,
    baseCommit: null,
    worktree: { path: scratch, branch: 'pi-kit/verify-x', projectCwd: project, base: 'a'.repeat(40) },
  });
  const outcomes = {
    refreshBase: vi.fn(async () => undefined),
    track: vi.fn(async () => undefined),
    headOf: vi.fn(async () => null),
  };
  service = new ThreadsService(
    rows,
    {} as never,
    meta,
    {} as never,
    {} as never,
    {} as never,
    outcomes as never,
    { defaultCwd: project } as never,
    ThreadProtectionTesting.bypass(),
  );
});

afterEach(() => {
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
});

it('admits no run while a thread is deleted, and keeps it Sandboxed and runnable when its worktree cannot be removed', async () => {
  const protection = new ThreadProtectionTesting();
  protection.bindings.set('replay', {
    version: 1,
    mode: 'sandboxed',
    generation: 1,
    experimentalWindowsAccepted: false,
  });
  let refuse!: (error: Error) => void;
  const refused = new ThreadsService(
    rows,
    { lastRun: () => undefined } as never,
    meta,
    { dispose: vi.fn() } as never,
    {} as never,
    { remove: vi.fn(() => new Promise((_, reject) => (refuse = reject))) } as never,
    { refreshBase: vi.fn(async () => undefined), track: vi.fn(async () => undefined) } as never,
    { defaultCwd: project } as never,
    protection.service(),
  );
  const removing = refused.remove('replay', 'remove');
  await vi.waitFor(() => expect(refuse).toBeDefined());
  await expect(refused.prepareRun('replay', project, { open: true })).rejects.toThrow('being deleted');
  refuse(new Error('The worktree has uncommitted changes.'));
  await expect(removing).rejects.toThrow('uncommitted changes');
  expect(protection.bindings.get('replay')?.mode).toBe('sandboxed');
  await expect(refused.prepareRun('replay', project, { open: true })).resolves.toBeDefined();
});

describe('prepareRun and a verification thread', () => {
  it('lets a verification thread run while its scratch worktree is there, in the worktree', async () => {
    meta.markVerificationThread('replay', 'draft-1');
    const target = await service.prepareRun('replay', project);
    expect(target.cwd).toBe(scratch);
    // The replay's session lives in the scratch worktree itself, so pi's cwd needs no forcing (`inWorktree` says the session is elsewhere).
    expect(target.inWorktree).toBe(false);
  });

  it('refuses to run a verification thread whose worktree is gone: it would fall back to the project’s folder', async () => {
    meta.markVerificationThread('replay', 'draft-1');
    rows.clearWorktree('replay');
    await expect(service.prepareRun('replay', project)).rejects.toThrow(/cannot run again/);
    rmSync(scratch, { recursive: true, force: true });
    await expect(service.prepareRun('replay', project)).rejects.toThrow(/cannot run again/);
  });

  it('still opens it to read: the record can be looked at', async () => {
    meta.markVerificationThread('replay', 'draft-1');
    rows.clearWorktree('replay');
    await expect(service.prepareRun('replay', project, { open: true })).resolves.toMatchObject({
      sessionPath: expect.any(String),
    });
  });

  it('does not touch any other thread: a worktree thread whose worktree was deleted carries on in the project, as says', async () => {
    rows.clearWorktree('replay');
    await expect(service.prepareRun('replay', project)).resolves.toMatchObject({ cwd: project });
    await expect(service.prepareRun('plain', project)).resolves.toMatchObject({ cwd: project });
  });
});
