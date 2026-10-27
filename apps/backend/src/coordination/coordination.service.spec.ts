import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { LeasesRepository } from '../db/leases.repository';
import { ThreadsRepository } from '../db/threads.repository';
import type { PiSessionService, ToolStart } from '../pi/pi-session.service';
import type { ThreadStatusService } from '../threads/thread-status.service';
import { CoordinationService } from './coordination.service';
import { LEASE_TTL_MS } from './leases';

let dir: string;
let db: DatabaseService;
let threads: ThreadsRepository;
let leases: LeasesRepository;
let service: CoordinationService;
let activity: Record<string, 'idle' | 'running' | 'waiting'>;
let open: Set<string>;
const PROJECT = '/proj';

/** A thread of the project with a real session file (its mtime is what "recently active" reads). */
function addThread(id: string, title: string, options: { cwd?: string; messages?: number; modifiedAgoMs?: number; worktree?: { path: string; branch: string }; cli?: boolean } = {}): void {
  const sessionPath = join(dir, `${id}.jsonl`);
  writeFileSync(sessionPath, '{}\n');
  const modified = new Date(Date.now() - (options.modifiedAgoMs ?? 0));
  utimesSync(sessionPath, modified, modified);
  if (options.cli) {
    threads.upsertFromSession({ id, sessionPath, cwd: options.cwd ?? PROJECT, title, preview: 'p', parentSessionPath: undefined, messageCount: options.messages ?? 2, createdAt: 1, updatedAt: 2 });
    return;
  }
  threads.insertDraft({
    id,
    sessionPath,
    cwd: options.worktree?.path ?? options.cwd ?? PROJECT,
    title,
    ...(options.worktree ? { worktree: { path: options.worktree.path, branch: options.worktree.branch, projectCwd: PROJECT, base: 'main' } } : {}),
  });
  threads.recordRunEnd(id, { logMtime: null, messageCount: options.messages ?? 2, preview: undefined });
}

const start = (threadId: string, toolName: string, path: string, cwd = PROJECT): ToolStart => ({ threadId, cwd, toolName, args: { path } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pk-coord-'));
  mkdirSync(dir, { recursive: true });
  db = new DatabaseService({ dataDir: join(dir, 'data') });
  threads = new ThreadsRepository(db);
  leases = new LeasesRepository(db);
  activity = {};
  open = new Set();
  const sessions = { has: (id: string) => open.has(id), onToolStart: () => () => undefined, setCoordination: () => undefined } as unknown as PiSessionService;
  const status = { stateOf: (row: { id: string }) => ({ activity: activity[row.id] ?? 'idle' }) } as unknown as ThreadStatusService;
  service = new CoordinationService(threads, leases, sessions, status);
});
afterEach(() => {
  db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('capture', () => {
  it('takes a lease on edit and write, not on read, and keeps paths relative to the thread folder', () => {
    addThread('a', 'A');
    service.record(start('a', 'edit', '/proj/src/a.ts'));
    service.record(start('a', 'write', 'src/b.ts'));
    service.record(start('a', 'read', 'src/c.ts'));
    service.record(start('a', 'bash', 'src/d.ts'));
    service.record(start('a', 'edit', '/elsewhere/x.ts'));
    expect(leases.activeOf('a').map((l) => l.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('others', () => {
  it('is empty for a thread that is alone, and lists a recently active thread next to it', () => {
    addThread('a', 'A');
    expect(service.others('a')).toEqual([]);
    addThread('b', 'B', { modifiedAgoMs: 60_000 });
    expect(service.others('a')).toMatchObject([{ title: 'B', state: 'idle', relation: 'same-folder', files: [] }]);
  });

  it('leaves out threads that are idle, old and without a lease, empty drafts and archived ones', () => {
    addThread('a', 'A');
    addThread('old', 'Old', { modifiedAgoMs: LEASE_TTL_MS + 60_000 });
    addThread('draft', 'Draft', { messages: 0 });
    addThread('gone', 'Gone');
    threads.update('gone', { archived: true });
    addThread('elsewhere', 'Elsewhere', { cwd: '/another/project' });
    expect(service.others('a')).toEqual([]);
  });

  it('lists a running thread and the files it edited in the last 30 minutes, newest first', () => {
    addThread('a', 'A');
    addThread('b', 'B', { modifiedAgoMs: LEASE_TTL_MS * 2 });
    activity['b'] = 'running';
    const now = Date.now();
    leases.take('b', PROJECT, 'src/old.ts', now - LEASE_TTL_MS - 1000);
    leases.take('b', PROJECT, 'src/x.ts', now - 120_000);
    leases.take('b', PROJECT, 'src/y.ts', now - 5_000);
    const [other] = service.others('a');
    expect(other.state).toBe('running');
    expect(other.files.map((f) => f.path)).toEqual(['src/y.ts', 'src/x.ts']);
  });

  it('knows a thread in a worktree of the project as such, with its branch, and a command-line session in the same folder', () => {
    addThread('a', 'A');
    addThread('w', 'W', { worktree: { path: '/wt/proj/w', branch: 'pi-kit/w' }, modifiedAgoMs: 1000 });
    addThread('cli', 'In a terminal', { cli: true, modifiedAgoMs: 30_000 });
    const found = service.others('a');
    expect(found.find((o) => o.title === 'W')).toMatchObject({ relation: 'worktree', branch: 'pi-kit/w', state: 'idle' });
    expect(found.find((o) => o.title === 'In a terminal')).toMatchObject({ state: 'terminal', relation: 'same-folder', files: [] });
    expect(service.othersInfo('a').map((o) => o.state).sort()).toEqual(['idle', 'terminal']);
  });

  it('does not call a command-line session in another folder of the repository "next to" a thread; a thread open in the app is not one', () => {
    addThread('w', 'W', { worktree: { path: '/wt/proj/w', branch: 'pi-kit/w' } });
    addThread('cli', 'In a terminal', { cli: true, modifiedAgoMs: 1000 });
    expect(service.others('w').map((o) => o.title)).not.toContain('In a terminal');
    addThread('a', 'A');
    open.add('cli');
    expect(service.others('a').map((o) => o.state)).not.toContain('terminal');
  });
});

describe('the section and the notices', () => {
  it('builds the section from the others and is undefined when alone', () => {
    addThread('a', 'A');
    expect(service.section('a')).toBeUndefined();
    addThread('b', 'Fix e2e');
    leases.take('b', PROJECT, 'src/a.ts');
    expect(service.section('a')).toMatch(/^Other agents in this workspace[\s\S]*"Fix e2e" \(idle, this same folder\): edited src\/a\.ts[\s\S]*Rules:/);
  });

  it('tells a thread once that another changed a file it read, and again only after another change', () => {
    addThread('a', 'A');
    addThread('b', 'Reporting adapter');
    const t0 = Date.now();
    service.record(start('a', 'read', 'src/map.ts'), t0 - 10_000);
    expect(service.notices('a')).toEqual([]);
    service.record(start('b', 'edit', 'src/map.ts'), t0 - 5_000);
    expect(service.notices('a')).toEqual(['*Reporting adapter* changed `src/map.ts` since you last read it.']);
    expect(service.notices('a')).toEqual([]);
    service.record(start('b', 'edit', 'src/map.ts'), t0);
    expect(service.notices('a')).toHaveLength(1);
    // Reading the file again settles it: a change before the read is not news.
    service.record(start('a', 'read', 'src/map.ts'), t0 + 1000);
    service.record(start('b', 'edit', 'src/map.ts'), t0 + 500);
    expect(service.notices('a')).toEqual([]);
  });

  it('says nothing about files the thread never touched, or leases of its own', () => {
    addThread('a', 'A');
    addThread('b', 'B');
    service.record(start('b', 'edit', 'src/other.ts'));
    service.record(start('a', 'edit', 'src/mine.ts'));
    expect(service.notices('a')).toEqual([]);
  });

  it('gives the leases of other threads in the thread’s own folder, with the other thread’s title', () => {
    addThread('a', 'A');
    addThread('b', 'Fix e2e');
    addThread('w', 'In a worktree', { worktree: { path: '/wt/proj/w', branch: 'pi-kit/w' } });
    leases.take('b', PROJECT, 'src/x.ts');
    leases.take('w', '/wt/proj/w', 'src/y.ts');
    leases.take('a', PROJECT, 'src/mine.ts');
    expect(service.leasesFor('a').map((l) => [l.path, l.title])).toEqual([['src/x.ts', 'Fix e2e']]);
    // A thread in a worktree works in another folder: the lease of the main checkout's file is not on its files, and its own is not another's.
    expect(service.leasesFor('w')).toEqual([]);
  });
});
