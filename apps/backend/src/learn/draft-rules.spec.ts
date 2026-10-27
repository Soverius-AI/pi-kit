import { describe, expect, it } from 'vitest';
import { MATCH_TERMS, MIN_CHANGED_LINES, MIN_TOOL_CALLS, keyTerms, matchingSkill, worthADraft } from './draft-rules';

const FIRST = 'Add a database migration for the invoices table and write a test for the migration runner';

describe('keyTerms', () => {
  it('are the distinct words of four letters or more without the filler, at most twelve, in order', () => {
    expect(keyTerms(FIRST)).toEqual(['database', 'migration', 'invoices', 'table', 'test', 'runner']);
    expect(keyTerms('Fix the thing')).toEqual(['thing']);
    expect(keyTerms('a b c')).toEqual([]);
    expect(keyTerms(Array.from({ length: 30 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${i}`).join(' '))).toHaveLength(12);
  });
});

describe('matchingSkill', () => {
  const skills = [
    { name: 'pdf-tools', description: 'Read, merge and split PDF files' },
    { name: 'db-migrations', description: 'Use when adding a database migration or changing a table schema' },
  ];

  it('finds a skill whose name and description share the prompt’s key terms', () => {
    expect(matchingSkill(FIRST, skills)?.name).toBe('db-migrations');
  });

  it('needs MATCH_TERMS shared terms, so one word in common is not a match', () => {
    expect(MATCH_TERMS).toBe(3);
    expect(matchingSkill('Add a migration for the cache layer', skills)).toBeUndefined();
  });

  it('asks for fewer when the prompt has fewer key terms', () => {
    expect(matchingSkill('Merge PDF', skills)?.name).toBe('pdf-tools');
  });

  it('never matches a prompt without key terms, or a list without skills', () => {
    expect(matchingSkill('do it', skills)).toBeUndefined();
    expect(matchingSkill(FIRST, [])).toBeUndefined();
  });
});

describe('worthADraft (the rule: tool calls, size, no matching skill)', () => {
  const facts = { toolCalls: MIN_TOOL_CALLS, changedLines: MIN_CHANGED_LINES, firstPrompt: FIRST, skills: [] };

  it('is yes at the thresholds', () => {
    expect(MIN_TOOL_CALLS).toBe(6);
    expect(MIN_CHANGED_LINES).toBe(10);
    expect(worthADraft(facts)).toEqual({ worth: true });
  });

  it('is no below either threshold, and says which', () => {
    expect(worthADraft({ ...facts, toolCalls: 5 })).toEqual({ worth: false, reason: 'Only 5 tool calls (a draft needs 6).' });
    expect(worthADraft({ ...facts, changedLines: 9 })).toEqual({ worth: false, reason: 'Only 9 changed lines (a draft needs 10).' });
  });

  it('is no when a skill that pi has already covers the prompt', () => {
    const verdict = worthADraft({ ...facts, skills: [{ name: 'db-migrations', description: 'Use when adding a database migration or changing a table schema' }] });
    expect(verdict).toEqual({ worth: false, reason: 'The skill db-migrations already covers this.' });
  });

  it('is yes when the skills pi has are about something else', () => {
    expect(worthADraft({ ...facts, skills: [{ name: 'pdf-tools', description: 'Read, merge and split PDF files' }] })).toEqual({ worth: true });
  });
});
