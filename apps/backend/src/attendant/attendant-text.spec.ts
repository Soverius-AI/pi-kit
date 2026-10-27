import type { PiSessionEntry } from '@pi-kit/pi-adapter';
import { describe, expect, it } from 'vitest';
import { answerOptions, cleanLabel, cleanSummary, cleanTitle, digestOf, draftPrompt, parseChoice, summaryPrompt, titlePrompt } from './attendant-text';

const msg = (id: string, parentId: string | null, role: 'user' | 'assistant', content: unknown): PiSessionEntry => ({ type: 'message', id, parentId, message: { role, content } });

describe('digestOf', () => {
  it('reads the branch: the first message, the last six, the tools used', () => {
    const entries: PiSessionEntry[] = [msg('u1', null, 'user', [{ type: 'text', text: 'Add a mul function to src/math.ts' }])];
    let parent = 'u1';
    for (let i = 0; i < 5; i++) {
      entries.push(msg(`a${i}`, parent, 'assistant', [{ type: 'text', text: `answer ${i}` }, { type: 'toolCall', name: i % 2 ? 'edit' : 'read' }]));
      entries.push(msg(`u${i + 2}`, `a${i}`, 'user', `question ${i + 2}`));
      parent = `u${i + 2}`;
    }
    const digest = digestOf(entries, parent);
    expect(digest.first).toBe('Add a mul function to src/math.ts');
    expect(digest.recent).toHaveLength(6);
    expect(digest.recent.at(-1)).toEqual({ role: 'user', text: 'question 6' });
    expect(digest.tools).toEqual(['read', 'edit']);
    expect(digest.answered).toBe(true);
  });

  it('ignores another branch, and a thread nobody answered is not "answered"', () => {
    const entries = [msg('u1', null, 'user', 'hello'), msg('a1', 'u1', 'assistant', 'on another branch')];
    const digest = digestOf(entries, 'u1');
    expect(digest.answered).toBe(false);
    expect(digest.recent).toEqual([{ role: 'user', text: 'hello' }]);
  });

  it('keeps long messages short', () => {
    const digest = digestOf([msg('u1', null, 'user', 'x'.repeat(2000))], 'u1');
    expect(digest.first.length).toBeLessThanOrEqual(500);
    expect(digest.recent[0].text.length).toBeLessThanOrEqual(300);
  });
});

describe('prompts', () => {
  const digest = digestOf([msg('u1', null, 'user', 'Fix the invoice export'), msg('a1', 'u1', 'assistant', 'Looking at it.')], 'a1');

  it('ask for one thing each, and give the model the conversation', () => {
    expect(titlePrompt(digest).system).toMatch(/6 to 10 words/);
    expect(titlePrompt(digest).user).toContain('Fix the invoice export');
    expect(summaryPrompt(digest).system).toMatch(/at most 14 words/);
    expect(summaryPrompt(digest, 'Delete the file?').user).toContain('waiting for the user to answer: Delete the file?');
  });

  it('a draft prompt lists the choices and says to skip when unsure', () => {
    const prompt = draftPrompt({ method: 'confirm', title: 'Run npm test?' }, ['Allow', 'Deny'], digest);
    expect(prompt.system).toContain('Allow | Deny | SKIP');
    expect(prompt.system).toMatch(/Never approve anything that deletes/);
    expect(prompt.user).toContain('Run npm test?');
  });
});

describe('what a model said', () => {
  it('cleanTitle strips quotes, a "Title:" lead and the full stop, and wants at least two words', () => {
    expect(cleanTitle('"Add a monthly summary to the reporting module."')).toBe('Add a monthly summary to the reporting module');
    expect(cleanTitle('Title: **Fix invoice export tests**\nSome more')).toBe('Fix invoice export tests');
    expect(cleanTitle('Done')).toBeUndefined();
    expect(cleanTitle('   ')).toBeUndefined();
    expect(cleanTitle('one two three four five six seven eight nine ten eleven twelve thirteen fourteen')?.split(' ')).toHaveLength(12);
  });

  it('cleanSummary is one line of at most 100 characters', () => {
    expect(cleanSummary('Status: Waiting for your answer on the scratch file.\nextra')).toBe('Waiting for your answer on the scratch file');
    expect((cleanSummary('word '.repeat(60)) ?? '').length).toBeLessThanOrEqual(101);
    expect(cleanSummary('')).toBeUndefined();
  });

  it('cleanLabel is a few words', () => {
    expect(cleanLabel('Label: "Retry or give up".')).toBe('Retry or give up');
    expect(cleanLabel('a b c d e f g h')?.split(' ')).toHaveLength(5);
  });

  it('parseChoice takes only one of the options, whatever the case or punctuation, and never SKIP', () => {
    expect(parseChoice('allow', ['Allow', 'Deny'])).toBe('Allow');
    expect(parseChoice('**Deny**.', ['Allow', 'Deny'])).toBe('Deny');
    expect(parseChoice('SKIP', ['Allow', 'Deny'])).toBeUndefined();
    expect(parseChoice('Probably allow', ['Allow', 'Deny'])).toBeUndefined();
    expect(parseChoice('pistachio', ['vanilla', 'pistachio'])).toBe('pistachio');
  });

  it('only a confirm and a select are mechanical enough to draft', () => {
    expect(answerOptions({ method: 'confirm', title: 'x' })).toEqual(['Allow', 'Deny']);
    expect(answerOptions({ method: 'select', title: 'x', options: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(answerOptions({ method: 'select', title: 'x' })).toBeUndefined();
    expect(answerOptions({ method: 'input', title: 'x' })).toBeUndefined();
    expect(answerOptions({ method: 'editor', title: 'x' })).toBeUndefined();
  });
});
