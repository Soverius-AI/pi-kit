import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database.service';
import { OutcomesRepository } from './outcomes.repository';
import { SignalsRepository } from './signals.repository';
import { ThreadsRepository } from './threads.repository';

let dir: string;
let db: DatabaseService;
let signals: SignalsRepository;
let outcomes: OutcomesRepository;
let threads: ThreadsRepository;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'pk-signals-')));
  db = new DatabaseService({ dataDir: dir });
  signals = new SignalsRepository(db);
  outcomes = new OutcomesRepository(db);
  threads = new ThreadsRepository(db);
});
afterEach(() => {
  db.onApplicationShutdown();
  rmSync(dir, { recursive: true, force: true });
});

describe('dialog answers', () => {
  it('are kept in order with what was asked and what was said', () => {
    signals.noteAnswer('t1', 20, { method: 'select', title: 'Which?', status: 'resolved', value: 'b' });
    signals.noteAnswer('t1', 10, { method: 'confirm', title: 'Allow bash?', status: 'resolved', confirmed: false });
    signals.noteAnswer('t1', 30, { method: 'input', title: 'Name', status: 'cancelled' });
    expect(signals.answers('t1')).toEqual([
      { at: 10, method: 'confirm', title: 'Allow bash?', status: 'resolved', confirmed: false },
      { at: 20, method: 'select', title: 'Which?', status: 'resolved', value: 'b' },
      { at: 30, method: 'input', title: 'Name', status: 'cancelled' },
    ]);
  });
});

describe('a deleted thread takes its answers with it', () => {
  it('through the threads repository', () => {
    threads.insertDraft({ id: 't1', sessionPath: join(dir, 't1.jsonl'), cwd: dir });
    signals.noteAnswer('t1', 1, { method: 'confirm', title: 'Allow?', status: 'resolved', confirmed: true });
    threads.delete('t1');
    expect(signals.answers('t1')).toEqual([]);
  });
});

describe('the annotations of an outcome', () => {
  const outcome = {
    threadId: 't1',
    kind: 'committed' as const,
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    mergeCommit: null,
    prUrl: null,
    at: 5,
    files: ['a.txt'],
  };

  it('the setters write the labels and the scores; `put` never touches them', () => {
    outcomes.put(outcome);
    expect(outcomes.setAnnotations('t1', { hunkLabels: { labels: ['x'] }, scores: { meat: 50 } })).toBe(true);
    expect(outcomes.get('t1')).toMatchObject({ hunkLabels: { labels: ['x'] }, scores: { meat: 50 } });
    // A later commit replaces the outcome row; the annotations stay (the score says the outcome moved on).
    outcomes.put({ ...outcome, headCommit: 'c'.repeat(40), at: 9 });
    expect(outcomes.get('t1')).toMatchObject({
      headCommit: 'c'.repeat(40),
      hunkLabels: { labels: ['x'] },
      scores: { meat: 50 },
    });
  });

  it('undefined leaves a column alone, null clears it', () => {
    outcomes.put(outcome);
    outcomes.setAnnotations('t1', { hunkLabels: { a: 1 }, scores: { b: 2 } });
    outcomes.setAnnotations('t1', { scores: null });
    expect(outcomes.get('t1')).toMatchObject({ hunkLabels: { a: 1 }, scores: null });
    outcomes.setAnnotations('t1', { hunkLabels: null });
    expect(outcomes.get('t1')).toMatchObject({ hunkLabels: null });
  });

  it('a thread without an outcome has nothing to annotate', () => {
    expect(outcomes.setAnnotations('nope', { scores: { meat: 1 } })).toBe(false);
    expect(outcomes.setAnnotations('nope', {})).toBe(false);
  });
});
