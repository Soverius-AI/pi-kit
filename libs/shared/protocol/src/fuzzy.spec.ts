import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyScore } from './fuzzy';

describe('fuzzyScore', () => {
  it('needs the characters in order', () => {
    expect(fuzzyScore('sk', 'skill:pdf')).toBeGreaterThan(0);
    expect(fuzzyScore('ks', 'skill')).toBe(-1);
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('is case-insensitive and prefers prefixes, word starts and shorter text', () => {
    expect(fuzzyScore('PDF', 'skill:pdf-tools')).toBeGreaterThan(0);
    expect(fuzzyScore('comp', 'compact')).toBeGreaterThan(fuzzyScore('comp', 'recompile')); // prefix beats the middle of a word
    expect(fuzzyScore('ses', 'session')).toBeGreaterThan(fuzzyScore('ses', 'reset-all-sessions'));
  });
});

describe('fuzzyFilter', () => {
  const commands = ['model', 'compact', 'session', 'skill:pdf', 'settings'];
  it('ranks matches and drops the rest', () => {
    expect(fuzzyFilter(commands, 'se', (c) => c)).toEqual(['session', 'settings']);
    expect(fuzzyFilter(commands, 'zzz', (c) => c)).toEqual([]);
  });
  it('returns everything, in order, for an empty query', () => {
    expect(fuzzyFilter(commands, '  ', (c) => c)).toEqual(commands);
  });
});
