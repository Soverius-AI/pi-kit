import { describe, expect, it } from 'vitest';
import type { OutcomeRow } from '../db/outcomes.repository';
import { attribute, type Candidate, isCommitSubject, nextOutcome, outcomeBadge, overlap } from './outcome-rules';

const candidate = (threadId: string, touched: string[], over: Partial<Candidate> = {}): Candidate => ({
  threadId,
  touched: new Set(touched),
  open: false,
  lastToRun: true,
  lastRunAt: 1,
  ...over,
});

describe('attribute: whose commit is it', () => {
  it('goes to the thread that touched the committed files', () => {
    expect(attribute(['a.ts', 'b.ts'], [candidate('t1', ['a.ts']), candidate('t2', ['z.ts'])])).toBe('t1');
  });

  it('goes to nobody when no thread touched any of the files', () => {
    expect(attribute(['a.ts'], [candidate('t1', ['b.ts']), candidate('t2', [])])).toBeUndefined();
    expect(attribute(['a.ts'], [])).toBeUndefined();
    expect(attribute([], [candidate('t1', ['a.ts'])])).toBeUndefined();
  });

  it('prefers the larger overlap', () => {
    const files = ['a.ts', 'b.ts', 'c.ts'];
    expect(
      attribute(files, [
        candidate('small', ['a.ts'], { lastRunAt: 99 }),
        candidate('large', ['a.ts', 'b.ts'], { lastRunAt: 1 }),
      ]),
    ).toBe('large');
  });

  it('breaks a tie by the most recent run, then by id so the order of the list does not matter', () => {
    expect(
      attribute(
        ['a.ts'],
        [candidate('old', ['a.ts'], { lastRunAt: 10 }), candidate('new', ['a.ts'], { lastRunAt: 20 })],
      ),
    ).toBe('new');
    expect(
      attribute(
        ['a.ts'],
        [candidate('new', ['a.ts'], { lastRunAt: 20 }), candidate('old', ['a.ts'], { lastRunAt: 10 })],
      ),
    ).toBe('new');
    expect(attribute(['a.ts'], [candidate('b', ['a.ts']), candidate('a', ['a.ts'])])).toBe('a');
    expect(attribute(['a.ts'], [candidate('a', ['a.ts']), candidate('b', ['a.ts'])])).toBe('a');
  });

  it('only considers a thread that is open or ran last in the folder', () => {
    const quiet = candidate('quiet', ['a.ts'], { lastToRun: false, open: false });
    expect(attribute(['a.ts'], [quiet])).toBeUndefined();
    expect(attribute(['a.ts'], [{ ...quiet, open: true }])).toBe('quiet');
    expect(attribute(['a.ts'], [{ ...quiet, lastToRun: true }])).toBe('quiet');
    // An eligible thread with a smaller overlap beats a bigger one that is not eligible.
    expect(
      attribute(
        ['a.ts', 'b.ts'],
        [candidate('eligible', ['a.ts']), candidate('gone', ['a.ts', 'b.ts'], { lastToRun: false })],
      ),
    ).toBe('eligible');
  });

  it('counts the overlap per file', () => {
    expect(overlap(['a', 'b', 'c'], new Set(['b', 'c', 'd']))).toBe(2);
  });
});

const row = (over: Partial<OutcomeRow> = {}): OutcomeRow => ({
  threadId: 't1',
  kind: 'committed',
  baseCommit: 'base1',
  headCommit: 'head1',
  mergeCommit: null,
  prUrl: null,
  at: 100,
  files: ['a.ts'],
  scores: null,
  hunkLabels: null,
  ...over,
});

describe('nextOutcome: what a thread has after new work', () => {
  const commit = {
    threadId: 't1',
    kind: 'committed' as const,
    base: 'baseX',
    head: 'head2',
    at: 200,
    files: ['b.ts', 'a.ts'],
  };

  it('a commit is the outcome of a thread that had none', () => {
    expect(nextOutcome(undefined, commit)).toEqual({
      threadId: 't1',
      kind: 'committed',
      baseCommit: 'baseX',
      headCommit: 'head2',
      mergeCommit: null,
      prUrl: null,
      at: 200,
      files: ['b.ts', 'a.ts'],
    });
  });

  it('a later commit extends a committed outcome: the head moves, the files grow, the base stays', () => {
    const next = nextOutcome(row(), commit);
    expect(next).toMatchObject({ kind: 'committed', baseCommit: 'base1', headCommit: 'head2', at: 200 });
    expect(next?.files).toEqual(['a.ts', 'b.ts']);
  });

  it('the same head again changes nothing', () => {
    expect(nextOutcome(row({ headCommit: 'head2' }), commit)).toBeUndefined();
  });

  it('a commit never replaces a merge or a pull request', () => {
    expect(nextOutcome(row({ kind: 'merged', mergeCommit: 'm' }), commit)).toBeUndefined();
    expect(nextOutcome(row({ kind: 'pr', prUrl: 'https://example.test/pr/1' }), commit)).toBeUndefined();
  });

  it('a merge or a pull request replaces whatever the thread had, the latest of the two winning', () => {
    const merged = nextOutcome(row(), {
      threadId: 't1',
      kind: 'merged',
      base: 'b',
      head: 'm1',
      merge: 'm1',
      at: 300,
      files: ['x'],
    });
    expect(merged).toMatchObject({
      kind: 'merged',
      baseCommit: 'b',
      headCommit: 'm1',
      mergeCommit: 'm1',
      files: ['x'],
    });
    const pr = nextOutcome(row({ kind: 'merged', mergeCommit: 'm1' }), {
      threadId: 't1',
      kind: 'pr',
      base: 'b',
      head: 'tip',
      prUrl: 'https://example.test/pr/2',
      at: 400,
      files: ['y'],
    });
    expect(pr).toMatchObject({ kind: 'pr', headCommit: 'tip', prUrl: 'https://example.test/pr/2', mergeCommit: null });
    expect(
      nextOutcome(row({ kind: 'pr', prUrl: 'u' }), {
        threadId: 't1',
        kind: 'merged',
        base: 'b',
        head: 'm',
        merge: 'm',
        at: 500,
        files: [],
      }),
    ).toMatchObject({ kind: 'merged', prUrl: null });
  });
});

describe('the pieces around the rules', () => {
  it('knows which reflog subjects are commits', () => {
    for (const subject of [
      'commit: add a',
      'commit (amend): add a',
      'commit (merge): m',
      'commit (initial): first',
      'merge feature: Fast-forward',
      'cherry-pick: x',
      'rebase (finish): returning to refs/heads/main',
      'pull: Fast-forward',
      'revert: Revert "x"',
    ]) {
      expect(isCommitSubject(subject), subject).toBe(true);
    }
    for (const subject of [
      'checkout: moving from main to feature',
      'reset: moving to HEAD~1',
      'branch: Created from HEAD',
      '',
    ]) {
      expect(isCommitSubject(subject), subject).toBe(false);
    }
  });

  it('turns a row into the badge the thread state carries', () => {
    expect(outcomeBadge(undefined)).toBeNull();
    expect(outcomeBadge(row())).toEqual({ kind: 'committed', head: 'head1', at: 100 });
    expect(outcomeBadge(row({ kind: 'pr', prUrl: 'https://example.test/pr/1' }))).toEqual({
      kind: 'pr',
      head: 'head1',
      at: 100,
      url: 'https://example.test/pr/1',
    });
  });

  it('carries the Meat Proxy Score only when the score plugin hands one: without it the badge is the outcome alone', () => {
    const score = { meat: 62, vibe: 38, line: '62 % steered: 14 of 23 hunks', stale: false };
    expect(outcomeBadge(row(), score)).toEqual({ kind: 'committed', head: 'head1', at: 100, score });
    expect(outcomeBadge(row(), undefined)).toEqual({ kind: 'committed', head: 'head1', at: 100 });
    expect(outcomeBadge(undefined, score)).toBeNull();
  });
});
