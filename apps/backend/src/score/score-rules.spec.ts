import type { HunkLabelEntry, HunkLabelsStore } from '@pi-kit/protocol';
import { describe, expect, it } from 'vitest';
import { MAX_CORRECTIONS, RUN_GRACE_MS, answerFromDialog, handEditedPaths, histogram, mergeLabels, parseLabelsStore, parseScores, projectScores, relabelHunk, scoreBadgeOf } from './score-rules';

const entry = (id: string, label: HunkLabelEntry['label'], lines = 4, extra: Partial<HunkLabelEntry> = {}): HunkLabelEntry => ({
  id,
  file: id.split('@')[0],
  header: '@@ -1,3 +1,4 @@',
  label,
  input: label === 'autonomous' ? 'none' : 'first-prompt',
  trace: 'because',
  lines,
  by: 'model',
  ...extra,
});

const store = (labels: HunkLabelEntry[], extra: Partial<HunkLabelsStore> = {}): HunkLabelsStore => ({ base: 'a'.repeat(40), head: 'b'.repeat(40), model: 'fake/canned', at: 1, labels, corrections: {}, ...extra });

describe('handEditedPaths: what the watcher saw that is the person’s hand', () => {
  const batch = (extra: Partial<Parameters<typeof handEditedPaths>[0]> = {}) => ({ paths: ['notes/gamma.md', 'src/a.ts'], running: false, sinceRunEnd: null, headMoved: false, ...extra });

  it('a batch while nothing runs is the person’s', () => {
    expect(handEditedPaths(batch())).toEqual(['notes/gamma.md', 'src/a.ts']);
    expect(handEditedPaths(batch({ sinceRunEnd: RUN_GRACE_MS + 1 }))).toHaveLength(2);
  });

  it('a batch while a run is going on is pi’s own writing', () => {
    expect(handEditedPaths(batch({ running: true }))).toEqual([]);
  });

  it('a batch right after a run ended is still pi’s: the watcher debounces', () => {
    expect(handEditedPaths(batch({ sinceRunEnd: 300 }))).toEqual([]);
    expect(handEditedPaths(batch({ sinceRunEnd: RUN_GRACE_MS - 1 }))).toEqual([]);
  });

  it('a batch that moves HEAD is git’s work (a checkout, a pull, a merge), not a hand', () => {
    expect(handEditedPaths(batch({ headMoved: true }))).toEqual([]);
  });

  it('git’s own folder is never a file the person edited', () => {
    expect(handEditedPaths(batch({ paths: ['.git/index', '.git', 'a.ts', ''] }))).toEqual(['a.ts']);
  });
});

describe('mergeLabels: a new scoring and the person’s corrections', () => {
  const correction = { label: 'specified' as const, was: 'autonomous' as const, file: 'a.ts', header: '@@', at: 5 };

  it('the package’s labels replace the earlier ones; the corrections stay', () => {
    const existing = store([entry('a.ts@1:1', 'autonomous')], { corrections: { 'a.ts@1:1': correction } });
    const merged = mergeLabels(existing, { base: 'c'.repeat(40), head: 'd'.repeat(40), model: 'm', labels: [entry('a.ts@1:1', 'autonomous'), entry('b.ts@1:1', 'specified')] }, 9);
    expect(merged).toMatchObject({ base: 'c'.repeat(40), head: 'd'.repeat(40), model: 'm', at: 9 });
    expect(merged?.labels).toHaveLength(2);
    expect(merged?.corrections).toEqual({ 'a.ts@1:1': correction });
  });

  it('labels left out change nothing, and null clears the labels with the corrections', () => {
    expect(mergeLabels(store([]), { base: 'a', head: 'b' }, 1)).toBeUndefined();
    expect(mergeLabels(store([]), { base: 'a', head: 'b', labels: null }, 1)).toBeNull();
  });
});

describe('relabelHunk: the person says what a hunk is', () => {
  const base = store([entry('a.ts@1:1', 'autonomous', 10, { excerpt: ['+x'] }), entry('b.ts@1:1', 'specified')]);

  it('records the correction with what it was and an example for the next prompt', () => {
    const next = relabelHunk(base, 'a.ts@1:1', 'specified', 7);
    expect(next?.corrections['a.ts@1:1']).toEqual({ label: 'specified', was: 'autonomous', file: 'a.ts', header: '@@ -1,3 +1,4 @@', excerpt: ['+x'], at: 7 });
    expect(next?.labels).toBe(base.labels);
  });

  it('a label that is the model’s own takes the correction back, and so does null', () => {
    const corrected = relabelHunk(base, 'a.ts@1:1', 'specified', 7) as HunkLabelsStore;
    expect(relabelHunk(corrected, 'a.ts@1:1', 'autonomous', 8)?.corrections).toEqual({});
    expect(relabelHunk(corrected, 'a.ts@1:1', null, 8)?.corrections).toEqual({});
  });

  it('a hunk the outcome does not have is refused', () => {
    expect(relabelHunk(base, 'nope@1:1', 'manual', 1)).toBeUndefined();
  });

  it('keeps the newest corrections when there are too many', () => {
    const many = store(Array.from({ length: MAX_CORRECTIONS + 5 }, (_, i) => entry(`f${i}.ts@1:1`, 'autonomous')));
    let current = many;
    for (let i = 0; i < MAX_CORRECTIONS + 5; i++) current = relabelHunk(current, `f${i}.ts@1:1`, 'specified', i) as HunkLabelsStore;
    const keys = Object.keys(current.corrections);
    expect(keys).toHaveLength(MAX_CORRECTIONS);
    expect(keys.at(-1)).toBe(`f${MAX_CORRECTIONS + 4}.ts@1:1`);
    expect(keys[0]).toBe('f5.ts@1:1');
  });
});

describe('reading what is stored', () => {
  it('a store is what pi-kit writes or nothing', () => {
    expect(parseLabelsStore(null)).toBeNull();
    expect(parseLabelsStore({ labels: 'no' })).toBeNull();
    expect(parseLabelsStore(store([entry('a@1:1', 'specified')]))).not.toBeNull();
    expect(parseScores({ meat: 150 })).toBeNull();
  });

  it('the badge carries the number and the sentence, or nulls for a thread nobody scored', () => {
    const scores = { meat: 62, vibe: 38, hunks: 23, steered: 14, lines: 100, steeredLines: 62, byLabel: { specified: { hunks: 1, lines: 1 }, corrected: { hunks: 1, lines: 1 }, autonomous: { hunks: 1, lines: 1 }, manual: { hunks: 1, lines: 1 } }, byInput: {}, line: '62 % steered: 14 of 23 hunks' };
    const labels = store([entry('a@1:1', 'specified')]);
    expect(scoreBadgeOf(scores, labels, { base: labels.base, head: labels.head })).toEqual({ meat: 62, vibe: 38, line: '62 % steered: 14 of 23 hunks', stale: false });
    expect(scoreBadgeOf(scores, labels, { base: labels.base, head: 'c'.repeat(40) }).stale).toBe(true);
    expect(scoreBadgeOf(null, null, { base: 'a', head: 'b' })).toEqual({ meat: null, vibe: null, line: null, stale: false });
  });
});

describe('the per-project distribution', () => {
  it('bins into tenths, with 100 % in the last', () => {
    expect(histogram([0, 9, 10, 55, 99, 100])).toEqual([2, 1, 0, 0, 0, 1, 0, 0, 0, 2]);
    expect(histogram([])).toEqual(Array(10).fill(0));
  });

  it('counts a project’s scored threads, averages them and lists the newest', () => {
    const scored = [
      { threadId: 't1', title: 'A', cwd: '/p', meat: 20, line: 'l1', at: 1 },
      { threadId: 't2', title: null, cwd: '/p', meat: 61, line: 'l2', at: 3 },
      { threadId: 't3', title: 'C', cwd: '/q', meat: 90, line: 'l3', at: 2 },
    ];
    const p = projectScores('/p', scored);
    expect(p).toMatchObject({ cwd: '/p', scored: 2, mean: 41 });
    expect(p.bins[2]).toBe(1);
    expect(p.bins[6]).toBe(1);
    expect(p.recent.map((r) => r.threadId)).toEqual(['t2', 't1']);
    expect(projectScores('/none', scored)).toMatchObject({ scored: 0, mean: null, recent: [] });
  });
});

describe('answerFromDialog: what the ledger keeps of a dialog', () => {
  it('an allow or deny, a choice, a text, a dismissal', () => {
    expect(answerFromDialog({ method: 'confirm', title: 'Allow bash?' }, { status: 'resolved', confirmed: true })).toEqual({ method: 'confirm', title: 'Allow bash?', status: 'resolved', confirmed: true });
    expect(answerFromDialog({ method: 'select', title: 'Which?', options: ['a', 'b'] }, { status: 'resolved', value: 'b' })).toMatchObject({ method: 'select', value: 'b' });
    expect(answerFromDialog({ method: 'input', title: 'Name' }, { status: 'resolved', value: 'x'.repeat(500) })?.value).toHaveLength(300);
    expect(answerFromDialog({ method: 'confirm', title: 'Allow?' }, { status: 'cancelled' })).toEqual({ method: 'confirm', title: 'Allow?', status: 'cancelled' });
  });
});
