import { describe, expect, it } from 'vitest';
import { computeScores, describeScore, effectiveLabels } from './score.mjs';

const entry = (id, label, lines, input = label === 'autonomous' ? 'none' : 'first-prompt', extra = {}) => ({ id, file: id.split('@')[0], header: '@@', label, input, lines, trace: '', by: 'model', ...extra });

describe('computeScores: the line-weighted share of specified, corrected and manual', () => {
  it('weighs lines, not hunks', () => {
    // 1 big autonomous hunk (90 lines) beside 9 small specified ones (1 line each): 9 of 10 hunks, 9 of 99 lines.
    const entries = [entry('a@1:1', 'autonomous', 90), ...Array.from({ length: 9 }, (_, i) => entry(`b@${i}:${i}`, 'specified', 1))];
    const scores = computeScores(entries);
    expect(scores).toMatchObject({ meat: 9, vibe: 91, hunks: 10, steered: 9, lines: 99, steeredLines: 9 });
  });

  it('meat plus vibe is always 100, and the shares round to whole percent', () => {
    const scores = computeScores([entry('a@1:1', 'specified', 1), entry('b@1:1', 'autonomous', 2)]);
    expect(scores.meat).toBe(33);
    expect(scores.vibe).toBe(67);
  });

  it('counts specified, corrected and manual as steered; autonomous as pi’s own', () => {
    const scores = computeScores([entry('a@1:1', 'specified', 10), entry('b@1:1', 'corrected', 10, 'review'), entry('c@1:1', 'manual', 10, 'hand'), entry('d@1:1', 'autonomous', 10)]);
    expect(scores.meat).toBe(75);
    expect(scores.byLabel).toEqual({ specified: { hunks: 1, lines: 10 }, corrected: { hunks: 1, lines: 10 }, autonomous: { hunks: 1, lines: 10 }, manual: { hunks: 1, lines: 10 } });
  });

  it('breaks the steered hunks down by what they trace to', () => {
    const scores = computeScores([
      entry('a@1:1', 'specified', 5, 'first-prompt'),
      entry('b@1:1', 'specified', 5, 'first-prompt'),
      entry('c@1:1', 'specified', 5, 'follow-up'),
      entry('d@1:1', 'corrected', 5, 'review'),
      entry('e@1:1', 'manual', 5, 'hand'),
      entry('f@1:1', 'autonomous', 5),
    ]);
    expect(scores.byInput).toEqual({ 'first-prompt': 2, 'follow-up': 1, review: 1, hand: 1 });
    expect(scores.line).toBe('83 % steered: 5 of 6 hunks, 2 by the first prompt, 1 by later prompts, 1 by review comments, 1 by hand');
  });

  it('says the example sentence (14 of 23 hunks) for hunks of equal size', () => {
    const entries = [
      ...Array.from({ length: 9 }, (_, i) => entry(`p@${i}:1`, 'specified', 4, 'first-prompt')),
      ...Array.from({ length: 3 }, (_, i) => entry(`r@${i}:1`, 'corrected', 4, 'review')),
      ...Array.from({ length: 2 }, (_, i) => entry(`h@${i}:1`, 'manual', 4, 'hand')),
      ...Array.from({ length: 9 }, (_, i) => entry(`x@${i}:1`, 'autonomous', 4)),
    ];
    const scores = computeScores(entries);
    expect(scores.hunks).toBe(23);
    expect(scores.steered).toBe(14);
    expect(scores.line).toBe('61 % steered: 14 of 23 hunks, 9 by the first prompt, 3 by review comments, 2 by hand');
  });

  it('is null where there is nothing to weigh', () => {
    expect(computeScores([])).toBeNull();
    expect(computeScores([entry('a@1:1', 'specified', 0)])).toBeNull();
  });

  it('a steered hunk with an unnamed input is counted as other input', () => {
    const scores = computeScores([entry('a@1:1', 'specified', 3, 'something-else'), entry('b@1:1', 'specified', 3, 'first-prompt')]);
    expect(describeScore(scores)).toBe('100 % steered: 2 of 2 hunks, 1 by the first prompt, 1 by other input');
  });

  it('singular hunk', () => {
    expect(computeScores([entry('a@1:1', 'autonomous', 3)]).line).toBe('0 % steered: 0 of 1 hunk');
  });
});

describe('effectiveLabels: the person’s corrections laid over the model’s labels', () => {
  const stored = {
    labels: [entry('a@1:1', 'autonomous', 10), entry('b@1:1', 'specified', 10)],
    corrections: { 'a@1:1': { label: 'specified', was: 'autonomous' }, 'b@1:1': { label: 'autonomous', was: 'specified' } },
  };

  it('replaces the label, remembers what it was and marks the entry as the person’s', () => {
    const [a, b] = effectiveLabels(stored);
    expect(a).toMatchObject({ label: 'specified', was: 'autonomous', by: 'person', input: 'person' });
    expect(b).toMatchObject({ label: 'autonomous', was: 'specified', by: 'person', input: 'none' });
  });

  it('moves the score: relabelling the autonomous hunk to specified and the specified to autonomous swaps nothing, relabelling only one moves it', () => {
    expect(computeScores(effectiveLabels({ labels: stored.labels, corrections: {} })).meat).toBe(50);
    expect(computeScores(effectiveLabels({ labels: stored.labels, corrections: { 'a@1:1': stored.corrections['a@1:1'] } })).meat).toBe(100);
    expect(computeScores(effectiveLabels({ labels: stored.labels, corrections: { 'b@1:1': stored.corrections['b@1:1'] } })).meat).toBe(0);
  });

  it('a stored value that is not labels is no labels', () => {
    expect(effectiveLabels(null)).toEqual([]);
    expect(effectiveLabels({})).toEqual([]);
  });
});
