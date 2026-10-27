import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../db/database.service';
import { SignalsRepository } from '../db/signals.repository';
import { ThreadsRepository } from '../db/threads.repository';
import { OutsideEditsService } from './outside-edits.service';

let base: string;
let project: string;
let worktree: string;
let db: DatabaseService;
let rows: ThreadsRepository;
let signals: SignalsRepository;
let service: OutsideEditsService;
let runListener: (threadId: string, change: 'start' | 'end') => void;
let answerListener: (threadId: string, answered: { request: unknown; answer: unknown }) => void;
let runs: Map<string, { status: string; startedAt: number; endedAt: number | null }>;
let subscribed: string[];

const NOW = 1_800_000_000_000;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pk-outside-')));
  project = join(base, 'project');
  worktree = join(base, 'worktree');
  mkdirSync(project);
  mkdirSync(worktree);
  db = new DatabaseService({ dataDir: join(base, 'data') });
  rows = new ThreadsRepository(db);
  signals = new SignalsRepository(db);
  runs = new Map();
  subscribed = [];
  rows.insertDraft({ id: 'plain', sessionPath: join(base, 'plain.jsonl'), cwd: project });
  rows.insertDraft({ id: 'second', sessionPath: join(base, 'second.jsonl'), cwd: project });
  rows.insertDraft({ id: 'wt', sessionPath: join(base, 'wt.jsonl'), cwd: project, worktree: { path: worktree, branch: 'pk/wt', projectCwd: project, base: 'main' } });
  service = new OutsideEditsService(
    rows,
    {
      onRunChange: (l: typeof runListener) => {
        runListener = l;
        return () => undefined;
      },
      lastRun: (id: string) => runs.get(id),
    } as never,
    {
      onDialogAnswered: (l: typeof answerListener) => {
        answerListener = l;
        return () => undefined;
      },
      has: () => false,
    } as never,
    {
      onBatch: () => () => undefined,
      subscribe: (folder: string) => {
        subscribed.push(folder);
        return () => undefined;
      },
    } as never,
    signals,
  );
  service.onModuleInit();
});
afterEach(() => {
  service.onModuleDestroy();
  db.onApplicationShutdown();
  rmSync(base, { recursive: true, force: true });
});

const ran = (id: string, endedAt: number | null, status = 'finished') => runs.set(id, { status, startedAt: NOW - 600_000, endedAt });

describe('files changed by hand', () => {
  it('a run holds the folder; a batch after it is noted for the threads that ran there lately', () => {
    ran('plain', NOW - 60_000);
    runListener('plain', 'start');
    runListener('plain', 'end');
    expect(subscribed).toEqual([project]);
    service.onBatch(project, ['notes/gamma.md'], NOW);
    service.onBatch(project, ['notes/gamma.md', 'src/a.ts'], NOW + 1000);
    expect(signals.outsideEdits('plain')).toEqual([
      { path: 'notes/gamma.md', firstAt: NOW, lastAt: NOW + 1000, count: 2 },
      { path: 'src/a.ts', firstAt: NOW + 1000, lastAt: NOW + 1000, count: 1 },
    ]);
  });

  it('a folder nobody ran in is not watched for hands, and a thread that never ran gets nothing', () => {
    service.onBatch(project, ['a.txt'], NOW);
    ran('plain', NOW - 60_000);
    runListener('plain', 'end');
    service.onBatch(project, ['a.txt'], NOW);
    expect(signals.outsideEdits('plain')).toHaveLength(1);
    expect(signals.outsideEdits('second')).toEqual([]);
  });

  it('while a run is going on in the folder, the writes are pi’s', () => {
    ran('plain', null, 'running');
    runListener('plain', 'start');
    service.onBatch(project, ['a.txt'], NOW);
    expect(signals.outsideEdits('plain')).toEqual([]);
  });

  it('in the moment after a run ended, the debounced batch is still pi’s', () => {
    ran('plain', NOW - 100);
    runListener('plain', 'start');
    runListener('plain', 'end');
    // `lastEnd` is the moment the listener ran, so a batch right away is inside the grace.
    service.onBatch(project, ['a.txt'], Date.now());
    expect(signals.outsideEdits('plain')).toEqual([]);
  });

  it('a batch that moves HEAD is git’s work', () => {
    ran('plain', NOW - 60_000);
    runListener('plain', 'start');
    service.onBatch(project, ['a.txt', '.git/HEAD'], NOW);
    expect(signals.outsideEdits('plain')).toEqual([]);
  });

  it('a worktree thread is watched in its worktree, and its edits are not the project’s threads’', () => {
    ran('wt', NOW - 60_000);
    runListener('wt', 'start');
    expect(subscribed).toEqual([worktree]);
    service.onBatch(worktree, ['b.txt'], NOW);
    expect(signals.outsideEdits('wt')).toHaveLength(1);
    expect(signals.outsideEdits('plain')).toEqual([]);
  });

  it('a thread whose last run was long ago does not own the edit', () => {
    ran('plain', NOW - 3 * 3_600_000);
    runs.set('plain', { status: 'finished', startedAt: NOW - 3 * 3_600_000 - 1000, endedAt: NOW - 3 * 3_600_000 });
    runListener('second', 'start');
    ran('second', NOW - 60_000);
    service.onBatch(project, ['a.txt'], NOW);
    expect(signals.outsideEdits('plain')).toEqual([]);
    expect(signals.outsideEdits('second')).toHaveLength(1);
  });
});

describe('dialogs the person answered', () => {
  it('are kept for the ledger', () => {
    answerListener('plain', { request: { method: 'confirm', title: 'Allow bash?' }, answer: { status: 'resolved', confirmed: true } });
    expect(signals.answers('plain')).toMatchObject([{ method: 'confirm', title: 'Allow bash?', status: 'resolved', confirmed: true }]);
  });
});
