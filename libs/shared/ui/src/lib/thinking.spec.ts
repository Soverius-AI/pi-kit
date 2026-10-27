import { english } from '@pi-kit/i18n/testing';
import { describe, expect, it } from 'vitest';
import { approxTokens, compactNumber, formatCost, formatDuration, newestSentence, thoughtLabel } from './thinking';

describe('newestSentence', () => {
  it('shows the last complete sentence', () => {
    expect(newestSentence('First thought. The third interrupt spec fails intermittently. ')).toBe(
      'The third interrupt spec fails intermittently.',
    );
  });
  it('marks a sentence that is still being written', () => {
    expect(newestSentence('Done here. Checking whether toolCallId stays stable')).toBe(
      'Checking whether toolCallId stays stable…',
    );
  });
  it('is empty for no text and shortens a long one from the left', () => {
    expect(newestSentence('  ')).toBe('');
    expect(newestSentence('x'.repeat(300), 20).length).toBeLessThanOrEqual(22);
  });
});

describe('labels and numbers', () => {
  it('formats durations and the thought label', () => {
    expect(formatDuration(8400)).toBe('8s');
    expect(formatDuration(72_000)).toBe('1m 12s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(thoughtLabel(english, 8000)).toBe('Thought for 8s');
    expect(thoughtLabel(english, undefined)).toBe('Thought');
  });
  it('formats tokens, counts and costs', () => {
    expect(approxTokens(english, 'x'.repeat(4800))).toBe('~1.2k tokens');
    expect(approxTokens(english, 'x'.repeat(40))).toBe('~10 tokens');
    expect(compactNumber(18_400)).toBe('18.4k');
    expect(compactNumber(200_000)).toBe('200k');
    expect(compactNumber(950)).toBe('950');
    expect(formatCost(0.84)).toBe('$0.84');
    expect(formatCost(0.0123)).toBe('$0.0123');
    expect(formatCost(0)).toBe('$0.00');
  });
});
