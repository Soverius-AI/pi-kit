import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { MetaRepository } from '../db/meta.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { ThreadsService } from './threads.service';
import { ThreadProtectionTesting } from '../pi/thread-protection.testing';
import { ExternalImportsService } from './external-imports.service';
import * as external from './external-sessions';
import * as files from '../pi/session-files';
import { SessionIndex } from '../pi/session-index';

vi.mock('../pi/load-pi', () => ({ loadPi: () => import('@earendil-works/pi-coding-agent') }));

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
  vi.restoreAllMocks();
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
});

describe('external imports', () => {
  const writeHistory = vi.fn();
  let snapshot: external.ExternalSnapshot;
  let imports: ExternalImportsService;

  beforeEach(() => {
    snapshot = {
      key: external.fingerprint('source'),
      source: 'claude-code',
      nativeId: 'original',
      title: 'Original chat',
      updatedAt: 1,
      fingerprint: external.fingerprint('first'),
      messages: [{ role: 'user', text: 'Original context', timestamp: 1 }],
    };
    vi.spyOn(external, 'discoverExternalSessions').mockImplementation(async () => ({
      sessions: [snapshot],
      unavailable: [],
      skipped: 0,
    }));
    let count = 0;
    writeHistory.mockReset().mockImplementation(async () => {
      const id = `copy-${++count}`;
      const path = join(base, `${id}.jsonl`);
      writeFileSync(path, '{}\n');
      return { id, path, cwd: project };
    });
    service = new ThreadsService(
      rows,
      { lastRun: () => undefined } as never,
      meta,
      { importHistory: writeHistory, dispose: () => undefined, trashSession: () => 'trash' } as never,
      {
        stateOf: () => ({ activity: 'idle', lastRun: null }),
        gone: () => undefined,
        listChanged: () => undefined,
      } as never,
      { describe: () => undefined } as never,
      { headOf: async () => null } as never,
      { defaultCwd: project } as never,
      ThreadProtectionTesting.bypass(),
    );
    vi.spyOn(service, 'reconcile').mockResolvedValue();
    imports = new ExternalImportsService(service, meta, { importHistory: writeHistory } as never);
  });

  it('deduplicates simultaneous and repeated imports while leaving native pi parent paths empty', async () => {
    const request = { key: snapshot.key, fingerprint: snapshot.fingerprint };
    const [first, concurrent] = await Promise.all([
      imports.importSession(project, request),
      imports.importSession(project, request),
    ]);
    expect(concurrent.id).toBe(first.id);
    expect((await imports.importSession(project, request)).id).toBe(first.id);
    expect(writeHistory).toHaveBeenCalledTimes(1);
    expect(rows.get(first.id)?.parentSessionPath).toBeNull();
    expect((await imports.discover(project)).sessions[0]).toMatchObject({
      status: 'imported',
      importedThreadId: first.id,
    });
  });

  it('creates another snapshot for changed history, and rejects a stale review without writing anything', async () => {
    const first = await imports.importSession(project, { key: snapshot.key, fingerprint: snapshot.fingerprint });
    const previous = snapshot.fingerprint;
    snapshot = {
      ...snapshot,
      fingerprint: external.fingerprint('second'),
      messages: [...snapshot.messages, { role: 'assistant', text: 'More source work', timestamp: 2 }],
    };
    expect((await imports.discover(project)).sessions[0].status).toBe('changed');
    await expect(
      imports.importSession(project, { key: snapshot.key, fingerprint: external.fingerprint('stale') }),
    ).rejects.toThrow('changed');
    expect(writeHistory).toHaveBeenCalledTimes(1);
    const second = await imports.importSession(project, { key: snapshot.key, fingerprint: snapshot.fingerprint });
    expect(second.id).not.toBe(first.id);
    expect(rows.get(first.id)).toBeDefined();
    expect((await imports.importSession(project, { key: snapshot.key, fingerprint: previous })).id).toBe(first.id);
    expect(writeHistory).toHaveBeenCalledTimes(2);
  });

  it('offers a deleted copy as new and recreates it on request', async () => {
    const request = { key: snapshot.key, fingerprint: snapshot.fingerprint };
    const first = await imports.importSession(project, request);
    rows.delete(first.id);
    expect((await imports.discover(project)).sessions[0].status).toBe('new');
    const original = snapshot;
    snapshot = { ...snapshot, fingerprint: external.fingerprint('continued') };
    expect((await imports.discover(project)).sessions[0].status).toBe('new');
    snapshot = original;
    expect((await imports.importSession(project, request)).id).not.toBe(first.id);
    expect(writeHistory).toHaveBeenCalledTimes(2);
  });

  it('forgets what a deleted thread imported and keeps the other copies', async () => {
    const first = await imports.importSession(project, { key: snapshot.key, fingerprint: snapshot.fingerprint });
    snapshot = {
      ...snapshot,
      fingerprint: external.fingerprint('second'),
      messages: [...snapshot.messages, { role: 'assistant', text: 'More source work', timestamp: 2 }],
    };
    const second = await imports.importSession(project, { key: snapshot.key, fingerprint: snapshot.fingerprint });
    const owners = () =>
      Object.values(meta.getSetting('imports') as Record<string, Record<string, string>>).flatMap((versions) =>
        Object.values(versions),
      );
    expect(new Set(owners())).toEqual(new Set([first.id, second.id]));
    await service.remove(first.id);
    expect(new Set(owners())).toEqual(new Set([second.id]));
    await service.remove(second.id);
    expect(meta.allSettings()).not.toHaveProperty('imports');
  });

  it('answers a Codex source that changed or cannot be read with a conflict', async () => {
    snapshot = { ...snapshot, source: 'codex', messages: [] };
    vi.spyOn(external, 'loadCodexSnapshot').mockRejectedValue(new Error('Codex session reader timed out.'));
    await expect(
      imports.importSession(project, { key: snapshot.key, fingerprint: snapshot.fingerprint }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(writeHistory).not.toHaveBeenCalled();
  });

  it('reuses identical normalized history after a metadata-only source change', async () => {
    const first = await imports.importSession(project, { key: snapshot.key, fingerprint: snapshot.fingerprint });
    snapshot = { ...snapshot, fingerprint: external.fingerprint('metadata-change') };
    const second = await imports.importSession(project, { key: snapshot.key, fingerprint: snapshot.fingerprint });
    expect(second.id).toBe(first.id);
    expect(writeHistory).toHaveBeenCalledTimes(1);
    expect((await imports.discover(project)).sessions[0].status).toBe('imported');
  });

  it('adopts a real pi file even when reconciliation indexes it before adoption completes', async () => {
    rows.delete('plain');
    rows.delete('replay');
    const index = new SessionIndex(() => join(base, 'pi'));
    const importHistory = (
      cwd: string,
      title: string,
      messages: external.ImportedMessage[],
      origin: Record<string, unknown>,
    ) => files.importHistory(cwd, title, messages, origin, join(base, 'pi', 'project'));
    service = new ThreadsService(
      rows,
      {} as never,
      meta,
      {
        scanSessions: () => index.scan(),
        has: () => false,
        treeSource: (_id: string, path: string) => files.readSession(path),
        modelWindow: async () => undefined,
      } as never,
      { stateOf: () => ({ activity: 'idle', lastRun: null }), listChanged: vi.fn(), touchAll: vi.fn() } as never,
      { describe: () => undefined, sweep: async () => undefined } as never,
      {
        headOf: async () => {
          await service.reconcile();
          return null;
        },
        estimateBases: async () => undefined,
      } as never,
      { defaultCwd: project } as never,
      ThreadProtectionTesting.bypass(),
    );
    imports = new ExternalImportsService(service, meta, { importHistory } as never);
    const request = { key: snapshot.key, fingerprint: snapshot.fingerprint };
    const imported = await imports.importSession(project, request);
    expect(rows.all()).toHaveLength(1);
    expect(rows.get(imported.id)).toMatchObject({
      title: 'Original chat',
      messageCount: 1,
      parentSessionPath: null,
      origin: 'app',
    });
    expect((await imports.importSession(project, request)).id).toBe(imported.id);
    expect((await imports.discover(project)).sessions[0].status).toBe('imported');
  });
});

it('admits no run while or after a thread is deleted, and keeps it Sandboxed and runnable when its worktree cannot be removed', async () => {
  const protection = new ThreadProtectionTesting();
  protection.bindings.set('replay', {
    version: 1,
    mode: 'sandboxed',
    generation: 1,
    experimentalWindowsAccepted: false,
  });
  let refuse!: (error: Error) => void;
  const refreshBase = vi.fn(async () => undefined);
  const refused = new ThreadsService(
    rows,
    { lastRun: () => undefined } as never,
    meta,
    { dispose: vi.fn(), trashSession: vi.fn(() => 'trashed') } as never,
    { listChanged: vi.fn(), gone: vi.fn() } as never,
    { remove: vi.fn(() => new Promise((_, reject) => (refuse = reject))) } as never,
    { refreshBase, track: vi.fn(async () => undefined) } as never,
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

  let based!: () => void;
  refreshBase.mockImplementationOnce(() => new Promise<undefined>((done) => (based = () => done(undefined))));
  const waiting = refused.prepareRun('replay', project, { open: true });
  await vi.waitFor(() => expect(based).toBeDefined());
  await refused.remove('replay', 'keep');
  based();
  await expect(waiting).rejects.toThrow('being deleted');
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

describe('session opening', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };
  let protection: ReturnType<ThreadProtectionTesting['service']>;
  let refreshBase: ReturnType<typeof vi.fn>;
  let open: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    protection = ThreadProtectionTesting.bypass();
    refreshBase = vi.fn(async () => undefined);
    open = vi.fn(async () => ({ threadId: 'plain' }));
    release = vi.spyOn(protection, 'release').mockResolvedValue();
    service = new ThreadsService(
      rows,
      { lastRun: () => undefined } as never,
      meta,
      { open, dispose: vi.fn(), trashSession: () => 'trash', isBusy: () => false } as never,
      { gone: vi.fn(), listChanged: vi.fn() } as never,
      {} as never,
      { refreshBase, track: async () => undefined } as never,
      { defaultCwd: project } as never,
      protection,
    );
  });

  it('shares preparation and session creation for concurrent cold opens, but caches no settled info', async () => {
    const preparation = deferred();
    const opening = deferred();
    refreshBase.mockImplementation(() => preparation.promise);
    open.mockImplementation(async () => {
      await opening.promise;
      return { threadId: 'plain' };
    });
    const first = service.openSession('plain');
    const second = service.openSession('plain');
    expect(refreshBase).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    preparation.resolve();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const third = service.openSession('plain');
    expect(refreshBase).toHaveBeenCalledTimes(1);
    opening.resolve();
    const infos = await Promise.all([first, second, third]);
    expect(infos[0]).toBe(infos[1]);
    expect(infos[0]).toBe(infos[2]);
    await service.openSession('plain');
    expect(refreshBase).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it.each(['preparation', 'opening'])('clears a failed %s so another request can retry', async (phase) => {
    const failure = deferred();
    const mock = phase === 'preparation' ? refreshBase : open;
    mock.mockImplementationOnce(async () => {
      await failure.promise;
      throw new Error('open failed');
    });
    const attempts = Promise.allSettled([service.openSession('plain'), service.openSession('plain')]);
    failure.resolve();
    expect(await attempts).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: 'open failed' }) },
      { status: 'rejected', reason: expect.objectContaining({ message: 'open failed' }) },
    ]);
    await expect(service.openSession('plain')).resolves.toMatchObject({ threadId: 'plain' });
    expect(refreshBase).toHaveBeenCalledTimes(2);
  });

  it('rejects joiners during deletion and prevents a prepared open from resurrecting a deleted draft', async () => {
    const preparation = deferred();
    const deleting = deferred();
    refreshBase.mockImplementation(() => preparation.promise);
    release.mockImplementation(() => deleting.promise);
    const attempts = Promise.allSettled([service.openSession('plain'), service.openSession('plain')]);
    const removal = service.remove('plain');
    await expect(service.openSession('plain')).rejects.toThrow('being deleted');
    deleting.resolve();
    await removal;
    preparation.resolve();
    expect((await attempts).every((result) => result.status === 'rejected')).toBe(true);
    expect(open).not.toHaveBeenCalled();
    await expect(service.openSession('plain')).rejects.toThrow('plain');
  });

  it('does not return shared info if deletion completes while session creation waits', async () => {
    const opening = deferred();
    open.mockImplementation(async () => {
      await opening.promise;
      return { threadId: 'plain' };
    });
    const attempt = service.openSession('plain');
    const result = Promise.allSettled([attempt]);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await service.remove('plain');
    opening.resolve();
    expect((await result)[0]).toMatchObject({ status: 'rejected' });
    expect(rows.get('plain')).toBeUndefined();
  });

  it('admits every joiner and rejects a protection generation change during preparation', async () => {
    const preparation = deferred();
    refreshBase.mockImplementation(() => preparation.promise);
    const attempts = Promise.allSettled([service.openSession('plain'), service.openSession('plain')]);
    const admission = vi.spyOn(protection, 'assertAdmitted').mockImplementation(() => {
      throw new ConflictException('changing protection');
    });
    await expect(service.openSession('plain')).rejects.toThrow('changing protection');
    admission.mockRestore();
    vi.spyOn(protection, 'binding').mockReturnValue({
      version: 1,
      mode: 'bypass',
      generation: 1,
      experimentalWindowsAccepted: false,
    });
    preparation.resolve();
    expect((await attempts).every((result) => result.status === 'rejected')).toBe(true);
    await expect(service.openSession('plain')).resolves.toMatchObject({ threadId: 'plain' });
    // Even an already-open thread must still pass admission.
    vi.spyOn(protection, 'assertAdmitted').mockImplementation(() => {
      throw new ConflictException('changing protection');
    });
    await expect(service.openSession('plain')).rejects.toThrow('changing protection');
    expect(open).toHaveBeenCalledTimes(2);
  });
});
